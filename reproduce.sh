#!/usr/bin/env bash
# One command for the whole evaluation: installs and checks every dependency,
# runs the test suite, every experiment and the formal proofs, then the analysis,
# and compares the outcome with the shipped results.
#
#   ./reproduce.sh               full run (needs an Ollama server; see below)
#   ./reproduce.sh --no-models   everything that needs no language model
#   ./reproduce.sh --analyze     only regenerate tables from the shipped raw results
#
# Environment (all optional):
#   OLLAMA_HOST   model server, host:port (default 127.0.0.1:11434). A GPU host
#                 cuts the full run from about a day (CPU) to a few hours.
#   MODELS        comma-separated models (default qwen2.5:3b,llama3.1:8b,gemma4:latest)
#   OUT           results folder (default experiments/results-reproduced/<timestamp>)
#
# Fresh runs never overwrite experiments/results/ (the shipped results).
# Every step is resumable: rerun with the same OUT to continue an interrupted run.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(pwd)

MODE=full
case "${1:-}" in
  "") ;;
  --no-models) MODE=no-models ;;
  --analyze) MODE=analyze ;;
  -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  *) echo "unknown option: $1 (try --help)"; exit 2 ;;
esac

OLLAMA_HOST=${OLLAMA_HOST:-127.0.0.1:11434}
MODELS=${MODELS:-qwen2.5:3b,llama3.1:8b,gemma4:latest}
OUT=${OUT:-$ROOT/experiments/results-reproduced/$(date +%Y%m%d-%H%M%S)}
VENV=$ROOT/experiments/comparators/.venv
TOOLS=$ROOT/formal/.tools
LEGACY=$ROOT/experiments/legacy/v1.0

step() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || die "$1 is required: $2"; }

# ---------------------------------------------------------------- analyze only
if [ "$MODE" = analyze ]; then
  need node "install Node.js 20 or newer"
  [ -d node_modules ] || { step "Installing Node.js dependencies"; npm ci --no-audit --no-fund; }
  step "Regenerating summaries and tables from experiments/results/raw"
  node experiments/analyze.js
  echo; echo "Done. Summaries: experiments/results/summary/  Tables: experiments/results/generated/"
  exit 0
fi

# ---------------------------------------------------------------- prerequisites
step "Checking prerequisites"
need node "install Node.js 20 or newer"
need npm "it ships with Node.js"
need python3 "install Python 3.10 or newer"
need curl "install curl"
need tar "install tar"
node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' || die "Node.js 20 or newer is required (found $(node --version))"
python3 -c 'import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)' || die "Python 3.10 or newer is required"
node -e '
const net = require("node:net");
const ports = [5600, 5601, 5602, 5603, 5700, 5701, 5702, 5703];
Promise.all(ports.map((port) => new Promise((resolve) => {
  const socket = net.connect({ port, host: "127.0.0.1" }, () => { socket.end(); resolve(port); });
  socket.on("error", () => resolve(null));
}))).then((busy) => { busy = busy.filter(Boolean); if (busy.length) { console.error("ports in use: " + busy.join(", ")); process.exit(1); } });
' || die "E2 needs ports 5600-5603 and 5700-5703 to be free"
echo "Node $(node --version), Python $(python3 --version | cut -d' ' -f2); results will go to $OUT"
mkdir -p "$OUT/raw" "$OUT/logs"
export SFMCP_RESULTS="$OUT"

step "Installing Node.js dependencies"
npm ci --no-audit --no-fund >"$OUT/logs/npm.log" 2>&1 || { tail -20 "$OUT/logs/npm.log"; die "npm ci failed"; }

step "Running the test suite"
npm test --silent >"$OUT/logs/tests.log" 2>&1 || { tail -30 "$OUT/logs/tests.log"; die "tests failed"; }
grep -E "Tests +[0-9]+ passed" "$OUT/logs/tests.log" || true

step "Preparing the original implementation (v1.0) for the exploit experiment"
[ -e "$LEGACY/node_modules" ] || ln -s "$ROOT/node_modules" "$LEGACY/node_modules"

step "Installing Tamarin 1.12.0 and Maude 3.5.1 (formal model)"
if [ ! -x "$TOOLS/tamarin-prover" ] || [ ! -x "$TOOLS/maude" ]; then
  [ "$(uname -s)-$(uname -m)" = "Linux-x86_64" ] || die "automatic Tamarin install supports Linux x86_64 only; install tamarin-prover 1.12 and maude 3.5.1 on PATH and rerun"
  mkdir -p "$TOOLS"
  curl -sfL -o "$TOOLS/tamarin.tar.gz" https://github.com/tamarin-prover/tamarin-prover/releases/download/1.12.0/tamarin-prover-1.12.0-linux64-ubuntu.tar.gz
  curl -sfL -o "$TOOLS/maude.zip" https://github.com/maude-lang/Maude/releases/download/Maude3.5.1/Maude-3.5.1-linux-x86_64.zip
  (cd "$TOOLS" && printf '%s  %s\n%s  %s\n' \
    201be06f469e47cff554df6ca93db8366fc2c69d70c61fcbd1370a1074b469c6 tamarin.tar.gz \
    72ed1ca87e3b3d0dfc6ee1436baf154bf04c45ff97d521bec040c5e8dfc8f92c maude.zip | sha256sum -c --quiet) || die "checksum mismatch for the Tamarin or Maude download"
  tar xzf "$TOOLS/tamarin.tar.gz" -C "$TOOLS"
  python3 -c 'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])' "$TOOLS/maude.zip" "$TOOLS"
  chmod +x "$TOOLS/tamarin-prover" "$TOOLS/maude"
