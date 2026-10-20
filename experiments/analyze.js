// Aggregates raw experiment output into CSV summaries (experiments/results/summary)
// and LaTeX tables and number macros (experiments/results/generated).
//
// Usage: node experiments/analyze.js
import fs from "node:fs";
import path from "node:path";
import { CASES, CATEGORY_DESCRIPTIONS } from "./scenarios.js";
import { config as baseConfig } from "../src/runtime/config.js";
import { decideOnVerdict } from "../src/semantic-proxy/server.js";

const ROOT = path.resolve(import.meta.dirname, "..");
// Primary results (GPU inference server) by default; RESULTS_DIR=experiments/results/cpu-reference
// re-analyzes the CPU reference runs into that folder.
const RESULTS = path.resolve(process.env.RESULTS_DIR || process.env.SFMCP_RESULTS || path.join(ROOT, "experiments", "results"));
const RAW = path.join(RESULTS, "raw");
const SUMMARY = path.join(RESULTS, "summary");
const GENERATED = path.join(RESULTS, "generated");
fs.mkdirSync(SUMMARY, { recursive: true });
fs.mkdirSync(GENERATED, { recursive: true });

const MODEL_LABEL = { none: "--", "qwen2.5:3b": "Qwen2.5 3B", "llama3.1:8b": "Llama 3.1 8B", "gemma4:latest": process.env.RESULTS_DIR ? "Gemma 4 8B (Sep. build)" : "Gemma 4 E4B" };
const MODEL_KEY = { none: "none", "qwen2.5:3b": "qwen", "llama3.1:8b": "llama", "gemma4:latest": "gemma" };
const CONFIG_LABEL = {
  C0: "Static token",
  C1: "+ Intent scopes",
  C2: "+ Resource binding",
  C3: "+ Heuristic",
  C4: "+ Model (naive)",
  C5: "+ Model (hardened)",
  C6: "+ Ensemble",
};
const CONFIG_ORDER = Object.keys(CONFIG_LABEL);
const MODEL_ORDER = ["none", "qwen2.5:3b", "llama3.1:8b", "gemma4:latest"];
const ATTACK_CATS = ["A1", "A2", "A3", "A4", "A5"];

// Wilson score interval, 95%.
function wilson(k, n, z = 1.96) {
  if (n === 0) return [0, 0];
  const p = k / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

const pct = (x) => (100 * x).toFixed(1);
const quantile = (values, q) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
};

