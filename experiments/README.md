# Experiments

Everything needed to reproduce the evaluation. All scripts are plain Node.js
(no extra dependencies beyond `npm ci`); local models are served by Ollama.

| ID | Script | Question | Needs a model |
|----|--------|----------|---------------|
| E1 | `run-enforcement.js` | How much does each enforcement layer reduce attack success, and what does it cost benign calls? | C4, C6 only |
| E2 | `run-protocol-attacks.js` | Are the protocol-level attacks exploitable in v1.0.0, and does v1.1.0 stop them? | No |
| E3 | `run-summarizer.js` | How accurately is the user prompt turned into intent type and bound resources? | Yes |
| E4 | `run-overhead.js` | Latency added by the proxy without a model | No |
| E5 | `comparators/run_comparators.py` | How do Progent-LLM policies and LlamaFirewall's AlignmentCheck do on the same corpus and models? | Yes |
| E6 | `comparators/build_agentdojo_corpus.py`, `run-agentdojo-inspector.js`, `comparators/run_comparators.py --corpus agentdojo` | Do the results transfer to independent, multi-domain data? (AgentDojo-derived intent/call pairs) | Yes |
| — | `analyze.js` | Aggregates raw results into `results/summary/*.csv` and LaTeX tables in `results/generated/` | No |

## Corpus

`scenarios.js` holds 73 tool-call cases over 9 user intents: 34 benign (28 ordinary,
6 with phrasing that deliberately mentions words the heuristic keys on) and 39
attacks in five categories:

- **A1** scope escalation (8): tool outside the intent's scope
- **A2** resource escalation (7): in-scope tool, unbound resource (including `resources/read`)
- **A3** in-scope semantic misuse (12): the "right intent, malicious action" case, including user-granted broad scopes
- **A4** known-pattern injection (6): A3-style action plus text aimed at the inspector
- **A5** adaptive injection (6): written after the heuristic was frozen, avoiding its patterns

The SHA-256 of `scenarios.js` is recorded in each run's metadata file.

## Configurations (E1)

