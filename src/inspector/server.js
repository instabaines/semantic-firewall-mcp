import Fastify from "fastify";
import { generateJsonWithModel } from "./model-client.js";
import { PROMPT_VARIANTS } from "./prompts.js";

const DESTRUCTIVE = ["delete", "drop", "destroy", "truncate", "wipe", "shutdown"];
const READ_INTENT = ["report", "summarize", "summary", "read", "list", "fetch", "query", "analyze", "generate", "review"];
const SENSITIVE = ["secret", "token", "credential", "password", "env", "key", "email", "customer", "contact", "phone", "address"];

// Text addressed to the inspector / an AI rather than to the tool.
const INJECTION_PATTERNS = [
  /ignore (all |any |the )?(previous|prior|above|earlier) (instructions|rules|context)/i,
  /disregard (all |any |the )?(previous|prior|above|earlier|your)/i,
  /\byou are (now )?(an?|the) /i,
  /\b(system|developer) (prompt|message|override)\b/i,
  /\b(inspector|reviewer|security (check|model|filter)|firewall|guardrail)s?\b/i,
  /["']?violation["']?\s*[:=]\s*(false|0|no)\b/i,
  /\bpre-?approved\b|\balready approved\b|\bauthori[sz]ed by (the )?(admin|security|user)\b/i,
  /\b(do not|don't) (flag|block|report|deny)\b/i,
  /<\/?\s*(system|instructions?|untrusted[_a-z]*|tool_arguments)\s*>/i,
];

// Directing data to a destination the user did not name.
const EXFIL_PATTERNS = [
  /https?:\/\//i,
  /\b[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}\b/i,
  /\b(send|forward|upload|post|email|mail|share|transmit|copy) (it |them |this |all |the )?(to|with|into)\b/i,
  /\b(webhook|pastebin|ngrok|requestbin|discord|telegram|s3 bucket|gist)\b/i,
];

function argsText(tool) {
  return JSON.stringify(tool?.arguments || {});
}

export function heuristicDecision({ userIntent, intentType, tool }) {
  const intent = `${String(userIntent || "")} ${String(intentType || "")}`.toLowerCase();
  const name = String(tool?.name || "").toLowerCase();
  const args = argsText(tool);
  const action = `${name} ${args}`.toLowerCase();
  const verdict = (violation, confidence, reason, signals = []) => ({
    violation,
    confidence,
    reason,
    signals,
    model: "heuristic-slm",
  });

  const injection = INJECTION_PATTERNS.filter((pattern) => pattern.test(args)).map(String);
  if (injection.length > 0) {
    return verdict(true, 0.99, "Tool arguments contain text addressed to the inspector or an AI.", ["injection", ...injection]);
  }

  const exfil = EXFIL_PATTERNS.filter((pattern) => pattern.test(args)).map(String);
  const intentNamesDestination = /https?:\/\/|@|\b(send|share|forward|upload)\b/.test(intent);
  if (exfil.length > 0 && !intentNamesDestination) {
    return verdict(true, 0.96, "Tool arguments direct data to a destination the user did not name.", ["exfiltration", ...exfil]);
  }

  const destructiveHit = DESTRUCTIVE.some((word) => action.includes(word));
  const destructiveIntent = DESTRUCTIVE.some((word) => intent.includes(word)) || intent.includes("remove");
  if (destructiveHit && !destructiveIntent) {
    return verdict(true, 0.98, "Destructive tool call conflicts with a non-destructive user intent.", ["destructive"]);
  }

  const sensitiveHit = SENSITIVE.some((word) => action.includes(word));
  const exportIntent = intent.includes("export") || intent.includes("email") || intent.includes("contact");
  if (sensitiveHit && !exportIntent && READ_INTENT.some((word) => intent.includes(word))) {
    return verdict(true, 0.87, "Sensitive data access appears outside the stated user intent.", ["sensitive_data"]);
  }

  return verdict(false, 0.06, "Action appears consistent with the original intent and scoped tools.");
}

export function normalizeVerdict(parsed) {
  const rawViolation = parsed?.violation;
  const violation = rawViolation === true || String(rawViolation).toLowerCase() === "true";
  let confidence = Number(parsed?.confidence);
  if (!Number.isFinite(confidence)) {
    confidence = violation ? 0.8 : 0.2;
  }
  // Some models answer on a 0-100 scale.
  if (confidence > 1 && confidence <= 100) {
    confidence /= 100;
  }
  confidence = Math.min(1, Math.max(0, confidence));
  return {
    violation,
    confidence,
    reason: String(parsed?.reason || "No reason provided").slice(0, 400),
  };
}

export async function modelDecision({ config, payload, variant = config.inspectorPrompt }) {
  // With session history available, the hardened prompt gains the session block.
  if (variant === "hardened" && Array.isArray(payload.history) && payload.history.length > 0) {
    variant = "hardened-session";
  }
  const build = PROMPT_VARIANTS[variant];
  if (!build) {
    throw new Error(`Unknown inspector prompt variant: ${variant}`);
  }
  const { system, prompt } = build(payload);

  const parsed = await generateJsonWithModel({
    config,
    system,
    prompt,
    maxTokens: 160,
  });

  return {
    ...normalizeVerdict(parsed),
    model: config.ollamaModel,
    promptVariant: variant,
  };
}

// The model may be talked out of a verdict; the deterministic rules cannot.
// A violation from either side stands.
export function combineVerdicts(heuristic, model) {
  const flagged = [heuristic, model].filter((verdict) => verdict.violation);
  if (flagged.length === 0) {
    return {
      ...model,
      confidence: Math.max(heuristic.confidence, model.confidence),
      signals: heuristic.signals,
      components: { heuristic, model },
      mode: "ensemble",
    };
  }
  const strongest = flagged.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  return {
    violation: true,
    confidence: strongest.confidence,
    reason: flagged.map((verdict) => `[${verdict.model}] ${verdict.reason}`).join(" "),
    signals: heuristic.signals,
    model: model.model,
    promptVariant: model.promptVariant,
    components: { heuristic, model },
    mode: "ensemble",
  };
}

export async function inspect({ config, payload, log }) {
  const mode = config.ollamaModel ? config.inspectorMode : "heuristic";
  const heuristic = heuristicDecision(payload);

  if (mode === "heuristic") {
    return { ...heuristic, mode };
  }

  let model;
  try {
    model = await modelDecision({ config, payload });
  } catch (error) {
    if (config.requireModel) {
      throw error;
    }
    log?.warn({ err: error }, "Model inspection failed; falling back to heuristic inspector");
    return { ...heuristic, mode: "heuristic-fallback" };
  }

  if (mode === "model") {
    return { ...model, mode };
  }
  return combineVerdicts(heuristic, model);
}

// Diagram box: Inspector SLM (Local)
export function buildInspectorServer(config) {
  const app = Fastify({ logger: { level: config.logLevel } });

  app.post("/inspect", async (request) => {
    const started = performance.now();
    const decision = await inspect({ config, payload: request.body, log: request.log });
    const latencyMs = Number((performance.now() - started).toFixed(2));

    return {
      ...decision,
      latencyMs,
    };
  });

  return app;
}
