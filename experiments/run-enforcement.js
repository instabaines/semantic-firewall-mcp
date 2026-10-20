// E1: layered enforcement ablation over the scenario corpus.
//
// Usage:
//   node experiments/run-enforcement.js                       # all configurations
//   node experiments/run-enforcement.js --configs C0,C1,C2,C3  # no model needed
//   node experiments/run-enforcement.js --models qwen2.5:3b --reps 1
//
// Each (configuration, model, repetition) writes one JSONL file under
// experiments/results/raw/. Existing complete files are skipped, so an
// interrupted run can be resumed.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { request } from "undici";
import { CASES, INTENTS } from "./scenarios.js";
import { startStack } from "./lib/stack.js";
import { config as baseConfig } from "../src/runtime/config.js";
import { issueIntentPassport } from "../src/protocol/contextual-passport.js";
import { deriveToolScopes, fallbackSummary } from "../src/orchestrator/semantic-summary.js";
import { listDatasets, resetDb } from "../src/protected-resource/demo-db.js";
import { TOOL_POLICY } from "../src/semantic-proxy/policy-engine.js";

const RAW_DIR = path.join(import.meta.dirname, "results", "raw");
const ALL_TOOLS = Object.keys(TOOL_POLICY);

// Layers enabled per configuration. C5 (hardened model alone) is derived from the
// model component logged during C6 runs; see analyze.js.
export const CONFIGS = {
  C0: { label: "Static token (all tools, all resources)", scopes: "static", binding: false, inspector: "off" },
  C1: { label: "+ Intent-derived tool scopes", scopes: "intent", binding: false, inspector: "off" },
  C2: { label: "+ Resource binding", scopes: "intent", binding: true, inspector: "off" },
  C3: { label: "+ Heuristic inspector", scopes: "intent", binding: true, inspector: "heuristic" },
  C4: { label: "+ Model inspector (naive prompt)", scopes: "intent", binding: true, inspector: "model", prompt: "naive", needsModel: true },
  C6: { label: "+ Ensemble (hardened model OR heuristic)", scopes: "intent", binding: true, inspector: "ensemble", prompt: "hardened", needsModel: true },
};

function parseArgs(argv) {
  const args = { configs: Object.keys(CONFIGS), models: ["qwen2.5:3b", "llama3.1:8b", "gemma4:latest"], reps: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    const [key, value] = [argv[i], argv[i + 1]];
    if (key === "--configs") args.configs = value.split(",");
    if (key === "--models") args.models = value.split(",");
    if (key === "--reps") args.reps = Number(value);
  }
  return args;
}

function passportFor(testCase, cfg, config) {
  const intent = INTENTS[testCase.intent];
  const datasets = listDatasets(config);
  const semantic = fallbackSummary(intent.prompt, datasets);
  const scopes = cfg.scopes === "static"
    ? ALL_TOOLS
    : intent.grantedScopes || deriveToolScopes(semantic.intentType);
  const resources = cfg.binding ? semantic.requestedResourceUris : datasets.map((dataset) => dataset.uri);

  return issueIntentPassport({
    prompt: intent.prompt,
    summary: semantic.summary,
    rationale: semantic.rationale,
    intentType: semantic.intentType,
    toolScopes: scopes,
    scopeSource: intent.grantedScopes ? "user_granted" : "derived",
    resources,
    sessionId: `${testCase.id}`,
    config,
  });
}

function rpcFor(testCase) {
  const call = testCase.call;
  if (call.method === "resources/read") {
    return { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: call.uri } };
  }
  return { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: call.name, arguments: call.arguments } };
}

function classify(statusCode, body) {
  if (statusCode === 200 && body?.result) {
    return { outcome: body.result.isError ? "tool_error" : "executed", reason: null };
  }
  const reason = body?.error?.data?.reason || body?.error?.message || `http_${statusCode}`;
  return { outcome: reason === "human_denied" ? "held" : "blocked", reason };
}

