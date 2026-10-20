#!/bin/sh
# Runs the full evaluation in order. Model-backed steps use the Ollama server at
# OLLAMA_HOST (default 127.0.0.1:11434); point it at a GPU host to speed them up.
# Every step is resumable: completed outputs are skipped on a re-run.
#
#   OLLAMA_HOST=<gpu-host>:11434 sh experiments/run-all.sh
#
# Prerequisites: see experiments/README.md (npm ci, the Python venv for the
# comparators, the AgentDojo corpus, a checkout of the original commit for E2).
set -e
cd "$(dirname "$0")/.."
export OLLAMA_HOST="${OLLAMA_HOST:-127.0.0.1:11434}"
export OLLAMA_BASE="http://${OLLAMA_HOST}"
MODELS="${MODELS:-qwen2.5:3b,llama3.1:8b,gemma4:latest}"
PY=experiments/comparators/.venv/bin/python
LEGACY_ROOT="${LEGACY_ROOT:-../sfmcp-legacy}"

echo "E1: layer ablation (deterministic layers, then model inspectors)"
node experiments/run-enforcement.js --configs C0,C1,C2,C3
node experiments/run-enforcement.js --configs C6,C4 --reps 3 --models "$MODELS"

echo "E2: protocol exploits against the original and the hardened implementation"
if [ -d "$LEGACY_ROOT" ]; then
  node experiments/run-protocol-attacks.js --target legacy --root "$LEGACY_ROOT" --base-port 5600
fi
node experiments/run-protocol-attacks.js --target fixed --root . --base-port 5700

echo "E3: intent summarization accuracy"
node experiments/run-summarizer.js --reps 3 --models "$MODELS"

echo "E4: proxy overhead (run on an otherwise idle machine)"
node experiments/run-overhead.js --n 300

echo "E5: prior defenses on our corpus"
node experiments/export-corpus.js > experiments/results/raw/corpus.json
$PY -I experiments/comparators/run_comparators.py --systems progent --reps 3 --models "$MODELS"
$PY -I experiments/comparators/run_comparators.py --systems alignmentcheck --reps 1 --models "$MODELS"

echo "E6: AgentDojo-derived calls, per call and with session history"
$PY -I experiments/comparators/build_agentdojo_corpus.py --pairs-per-injection 6 --seed 7
$PY -I experiments/comparators/build_agentdojo_sessions.py
node experiments/run-agentdojo-inspector.js --models "$MODELS"
node experiments/run-agentdojo-inspector.js --sessions --models "$MODELS"
$PY -I experiments/comparators/run_comparators.py --corpus agentdojo --systems progent,alignmentcheck --models "$MODELS"
$PY -I experiments/comparators/run_comparators.py --corpus agentdojo-sessions --models "$MODELS"
python3 -I experiments/provenance-analysis.py

echo "Formal model"
python3 formal/run.py

echo "Analysis"
node experiments/analyze.js
