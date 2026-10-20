import { config } from "./runtime/config.js";
import { getDb } from "./protected-resource/demo-db.js";
import { writeRuntimeEnv } from "./runtime/active-stack.js";
import { buildInspectorServer } from "./inspector/server.js";
import { buildOrchestratorServer } from "./orchestrator/server.js";
import { buildProtectedServer } from "./protected-resource/server.js";
import { buildProxyServer } from "./semantic-proxy/server.js";

async function start(name, app, port) {
  await app.listen({ port, host: "127.0.0.1" });
  app.log.info(`${name} listening on ${port}`);
}

const mode = process.argv[2] || "all";
getDb(config);
writeRuntimeEnv(config);

if (mode === "proxy") {
  await start("semantic-proxy", buildProxyServer(config), config.proxyPort);
} else if (mode === "protected") {
  await start("protected-mcp", buildProtectedServer(config), config.protectedPort);
} else if (mode === "inspector") {
  await start("inspector", buildInspectorServer(config), config.inspectorPort);
} else if (mode === "orchestrator") {
  await start("orchestrator", buildOrchestratorServer(config), config.orchestratorPort);
} else {
  await Promise.all([
    start("semantic-proxy", buildProxyServer(config), config.proxyPort),
    start("protected-mcp", buildProtectedServer(config), config.protectedPort),
    start("inspector", buildInspectorServer(config), config.inspectorPort),
    start("orchestrator", buildOrchestratorServer(config), config.orchestratorPort),
  ]);
}
