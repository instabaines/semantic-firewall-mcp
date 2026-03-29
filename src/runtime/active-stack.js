import fs from "node:fs";
import path from "node:path";

const runtimeDir = path.join(process.cwd(), ".runtime");
const runtimeFile = path.join(runtimeDir, "active-stack.json");

export function getRuntimeFilePath() {
  return runtimeFile;
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function writeRuntimeEnv(config) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const payload = {
    proxyPort: config.proxyPort,
    protectedPort: config.protectedPort,
    inspectorPort: config.inspectorPort,
    orchestratorPort: config.orchestratorPort,
    protectedResourceAudience: config.protectedResourceAudience,
    passportTtlSeconds: config.passportTtlSeconds,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    senderConstraintThumbprint: config.senderConstraint.thumbprint,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
  };
  fs.writeFileSync(runtimeFile, JSON.stringify(payload, null, 2));
  return payload;
}

export function readRuntimeEnv() {
  try {
    const raw = fs.readFileSync(runtimeFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!processExists(parsed.pid)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
