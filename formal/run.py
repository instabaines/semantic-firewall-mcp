"""Builds each model variant (#ifdef/#ifndef/#else/#endif) and proves it with Tamarin.

Usage: python3 formal/run.py            (expects tamarin-prover and maude on PATH,
                                          or in formal/.tools/)
Writes formal/build/<variant>.spthy, formal/build/<variant>.log and formal/results.json.
"""

import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
MODEL = HERE / "semantic_firewall.spthy"
BUILD = HERE / "build"

# name -> (flags, expectation per lemma: True = should verify)
VARIANTS = {
    "v1.1": ([], None),
    "v1.1+body-binding": (["BODY_BINDING"], None),
    "legacy-issuance": (["LEGACY_ISSUANCE"], None),
    "legacy-approval": (["LEGACY_APPROVAL"], None),
    "no-replay-cache": (["NO_REPLAY_CACHE"], None),
    "no-server-recheck": (["NO_SERVER_RECHECK"], None),
    "v1.0 (all legacy)": (["LEGACY_ISSUANCE", "LEGACY_APPROVAL", "NO_REPLAY_CACHE", "NO_SERVER_RECHECK"], None),
}


def preprocess(text, flags):
    out, stack = [], []  # stack of (parent_active, this_branch_active)
    active = True
    for line in text.splitlines():
        stripped = line.strip()
        match = re.match(r"#(ifdef|ifndef)\s+(\w+)", stripped)
        if match:
            cond = (match.group(2) in flags) == (match.group(1) == "ifdef")
            stack.append((active, cond))
            active = active and cond
            continue
        if stripped == "#else":
            parent, cond = stack[-1]
            stack[-1] = (parent, not cond)
            active = parent and not cond
            continue
        if stripped == "#endif":
            parent, _ = stack.pop()
            active = parent
            continue
        if active:
            out.append(line)
    if stack:
        raise SystemExit("unbalanced #ifdef")
    return "\n".join(out) + "\n"


LEMMAS = ["executable_low", "executable_high", "P1_authentic_intent", "P23_confinement",
          "P5_sender_constraint", "P5_no_replay", "replay_witness", "P7_consent_integrity"]


def run(name, flags, timeout):
    """Proves each lemma in its own process, so one non-terminating lemma
    cannot block the others; it is recorded as a timeout instead."""
    BUILD.mkdir(exist_ok=True)
    slug = re.sub(r"[^a-z0-9.+-]+", "-", name.lower()).strip("-")
    source = BUILD / f"{slug}.spthy"
    source.write_text(preprocess(MODEL.read_text(), set(flags)))
    env = dict(os.environ)
    env["PATH"] = f"{HERE / '.tools'}:{env.get('PATH', '')}"
    started = time.time()
    results, logs = {}, []
    for lemma in LEMMAS:
        t0 = time.time()
        try:
            proc = subprocess.run(["tamarin-prover", f"--prove={lemma}", str(source)],
                                  capture_output=True, text=True, env=env, timeout=timeout)
            log = proc.stdout + proc.stderr
            match = re.search(rf"^\s+{lemma} \((all-traces|exists-trace)\): (verified|falsified - found trace|falsified - no trace found|analysis incomplete)[^\n]*?\((\d+) steps\)", log, re.M)
            if match:
                results[lemma] = {"type": match.group(1), "result": match.group(2).split(" ")[0], "detail": match.group(2),
                                  "steps": int(match.group(3)), "seconds": round(time.time() - t0, 1)}
            else:
                results[lemma] = {"result": "error", "seconds": round(time.time() - t0, 1)}
                print(log[-1500:], file=sys.stderr)
        except subprocess.TimeoutExpired:
            log = f"timeout after {timeout} s"
            results[lemma] = {"result": "timeout", "seconds": timeout}
        logs.append(f"===== {lemma}\n{log}")
    (BUILD / f"{slug}.log").write_text("\n".join(logs))
    return {"flags": flags, "seconds": round(time.time() - started, 1), "lemmas": results}


def main():
    timeout = int(os.environ.get("TAMARIN_TIMEOUT", "600"))
    only = sys.argv[1:]
    out = {}
    results_file = HERE / "results.json"
    if results_file.exists():
        out = json.loads(results_file.read_text())
    for name, (flags, _) in VARIANTS.items():
        if only and name not in only:
            continue
        out[name] = run(name, flags, timeout)
        print(name, json.dumps(out[name]["lemmas"]), f"{out[name]['seconds']} s", flush=True)
        results_file.write_text(json.dumps(out, indent=2))
    version = subprocess.run(["tamarin-prover", "--version"], capture_output=True, text=True,
                             env={**os.environ, "PATH": f"{HERE / '.tools'}:{os.environ.get('PATH', '')}"}).stdout.splitlines()[:1]
    out["_meta"] = {"tamarin": version, "model": MODEL.name}
    results_file.write_text(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
