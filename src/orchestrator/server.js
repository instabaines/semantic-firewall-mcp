import Fastify from "fastify";
import { listDatasets } from "../protected-resource/demo-db.js";
import { eventBus } from "../dashboard/event-bus.js";
import { bearerFrom, secretMatches } from "../protocol/bearer.js";
import { issueIntentPassport } from "../protocol/contextual-passport.js";
import { isKnownTool } from "../semantic-proxy/policy-engine.js";
import { deriveToolScopes, summarizeIntent } from "./semantic-summary.js";

// Diagram box: Agent Orchestrator
//
// Only the trusted user-facing client (holding orchestratorClientToken) may mint
// passports. The agent receives a passport, never this credential, so a hijacked
// agent cannot issue itself broader permissions.
export function buildOrchestratorServer(config) {
  const app = Fastify({ logger: { level: config.logLevel } });

  app.get("/catalog", async () => ({
    datasets: listDatasets(config),
  }));

  app.post("/intent-passports", async (request, reply) => {
    if (!secretMatches(bearerFrom(request), config.orchestratorClientToken)) {
      eventBus.publish("intent.unauthorized_mint", {});
      return reply.code(401).send({ error: "Orchestrator client credential required" });
    }

    const prompt = String(request.body?.prompt || "");
    const semantic = await summarizeIntent({ config, prompt });

    // Explicit scopes represent a consent grant made by the user through the
    // trusted client. They are recorded as such and still limited to known tools.
    const requestedScopes = request.body?.toolScopes;
    let toolScopes = deriveToolScopes(semantic.intentType);
    let scopeSource = "derived";
    if (requestedScopes !== undefined) {
      if (!Array.isArray(requestedScopes) || !requestedScopes.every(isKnownTool)) {
        return reply.code(400).send({ error: "toolScopes must be an array of known tool names" });
      }
      toolScopes = [...new Set(requestedScopes)];
      scopeSource = "user_granted";
    }

    const sessionId = request.body?.sessionId || crypto.randomUUID();

    const passport = issueIntentPassport({
      prompt,
      summary: semantic.summary,
      rationale: semantic.rationale,
      intentType: semantic.intentType,
      toolScopes,
      scopeSource,
      resources: semantic.requestedResourceUris,
      sessionId,
      config,
    });

    eventBus.publish("intent.passport_issued", {
      sessionId,
      summary: semantic.summary,
      intentType: semantic.intentType,
      resourceIndicators: semantic.requestedResourceUris,
      toolScopes,
      scopeSource,
    });

    return passport;
  });

  return app;
}
