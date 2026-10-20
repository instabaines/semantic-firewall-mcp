// Compares a reproduced results folder with the shipped results, metric by metric.
// Usage: node experiments/compare-results.js <reproduced-results-dir> [shipped-dir]
import fs from "node:fs";
import path from "node:path";

const reproduced = path.resolve(process.argv[2] || "");
const shipped = path.resolve(process.argv[3] || path.join(import.meta.dirname, "results"));
if (!process.argv[2]) {
  console.error("usage: node experiments/compare-results.js <reproduced-results-dir> [shipped-dir]");
  process.exit(2);
}

function readCsv(file) {
  if (!fs.existsSync(file)) return null;
  const [header, ...lines] = fs.readFileSync(file, "utf8").trim().split("\n");
  const keys = header.split(",");
  return lines.map((line) => Object.fromEntries(line.split(",").map((value, i) => [keys[i], value])));
}

function compare(title, file, idKeys, metrics) {
  const a = readCsv(path.join(shipped, "summary", file));
  const b = readCsv(path.join(reproduced, "summary", file));
  console.log(`\n${title} (${file})`);
  if (!a || !b) {
    console.log(`  missing in ${!a ? "shipped" : "reproduced"} results`);
    return;
  }
  const id = (row) => idKeys.map((k) => row[k]).join(" / ");
  let maxDiff = 0;
  let matched = 0;
  for (const row of b) {
    const ref = a.find((r) => id(r) === id(row));
    if (!ref) continue;
    matched += 1;
    const cells = metrics.map((m) => {
      const x = 100 * Number(ref[m]);
      const y = 100 * Number(row[m]);
      maxDiff = Math.max(maxDiff, Math.abs(x - y));
      return `${m} ${x.toFixed(1)} -> ${y.toFixed(1)}`;
    });
    console.log(`  ${id(row).padEnd(32)} ${cells.join("   ")}`);
  }
  console.log(matched ? `  largest difference: ${maxDiff.toFixed(1)} percentage points` : "  not run in this reproduction");
}

compare("E1 layer ablation", "e1-metrics.csv", ["config", "model"], ["asr", "asr_semantic", "benign_pass"]);
compare("E3 intent derivation", "e3-summarizer.csv", ["summarizer"], ["intent_acc", "resources_exact"]);
compare("E5 prior defenses", "e5-comparators.csv", ["config", "model"], ["asr", "asr_sem", "benign_pass"]);
compare("E6 AgentDojo transfer", "e6-agentdojo.csv", ["system", "model"], ["detect_final", "benign_flag_rate"]);
console.log("\nE2 protocol exploits");

for (const target of ["legacy", "fixed"]) {
  const file = (dir) => path.join(dir, "raw", `e2-${target}.json`);
  if (fs.existsSync(file(shipped)) && fs.existsSync(file(reproduced))) {
    const a = JSON.parse(fs.readFileSync(file(shipped), "utf8")).results;
    const b = JSON.parse(fs.readFileSync(file(reproduced), "utf8")).results;
    const same = b.every((row) => a.find((r) => r.id === row.id)?.success === row.success);
    console.log(`  E2 ${target}: ${same ? "same exploit outcomes as shipped" : "OUTCOMES DIFFER from shipped"}`);
  }
}
