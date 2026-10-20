// Writes the scenario corpus as JSON for the Python comparator harness.
// Usage: node experiments/export-corpus.js > "$SFMCP_RESULTS/raw/corpus.json"
import { CASES, INTENTS } from "./scenarios.js";

process.stdout.write(`${JSON.stringify({ intents: INTENTS, cases: CASES }, null, 2)}\n`);