| Config | Tool scopes | Resource binding | Inspector |
|--------|-------------|------------------|-----------|
| C0 | all tools (static token) | none | off |
| C1 | intent-derived | none | off |
| C2 | intent-derived | yes | off |
| C3 | intent-derived | yes | heuristic |
| C4 | intent-derived | yes | model, naive prompt |
| C5 | intent-derived | yes | model, hardened prompt (derived from C6's logged model verdict) |
| C6 | intent-derived | yes | ensemble: hardened model OR heuristic |

Each case runs through the real proxy, inspector, and MCP SDK server with DPoP;
the database is reset before every case. A call held for approval is denied by
timeout (simulated human); `ASR_rs` additionally reports attack success if the
human rubber-stamped every held call.

## Reproduce

`sh experiments/run-all.sh` runs every step below in order (set `OLLAMA_HOST` to the
model server; completed outputs are skipped on a re-run). The individual steps:

```bash
npm ci
ollama pull qwen2.5:3b && ollama pull llama3.1:8b && ollama pull gemma4:latest

# E1 (layers without a model: ~1 min; model configurations: hours on CPU)
node experiments/run-enforcement.js --configs C0,C1,C2,C3
node experiments/run-enforcement.js --configs C6,C4 --reps 3

# E2: needs a checkout of the original commit for the comparison
git worktree add ../sfmcp-legacy ce51701 && ln -s "$PWD/node_modules" ../sfmcp-legacy/node_modules
node experiments/run-protocol-attacks.js --target legacy --root ../sfmcp-legacy --base-port 5600
node experiments/run-protocol-attacks.js --target fixed  --root .              --base-port 5700

# E3
node experiments/run-summarizer.js --reps 3

# E4 (run on an otherwise idle machine)
node experiments/run-overhead.js --n 300

# E5: prior defenses (Python 3.10+, CPU-only torch for LlamaFirewall)
git clone https://github.com/sunblaze-ucb/progent experiments/comparators/vendor/progent
git -C experiments/comparators/vendor/progent checkout 5be7b63fa96f70bc19b72fbcee81f1c0bcc1a565
python3 -m venv experiments/comparators/.venv
experiments/comparators/.venv/bin/pip install -e experiments/comparators/vendor/progent
experiments/comparators/.venv/bin/pip install torch --index-url https://download.pytorch.org/whl/cpu
experiments/comparators/.venv/bin/pip install llamafirewall==1.0.3
node experiments/export-corpus.js > experiments/results/raw/corpus.json
experiments/comparators/.venv/bin/python -I experiments/comparators/run_comparators.py --systems progent --reps 3
experiments/comparators/.venv/bin/python -I experiments/comparators/run_comparators.py --systems alignmentcheck --reps 1

# E6: AgentDojo-derived corpus (agentdojo 0.1.35, benchmark v1.2.1)
experiments/comparators/.venv/bin/pip install agentdojo==0.1.35
experiments/comparators/.venv/bin/python -I experiments/comparators/build_agentdojo_corpus.py --pairs-per-injection 6 --seed 7
node experiments/run-agentdojo-inspector.js
# E6-S: session-aware variant (history = preceding calls executed in AgentDojo's environment)
experiments/comparators/.venv/bin/python -I experiments/comparators/build_agentdojo_sessions.py
node experiments/run-agentdojo-inspector.js --sessions
experiments/comparators/.venv/bin/python -I experiments/comparators/run_comparators.py --corpus agentdojo-sessions
experiments/comparators/.venv/bin/python -I experiments/comparators/run_comparators.py --corpus agentdojo --systems progent
experiments/comparators/.venv/bin/python -I experiments/comparators/run_comparators.py --corpus agentdojo --systems alignmentcheck

# Tables, CSVs and LaTeX tables
node experiments/analyze.js
```

E1 is resumable: completed `(config, model, rep)` files are skipped.

## Outputs

- `results/raw/` — one JSONL row per case and run, with inspector verdicts; E2 JSON; run metadata (Node version, CPU, git HEAD, scenario hash, Ollama model digests)
- `results/summary/` — aggregated CSVs (`e1-metrics.csv`, `e1-by-category.csv`, `e1-case-matrix.csv`, `e2-protocol.csv`, `e3-summarizer.csv`)
- `results/logs/` — console logs of the reported runs
- `results/generated/` — LaTeX tables, pgfplots data and number macros derived from the summaries

## Notes on the reported run

- Hardware: CPU-only inference (no GPU), 8 cores, 30 GB RAM; Ollama default quantizations.
- Sampling: temperature 0.1, seed = repetition number.
- C4 and C6 were each run with three repetitions per model.
- A stray duplicate process ran for about 30 s at the start of the first Qwen C6 repetition; outcomes are unaffected, but a few latency samples in that repetition may be inflated.
- E5 replaces only the comparators' LLM transport (local Ollama, thinking disabled); their prompts, parsing and decision logic are unchanged. AlignmentCheck receives no agent reasoning (the corpus has none), which handicaps it. Progent's dynamic policy updates are not exercised because there is no execution trace. `resources/read` is not mediated by Progent's MCP proxy (it filters tool calls only). CaMeL restructures the agent and cannot be applied to a fixed-call corpus; it is compared analytically, and an end-to-end agent study is future work. No API models were used.
- E6 pairs each AgentDojo user-task prompt with (a) that task's ground-truth calls (benign) and (b) the ground-truth calls of an injection task from the same suite (attack), sampling 6 user tasks per injection task (seed 7). 339 benign calls from 97 user tasks; 156 attack pairs (282 calls) from 26 injection tasks; 9 injection tasks with text-only goals are excluded. Only the semantic and policy layers are compared: our deterministic layers would need a per-suite tool registry. Attack success is scored on the final (harmful) call of each pair; "any call flagged" is reported as a secondary measure.
- E2 runs each attack 5 times on fresh stacks and reports successes over valid trials; a trial that errors (for example, a component not yet listening) is recorded as invalid, never as prevented.
- E6-S gives every evaluated call the session history a proxy would observe: the preceding ground-truth calls executed in AgentDojo's environment, with results truncated to 800 characters (last 6 steps). For attack pairs, the vectors read by the user task carry AgentDojo's "important_instructions" injection for the injection task's goal, so the injection appears in the history (259 of 282 attack items). Our inspector uses the `hardened-session` prompt; AlignmentCheck receives the full trace (user message, actions, tool results).
- The session prompt rules were written after inspecting the items listed in `results/raw/e6-dev-items.json`; those items (and their attack pairs) are excluded from every E6 and E6-S metric.
- Hardware: all primary model results ran on an RTX 3060 Laptop GPU (6 GB) via Ollama 0.40.6 (`OLLAMA_HOST=<gpu-host>:11434` in the logged runs); `results/cpu-reference/` holds the earlier CPU-only runs (Ollama 0.34.4; older gemma4 build `c6eb396dbd59`). Model digests are recorded in each run's metadata.
- Progent-LLM's policy generation returned unparseable output for 6 of 97 AgentDojo tasks with gemma4 (after Progent's own retries); calls under those tasks are counted as blocked (`policy_generation_failed`).
