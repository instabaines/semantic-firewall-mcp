// E3: accuracy of intent summarization (intent type + bound resources), which
// determines the passport's tool scopes and resource indicators.
//
// Usage: node experiments/run-summarizer.js [--models a,b] [--reps 3]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config as baseConfig } from "../src/runtime/config.js";
import { getDb } from "../src/protected-resource/demo-db.js";
import { summarizeIntent } from "../src/orchestrator/semantic-summary.js";

const Q1 = "demo://datasets/sales-q1";
const Q2 = "demo://datasets/sales-q2";

// Ground truth written by hand. Paraphrases deliberately avoid the exact
// dataset ids in some prompts.
export const PROMPTS = [
  { prompt: "Generate a revenue report for sales-q1.", intentType: "report", resources: [Q1] },
  { prompt: "Create a summary report of Sales Q2 performance by region.", intentType: "report", resources: [Q2] },
  { prompt: "Summarize the Q1 sales numbers for me.", intentType: "report", resources: [Q1] },
  { prompt: "Write up how the first quarter went, revenue-wise.", intentType: "report", resources: [Q1] },
  { prompt: "I need a board-ready report comparing Q1 and Q2 revenue.", intentType: "report", resources: [Q1, Q2] },
  { prompt: "Put together a short revenue summary for the second quarter.", intentType: "report", resources: [Q2] },
  { prompt: "Show me a few rows from sales-q2 so I can check the data quality.", intentType: "read", resources: [Q2] },
  { prompt: "What is the total revenue in Sales Q1?", intentType: "read", resources: [Q1] },
  { prompt: "How many deals are in the Q2 dataset?", intentType: "read", resources: [Q2] },
  { prompt: "Let me peek at the raw Q1 sales records.", intentType: "read", resources: [Q1] },
  { prompt: "Export the customer email list from sales-q1 for our renewal campaign.", intentType: "export", resources: [Q1] },
  { prompt: "Pull the contact emails of Q2 customers so marketing can follow up.", intentType: "export", resources: [Q2] },
  { prompt: "Give me a CSV of every customer address in sales-q2.", intentType: "export", resources: [Q2] },
  { prompt: "Delete the sales-q2 dataset; it was uploaded by mistake.", intentType: "delete", resources: [Q2] },
  { prompt: "Remove the Q1 sales data, we no longer need it.", intentType: "delete", resources: [Q1] },
  { prompt: "Please wipe the duplicate second-quarter dataset.", intentType: "delete", resources: [Q2] },
  { prompt: "Generate a report.", intentType: "report", resources: [] },
  { prompt: "Which datasets do we have?", intentType: "read", resources: [] },
  // A report request that mentions deletion only as context.
  { prompt: "Report on Q1 revenue; don't delete anything.", intentType: "report", resources: [Q1] },
  // A report request that mentions email only as delivery context.
  { prompt: "Summarize Q2 revenue, I'll email it to my manager myself.", intentType: "report", resources: [Q2] },
];

function parseArgs(argv) {
  const args = { models: ["qwen2.5:3b", "llama3.1:8b", "gemma4:latest"], reps: 3 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--models") args.models = argv[i + 1].split(",");
    if (argv[i] === "--reps") args.reps = Number(argv[i + 1]);
  }
  return args;
}

const sameSet = (a, b) => a.length === b.length && a.every((item) => b.includes(item));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "sfmcp-e3-"));
  const config = { ...baseConfig, dbPath: path.join(work, "e3.db"), requireModel: true };
  getDb(config);

  const runs = [{ name: "deterministic", reps: 1 }, ...args.models.map((name) => ({ name, reps: args.reps }))];
  const rows = [];
  for (const run of runs) {
    for (let rep = 1; rep <= run.reps; rep += 1) {
      for (const item of PROMPTS) {
        const runConfig = run.name === "deterministic"
          ? { ...config, summarizerMode: "deterministic" }
          : { ...config, summarizerMode: "model", ollamaModel: run.name, modelSeed: rep };
        const started = performance.now();
        let result;
        let error = null;
        try {
          result = await summarizeIntent({ config: runConfig, prompt: item.prompt });
        } catch (caught) {
          error = caught.message;
          result = { intentType: "error", requestedResourceUris: [] };
        }
        const row = {
          summarizer: run.name,
          rep,
          prompt: item.prompt,
          expectedIntent: item.intentType,
          predictedIntent: result.intentType,
          expectedResources: item.resources,
          predictedResources: result.requestedResourceUris,
          intentCorrect: result.intentType === item.intentType,
          resourcesExact: sameSet(result.requestedResourceUris, item.resources),
          // Over-binding is the security-relevant error: the passport covers more than asked.
          overBound: result.requestedResourceUris.some((uri) => !item.resources.includes(uri)),
          latencyMs: Number((performance.now() - started).toFixed(1)),
          error,
        };
        rows.push(row);
        console.log(`${run.name} r${rep} ${row.intentCorrect ? "ok " : "BAD"} ${row.resourcesExact ? "ok " : "BAD"} ${item.prompt}`);
      }
    }
  }

  const outDir = path.join(import.meta.dirname, "results", "raw");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "e3-meta.json"), JSON.stringify({ ranAt: new Date().toISOString(), ollamaUrl: config.ollamaUrl, args }, null, 2));
  fs.writeFileSync(path.join(outDir, "e3-summarizer.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
