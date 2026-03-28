import Fastify from "fastify";
import sensible from "@fastify/sensible";
import fastifyStatic from "@fastify/static";
import { request as httpRequest } from "undici";
import { ApprovalStore } from "./approval-gate.js";
import { listDatasets, listReports } from "../protected-resource/demo-db.js";
import { eventBus } from "../dashboard/event-bus.js";
import { extractIntentToken, verifyIntentPassport } from "../protocol/contextual-passport.js";
import { buildPolicyContext, checkResourceBinding, checkToolScope, extractTargetResources, isHighRiskTool } from "./policy-engine.js";
import { readRuntimeEnv } from "../runtime/active-stack.js";
import { inspectAction } from "./inspector-client.js";

async function forwardRpc(config, body) {
  const response = await httpRequest(config.upstreamUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });

  const contentType = String(response.headers["content-type"] || "");
  const raw = await response.body.text();

  if (contentType.includes("text/event-stream")) {
    const match = raw.match(/data:\s*(\{[\s\S]*\})/);
    if (!match) {
      throw new Error("Unable to parse MCP event stream response");
    }
    return JSON.parse(match[1]);
  }

  return JSON.parse(raw);
}

// Diagram box: Semantic Proxy (PEP)
export function buildProxyServer(config, overrides = {}) {
  const app = Fastify({ logger: true });
  const approvals = new ApprovalStore({ timeoutMs: config.approvalTimeoutMs, eventBus });
  const inspect = overrides.inspectAction || ((input) => inspectAction(input));
  const forward = overrides.forwardRpc || ((body) => forwardRpc(config, body));

  app.register(sensible);
  app.register(fastifyStatic, {
    root: config.publicDir,
    prefix: "/dashboard/",
  });
  app.decorate("approvals", approvals);

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
    const approved = Boolean(request.body?.approved);
    const approver = request.body?.approver || "human";
    const ok = approved
      ? approvals.approve(request.params.id, approver)
      : approvals.reject(request.params.id, approver);

    if (!ok) {
      return reply.notFound("Approval request not found");
    }

    return { ok: true };
  });

  app.post("/mcp", async (request, reply) => {
    const rpc = request.body;

    if (rpc.method !== "tools/call") {
      eventBus.publish("proxy.rpc_passthrough", { method: rpc.method });
      return forward(rpc);
    }

    const token = extractIntentToken(request);
    if (!token) {
      return reply.forbidden("Missing Intent JWT");
    }

    let passport;
    try {
      passport = verifyIntentPassport(token, config);
    } catch (error) {
      request.log.warn({ err: error }, "Intent JWT verification failed");
      return reply.forbidden("Invalid Intent JWT");
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
      eventBus.publish("proxy.denied", {
        reason: "scope_mismatch",
        toolName: toolCall.name,
        summary: passport.summary,
      });
      return reply.code(403).send({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: {
          code: 403,
          message: "Intent scope mismatch",
          data: {
            summary: passport.summary,
            attemptedTool: toolCall.name,
            allowedScopes: passport.tool_scopes,
          },
        },
      });
    }

    if (!checkResourceBinding(passport, toolCall)) {
      eventBus.publish("proxy.denied", {
        reason: "resource_binding_mismatch",
        toolName: toolCall.name,
        targets: extractTargetResources(toolCall),
        allowed: passport.resource_indicators,
      });
      return reply.code(403).send({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: {
          code: 403,
          message: "Resource binding mismatch",
          data: {
            attemptedResources: extractTargetResources(toolCall),
            allowedResources: passport.resource_indicators,
          },
        },
      });
    }

    const inspector = await inspect({ config, passport, toolCall });
    const policyContext = buildPolicyContext(passport, toolCall);
    const needsApproval = inspector.violation && inspector.confidence >= config.violationThreshold;
    const autoBlock = inspector.violation && !isHighRiskTool(toolCall.name) && inspector.confidence >= 0.95;

    if (autoBlock) {
      eventBus.publish("proxy.denied", {
        reason: "semantic_policy",
        toolName: toolCall.name,
        inspector,
      });
      return reply.code(403).send({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        error: {
          code: 403,
          message: "Semantic policy denied the tool call",
          data: {
            inspector,
            policyContext,
          },
        },
      });
    }

    if (needsApproval) {
      const pending = approvals.create({
        rpc,
        inspector,
        policyContext,
      });

      request.log.warn(
        { approvalId: pending.id, inspector, policyContext },
        "Tool call paused pending human approval",
      );

      const decision = await pending.promise;
      if (!decision.approved) {
        eventBus.publish("proxy.denied", {
          reason: "human_denied",
          toolName: toolCall.name,
          inspector,
        });
        return reply.code(403).send({
          jsonrpc: "2.0",
          id: rpc.id ?? null,
          error: {
            code: 403,
            message: "Human approval denied",
            data: {
              inspector,
              policyContext,
              decision,
            },
          },
        });
      }
    }

    const forwarded = await forward(rpc);
    eventBus.publish("proxy.forwarded", {
      toolName: toolCall.name,
      summary: passport.summary,
      inspector,
    });
    return forwarded;
  });

  return app;
}
