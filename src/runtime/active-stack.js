import fs from "node:fs";
import path from "node:path";

const runtimeDir = path.join(process.cwd(), ".runtime");
const runtimeFile = path.join(runtimeDir, "active-stack.json");

export function getRuntimeFilePath() {
  return runtimeFile;
}

export function writeRuntimeEnv(config) {
  fs.mkdirSync(runtimeDir, { recursive: true });
  const payload = {
    proxyPort: config.proxyPort,
    protectedPort: config.protectedPort,
    inspectorPort: config.inspectorPort,
    orchestratorPort: config.orchestratorPort,
    ollamaUrl: config.ollamaUrl,
    ollamaModel: config.ollamaModel,
    updatedAt: new Date().toISOString(),
    pid: process.pid,
  };
  fs.writeFileSync(runtimeFile, JSON.stringify(payload, null, 2));
  return payload;
}

export function readRuntimeEnv() {
  try {
    const raw = fs.readFileSync(runtimeFile, "utf8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
