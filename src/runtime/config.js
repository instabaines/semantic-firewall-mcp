import path from "node:path";

const ollamaHost = process.env.OLLAMA_HOST || "127.0.0.1:11434";

export const config = {
  jwtSecret: process.env.INTENT_JWT_SECRET || "demo-intent-secret-change-me",
  issuer: process.env.INTENT_JWT_ISSUER || "orchestrator.demo",
  audience: process.env.INTENT_JWT_AUDIENCE || "semantic-proxy.demo",
  proxyPort: Number(process.env.PROXY_PORT || 4000),
  protectedPort: Number(process.env.PROTECTED_PORT || 4100),
  inspectorPort: Number(process.env.INSPECTOR_PORT || 4200),
  orchestratorPort: Number(process.env.ORCHESTRATOR_PORT || 4300),
  approvalTimeoutMs: Number(process.env.APPROVAL_TIMEOUT_MS || 30000),
  violationThreshold: Number(process.env.VIOLATION_THRESHOLD || 0.7),
  upstreamUrl: process.env.UPSTREAM_URL || `http://127.0.0.1:${Number(process.env.PROTECTED_PORT || 4100)}/mcp`,
  inspectorUrl: process.env.INSPECTOR_URL || `http://127.0.0.1:${Number(process.env.INSPECTOR_PORT || 4200)}/inspect`,
  ollamaUrl: process.env.OLLAMA_URL || `http://${ollamaHost}/api/generate`,
  ollamaModel: process.env.OLLAMA_MODEL || "qwen3-vl:8b",
  requireModel: process.env.REQUIRE_MODEL === "1",
  dbPath: process.env.DB_PATH || path.join(process.cwd(), "data", "demo.db"),
  publicDir: process.env.PUBLIC_DIR || path.join(process.cwd(), "public"),
};