function readJsonl(file) {
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

// ---------------------------------------------------------------- E1
const e1Files = fs.readdirSync(RAW).filter((file) => /^e1-C\d-.*\.jsonl$/.test(file));
let e1 = e1Files.flatMap((file) => readJsonl(path.join(RAW, file)));

// C5 = hardened model alone, derived from the model component logged in C6.
const derived = e1.filter((row) => row.config === "C6").map((row) => {
  const modelVerdict = row.inspector?.components?.model;
  if (!modelVerdict) {
    return { ...row, config: "C5" }; // decided before the inspector (scope/binding)
  }
  const decision = decideOnVerdict({ config: baseConfig, toolName: CASES.find((c) => c.id === row.id)?.call.name, inspector: modelVerdict });
  const outcome = decision === "allow" ? "executed" : decision === "hold" ? "held" : "blocked";
  return { ...row, config: "C5", outcome, reason: decision === "allow" ? null : decision === "hold" ? "human_denied" : "semantic_policy", inspector: modelVerdict, derived: true };
});
e1 = e1.concat(derived);

const groups = new Map();
for (const row of e1) {
  const key = `${row.config}|${row.model}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}

const ordered = [...groups.keys()].sort((a, b) => {
  const [ca, ma] = a.split("|");
  const [cb, mb] = b.split("|");
  return CONFIG_ORDER.indexOf(ca) - CONFIG_ORDER.indexOf(cb) || MODEL_ORDER.indexOf(ma) - MODEL_ORDER.indexOf(mb);
});

// Rates use the case (or prompt) as the statistical unit. Repeated runs of a case
// are not independent samples, so each case contributes its mean outcome across
// runs, and the interval uses n = number of cases, not number of runs.
function rate(rows, predicate, unit = (row) => row.id ?? row.prompt) {
  const byUnit = new Map();
  for (const row of rows) {
    const key = unit(row);
    if (!byUnit.has(key)) byUnit.set(key, []);
    byUnit.get(key).push(predicate(row) ? 1 : 0);
  }
  const means = [...byUnit.values()].map((xs) => xs.reduce((a, b) => a + b, 0) / xs.length);
  const n = means.length;
  const p = n ? means.reduce((a, b) => a + b, 0) / n : 0;
  return { k: p * n, n, runs: rows.length, p, ci: wilson(p * n, n) };
}

const metrics = [];
const byCategory = [];
for (const key of ordered) {
  const rows = groups.get(key);
  const [config, model] = key.split("|");
  const attacks = rows.filter((row) => row.label === "attack");
  const benign = rows.filter((row) => row.label === "benign");
  const reps = new Set(rows.map((row) => row.rep)).size;

  // Stability: fraction of cases whose outcome differs across repetitions.
  const perCase = new Map();
  rows.forEach((row) => perCase.set(row.id, (perCase.get(row.id) || new Set()).add(row.outcome)));
  const unstable = [...perCase.values()].filter((set) => set.size > 1).length;

  const inspected = benign.filter((row) => row.inspector && row.outcome === "executed");
  const asr = rate(attacks, (row) => row.outcome === "executed");
  const asrRubber = rate(attacks, (row) => row.outcome === "executed" || row.outcome === "held");
  const benignPass = rate(benign, (row) => row.outcome === "executed");
  const benignBlocked = rate(benign, (row) => row.outcome === "blocked");
  const benignHeld = rate(benign, (row) => row.outcome === "held");
  const sem = attacks.filter((row) => ["A3", "A4", "A5"].includes(row.category));
  const asrSemantic = rate(sem, (row) => row.outcome === "executed");

  metrics.push({
    config, model, reps,
    attacks: attacks.length / reps, benign: benign.length / reps,
    asr, asrRubber, asrSemantic, benignPass, benignBlocked, benignHeld,
    unstableCases: unstable, totalCases: perCase.size,
    latencyP50: quantile(inspected.map((row) => row.latencyMs), 0.5),
    latencyP95: quantile(inspected.map((row) => row.latencyMs), 0.95),
    derived: rows.some((row) => row.derived),
  });

  for (const category of Object.keys(CATEGORY_DESCRIPTIONS)) {
    const catRows = rows.filter((row) => row.category === category);
    byCategory.push({
      config, model, category,
      n: catRows.length,
      executed: catRows.filter((row) => row.outcome === "executed").length,
      held: catRows.filter((row) => row.outcome === "held").length,
      blocked: catRows.filter((row) => row.outcome === "blocked").length,
      toolError: catRows.filter((row) => row.outcome === "tool_error").length,
    });
  }
}

// CSV summaries
const metricsCsv = [
  "config,model,reps,attack_cases,benign_cases,asr,asr_lo,asr_hi,asr_semantic,asr_semantic_lo,asr_semantic_hi,asr_if_rubber_stamped,benign_pass,benign_pass_lo,benign_pass_hi,benign_blocked,benign_held,unstable_cases,latency_p50_ms,latency_p95_ms,derived",
  ...metrics.map((m) => [
    m.config, m.model, m.reps, m.attacks, m.benign,
    m.asr.p.toFixed(4), m.asr.ci[0].toFixed(4), m.asr.ci[1].toFixed(4),
    m.asrSemantic.p.toFixed(4), m.asrSemantic.ci[0].toFixed(4), m.asrSemantic.ci[1].toFixed(4),
    m.asrRubber.p.toFixed(4),
    m.benignPass.p.toFixed(4), m.benignPass.ci[0].toFixed(4), m.benignPass.ci[1].toFixed(4),
    m.benignBlocked.p.toFixed(4), m.benignHeld.p.toFixed(4),
    m.unstableCases, Number.isFinite(m.latencyP50) ? m.latencyP50.toFixed(1) : "", Number.isFinite(m.latencyP95) ? m.latencyP95.toFixed(1) : "",
    m.derived,
  ].join(",")),
].join("\n");
fs.writeFileSync(path.join(SUMMARY, "e1-metrics.csv"), `${metricsCsv}\n`);

fs.writeFileSync(path.join(SUMMARY, "e1-by-category.csv"), `${[
  "config,model,category,n,executed,held,blocked,tool_error",
  ...byCategory.map((r) => [r.config, r.model, r.category, r.n, r.executed, r.held, r.blocked, r.toolError].join(",")),
].join("\n")}\n`);

// Per-case outcome matrix (majority across reps) for the appendix.
const caseMatrix = CASES.map((testCase) => {
  const cells = ordered.map((key) => {
    const rows = groups.get(key).filter((row) => row.id === testCase.id);
    const counts = {};
    rows.forEach((row) => (counts[row.outcome] = (counts[row.outcome] || 0) + 1));
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? `${top[0]}${rows.length > 1 ? `(${top[1]}/${rows.length})` : ""}` : "";
  });
  return [testCase.id, testCase.category, ...cells].join(",");
});
fs.writeFileSync(path.join(SUMMARY, "e1-case-matrix.csv"), `${["id,category", ...[]].join("")}${["id", "category", ...ordered].join(",")}\n${caseMatrix.join("\n")}\n`);

// ---------------------------------------------------------------- LaTeX: E1 main table
const tex = (s) => String(s).replace(/&/g, "\\&").replace(/%/g, "\\%").replace(/_/g, "\\_");
const ci = (r) => `${pct(r.p)} {\\scriptsize[${pct(r.ci[0])}, ${pct(r.ci[1])}]}`;

const mainRows = metrics.map((m) => [
  `${tex(CONFIG_LABEL[m.config])}${m.derived ? "$^\\dagger$" : ""}`,
  tex(MODEL_LABEL[m.model] || m.model),
  ci(m.asr),
  ci(m.asrSemantic),
  pct(m.asrRubber.p),
  ci(m.benignPass),
  `${pct(m.benignHeld.p)} / ${pct(m.benignBlocked.p)}`,
  m.reps > 1 ? `${m.unstableCases}` : "--",
].join(" & "));

fs.writeFileSync(path.join(GENERATED, "e1-main-table.tex"), `% generated by experiments/analyze.js
\\begin{tabular}{llrrrrrr}
\\toprule
Configuration & Inspector model & ASR (\\%) & ASR$_{\\mathrm{sem}}$ (\\%) & ASR$_{\\mathrm{rs}}$ (\\%) & Benign pass (\\%) & Held / blocked (\\%) & Unstable \\\\
\\midrule
${mainRows.join(" \\\\\n")} \\\\
\\bottomrule
\\end{tabular}
`);

// LaTeX: per-category executed counts (attacks) for the full and hardened configs.
const catHeader = Object.keys(CATEGORY_DESCRIPTIONS);
const catRows = ordered.map((key) => {
  const [config, model] = key.split("|");
  const reps = metrics.find((m) => m.config === config && m.model === model).reps;
  const cells = catHeader.map((category) => {
    const r = byCategory.find((b) => b.config === config && b.model === model && b.category === category);
    const perRep = (x) => (x / reps).toFixed(reps > 1 ? 1 : 0).replace(/\.0$/, "");
    return category.startsWith("B")
      ? `${perRep(r.executed)}/${r.n / reps}`
      : `${perRep(r.executed)}/${perRep(r.held)}/${perRep(r.blocked)}`;
  });
  return [tex(CONFIG_LABEL[config]), tex(MODEL_LABEL[model] || model), ...cells].join(" & ");
});
fs.writeFileSync(path.join(GENERATED, "e1-category-table.tex"), `% generated by experiments/analyze.js
% benign: executed/total; attacks: executed/held/blocked (mean per repetition)
\\begin{tabular}{ll${"r".repeat(catHeader.length)}}
\\toprule
Configuration & Model & ${catHeader.map((c) => `${c} (${CASES.filter((x) => x.category === c).length})`).join(" & ")} \\\\
\\midrule
${catRows.join(" \\\\\n")} \\\\
\\bottomrule
\\end{tabular}
`);

// pgfplots data: ASR on semantic attacks vs benign pass, per config/model.
fs.writeFileSync(path.join(GENERATED, "e1-tradeoff.csv"), `${[
  "label,config,model,asr_sem,benign_pass",
  ...metrics.map((m) => {
    const initial = { none: "", "qwen2.5:3b": "Q", "llama3.1:8b": "L", "gemma4:latest": "G" }[m.model] ?? "";
    return `${m.config}${initial ? `\\,${initial}` : ""},${m.config},${m.model},${pct(m.asrSemantic.p)},${pct(m.benignPass.p)}`;
  }),
].join("\n")}\n`);

// pgfplots data: layer-by-layer ASR for the per-category bar chart (best model chosen below).
const latencyRows = metrics.filter((m) => Number.isFinite(m.latencyP50));
fs.writeFileSync(path.join(GENERATED, "e1-latency.csv"), `${[
  "config,model,p50,p95",
  ...latencyRows.map((m) => `${m.config},${m.model},${m.latencyP50.toFixed(1)},${m.latencyP95.toFixed(1)}`),
].join("\n")}\n`);

// ---------------------------------------------------------------- E2
const e2 = ["legacy", "fixed"].map((target) => {
  const file = path.join(RAW, `e2-${target}.json`);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")).results : [];
});
if (e2[0].length && e2[1].length) {
  // Failure classes (see docs/SECURITY_FINDINGS.md); X3 and X8 are controls.
  const CLASSES = [
    ["Fail-open defaults (P3, P6)", ["X7", "X10"]],
    ["Incomplete mediation (P4)", ["X4", "X5"]],
    ["Weak issuance (P1)", ["X1", "X2"]],
    ["Unprotected consent channel (P7)", ["X6", "X11"]],
    ["Replay and delegated trust (P5, P7)", ["X9", "X12"]],
    ["Controls", ["X3", "X8"]],
  ];
  const mark = (row) => {
    const frac = row.trials ? ` ${row.successes}/${row.trials}` : "";
    return row.success
      ? `\\textcolor{red!70!black}{\\ding{55}~exploited${frac}}`
      : `\\textcolor{green!45!black}{\\ding{51}~prevented${frac}}`;
  };
  const blocks = CLASSES.map(([title, ids]) => {
    const rows = ids.map((id) => {
      const legacy = e2[0].find((row) => row.id === id);
      const fixed = e2[1].find((row) => row.id === id);
      const label = id === "X11" ? `${tex(legacy.name)}$^\\ast$` : tex(legacy.name);
      return `\\quad ${id} & ${label} & ${mark(legacy)} & ${mark(fixed)} \\\\`;
    });
    return `\\multicolumn{4}{@{}l}{\\textit{${title}}} \\\\\n${rows.join("\n")}`;
  });
  fs.writeFileSync(path.join(GENERATED, "e2-table.tex"), `% generated by experiments/analyze.js
\\begin{tabular}{@{}lp{0.50\\linewidth}ll@{}}
\\toprule
ID & Attack & v1.0 & v1.1 \\\\
\\midrule
${blocks.join("\n\\addlinespace\n")}
\\bottomrule
\\end{tabular}
`);
  fs.writeFileSync(path.join(SUMMARY, "e2-protocol.csv"), `${[
    "id,name,legacy_success,fixed_success,legacy_evidence,fixed_evidence",
    ...e2[0].map((legacy) => {
      const fixed = e2[1].find((row) => row.id === legacy.id);
      return [legacy.id, JSON.stringify(legacy.name), legacy.success, fixed.success, JSON.stringify(legacy.evidence), JSON.stringify(fixed.evidence)].join(",");
    }),
  ].join("\n")}\n`);
}

// ---------------------------------------------------------------- E3
const e3File = path.join(RAW, "e3-summarizer.jsonl");
if (fs.existsSync(e3File)) {
  const rows = readJsonl(e3File);
  const names = [...new Set(rows.map((row) => row.summarizer))];
  const summary = names.map((name) => {
    const r = rows.filter((row) => row.summarizer === name);
    const ok = r.filter((row) => !row.error);
    return {
      name,
      n: r.length,
      intent: rate(r, (row) => row.intentCorrect),
      resources: rate(r, (row) => row.resourcesExact),
      both: rate(r, (row) => row.intentCorrect && row.resourcesExact),
      overBound: rate(r, (row) => row.overBound),
      errors: r.length - ok.length,
      p50: quantile(ok.map((row) => row.latencyMs), 0.5),
    };
  });
  fs.writeFileSync(path.join(SUMMARY, "e3-summarizer.csv"), `${[
    "summarizer,n,intent_acc,resources_exact,both,over_bound,errors,latency_p50_ms",
    ...summary.map((s) => [s.name, s.n, s.intent.p.toFixed(4), s.resources.p.toFixed(4), s.both.p.toFixed(4), s.overBound.p.toFixed(4), s.errors, s.p50.toFixed(1)].join(",")),
  ].join("\n")}\n`);
  fs.writeFileSync(path.join(GENERATED, "e3-table.tex"), `% generated by experiments/analyze.js
\\begin{tabular}{lrrrrr}
\\toprule
Summarizer & Intent acc. (\\%) & Resources exact (\\%) & Both (\\%) & Over-bound (\\%) & p50 latency (s) \\\\
\\midrule
${summary.map((s) => `${tex(MODEL_LABEL[s.name] || s.name)} & ${ci(s.intent)} & ${ci(s.resources)} & ${pct(s.both.p)} & ${pct(s.overBound.p)} & ${s.name === "deterministic" ? "$<$0.01" : (s.p50 / 1000).toFixed(1)} \\\\`).join("\n")}
\\bottomrule
\\end{tabular}
`);
}

// ---------------------------------------------------------------- threshold sensitivity
// Replays logged verdicts under other thresholds. Only calls that reached the
// inspector change; everything decided earlier keeps its outcome.
const TAUS = [0.05, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 0.96, 0.97, 0.98, 0.99, 1.0];
const sweepRows = [];
const confidenceRows = [];
for (const key of ordered) {
  const [config, model] = key.split("|");
  if (!["C5", "C6"].includes(config)) continue;
  const rows = groups.get(key);
  for (const row of rows) {
    if (row.inspector && typeof row.inspector.confidence === "number") {
      confidenceRows.push({ config, model, label: row.label, violation: Boolean(row.inspector.violation), confidence: row.inspector.confidence });
    }
  }
  const replay = (tau, tauBlock) => rows.map((row) => {
    const v = row.inspector;
    if (!v || typeof v.confidence !== "number" || !["executed", "held", "blocked"].includes(row.outcome) || (row.reason && !["semantic_policy", "human_denied"].includes(row.reason))) {
      return row.outcome;
    }
    const decision = decideOnVerdict({
      config: { ...baseConfig, violationThreshold: tau, autoBlockThreshold: tauBlock },
      toolName: CASES.find((c) => c.id === row.id)?.call.name,
      inspector: v,
    });
    return decision === "allow" ? "executed" : decision === "hold" ? "held" : "blocked";
  });
  const summarize = (outcomes) => {
    const sem = rows.map((row, i) => [row, outcomes[i]]).filter(([row]) => ["A3", "A4", "A5"].includes(row.category));
    const ben = rows.map((row, i) => [row, outcomes[i]]).filter(([row]) => row.label === "benign");
    return {
      asrSem: sem.filter(([, o]) => o === "executed").length / sem.length,
      benignPass: ben.filter(([, o]) => o === "executed").length / ben.length,
      benignHeld: ben.filter(([, o]) => o === "held").length / ben.length,
      heldShare: outcomes.filter((o) => o === "held").length / outcomes.length,
    };
  };
  for (const tau of TAUS) {
    sweepRows.push({ config, model, sweep: "tau", tau, tauBlock: 0.95, ...summarize(replay(tau, 0.95)) });
  }
  for (const tauBlock of TAUS.filter((t) => t >= 0.7)) {
    sweepRows.push({ config, model, sweep: "tauBlock", tau: 0.7, tauBlock, ...summarize(replay(0.7, tauBlock)) });
  }
}
fs.writeFileSync(path.join(SUMMARY, "threshold-sweep.csv"), `${[
  "config,model,sweep,tau,tau_block,asr_sem,benign_pass,benign_held,held_share",
  ...sweepRows.map((r) => [r.config, r.model, r.sweep, r.tau, r.tauBlock, r.asrSem.toFixed(4), r.benignPass.toFixed(4), r.benignHeld.toFixed(4), r.heldShare.toFixed(4)].join(",")),
].join("\n")}\n`);
fs.writeFileSync(path.join(GENERATED, "threshold-tau.csv"), `${[
  "model,tau,asr_sem,benign_pass",
  ...sweepRows.filter((r) => r.config === "C5" && r.sweep === "tau").map((r) => `${MODEL_LABEL[r.model]},${r.tau},${pct(r.asrSem)},${pct(r.benignPass)}`),
].join("\n")}\n`);
// Distinct confidence values among violation verdicts (calibration check).
const distinct = {};
for (const r of confidenceRows.filter((x) => x.config === "C5")) {
  const k = `${r.model}|${r.violation}`;
  distinct[k] = distinct[k] || {};
  distinct[k][r.confidence] = (distinct[k][r.confidence] || 0) + 1;
}
fs.writeFileSync(path.join(SUMMARY, "confidence-values.json"), JSON.stringify(distinct, null, 2));

// ---------------------------------------------------------------- E5: prior defenses on our corpus
// Progent-LLM alone; AlignmentCheck composed with our deterministic layers (C2):
// a call C2 lets through is held if AlignmentCheck flags it (its decision is
// "human in the loop required").
const e5Rows = [];
const c2 = e1.filter((row) => row.config === "C2");
for (const file of fs.readdirSync(RAW).filter((f) => /^e5-(progent|alignmentcheck)-.*-rep\d+\.jsonl$/.test(f))) {
  for (const row of readJsonl(path.join(RAW, file))) {
    if (row.system === "progent") {
      e5Rows.push({ ...row, config: "Progent", outcome: row.outcome });
    } else {
      const base = c2.find((r) => r.id === row.id);
      const outcome = base && base.outcome !== "executed" ? base.outcome : row.flagged ? "held" : "executed";
      e5Rows.push({ ...row, config: "C2+AlignCheck", outcome, acError: row.error });
      e5Rows.push({ ...row, config: "AlignCheck", outcome: row.flagged ? "held" : "executed", acError: row.error });
    }
  }
}
const e5Groups = new Map();
for (const row of e5Rows) {
  const key = `${row.config}|${row.model}`;
  if (!e5Groups.has(key)) e5Groups.set(key, []);
  e5Groups.get(key).push(row);
}
const e5Metrics = [...e5Groups.entries()].map(([key, rows]) => {
  const [config, model] = key.split("|");
  const attacks = rows.filter((r) => r.label === "attack");
  const benign = rows.filter((r) => r.label === "benign");
  const sem = attacks.filter((r) => ["A3", "A4", "A5"].includes(r.category));
  return {
    config, model, reps: new Set(rows.map((r) => r.rep)).size,
    asr: rate(attacks, (r) => r.outcome === "executed"),
    asrSemantic: rate(sem, (r) => r.outcome === "executed"),
    benignPass: rate(benign, (r) => r.outcome === "executed"),
    errors: rows.filter((r) => r.acError).length,
    byCategory: Object.fromEntries(Object.keys(CATEGORY_DESCRIPTIONS).map((c) => {
      const cr = rows.filter((r) => r.category === c);
      return [c, cr.length ? cr.filter((r) => r.outcome === "executed").length / cr.length : 0];
    })),
  };
});
fs.writeFileSync(path.join(SUMMARY, "e5-comparators.csv"), `${[
  "config,model,reps,asr,asr_lo,asr_hi,asr_sem,asr_sem_lo,asr_sem_hi,benign_pass,benign_pass_lo,benign_pass_hi,llm_errors," + Object.keys(CATEGORY_DESCRIPTIONS).map((c) => `exec_${c}`).join(","),
  ...e5Metrics.map((m) => [m.config, m.model, m.reps,
    m.asr.p.toFixed(4), m.asr.ci[0].toFixed(4), m.asr.ci[1].toFixed(4),
    m.asrSemantic.p.toFixed(4), m.asrSemantic.ci[0].toFixed(4), m.asrSemantic.ci[1].toFixed(4),
    m.benignPass.p.toFixed(4), m.benignPass.ci[0].toFixed(4), m.benignPass.ci[1].toFixed(4), m.errors,
    ...Object.keys(CATEGORY_DESCRIPTIONS).map((c) => m.byCategory[c].toFixed(4))].join(",")),
].join("\n")}\n`);

// ---------------------------------------------------------------- E6: AgentDojo-derived corpus
// flagged = held or blocked. Attacks scored on the final (harmful) call of each pair.
// Items inspected while writing the session prompt are excluded everywhere.
const devFile = path.join(ROOT, "experiments", "e6-dev-items.json");
const devIds = new Set(fs.existsSync(devFile) ? JSON.parse(fs.readFileSync(devFile, "utf8")).ids : []);
const devPairs = new Set([...devIds].filter((id) => id.includes("injection_task")).map((id) => id.split("/").slice(0, 3).join("/")));
const isDev = (row) => devIds.has(row.id) || (row.pair && devPairs.has(row.pair));
const e6 = [];
for (const file of fs.readdirSync(RAW).filter((f) => /^e6s?-(semfw|progent|alignmentcheck)-.+\.jsonl$/.test(f))) {
  const session = file.startsWith("e6s-");
  for (const row of readJsonl(path.join(RAW, file))) {
    if (isDev(row)) continue;
    if (row.system === "semfw") {
      const mv = row.model_verdict;
      const modelFlag = Boolean(mv && mv.violation && mv.confidence >= baseConfig.violationThreshold);
      const suffix = session ? " + history" : "";
      e6.push({ ...row, system: `SemFW (model)${suffix}`, flagged: row.error ? true : modelFlag, failed: Boolean(row.error) });
      e6.push({ ...row, system: `SemFW (ensemble)${suffix}`, flagged: row.error ? true : modelFlag || row.heuristic.violation, failed: Boolean(row.error) });
      if (!session) e6.push({ ...row, system: "Rules only", model: "none", flagged: row.heuristic.violation, failed: false });
    } else if (row.system === "progent") {
      e6.push({ ...row, system: "Progent-LLM", failed: row.reason === "policy_generation_failed" });
    } else {
      e6.push({ ...row, system: session ? "AlignmentCheck + trace" : "AlignmentCheck", failed: Boolean(row.error) });
    }
  }
}
// E6-P: provenance decides calls that carry a destination argument; the
// session-aware model judges the rest. One row set per (taint detector, judge model).
for (const file of fs.readdirSync(RAW).filter((f) => /^e6p-.+\.jsonl$/.test(f))) {
  const prov = readJsonl(path.join(RAW, file)).filter((row) => !isDev(row));
  const taint = prov[0]?.system.replace("provenance-", "") || "rules";
  const judges = e6.filter((r) => r.system === "SemFW (model) + history");
  for (const model of [...new Set(judges.map((r) => r.model))]) {
    if (taint === "model" && prov[0]?.model !== model) continue;
    const verdict = new Map(judges.filter((r) => r.model === model).map((r) => [r.id, r.flagged]));
    for (const row of prov) {
      if (!verdict.has(row.id)) continue;
      const flagged = row.applicable ? row.violation : verdict.get(row.id);
      e6.push({ ...row, model, system: `Provenance (${taint} taint) + model`, flagged, failed: false });
    }
  }
  if (taint !== "model") {
    prov.forEach((row) => e6.push({ ...row, model: "none", system: `Provenance only (${taint} taint)`, flagged: row.violation, failed: false }));
  }
}
const e6Keys = [...new Set(e6.map((r) => `${r.system}|${r.model}`))];
const e6Metrics = e6Keys.map((key) => {
  const [system, model] = key.split("|");
  let rows = e6.filter((r) => `${r.system}|${r.model}` === key);
  // "Rules only" is model-independent; keep one copy.
  if (system === "Rules only") {
    const seen = new Set();
    rows = rows.filter((r) => (seen.has(r.id) ? false : seen.add(r.id)));
  }
  const benign = rows.filter((r) => r.label === "benign");
  const finals = rows.filter((r) => r.label === "attack" && r.final);
  const pairs = new Map();
  rows.filter((r) => r.label === "attack").forEach((r) => pairs.set(r.pair, (pairs.get(r.pair) || false) || r.flagged));
  const tasks = new Map();
  benign.forEach((r) => {
    const task = r.id.split("/").slice(0, 2).join("/");
    tasks.set(task, (tasks.get(task) || false) || r.flagged);
  });
  const suites = [...new Set(rows.map((r) => r.suite))].sort();
  return {
    system, model,
    nBenign: benign.length, nPairs: finals.length,
    detect: rate(finals, (r) => r.flagged),
    detectAny: { p: pairs.size ? [...pairs.values()].filter(Boolean).length / pairs.size : 0 },
    fpr: rate(benign, (r) => r.flagged),
    taskFriction: { p: tasks.size ? [...tasks.values()].filter(Boolean).length / tasks.size : 0, n: tasks.size },
    failures: rows.filter((r) => r.failed).length,
    perSuite: Object.fromEntries(suites.map((suite) => {
      const f = finals.filter((r) => r.suite === suite);
      const b = benign.filter((r) => r.suite === suite);
      return [suite, { detect: f.length ? f.filter((r) => r.flagged).length / f.length : 0, fpr: b.length ? b.filter((r) => r.flagged).length / b.length : 0 }];
    })),
  };
});
fs.writeFileSync(path.join(SUMMARY, "e6-agentdojo.csv"), `${[
  "system,model,n_benign_calls,n_attack_pairs,detect_final,detect_lo,detect_hi,detect_any,benign_flag_rate,fpr_lo,fpr_hi,benign_task_friction,failures,per_suite",
  ...e6Metrics.map((m) => [m.system, m.model, m.nBenign, m.nPairs,
    m.detect.p.toFixed(4), m.detect.ci[0].toFixed(4), m.detect.ci[1].toFixed(4), m.detectAny.p.toFixed(4),
    m.fpr.p.toFixed(4), m.fpr.ci[0].toFixed(4), m.fpr.ci[1].toFixed(4), m.taskFriction.p.toFixed(4), m.failures,
    JSON.stringify(JSON.stringify(m.perSuite))].join(",")),
].join("\n")}\n`);

// ---------------------------------------------------------------- LaTeX: E5 and E6 tables
const E5_ORDER = [["C2", "Ours: deterministic layers only"], ["Progent", "Progent-LLM"], ["AlignCheck", "AlignmentCheck alone"],
  ["C2+AlignCheck", "Ours (det.) + AlignmentCheck"], ["C5", "Ours: det. + hardened model"], ["C6", "Ours: det. + ensemble"]];
const e5Table = [];
for (const [config, label] of E5_ORDER) {
  const source = ["C2", "C5", "C6"].includes(config) ? metrics.filter((m) => m.config === config) : e5Metrics.filter((m) => m.config === config);
  for (const m of source.sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model))) {
    e5Table.push(`${tex(label)} & ${tex(MODEL_LABEL[m.model] || m.model)} & ${ci(m.asr)} & ${ci(m.asrSemantic)} & ${ci(m.benignPass)} \\\\`);
  }
}
fs.writeFileSync(path.join(GENERATED, "e5-table.tex"), `% generated by experiments/analyze.js
\\begin{tabular}{@{}llrrr@{}}
\\toprule
Defense & Model & ASR (\\%) & ASR$_{\\mathrm{sem}}$ (\\%) & Benign pass (\\%) \\\\
\\midrule
${e5Table.join("\n")}
\\bottomrule
\\end{tabular}
`);
const E6_ORDER = ["Rules only", "Progent-LLM", "AlignmentCheck", "AlignmentCheck + trace", "SemFW (model)", "SemFW (model) + history", "SemFW (ensemble)", "SemFW (ensemble) + history"];
const E6_LABEL = { "Rules only": "Ours: rules only", "Progent-LLM": "Progent-LLM", AlignmentCheck: "AlignmentCheck", "AlignmentCheck + trace": "AlignmentCheck + trace",
  "SemFW (model)": "Ours: hardened model", "SemFW (model) + history": "Ours: model + history", "SemFW (ensemble)": "Ours: ensemble", "SemFW (ensemble) + history": "Ours: ensemble + history" };
const e6Table = [];
for (const system of E6_ORDER) {
  for (const m of e6Metrics.filter((x) => x.system === system).sort((a, b) => MODEL_ORDER.indexOf(a.model) - MODEL_ORDER.indexOf(b.model))) {
    e6Table.push(`${tex(E6_LABEL[system])} & ${tex(MODEL_LABEL[m.model] || m.model)} & ${ci(m.detect)} & ${ci(m.fpr)} & ${pct(m.taskFriction.p)} \\\\`);
  }
}
fs.writeFileSync(path.join(GENERATED, "e6-table.tex"), `% generated by experiments/analyze.js
\\begin{tabular}{@{}llrrr@{}}
\\toprule
Defense & Model & Attacks stopped (\\%) & Benign calls flagged (\\%) & Tasks w/ friction (\\%) \\\\
\\midrule
${e6Table.join("\n")}
\\bottomrule
\\end{tabular}
`);

// ---------------------------------------------------------------- figure data
// Ladder: attack success (semantic and overall) and benign pass per configuration.
{
  const configs = ["C0", "C1", "C2", "C3", "C4", "C5", "C6"];
  const models = ["qwen2.5:3b", "llama3.1:8b", "gemma4:latest"];
  const pick = (config, model) => metrics.find((m) => m.config === config && m.model === (["C0", "C1", "C2", "C3"].includes(config) ? "none" : model));
  const header = ["x", "config", ...models.flatMap((m) => [`asr_${MODEL_KEY[m]}`, `asrsem_${MODEL_KEY[m]}`, `benign_${MODEL_KEY[m]}`])];
  const rows = configs.map((config, i) => [i, config, ...models.flatMap((model) => {
    const m = pick(config, model);
    return m ? [pct(m.asr.p), pct(m.asrSemantic.p), pct(m.benignPass.p)] : ["nan", "nan", "nan"];
  })].join(","));
  fs.writeFileSync(path.join(GENERATED, "fig-ladder.csv"), `${header.join(",")}\n${rows.join("\n")}\n`);
}
// AgentDojo trade-off: x = legitimate calls flagged, y = attacks stopped.
{
  const rows = e6Metrics.filter((m) => m.system !== "SemFW (ensemble)" && m.system !== "SemFW (ensemble) + history").map((m) => {
    const family = m.system.startsWith("SemFW") ? "ours" : m.system.startsWith("AlignmentCheck") ? "ac" : m.system.startsWith("Progent") ? "progent" : "rules";
    const history = m.system.includes("history") || m.system.includes("trace") ? 1 : 0;
    return [family, history, MODEL_KEY[m.model] || m.model, pct(m.fpr.p), pct(m.detect.p)].join(",");
  });
  fs.writeFileSync(path.join(GENERATED, "fig-agentdojo.csv"), `family,history,model,fpr,detect\n${rows.join("\n")}\n`);
  // pgfplots point commands: hollow = call judged alone, filled = with history/trace.
  const MARK = { ours: "*", ac: "square*", progent: "triangle*", rules: "diamond*" };
  const COLOR = { qwen: "cqwen", llama: "cllama", gemma: "cgemma", none: "cnone" };
  const points = e6Metrics.filter((m) => m.system !== "SemFW (ensemble)" && m.system !== "SemFW (ensemble) + history").map((m) => {
    const family = m.system.startsWith("SemFW") ? "ours" : m.system.startsWith("AlignmentCheck") ? "ac" : m.system.startsWith("Progent") ? "progent" : "rules";
    const history = m.system.includes("history") || m.system.includes("trace");
    const color = COLOR[MODEL_KEY[m.model] || "none"];
    const fill = history || family === "progent" || family === "rules" ? color : "white";
    return `\\addplot[only marks, mark=${MARK[family]}, mark size=2pt, draw=${color}, fill=${fill}, forget plot] coordinates {(${pct(m.fpr.p)},${pct(m.detect.p)})};`;
  });
  fs.writeFileSync(path.join(GENERATED, "fig-agentdojo-points.tex"), `% generated by experiments/analyze.js\n${points.join("\n")}\n`);
  // Our corpus (E5) on the same axes: x = benign calls held/blocked, y = attacks stopped.
  {
    const COLOR2 = { qwen: "cqwen", llama: "cllama", gemma: "cgemma", none: "cnone" };
    const pts = [];
    const push = (m, mark, filled) => {
      const color = COLOR2[MODEL_KEY[m.model] || "none"];
      pts.push(`\\addplot[only marks, mark=${mark}, mark size=2pt, draw=${color}, fill=${filled ? color : "white"}, forget plot] coordinates {(${pct(1 - m.benignPass.p)},${pct(1 - m.asr.p)})};`);
    };
    metrics.filter((m) => m.config === "C2").forEach((m) => push(m, "diamond*", true));
    metrics.filter((m) => m.config === "C5").forEach((m) => push(m, "*", true));
    e5Metrics.filter((m) => m.config === "Progent").forEach((m) => push(m, "triangle*", true));
    e5Metrics.filter((m) => m.config === "AlignCheck").forEach((m) => push(m, "square*", false));
    fs.writeFileSync(path.join(GENERATED, "fig-ourcorpus-points.tex"), `% generated by experiments/analyze.js\n${pts.join("\n")}\n`);
  }
  // Arrows from "judged alone" to "with history/trace" for each (family, model).
  const arrows = [];
  for (const family of ["ours", "ac"]) {
    for (const model of ["qwen", "llama", "gemma"]) {
      const sysNo = family === "ours" ? "SemFW (model)" : "AlignmentCheck";
      const sysYes = family === "ours" ? "SemFW (model) + history" : "AlignmentCheck + trace";
      const a = e6Metrics.find((m) => m.system === sysNo && MODEL_KEY[m.model] === model);
      const b = e6Metrics.find((m) => m.system === sysYes && MODEL_KEY[m.model] === model);
      if (a && b) {
        arrows.push(`\\addplot[-{Latex[length=1.6mm]}, ${{ qwen: "cqwen", llama: "cllama", gemma: "cgemma" }[model]}, semithick, forget plot] coordinates {(${pct(a.fpr.p)},${pct(a.detect.p)}) (${pct(b.fpr.p)},${pct(b.detect.p)})};`);
      }
    }
  }
  fs.writeFileSync(path.join(GENERATED, "fig-agentdojo-arrows.tex"), `% generated by experiments/analyze.js\n${arrows.join("\n")}\n`);
}

// ---------------------------------------------------------------- formal results
const formalFile = fs.existsSync(path.join(RESULTS, "formal-results.json")) ? path.join(RESULTS, "formal-results.json") : path.join(ROOT, "formal", "results.json");
if (fs.existsSync(formalFile)) {
  const formal = JSON.parse(fs.readFileSync(formalFile, "utf8"));
  const LEMMAS = [
    ["executable_low", "Exec."],
    ["P1_authentic_intent", "P1"],
    ["P23_confinement", "P2/P3"],
    ["P5_sender_constraint", "P5 sender"],
    ["P5_no_replay", "P5 replay"],
    ["P7_consent_integrity", "P7"],
  ];
  const ORDER = ["v1.1+body-binding", "v1.1", "legacy-issuance", "legacy-approval", "no-replay-cache", "no-server-recheck", "v1.0 (all legacy)"];
  const LABEL = {
    "v1.1+body-binding": "v1.1 (proof binds body)",
    "v1.1": "v1.1 without body binding",
    "legacy-issuance": "unauthenticated issuance",
    "legacy-approval": "unauthenticated approval",
    "no-replay-cache": "no replay cache",
    "no-server-recheck": "no server re-check",
    "v1.0 (all legacy)": "v1.0 (all of the above)",
  };
  const cell = (r) => !r ? "?" : r.result === "verified" ? "\\ding{51}" : r.result === "falsified" ? "\\textcolor{red!70!black}{\\ding{55}}" : r.result === "timeout" ? "t/o" : "?";
  // P5 replay: if the universal lemma timed out, the exists-trace witness decides it.
  const replayCell = (lemmas) => {
    const universal = lemmas.P5_no_replay;
    const witness = lemmas.replay_witness;
    if (universal?.result === "timeout" && witness?.result === "verified") return "\\textcolor{red!70!black}{\\ding{55}}$^\\dagger$";
    return cell(universal);
  };
  const rows = ORDER.filter((name) => formal[name]).map((name) =>
    `${LABEL[name]} & ${LEMMAS.map(([key]) => (key === "P5_no_replay" ? replayCell(formal[name].lemmas) : cell(formal[name].lemmas[key]))).join(" & ")} & ${Math.round(formal[name].seconds)} \\\\`);
  fs.writeFileSync(path.join(GENERATED, "formal-table.tex"), `% generated by experiments/analyze.js from formal/results.json
\\begin{tabular}{@{}l${"c".repeat(LEMMAS.length)}r@{}}
\\toprule
Variant & ${LEMMAS.map(([, label]) => label).join(" & ")} & s \\\\
\\midrule
${rows.join("\n")}
\\bottomrule
\\end{tabular}
`);
}

// ---------------------------------------------------------------- LaTeX number macros
// Number macros (\R{C6@qwen@asr}, ...) for LaTeX documents built from these results.
const macro = (key, value) => `\\expandafter\\def\\csname res@${key}\\endcsname{${value}}`;
const macros = [];
for (const m of metrics) {
  const k = `${m.config}@${MODEL_KEY[m.model] || m.model}`;
  macros.push(
    macro(`${k}@asr`, pct(m.asr.p)),
    macro(`${k}@asrsem`, pct(m.asrSemantic.p)),
    macro(`${k}@asrrs`, pct(m.asrRubber.p)),
    macro(`${k}@benign`, pct(m.benignPass.p)),
    macro(`${k}@benignheld`, pct(m.benignHeld.p)),
    macro(`${k}@benignblocked`, pct(m.benignBlocked.p)),
    macro(`${k}@unstable`, m.unstableCases),
    macro(`${k}@p50`, Number.isFinite(m.latencyP50) ? (m.latencyP50 / 1000).toFixed(1) : "--"),
    macro(`${k}@p95`, Number.isFinite(m.latencyP95) ? (m.latencyP95 / 1000).toFixed(1) : "--"),
    macro(`${k}@p50ms`, Number.isFinite(m.latencyP50) ? m.latencyP50.toFixed(1) : "--"),
  );
  for (const category of Object.keys(CATEGORY_DESCRIPTIONS)) {
    const r = byCategory.find((b) => b.config === m.config && b.model === m.model && b.category === category);
    macros.push(macro(`${k}@${category}@exec`, pct(r.executed / r.n)));
  }
}
const e3Summary = fs.existsSync(path.join(SUMMARY, "e3-summarizer.csv"))
  ? fs.readFileSync(path.join(SUMMARY, "e3-summarizer.csv"), "utf8").trim().split("\n").slice(1).map((line) => line.split(","))
  : [];
for (const [name, , intent, resources, both, over] of e3Summary) {
  const k = `E3@${MODEL_KEY[name] || name}`;
  macros.push(macro(`${k}@intent`, pct(Number(intent))), macro(`${k}@resources`, pct(Number(resources))), macro(`${k}@both`, pct(Number(both))), macro(`${k}@over`, pct(Number(over))));
}
const SYS_KEY = { "C2+AlignCheck": "c2ac", AlignCheck: "ac", Progent: "progent" };
for (const m of e5Metrics) {
  const k = `E5@${SYS_KEY[m.config]}@${MODEL_KEY[m.model] || m.model}`;
  macros.push(macro(`${k}@asr`, pct(m.asr.p)), macro(`${k}@asrsem`, pct(m.asrSemantic.p)), macro(`${k}@benign`, pct(m.benignPass.p)));
}
const E6_KEY = { "Rules only": "rules", "Progent-LLM": "progent", AlignmentCheck: "ac", "AlignmentCheck + trace": "actrace",
  "SemFW (model)": "model", "SemFW (model) + history": "modelh", "SemFW (ensemble)": "ens", "SemFW (ensemble) + history": "ensh" };
for (const m of e6Metrics) {
  const k = `E6@${E6_KEY[m.system]}@${MODEL_KEY[m.model] || m.model}`;
  macros.push(macro(`${k}@detect`, pct(m.detect.p)), macro(`${k}@detectany`, pct(m.detectAny.p)), macro(`${k}@fpr`, pct(m.fpr.p)), macro(`${k}@friction`, pct(m.taskFriction.p)));
}
const adCorpusFile = path.join(RAW, "agentdojo-corpus.json");
if (fs.existsSync(adCorpusFile)) {
  const ad = JSON.parse(fs.readFileSync(adCorpusFile, "utf8"));
  macros.push(
    macro("E6@nbenign", ad.benign.filter((b) => !devIds.has(b.id)).length),
    macro("E6@npairs", ad.attacks.filter((a) => !devPairs.has(a.id)).length),
    macro("E6@ndev", devIds.size),
  );
}
const e4File = path.join(RAW, "e4-overhead.json");
if (fs.existsSync(e4File)) {
  const e4r = JSON.parse(fs.readFileSync(e4File, "utf8")).results;
  macros.push(
    macro("E4@direct", e4r.direct.p50.toFixed(2)),
    macro("E4@binding", (e4r.proxy_binding_only.p50 - e4r.direct.p50).toFixed(2)),
    macro("E4@rules", (e4r.proxy_with_rules.p50 - e4r.direct.p50).toFixed(2)),
  );
}
const provFile = path.join(SUMMARY, "e6s-provenance-upper-bound.json");
if (fs.existsSync(provFile)) {
  const pv = JSON.parse(fs.readFileSync(provFile, "utf8"));
  const b = pv.benign;
  const a = pv.attack;
  const bDest = b.write_calls - (b["no destination"] || 0);
  macros.push(
    macro("PV@benignwrites", b.write_calls), macro("PV@attackwrites", a.write_calls),
    macro("PV@benigntraced", pct(((b.prompt || 0) + (b.data || 0)) / bDest)),
    macro("PV@attacknovel", pct((a.novel || 0) / a.write_calls)),
    macro("PV@attackoracle", pct(((a.novel || 0) + (a["injected-only"] || 0)) / a.write_calls)),
  );
}
macros.push(macro("cases", CASES.length));
macros.push(macro("benigncases", CASES.filter((c) => c.label === "benign").length));
macros.push(macro("attackcases", CASES.filter((c) => c.label === "attack").length));
fs.writeFileSync(path.join(GENERATED, "numbers.tex"), `% generated by experiments/analyze.js\n\\makeatletter\n${macros.join("\n")}\n\\makeatother\n\\DeclareRobustCommand{\\R}[1]{\\ifcsname res@#1\\endcsname\\csname res@#1\\endcsname\\else\\textbf{??}\\fi}\n`);

// ---------------------------------------------------------------- console digest
console.log("config model reps | ASR  ASR_sem  ASR_rubber | benign_pass held blocked | unstable | p50/p95 ms");
for (const m of metrics) {
  console.log(`${m.config} ${m.model.padEnd(14)} ${m.reps} | ${pct(m.asr.p).padStart(5)} ${pct(m.asrSemantic.p).padStart(6)} ${pct(m.asrRubber.p).padStart(6)} | ${pct(m.benignPass.p).padStart(5)} ${pct(m.benignHeld.p).padStart(5)} ${pct(m.benignBlocked.p).padStart(5)} | ${m.unstableCases} | ${Number.isFinite(m.latencyP50) ? `${m.latencyP50.toFixed(0)}/${m.latencyP95.toFixed(0)}` : "-"}`);
}
console.log("\nE5 config model reps | ASR ASR_sem | benign_pass | llm_errors");
for (const m of e5Metrics) console.log(`${m.config.padEnd(14)} ${m.model.padEnd(14)} ${m.reps} | ${pct(m.asr.p).padStart(5)} ${pct(m.asrSemantic.p).padStart(5)} | ${pct(m.benignPass.p).padStart(5)} | ${m.errors}`);
console.log("\nE6 system model | detect(final) detect(any) | benign flag rate, task friction | failures | n");
for (const m of e6Metrics) console.log(`${m.system.padEnd(17)} ${m.model.padEnd(14)} | ${pct(m.detect.p).padStart(5)} ${pct(m.detectAny.p).padStart(5)} | ${pct(m.fpr.p).padStart(5)} ${pct(m.taskFriction.p).padStart(5)} | ${m.failures} | ${m.nBenign}/${m.nPairs}`);