async function runCase(stack, cfgName, cfg, testCase) {
  resetDb(stack.config);
  const { token } = passportFor(testCase, cfg, stack.config);
  const started = performance.now();
  const response = await request(stack.proxyUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(rpcFor(testCase)),
  });
  const text = await response.body.text();
  const latencyMs = performance.now() - started;
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { raw: text.slice(0, 200) };
  }
  const { outcome, reason } = classify(response.statusCode, body);
  const inspector = body?.error?.data?.inspector || lastInspector.get(testCase.id) || null;

  return {
    id: testCase.id,
    category: testCase.category,
    label: testCase.label,
    config: cfgName,
    statusCode: response.statusCode,
    outcome,
    reason,
    latencyMs: Number(latencyMs.toFixed(2)),
    inspector,
  };
}

function tryExec(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

async function ollamaVersion(generateUrl) {
  try {
    const response = await request(new URL("/api/version", generateUrl));
    return (await response.body.json()).version;
  } catch {
    return null;
  }
}

async function ollamaModelDigests(generateUrl) {
  try {
    const response = await request(new URL("/api/tags", generateUrl));
    const body = await response.body.json();
    return body.models.map((model) => ({ name: model.name, digest: model.digest, quantization: model.details?.quantization_level }));
  } catch {
    return null;
  }
}

// Inspector verdicts for forwarded calls are not in the response body, so the
// harness listens on the event bus.
const lastInspector = new Map();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(RAW_DIR, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "sfmcp-e1-"));
  const { eventBus } = await import("../src/dashboard/event-bus.js");
  let currentCase = null;
  eventBus.on("event", (event) => {
    if (!currentCase) return;
    if (event.type === "proxy.forwarded" || event.type === "approval.created") {
      lastInspector.set(currentCase, event.payload.inspector);
    }
  });

  const meta = {
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.cpus()[0]?.model} x${os.cpus().length}`,
    cases: CASES.length,
    scenariosSha256: createHash("sha256").update(fs.readFileSync(path.join(import.meta.dirname, "scenarios.js"))).digest("hex"),
    gitHead: tryExec("git rev-parse HEAD"),
    gitDirty: tryExec("git status --porcelain") !== "",
    ollamaUrl: baseConfig.ollamaUrl,
    ollamaVersion: await ollamaVersion(baseConfig.ollamaUrl),
    ollamaModels: await ollamaModelDigests(baseConfig.ollamaUrl),
    args,
  };
  fs.writeFileSync(path.join(RAW_DIR, `e1-meta-${Date.now()}.json`), JSON.stringify(meta, null, 2));

  for (const cfgName of args.configs) {
    const cfg = CONFIGS[cfgName];
    const models = cfg.needsModel ? args.models : ["none"];
    const reps = cfg.needsModel ? args.reps : 1;

    for (const model of models) {
      for (let rep = 1; rep <= reps; rep += 1) {
        const file = path.join(RAW_DIR, `e1-${cfgName}-${model.replace(/[:/]/g, "_")}-rep${rep}.jsonl`);
        if (fs.existsSync(file) && fs.readFileSync(file, "utf8").trim().split("\n").length === CASES.length) {
          console.log(`skip ${path.basename(file)} (complete)`);
          continue;
        }

        const stack = await startStack({
          dbPath: path.join(workDir, "e1.db"),
          inspectorMode: cfg.inspector,
          inspectorPrompt: cfg.prompt || "hardened",
          ollamaModel: model === "none" ? "" : model,
          requireModel: cfg.needsModel, // a model failure must surface, not silently fall back
          modelSeed: rep,
          modelTemperature: 0.1,
        });

        const rows = [];
        const t0 = performance.now();
        for (const testCase of CASES) {
          currentCase = testCase.id;
          lastInspector.delete(testCase.id);
          const row = await runCase(stack, cfgName, cfg, testCase);
          rows.push({ ...row, model, rep });
          process.stdout.write(`${cfgName} ${model} r${rep} ${testCase.id} ${row.outcome}${row.reason ? ` (${row.reason})` : ""}\n`);
        }
        currentCase = null;
        await stack.close();

        fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
        console.log(`wrote ${path.basename(file)} in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

export { baseConfig };
