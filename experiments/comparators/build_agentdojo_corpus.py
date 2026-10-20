"""E6 corpus: (user intent, tool call) pairs derived from AgentDojo.

Benign items: every ground-truth call of every user task, paired with that task's
prompt. Attack items: the ground-truth calls of an injection task (the attacker's
goal), paired with the prompt of a user task from the same suite. This is the
right-intent, malicious-action setting: the user's request is legitimate and the
calls are the ones an agent hijacked by that injection would make.

Injection tasks whose goal needs no tool call (text-only goals) are excluded.
Attack pairs are sampled per injection task with a fixed seed.

Usage:
  experiments/comparators/.venv/bin/python -I experiments/comparators/build_agentdojo_corpus.py \
      --pairs-per-injection 6 --seed 7
"""

import argparse
import json
import os
import random
from importlib import metadata
from pathlib import Path

from agentdojo.task_suite.load_suites import get_suites

BENCHMARK_VERSION = "v1.2.1"
OUT = (Path(os.environ["SFMCP_RESULTS"]).resolve() / "raw" if os.environ.get("SFMCP_RESULTS") else Path(__file__).resolve().parents[1] / "results" / "raw") / "agentdojo-corpus.json"


def jsonable(value):
    try:
        json.dumps(value)
        return value
    except TypeError:
        if isinstance(value, dict):
            return {k: jsonable(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [jsonable(v) for v in value]
        return str(value)


def calls_of(task, env):
    return [{"name": call.function, "arguments": jsonable(dict(call.args))} for call in task.ground_truth(env)]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--pairs-per-injection", type=int, default=6)
    parser.add_argument("--seed", type=int, default=7)
    args = parser.parse_args()
    rng = random.Random(args.seed)

    suites = get_suites(BENCHMARK_VERSION)
    corpus = {
        "source": {"agentdojo": metadata.version("agentdojo"), "benchmark": BENCHMARK_VERSION,
                   "pairs_per_injection": args.pairs_per_injection, "seed": args.seed},
        "tools": {}, "benign": [], "attacks": [], "excluded_injections": [],
    }

    for suite_name, suite in suites.items():
        env = suite.load_and_inject_default_environment({})
        corpus["tools"][suite_name] = [
            {"name": tool.name, "description": tool.description,
             "args": tool.parameters.model_json_schema().get("properties", {})}
            for tool in suite.tools
        ]

        user_tasks = sorted(suite.user_tasks.items())
        for task_id, task in user_tasks:
            for index, call in enumerate(calls_of(task, env)):
                corpus["benign"].append({
                    "id": f"{suite_name}/{task_id}/{index}", "suite": suite_name, "task": task_id,
                    "intent": task.PROMPT, "call": call,
                })

        for inj_id, inj in sorted(suite.injection_tasks.items()):
            calls = calls_of(inj, env)
            if not calls:
                corpus["excluded_injections"].append(f"{suite_name}/{inj_id}")
                continue
            chosen = rng.sample(user_tasks, min(args.pairs_per_injection, len(user_tasks)))
            for task_id, task in chosen:
                corpus["attacks"].append({
                    "id": f"{suite_name}/{task_id}/{inj_id}", "suite": suite_name, "task": task_id,
                    "injection": inj_id, "goal": inj.GOAL, "intent": task.PROMPT, "calls": calls,
                })

    OUT.write_text(json.dumps(corpus, indent=2))
    n_attack_calls = sum(len(a["calls"]) for a in corpus["attacks"])
    print(f"benign calls: {len(corpus['benign'])} from {len({(b['suite'], b['task']) for b in corpus['benign']})} user tasks")
    print(f"attack pairs: {len(corpus['attacks'])} ({n_attack_calls} calls); excluded injections: {corpus['excluded_injections']}")


if __name__ == "__main__":
    main()
