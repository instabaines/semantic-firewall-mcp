import Fastify from "fastify";
import { generateJsonWithModel } from "./model-client.js";

function heuristicDecision({ userIntent, tool }) {
  const intent = String(userIntent || "").toLowerCase();
  const name = String(tool?.name || "").toLowerCase();
  const args = JSON.stringify(tool?.arguments || {}).toLowerCase();
  const action = `${name} ${args}`;

  const destructive = ["delete", "drop", "destroy", "truncate", "wipe", "shutdown"];
  const reporting = ["report", "summarize", "read", "list", "fetch", "query", "analyze", "generate"];
  const exporty = ["secret", "token", "credential", "password", "env", "key", "email", "customer"];

  const destructiveHit = destructive.some((word) => action.includes(word));
  const exportHit = exporty.some((word) => action.includes(word));
  const benignIntent = reporting.some((word) => intent.includes(word));

  if (destructiveHit && benignIntent) {
    return {
      violation: true,
      confidence: 0.98,
      reason: "Destructive tool call conflicts with a read/report style user intent.",
      prompt: `User Intent: ${userIntent}. Agent Action: ${tool.name}(${JSON.stringify(tool.arguments)}).`,
      model: "heuristic-slm",
    };
  }

  if (exportHit && !intent.includes("export")) {
    return {
      violation: true,
      confidence: 0.87,
      reason: "Credential or secret access appears outside the stated user intent.",
      prompt: `User Intent: ${userIntent}. Agent Action: ${tool.name}(${JSON.stringify(tool.arguments)}).`,
      model: "heuristic-slm",
    };
  }

  return {
    violation: false,
    confidence: 0.06,
    reason: "Action appears consistent with the original intent and scoped tools.",
    prompt: `User Intent: ${userIntent}. Agent Action: ${tool.name}(${JSON.stringify(tool.arguments)}).`,
    model: "heuristic-slm",
  };
}

async function modelDecision({ config, payload }) {
  const prompt = `User Intent: ${payload.userIntent}
Agent Action: ${payload.tool.name}(${JSON.stringify(payload.tool.arguments)})
Allowed Scopes: ${JSON.stringify(payload.allowedScopes)}
Resources: ${JSON.stringify(payload.resources)}
Does this action violate the original intent? Return strict JSON with keys violation, confidence, reason.`;

  const parsed = await generateJsonWithModel({
    config,
    prompt,
    maxTokens: 160,
  });

  return {
    violation: Boolean(parsed.violation),
    confidence: Number(parsed.confidence ?? (parsed.violation ? 0.8 : 0.2)),
    reason: parsed.reason || "No reason provided",
    prompt,
    model: config.ollamaModel,
  };
}

// Diagram box: Inspector SLM (Local)
export function buildInspectorServer(config) {
  const app = Fastify({ logger: true });

  app.post("/inspect", async (request) => {
    const payload = request.body;
    const started = performance.now();

    let decision;
    if (config.ollamaModel) {
      try {
        decision = await modelDecision({ config, payload });
      } catch (error) {
        if (config.requireModel) {
          throw error;
        }
        request.log.warn({ err: error }, "Falling back to heuristic inspector");
        decision = heuristicDecision(payload);
      }
    } else {
      decision = heuristicDecision(payload);
    }

    const latencyMs = Number((performance.now() - started).toFixed(2));

    return {
      ...decision,
      latencyMs,
    };
  });

  return app;
}
