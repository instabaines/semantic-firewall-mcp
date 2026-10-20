import path from "node:path";
import { loadPassportSigner, loadProxyIdentity, loadRuntimeSecrets } from "./proxy-identity.js";

const senderConstraint = loadProxyIdentity();
const passportSigner = loadPassportSigner();
const secrets = loadRuntimeSecrets();

export function resolveOllamaUrl(env = process.env) {
  if (env.OLLAMA_URL) {
    return env.OLLAMA_URL;
  }

  const rawHost = env.OLLAMA_HOST || "127.0.0.1:11434";
  const hostValue = /^https?:\/\//.test(rawHost) ? rawHost : `http://${rawHost}`;
  const url = new URL(hostValue);

  if (!url.port) {
    url.port = "11434";
  }

  if (url.pathname === "/" || !url.pathname) {
    url.pathname = "/api/generate";
  } else if (!url.pathname.endsWith("/api/generate")) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/api/generate`;
  }

  return url.toString();
}

export const config = {
  issuer: process.env.INTENT_JWT_ISSUER || "orchestrator.demo",
  protectedResourceAudience:
    process.env.PROTECTED_RESOURCE_AUDIENCE || "mcp-server-sales-production",
  proxyPort: Number(process.env.PROXY_PORT || 4000),
  protectedPort: Number(process.env.PROTECTED_PORT || 4100),
  inspectorPort: Number(process.env.INSPECTOR_PORT || 4200),
  orchestratorPort: Number(process.env.ORCHESTRATOR_PORT || 4300),
  inspectorTimeoutMs: Number(process.env.INSPECTOR_TIMEOUT_MS || 120000),
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 30000),
  violationThreshold: Number(process.env.VIOLATION_THRESHOLD || 0.7),
  autoBlockThreshold: Number(process.env.AUTO_BLOCK_THRESHOLD || 0.95),
  passportTtlSeconds: Number(process.env.PASSPORT_TTL_SECONDS || 300),
  upstreamUrl: process.env.UPSTREAM_URL || `http://127.0.0.1:${Number(process.env.PROTECTED_PORT || 4100)}/mcp`,
  inspectorUrl: process.env.INSPECTOR_URL || `http://127.0.0.1:${Number(process.env.INSPECTOR_PORT || 4200)}/inspect`,
  ollamaUrl: resolveOllamaUrl(process.env),
  ollamaModel: process.env.OLLAMA_MODEL || "qwen3-vl:8b",
  requireModel: process.env.REQUIRE_MODEL === "1",
  // heuristic | model | ensemble (model OR heuristic)
  inspectorMode: process.env.INSPECTOR_MODE || "ensemble",
  // naive | hardened (see src/inspector/prompts.js)
  inspectorPrompt: process.env.INSPECTOR_PROMPT || "hardened",
  // Recent calls (with truncated results) per session passed to the inspector; 0 disables.
  inspectorHistory: Number(process.env.INSPECTOR_HISTORY ?? 6),
  // Destination provenance (src/inspector/provenance.js): off | rules | model.
  // "rules" and "model" name the taint detector applied to tool results.
  provenance: process.env.PROVENANCE || "off",
  // model | deterministic
  summarizerMode: process.env.SUMMARIZER_MODE || "model",
  modelSeed: process.env.MODEL_SEED === undefined ? undefined : Number(process.env.MODEL_SEED),
  modelTemperature: Number(process.env.MODEL_TEMPERATURE || 0.1),
  orchestratorClientToken: process.env.ORCHESTRATOR_CLIENT_TOKEN || secrets.orchestratorClientToken,
  approverToken: process.env.APPROVER_TOKEN || secrets.approverToken,
  logLevel: process.env.LOG_LEVEL || "info",
  dbPath: process.env.DB_PATH || path.join(process.cwd(), "data", "demo.db"),
  publicDir: process.env.PUBLIC_DIR || path.join(process.cwd(), "public"),
  senderConstraint,
  passportSigner,
};