fi
PATH="$TOOLS:$PATH" tamarin-prover --version | head -1

if [ "$MODE" = full ]; then
  step "Installing the comparator environment (Progent, LlamaFirewall, AgentDojo)"
  [ -x "$VENV/bin/python" ] || python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip >"$OUT/logs/pip.log" 2>&1
  "$VENV/bin/pip" install -q -r experiments/comparators/requirements-lock.txt >>"$OUT/logs/pip.log" 2>&1 \
    || { tail -20 "$OUT/logs/pip.log"; die "installing the comparator environment failed (see $OUT/logs/pip.log)"; }

  step "Checking the model server at $OLLAMA_HOST"
  curl -sf "http://$OLLAMA_HOST/api/version" >/dev/null || die "no Ollama server at $OLLAMA_HOST (install from https://ollama.com, or set OLLAMA_HOST)"
  for model in $(echo "$MODELS" | tr ',' ' '); do
    if ! curl -sf "http://$OLLAMA_HOST/api/tags" | grep -q "\"name\":\"$model\""; then
      echo "pulling $model (this can take a while)"
      curl -sf "http://$OLLAMA_HOST/api/pull" -d "{\"model\":\"$model\",\"stream\":false}" >/dev/null || die "could not pull $model"
    fi
  done
  # Digests used for the shipped results; a different digest still runs, with a warning.
  curl -sf "http://$OLLAMA_HOST/api/tags" | python3 -c '
import json, sys
expected = {"qwen2.5:3b": "357c53fb659c", "llama3.1:8b": "46e0c10c039e", "gemma4:latest": "dc35e8d9c606"}
tags = {m["name"]: m["digest"][:12] for m in json.load(sys.stdin)["models"]}
for name, digest in expected.items():
    got = tags.get(name)
    if got and got != digest:
        print(f"WARNING: {name} is {got}; the shipped results used {digest}. Outcomes may differ slightly.")
    elif got:
        print(f"{name}: {got} (matches the shipped results)")
'
  export OLLAMA_HOST OLLAMA_BASE="http://$OLLAMA_HOST"
fi

run() { name=$1; shift; printf '  %s ... ' "$name"; if "$@" >>"$OUT/logs/$name.log" 2>&1; then echo ok; else echo "FAILED (see $OUT/logs/$name.log)"; exit 1; fi; }
PY=("$VENV/bin/python" -I)

# ---------------------------------------------------------------- experiments
step "E1: enforcement layers without a model (C0-C3)"
run e1-deterministic node experiments/run-enforcement.js --configs C0,C1,C2,C3

step "E2: protocol exploits, five trials each, against v1.0 and v1.1"
run e2-legacy node experiments/run-protocol-attacks.js --target legacy --root "$LEGACY" --base-port 5600
run e2-fixed node experiments/run-protocol-attacks.js --target fixed --root "$ROOT" --base-port 5700

step "E4: proxy overhead"
run e4 node experiments/run-overhead.js --n 300

step "Formal model: all variants (about 25 minutes)"
run formal env PATH="$TOOLS:$PATH" python3 formal/run.py

if [ "$MODE" = full ]; then
  step "E1: model inspectors (C4, C6; 3 runs each)"
  run e1-models node experiments/run-enforcement.js --configs C6,C4 --reps 3 --models "$MODELS"

  step "E3: intent derivation"
  run e3 node experiments/run-summarizer.js --reps 3 --models "$MODELS"

  step "E5: Progent and AlignmentCheck on our corpus"
  node experiments/export-corpus.js > "$OUT/raw/corpus.json"
  run e5-progent "${PY[@]}" experiments/comparators/run_comparators.py --systems progent --reps 3 --models "$MODELS"
  run e5-alignmentcheck "${PY[@]}" experiments/comparators/run_comparators.py --systems alignmentcheck --reps 1 --models "$MODELS"

  step "E6: AgentDojo-derived calls, judged alone and with session history"
  run e6-corpus "${PY[@]}" experiments/comparators/build_agentdojo_corpus.py --pairs-per-injection 6 --seed 7
  run e6-sessions-corpus "${PY[@]}" experiments/comparators/build_agentdojo_sessions.py
  run e6-ours node experiments/run-agentdojo-inspector.js --models "$MODELS"
  run e6s-ours node experiments/run-agentdojo-inspector.js --sessions --models "$MODELS"
  run e6-comparators "${PY[@]}" experiments/comparators/run_comparators.py --corpus agentdojo --systems progent,alignmentcheck --models "$MODELS"
  run e6s-alignmentcheck "${PY[@]}" experiments/comparators/run_comparators.py --corpus agentdojo-sessions --models "$MODELS"
  run provenance python3 -I experiments/provenance-analysis.py
  run e6p-provenance node experiments/run-provenance.js --taint rules,oracle,model --models "$MODELS"
fi

# ---------------------------------------------------------------- analysis
step "Analysis"
run analyze node experiments/analyze.js
step "Comparison with the shipped results"
node experiments/compare-results.js "$OUT" | tee "$OUT/comparison.txt"

printf '\nDone.\n  results:    %s\n  summaries:  %s/summary/\n  comparison: %s/comparison.txt\n' "$OUT" "$OUT" "$OUT"
