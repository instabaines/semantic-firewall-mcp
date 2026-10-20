// E4: latency overhead of the enforcement path without a model.
// Compares a direct, DPoP-authenticated call to the MCP server with the same call
// through the proxy (scope + binding only, and with the rule-based inspector).
//
// Usage: node experiments/run-overhead.js [--n 300]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { request } from "undici";
import { startStack } from "./lib/stack.js";
import { issueIntentPassport } from "../src/protocol/contextual-passport.js";
import { createDpopProof } from "../src/protocol/sender-constrained.js";
import { RAW } from "./lib/paths.js";

const n = Number(process.argv[process.argv.indexOf("--n") + 1]) || 300;
const WARMUP = 30;
const body = JSON.stringify({
  jsonrpc: "2.0", id: 1, method: "tools/call",
  params: { name: "get_dataset_overview", arguments: { datasetId: "sales-q1" } },
});

const quantile = (values, q) => {
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.ceil(pos)] - sorted[lo]) * (pos - lo);
};

async function time(fn) {
  const samples = [];
  for (let i = 0; i < WARMUP + n; i += 1) {
    const started = performance.now();
    const response = await fn();
    const text = await response.body.text();
    if (response.statusCode !== 200) throw new Error(`unexpected ${response.statusCode}: ${text.slice(0, 200)}`);
    if (i >= WARMUP) samples.push(performance.now() - started);
  }
  return { p50: quantile(samples, 0.5), p95: quantile(samples, 0.95), mean: samples.reduce((a, b) => a + b, 0) / samples.length };
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sfmcp-e4-"));
  const results = {};
  for (const [name, inspectorMode] of [["proxy_binding_only", "off"], ["proxy_with_rules", "heuristic"]]) {
    const stack = await startStack({ dbPath: path.join(work, "e4.db"), inspectorMode, ollamaModel: "" });
    const { token } = issueIntentPassport({
      prompt: "Generate a revenue report for sales-q1.", summary: "Generate a revenue report for sales-q1.",
      rationale: "e4", intentType: "report",
      toolScopes: ["get_dataset_overview"], resources: ["demo://datasets/sales-q1"], sessionId: "e4", config: stack.config,
    });
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${token}` };

    if (!results.direct) {
      results.direct = await time(() => request(stack.config.upstreamUrl, {
        method: "POST",
        headers: { ...headers, dpop: createDpopProof({ config: stack.config, accessToken: token, method: "POST", url: stack.config.upstreamUrl, body }) },
        body,
      }));
    }
    results[name] = await time(() => request(stack.proxyUrl, { method: "POST", headers, body }));
    await stack.close();
  }

  const out = { n, warmup: WARMUP, node: process.version, cpu: `${os.cpus()[0]?.model} x${os.cpus().length}`, results };
  const dir = RAW;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "e4-overhead.json"), JSON.stringify(out, null, 2));
  for (const [name, r] of Object.entries(results)) {
    console.log(`${name.padEnd(20)} p50 ${r.p50.toFixed(2)} ms  p95 ${r.p95.toFixed(2)} ms  mean ${r.mean.toFixed(2)} ms`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
