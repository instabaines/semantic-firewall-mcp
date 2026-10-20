import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import { request as httpRequest } from "undici";
import { ApprovalStore } from "./approval-gate.js";
import { listDatasets, listReports } from "../protected-resource/demo-db.js";
import { eventBus } from "../dashboard/event-bus.js";
import { extractIntentToken, verifyIntentPassport } from "../protocol/contextual-passport.js";
import { createDpopProof } from "../protocol/sender-constrained.js";
import { secretMatches } from "../protocol/bearer.js";
import {
  PASSTHROUGH_METHODS,
  buildPolicyContext,
  checkResourceBinding,
  checkResourceReadBinding,
  checkToolScope,
  extractTargetResources,
  isHighRiskTool,
} from "./policy-engine.js";
import { readRuntimeEnv } from "../runtime/active-stack.js";
import { inspectAction } from "./inspector-client.js";

async function forwardRpc(config, body, accessToken) {
  const payload = JSON.stringify(body);
  const dpop = createDpopProof({
    config,
    accessToken,
    method: "POST",
    url: config.upstreamUrl,
    body: payload,
  });

  const response = await httpRequest(config.upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      dpop,
    },
    body: payload,
  });

  const contentType = String(response.headers["content-type"] || "");
  const raw = await response.body.text();
  if (!raw.trim()) {
    return {};
  }

  if (contentType.includes("text/event-stream")) {
    const match = raw.match(/data:\s*(\{[\s\S]*\})/);
    if (!match) {
      throw new Error("Unable to parse MCP event stream response");
    }
    return JSON.parse(match[1]);
  }

  return JSON.parse(raw);
}

// Maps an inspector verdict to allow | hold | block.
//  - below the violation threshold: allow
//  - high-risk tools: always routed to a human (hold), never silently allowed
//  - other tools: block at >= autoBlockThreshold, otherwise hold
export function decideOnVerdict({ config, toolName, inspector }) {
  if (!inspector.violation || inspector.confidence < config.violationThreshold) {
    return "allow";
  }
  if (isHighRiskTool(toolName)) {
    return "hold";
  }
  return inspector.confidence >= config.autoBlockThreshold ? "block" : "hold";
}

