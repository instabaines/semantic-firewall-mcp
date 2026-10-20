// Boots the full stack in-process on ephemeral ports for one experiment configuration.
import { config as baseConfig } from "../../src/runtime/config.js";
import { getDb } from "../../src/protected-resource/demo-db.js";
import { buildInspectorServer } from "../../src/inspector/server.js";
import { buildProtectedServer } from "../../src/protected-resource/server.js";
import { buildProxyServer } from "../../src/semantic-proxy/server.js";

async function listen(app) {
  await app.listen({ port: 0, host: "127.0.0.1" });
  return app.server.address().port;
}

export async function startStack(overrides = {}) {
  const config = {
    ...baseConfig,
    logLevel: "silent",
    approvalTimeoutMs: 150, // simulated human: a held call is denied on timeout
    ...overrides,
  };
  getDb(config);

  const protectedApp = buildProtectedServer(config);
  config.protectedPort = await listen(protectedApp);
  config.upstreamUrl = `http://127.0.0.1:${config.protectedPort}/mcp`;

  const inspectorApp = buildInspectorServer(config);
  config.inspectorPort = await listen(inspectorApp);
  config.inspectorUrl = `http://127.0.0.1:${config.inspectorPort}/inspect`;

  const proxyApp = buildProxyServer(config);
  config.proxyPort = await listen(proxyApp);

  return {
    config,
    proxyUrl: `http://127.0.0.1:${config.proxyPort}/mcp`,
    async close() {
      await Promise.all([proxyApp.close(), inspectorApp.close(), protectedApp.close()]);
    },
  };
}
