// E6 (ours): the SemFW inspector on the AgentDojo-derived corpus.
// Records the rule-based and hardened-model verdicts separately, so both the
// model-only (C5) and ensemble (C6) results come from one pass. Resumable.
//
// Usage: node experiments/run-agentdojo-inspector.js [--models a,b] [--seed 1]
import fs from "node:fs";
import path from "node:path";
import { config as baseConfig } from "../src/runtime/config.js";
import { heuristicDecision, modelDecision } from "../src/inspector/server.js";
import { RAW } from "./lib/paths.js";

const SESSIONS = process.argv.includes("--sessions");
const corpus = JSON.parse(fs.readFileSync(path.join(RAW, "agentdojo-corpus.json"), "utf8"));

function parseArgs(argv) {
  const args = { models: ["qwen2.5:3b", "llama3.1:8b", "gemma4:latest"], seed: 1 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--models") args.models = argv[i + 1].split(",");
    if (argv[i] === "--seed") args.seed = Number(argv[i + 1]);
  }
  return args;
}

// One item per evaluated call. With --sessions, each item also carries the
// session history a proxy would have observed (agentdojo-sessions.json).
const items = SESSIONS
  ? JSON.parse(fs.readFileSync(path.join(RAW, "agentdojo-sessions.json"), "utf8")).items
  : [
  ...corpus.benign.map((b) => ({ id: b.id, label: "benign", suite: b.suite, intent: b.intent, call: b.call, final: true })),
  ...corpus.attacks.flatMap((a) => a.calls.map((call, index) => ({
    id: `${a.id}/${index}`, pair: a.id, label: "attack", suite: a.suite, intent: a.intent, call,
    final: index === a.calls.length - 1,
  }))),
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  for (const model of args.models) {
    const file = path.join(RAW, `${SESSIONS ? "e6s" : "e6"}-semfw-${model.replace(/[:/]/g, "_")}.jsonl`);
    const done = new Set(fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).id)
      : []);
    const config = { ...baseConfig, ollamaModel: model, requireModel: true, modelSeed: args.seed, modelTemperature: 0.1, inspectorPrompt: "hardened" };

    for (const item of items) {
      if (done.has(item.id)) continue;
      const payload = { userIntent: item.intent, intentType: "unknown", resources: [], tool: item.call, history: SESSIONS ? item.history : [] };
      const heuristic = heuristicDecision(payload);
      const started = performance.now();
      let modelVerdict;
      let error = null;
      try {
        modelVerdict = await modelDecision({ config, payload, variant: SESSIONS ? "hardened-session" : "hardened" });
      } catch (caught) {
        error = caught.message;
      }
      const row = {
        system: "semfw", model, id: item.id, pair: item.pair ?? null, label: item.label, suite: item.suite, final: item.final,
        heuristic: { violation: heuristic.violation, confidence: heuristic.confidence, signal: heuristic.signals?.[0] ?? null },
        model_verdict: modelVerdict ? { violation: modelVerdict.violation, confidence: modelVerdict.confidence, reason: modelVerdict.reason } : null,
        error,
        seconds: Number(((performance.now() - started) / 1000).toFixed(2)),
      };
      fs.appendFileSync(file, `${JSON.stringify(row)}\n`);
      console.log(`semfw ${model} ${item.id} model=${modelVerdict?.violation} rules=${heuristic.violation}${error ? ` ERROR ${error}` : ""}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