// Diagram box: Semantic Proxy (PEP)
export function buildProxyServer(config, overrides = {}) {
  const app = Fastify({ logger: { level: config.logLevel } });
  const approvals = new ApprovalStore({ timeoutMs: config.approvalTimeoutMs, eventBus });
  const inspect = overrides.inspectAction || ((input) => inspectAction(input));
  // Per-session history (keyed by passport jti) of forwarded calls and results.
  const sessions = new Map();
  const historyFor = (passport) => (config.inspectorHistory > 0 ? sessions.get(passport.jti) || [] : []);
  // Full results per session, for destination provenance (passports with prompt hashes only).
  const results = new Map();
  const resultsFor = (passport) => results.get(passport.jti) || [];
  const remember = (passport, toolCall, forwarded) => {
    if (!passport.jti) return;
    const text = JSON.stringify(forwarded?.result ?? forwarded?.error ?? null);
    if (config.inspectorHistory > 0) {
      const entry = { tool: toolCall.name, arguments: toolCall.arguments, result: text.length > 800 ? `${text.slice(0, 800)} ...[truncated]` : text };
      sessions.set(passport.jti, [...(sessions.get(passport.jti) || []), entry].slice(-config.inspectorHistory));
      if (sessions.size > 10000) sessions.delete(sessions.keys().next().value);
    }
    if (Array.isArray(passport.user_values)) {
      results.set(passport.jti, [...resultsFor(passport), text.slice(0, 50000)].slice(-32));
      if (results.size > 10000) results.delete(results.keys().next().value);
    }
  };
  const forward = overrides.forwardRpc || ((body, accessToken) => forwardRpc(config, body, accessToken));
  const securityState = {
    currentAudience: config.protectedResourceAudience,
    senderConstraintThumbprint: config.senderConstraint.thumbprint,
    lastRequestModelBacked: null,
    lastRequestDpopVerified: null,
  };
  const onEvent = (event) => {
    if (event.type !== "resource.auth_verified") {
      return;
    }
    securityState.currentAudience = event.payload.audience || securityState.currentAudience;
    securityState.senderConstraintThumbprint = event.payload.senderConstraintThumbprint || securityState.senderConstraintThumbprint;
    securityState.lastRequestDpopVerified = Boolean(event.payload.dpopVerified);
  };

  // Second layer against dashboard script injection: no inline or third-party script.
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/dashboard")) {
      reply.header("content-security-policy", "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      reply.header("x-content-type-options", "nosniff");
    }
    return payload;
  });

  app.register(sensible);
  app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: "/dashboard/",
  });
  app.decorate("approvals", approvals);
  eventBus.on("event", onEvent);
  app.addHook("onClose", async () => {
    eventBus.off("event", onEvent);
  });

  app.get("/", async (_request, reply) => reply.redirect("/dashboard/"));

  app.get("/health", async () => ({
    status: "ok",
    pendingApprovals: approvals.list().length,
  }));

  app.get("/api/state", async () => ({
    pendingApprovals: approvals.list(),
    recentEvents: eventBus.recent().slice(0, 30),
    datasets: listDatasets(config),
    reports: listReports(config),
    runtime: readRuntimeEnv(),
    security: { ...securityState },
  }));

  app.get("/approvals", async () => ({
    pending: approvals.list(),
  }));

  app.get("/events", async (request, reply) => {
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });

    const send = (event) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    for (const event of eventBus.recent().slice(0, 20).reverse()) {
      send(event);
    }

    const listener = (event) => send(event);
    eventBus.on("event", listener);
    request.raw.on("close", () => {
      eventBus.off("event", listener);
      reply.raw.end();
    });
  });

  app.post("/approvals/:id/decision", async (request, reply) => {
    // Only the human approver holds this token; the agent never does.
    if (!secretMatches(request.headers["x-approver-token"], config.approverToken)) {
      eventBus.publish("approval.unauthorized_decision", { id: request.params.id });
      return reply.unauthorized("Approver token required");
    }

    const approved = request.body?.approved === true;
    const approver = String(request.body?.approver || "human");
    const ok = approved
      ? approvals.approve(request.params.id, approver)
      : approvals.reject(request.params.id, approver);

    if (!ok) {
      return reply.notFound("Approval request not found");
    }

    return { ok: true };
  });

  const deny = (reply, rpc, status, reason, message, data = {}) => {
    eventBus.publish("proxy.denied", { reason, ...data });
    return reply.code(status).send({
      jsonrpc: "2.0",
      id: rpc?.id ?? null,
      error: { code: status, message, data: { reason, ...data } },
    });
  };

  app.post("/mcp", async (request, reply) => {
    const rpc = request.body;

    // One JSON-RPC request per HTTP request. Batches would let a tools/call ride
    // inside an array the policy layer never inspects.
    if (!rpc || typeof rpc !== "object" || Array.isArray(rpc) || typeof rpc.method !== "string") {
      return deny(reply, null, 400, "malformed_rpc", "Expected a single JSON-RPC request object");
    }

    const token = extractIntentToken(request);
    if (!token) {
      return deny(reply, rpc, 401, "missing_passport", "Missing Intent JWT");
    }

    let passport;
    try {
      passport = verifyIntentPassport(token, config, {
        audience: config.protectedResourceAudience,
      });
    } catch (error) {
      request.log.warn({ err: error }, "Intent JWT verification failed");
      return deny(reply, rpc, 403, "invalid_passport", "Invalid Intent JWT");
    }

    // Notifications have no response and no side effects on tools.
    if (rpc.method.startsWith("notifications/") || PASSTHROUGH_METHODS.has(rpc.method)) {
      eventBus.publish("proxy.rpc_passthrough", { method: rpc.method });
      return forward(rpc, token);
    }

    if (rpc.method === "resources/read") {
      const uri = rpc.params?.uri;
      if (!checkResourceReadBinding(passport, uri)) {
        return deny(reply, rpc, 403, "resource_binding_mismatch", "Resource binding mismatch", {
          attemptedResources: [uri],
          allowedResources: passport.resource_indicators,
        });
      }
      eventBus.publish("proxy.rpc_passthrough", { method: rpc.method, uri });
      return forward(rpc, token);
    }

    if (rpc.method !== "tools/call") {
      return deny(reply, rpc, 403, "method_not_allowed", `MCP method ${rpc.method} is not permitted`);
    }

    const toolCall = {
      name: rpc.params?.name,
      arguments: rpc.params?.arguments || {},
    };

    eventBus.publish("proxy.tool_requested", {
      toolName: toolCall.name,
      toolArgs: toolCall.arguments,
      summary: passport.summary,
      intentType: passport.intent_type,
    });

    if (!checkToolScope(passport, toolCall.name)) {
      securityState.lastRequestModelBacked = false;
      securityState.lastRequestDpopVerified = false;
      return deny(reply, rpc, 403, "scope_mismatch", "Intent scope mismatch", {
        attemptedTool: toolCall.name,
        allowedScopes: passport.tool_scopes,
      });
    }

    if (!checkResourceBinding(passport, toolCall)) {
      securityState.lastRequestModelBacked = false;
      securityState.lastRequestDpopVerified = false;
      return deny(reply, rpc, 403, "resource_binding_mismatch", "Resource binding mismatch", {
        toolName: toolCall.name,
        attemptedResources: extractTargetResources(toolCall),
        allowedResources: passport.resource_indicators,
      });
    }

    const policyContext = buildPolicyContext(passport, toolCall);

    let inspector;
    try {
      // "off" exists only for ablation experiments (static/scope/resource layers alone).
      inspector = config.inspectorMode === "off"
        ? { violation: false, confidence: 0, reason: "inspection disabled", model: "off" }
        : await inspect({ config, passport, toolCall, history: historyFor(passport), results: resultsFor(passport) });
    } catch (error) {
      // Fail closed: no verdict means no forward.
      request.log.error({ err: error }, "Inspector unavailable; failing closed");
      securityState.lastRequestModelBacked = false;
      return deny(reply, rpc, 503, "inspector_unavailable", "Semantic inspection unavailable", {
        toolName: toolCall.name,
        error: error.message,
      });
    }

    securityState.lastRequestModelBacked = inspector.model !== "heuristic-slm";
    securityState.lastRequestDpopVerified = false;
    const decision = decideOnVerdict({ config, toolName: toolCall.name, inspector });

    if (decision === "block") {
      return deny(reply, rpc, 403, "semantic_policy", "Semantic policy denied the tool call", {
        toolName: toolCall.name,
        inspector,
        policyContext,
      });
    }

    if (decision === "hold") {
      const pending = approvals.create({
        rpc,
        inspector,
        policyContext,
      });

      request.log.warn(
        { approvalId: pending.id, inspector, policyContext },
        "Tool call paused pending human approval",
      );

      const humanDecision = await pending.promise;
      if (!humanDecision.approved) {
        return deny(reply, rpc, 403, "human_denied", "Human approval denied", {
          toolName: toolCall.name,
          inspector,
          policyContext,
          decision: humanDecision,
        });
      }
    }

    const forwarded = await forward(rpc, token);
    remember(passport, toolCall, forwarded);
    eventBus.publish("proxy.forwarded", {
      toolName: toolCall.name,
      summary: passport.summary,
      inspector,
      decision,
    });
    return forwarded;
  });

  return app;
}
