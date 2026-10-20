"""E6-S: session-aware version of the AgentDojo-derived corpus.

Every evaluated call carries the session history a proxy would have seen before
it: the preceding calls and their real results, obtained by executing them in
AgentDojo's environment.

  Benign: the user task's ground-truth calls, executed in the default environment.
  Attack: the user task's ground-truth calls executed in an environment where the
          vectors this task reads carry AgentDojo's "important instructions"
          injection for the injection task's goal, followed by the injection
          task's calls. The injection text therefore appears in the history, as
          it would in a real hijacked session.

Uses the same items (ids, intents, calls) as agentdojo-corpus.json.

Usage:
  experiments/comparators/.venv/bin/python -I experiments/comparators/build_agentdojo_sessions.py
"""

import json
from pathlib import Path

from agentdojo.attacks.important_instructions_attacks import ImportantInstructionsAttack
from agentdojo.functions_runtime import FunctionsRuntime
from agentdojo.task_suite.load_suites import get_suites

RAW = Path(__file__).resolve().parents[1] / "results" / "raw"
MAX_RESULT_CHARS = 800
MAX_HISTORY = 6


class _NamedPipeline:
    """The attack template names the target model; no model is run."""
    name = "gpt-4o-2024-05-13"


def result_text(result, error):
    text = error if error else (result if isinstance(result, str) else json.dumps(result, default=str))
    return text if len(text) <= MAX_RESULT_CHARS else text[:MAX_RESULT_CHARS] + " ...[truncated]"


def execute(runtime, env, calls):
    """Runs calls in order against env; returns history entries."""
    history = []
    for call in calls:
        result, error = runtime.run_function(env, call["name"], call["arguments"])
        history.append({"tool": call["name"], "arguments": call["arguments"], "result": result_text(result, error)})
    return history


def main():
    corpus = json.loads((RAW / "agentdojo-corpus.json").read_text())
    suites = get_suites(corpus["source"]["benchmark"])
    out = {"source": {**corpus["source"], "max_result_chars": MAX_RESULT_CHARS, "max_history": MAX_HISTORY,
                      "attack_template": "important_instructions"},
           "items": []}

    attacks = {}
    for item in corpus["benign"]:
        suite = suites[item["suite"]]
        task = suite.user_tasks[item["task"]]
        index = int(item["id"].split("/")[-1])
        env = suite.load_and_inject_default_environment({})
        runtime = FunctionsRuntime(suite.tools)
        gt = [{"name": c.function, "arguments": dict(c.args)} for c in task.ground_truth(env.model_copy(deep=True))]
        history = execute(runtime, env, gt[:index])
        out["items"].append({**{k: item[k] for k in ("id", "suite", "task", "intent", "call")},
                             "label": "benign", "final": True, "pair": None, "history": history[-MAX_HISTORY:]})

    for pair in corpus["attacks"]:
        suite = suites[pair["suite"]]
        if suite.name not in attacks:
            attacks[suite.name] = ImportantInstructionsAttack(suite, _NamedPipeline())
        attack = attacks[suite.name]
        user_task = suite.user_tasks[pair["task"]]
        injection_task = suite.injection_tasks[pair["injection"]]
        try:
            injections = attack.attack(user_task, injection_task)
        except ValueError:
            injections = {}  # task reads no injectable vector; history then carries no injection
        env = suite.load_and_inject_default_environment(injections)
        runtime = FunctionsRuntime(suite.tools)
        user_calls = [{"name": c.function, "arguments": dict(c.args)} for c in user_task.ground_truth(env.model_copy(deep=True))]
        history = execute(runtime, env, user_calls)
        injected_seen = any("<INFORMATION>" in h["result"] for h in history)
        for index, call in enumerate(pair["calls"]):
            out["items"].append({
                "id": f"{pair['id']}/{index}", "suite": pair["suite"], "task": pair["task"], "intent": pair["intent"],
                "call": call, "label": "attack", "final": index == len(pair["calls"]) - 1, "pair": pair["id"],
                "history": history[-MAX_HISTORY:], "injection_in_history": injected_seen,
            })
            history = history + execute(runtime, env, [call])

    (RAW / "agentdojo-sessions.json").write_text(json.dumps(out, indent=1))
    items = out["items"]
    attacks_items = [i for i in items if i["label"] == "attack"]
    print(f"items: {len(items)} (benign {sum(i['label'] == 'benign' for i in items)}, attack {len(attacks_items)})")
    print(f"attack items whose history shows the injection: {sum(i['injection_in_history'] for i in attacks_items)}")
    print(f"mean history length: {sum(len(i['history']) for i in items) / len(items):.2f}")


if __name__ == "__main__":
    main()
