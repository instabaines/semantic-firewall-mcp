import Fastify from "fastify";
import { listDatasets } from "../protected-resource/demo-db.js";
import { eventBus } from "../dashboard/event-bus.js";
import { issueIntentPassport } from "../protocol/contextual-passport.js";
import { deriveToolScopes, summarizeIntent } from "./semantic-summary.js";

// Diagram box: Agent Orchestrator
export function buildOrchestratorServer(config) {
  const app = Fastify({ logger: true });

  app.get("/catalog", async () => ({
    datasets: listDatasets(config),
  }));

  app.post("/intent-passports", async (request) => {
    const prompt = String(request.body?.prompt || "");
    const semantic = await summarizeIntent({ config, prompt });
    const toolScopes = request.body?.toolScopes || deriveToolScopes(semantic.intentType);
    const sessionId = request.body?.sessionId || crypto.randomUUID();

    const passport = issueIntentPassport({
      prompt,
      summary: semantic.summary,
      rationale: semantic.rationale,
      intentType: semantic.intentType,
      toolScopes,
      resources: semantic.requestedResourceUris,
      sessionId,
      config,
    });

    eventBus.publish("intent.passport_issued", {
      sessionId,
      prompt,
      summary: semantic.summary,
      intentType: semantic.intentType,
      resourceIndicators: semantic.requestedResourceUris,
      toolScopes,
    });

    return passport;
  });

  return app;
}
