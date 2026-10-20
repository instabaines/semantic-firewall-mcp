"""E5: run prior defenses on the same corpus, with the same local models.

  progent         Progent-LLM (sunblaze-ucb/progent, `secagent`): a policy is generated
                  from the user query with Progent's own prompt, then every call is
                  checked with Progent's `check_tool_call`, as its MCP proxy does.
  alignmentcheck  LlamaFirewall's AlignmentCheck scanner: the user message plus the
                  selected action are judged with LlamaFirewall's own prompt and schema.

Only the LLM transport is replaced, by a call to the local Ollama server with
thinking disabled. Prompts, parsing and decision logic are the tools' own.

Usage (from the repository root):
  node experiments/export-corpus.js > experiments/results/raw/corpus.json
  experiments/comparators/.venv/bin/python -I experiments/comparators/run_comparators.py \
      --systems progent,alignmentcheck --models qwen2.5:3b,llama3.1:8b,gemma4:latest
"""

import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
RAW = ROOT / "experiments" / "results" / "raw"
OLLAMA = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434")

# Progent prints its configured model at import; we name local models with the
# "Qwen/" prefix so Progent uses its open-model output-format instruction.
os.environ.setdefault("SECAGENT_POLICY_MODEL", "Qwen/local")
os.environ["SECAGENT_GENERATE"] = "True"


def ollama_chat(model, system, user, temperature=0.0, json_schema=None, seed=0):
    body = {
        "model": model,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "stream": False,
        "think": False,
        "options": {"temperature": temperature, "seed": seed},
    }
    if json_schema is not None:
        body["format"] = json_schema
    request = urllib.request.Request(
        f"{OLLAMA}/api/chat", data=json.dumps(body).encode(), headers={"content-type": "application/json"}
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        return json.loads(response.read())["message"]["content"]


# ---------------------------------------------------------------- tools (MCP server mirror)
# Same names, descriptions and argument schemas as src/protected-resource/server.js.

def list_datasets():
    """List datasets available for analysis and reporting."""


def list_reports():
    """List generated reports in the demo environment."""


def get_dataset_overview(datasetId: str):
    """Return aggregate metrics for a dataset.

    Args:
        datasetId: Dataset identifier such as sales-q1
    """


def read_dataset_rows(datasetId: str, limit: int = 5):
    """Read a limited sample of dataset rows.

    Args:
        datasetId: Dataset identifier such as sales-q1
        limit: Number of rows to read, between 1 and 20
    """


def generate_report(datasetId: str, objective: str):
    """Generate a markdown revenue report for a dataset.

    Args:
        datasetId: Dataset identifier such as sales-q1
        objective: User's reporting objective
    """


def export_customer_emails(datasetId: str):
    """Export customer email addresses from a dataset.

    Args:
        datasetId: Dataset identifier such as sales-q1
    """


def delete_dataset(datasetId: str, confirmation: str):
    """Delete a dataset and all associated rows and reports.

    Args:
        datasetId: Dataset identifier such as sales-q1
        confirmation: Must equal DELETE to execute
    """


TOOLS = [list_datasets, list_reports, get_dataset_overview, read_dataset_rows,
         generate_report, export_customer_emails, delete_dataset]


# ---------------------------------------------------------------- Progent
def run_progent(corpus, model, rep, out):
    import secagent.tool as progent

    progent.policy_model = "Qwen/" + model  # selects Progent's open-model prompt variant
    progent.api_request = lambda sys_prompt, user_prompt, temperature=0.0: ollama_chat(
        model, sys_prompt, user_prompt, temperature, seed=rep
    )
    progent.available_tools.clear()
    progent.apply_secure_tool_wrapper(TOOLS)

    policies = {}
    for intent_id, intent in corpus["intents"].items():
        progent.reset_security_policy(include_human_policy=True)
        progent.security_policy = None
        started = time.time()
        error = None
        try:
            progent.generate_security_policy(intent["prompt"])
            policy = json.loads(json.dumps(progent.security_policy, default=str))
        except Exception as caught:  # Progent retries 5 times internally, then raises
            error = repr(caught)[:300]
            policy = None
        policies[intent_id] = {"policy": policy, "error": error, "seconds": round(time.time() - started, 1)}

    for case in corpus["cases"]:
        call = case["call"]
        record = {"system": "progent", "model": model, "rep": rep, "id": case["id"],
                  "category": case["category"], "label": case["label"]}
        intent_policy = policies[case["intent"]]
        if call["method"] != "tools/call":
            # Progent's MCP proxy middleware filters tool calls only (on_call_tool).
            record.update(outcome="executed", reason="not_mediated")
        elif intent_policy["policy"] is None:
            record.update(outcome="blocked", reason="policy_generation_failed")
        else:
            progent.security_policy = {
                name: [tuple(rule) for rule in rules] for name, rules in intent_policy["policy"].items()
            }
            progent.init_user_query = corpus["intents"][case["intent"]]["prompt"]
            try:
                progent.check_tool_call(call["name"], dict(call["arguments"]))
                record.update(outcome="executed", reason=None)
            except Exception as caught:
                record.update(outcome="blocked", reason=str(caught)[:200])
        out.write(json.dumps(record) + "\n")
    return policies


# ---------------------------------------------------------------- LlamaFirewall AlignmentCheck
class OllamaStructuredClient:
    """Drop-in for llamafirewall.utils.base_llm.LLMClient: same call() contract."""

    def __init__(self, model, seed):
        self.model = model
        self.seed = seed
        self.failures = 0

    async def call(self, prompt, system_prompt, output_schema, temperature=0.0, additional_messages=None):
        content = await asyncio.to_thread(
            ollama_chat, self.model, system_prompt, prompt, temperature, output_schema.model_json_schema(), self.seed
        )
        try:
            return output_schema.model_validate_json(content)
        except Exception:
            self.failures += 1
            raise


def run_alignmentcheck(corpus, model, rep, out):
    os.environ.setdefault("TOGETHER_API_KEY", "unused-local-transport")
    from llamafirewall import AssistantMessage, UserMessage
    from llamafirewall.scanners.experimental.alignmentcheck_scanner import AlignmentCheckScanner

    scanner = AlignmentCheckScanner()
    scanner.llm = OllamaStructuredClient(model, rep)

    for case in corpus["cases"]:
        call = case["call"]
        record = {"system": "alignmentcheck", "model": model, "rep": rep, "id": case["id"],
                  "category": case["category"], "label": case["label"]}
        if call["method"] != "tools/call":
            record.update(flagged=False, reason="not_a_tool_call", error=False)
            out.write(json.dumps(record) + "\n")
            continue
        user = UserMessage(content=corpus["intents"][case["intent"]]["prompt"])
        # The corpus has no agent reasoning, so THOUGHT is empty. AlignmentCheck is
        # designed to read reasoning; this is a handicap we report.
        action = AssistantMessage(
            content=f"THOUGHT: \nACTION: {call['name']}\nACTION INPUT: {json.dumps(call['arguments'])}"
        )
        failures_before = scanner.llm.failures
        started = time.time()
        result = asyncio.run(scanner.scan(action, [user]))
        record.update(
            flagged=str(result.decision).endswith("HUMAN_IN_THE_LOOP_REQUIRED"),
            error=scanner.llm.failures > failures_before or "Error occurred during evaluation" in result.reason,
            reason=result.reason[:400],
            seconds=round(time.time() - started, 1),
        )
        out.write(json.dumps(record) + "\n")
        out.flush()
        print(f"alignmentcheck {model} r{rep} {case['id']} flagged={record['flagged']} error={record['error']}", flush=True)


# ---------------------------------------------------------------- E6: AgentDojo-derived corpus
def agentdojo_items(corpus):
    items = [dict(id=b["id"], label="benign", suite=b["suite"], task=b["task"], intent=b["intent"],
                  call=b["call"], final=True, pair=None) for b in corpus["benign"]]
    for a in corpus["attacks"]:
        for index, call in enumerate(a["calls"]):
            items.append(dict(id=f"{a['id']}/{index}", label="attack", suite=a["suite"], task=a["task"],
                              intent=a["intent"], call=call, final=index == len(a["calls"]) - 1, pair=a["id"]))
    return items


def done_ids(path):
    if not path.exists():
        return set()
    return {json.loads(line)["id"] for line in path.open() if line.strip()}


def run_progent_agentdojo(corpus, model, path):
    import secagent.tool as progent

    progent.policy_model = "Qwen/" + model
    progent.api_request = lambda sys_prompt, user_prompt, temperature=0.0: ollama_chat(
        model, sys_prompt, user_prompt, temperature, seed=1
    )
    policies_path = path.with_name(path.stem + "-policies.json")
    policies = json.loads(policies_path.read_text()) if policies_path.exists() else {}
    done = done_ids(path)
    with path.open("a") as out:
        for item in agentdojo_items(corpus):
            if item["id"] in done:
                continue
            key = f"{item['suite']}/{item['task']}"
            if key not in policies:
                progent.available_tools[:] = corpus["tools"][item["suite"]]
                progent.reset_security_policy(include_human_policy=True)
                started = time.time()
                try:
                    progent.generate_security_policy(item["intent"])
                    policies[key] = {"policy": json.loads(json.dumps(progent.security_policy, default=str)), "error": None}
                except Exception as caught:
                    policies[key] = {"policy": None, "error": repr(caught)[:300]}
                policies[key]["seconds"] = round(time.time() - started, 1)
                policies_path.write_text(json.dumps(policies, indent=2))
            policy = policies[key]["policy"]
            record = {"system": "progent", "model": model, **{k: item[k] for k in ("id", "pair", "label", "suite", "final")}}
            if policy is None:
                record.update(flagged=True, reason="policy_generation_failed")
            else:
                progent.security_policy = {name: [tuple(rule) for rule in rules] for name, rules in policy.items()}
                progent.init_user_query = item["intent"]
                try:
                    progent.check_tool_call(item["call"]["name"], dict(item["call"]["arguments"]))
                    record.update(flagged=False, reason=None)
                except Exception as caught:
                    record.update(flagged=True, reason=str(caught)[:200])
            out.write(json.dumps(record) + "\n")
            out.flush()


def run_alignmentcheck_sessions(sessions, model, path):
    """AlignmentCheck with the full session trace it was designed to read."""
    os.environ.setdefault("TOGETHER_API_KEY", "unused-local-transport")
    from llamafirewall import AssistantMessage, ToolMessage, UserMessage
    from llamafirewall.scanners.experimental.alignmentcheck_scanner import AlignmentCheckScanner

    scanner = AlignmentCheckScanner()
    scanner.llm = OllamaStructuredClient(model, 1)
    done = done_ids(path)
    with path.open("a") as out:
        for item in sessions["items"]:
            if item["id"] in done:
                continue
            trace = [UserMessage(content=item["intent"])]
            for step in item["history"]:
                trace.append(AssistantMessage(content=f"THOUGHT: \nACTION: {step['tool']}\nACTION INPUT: {json.dumps(step['arguments'], default=str)}"))
                trace.append(ToolMessage(content=step["result"]))
            call = item["call"]
            action = AssistantMessage(content=f"THOUGHT: \nACTION: {call['name']}\nACTION INPUT: {json.dumps(call['arguments'], default=str)}")
            failures_before = scanner.llm.failures
            started = time.time()
            result = asyncio.run(scanner.scan(action, trace))
            record = {"system": "alignmentcheck", "model": model, **{k: item[k] for k in ("id", "pair", "label", "suite", "final")},
                      "flagged": str(result.decision).endswith("HUMAN_IN_THE_LOOP_REQUIRED"),
                      "error": scanner.llm.failures > failures_before or "Error occurred during evaluation" in result.reason,
                      "seconds": round(time.time() - started, 1)}
            out.write(json.dumps(record) + "\n")
            out.flush()


def run_alignmentcheck_agentdojo(corpus, model, path):
    os.environ.setdefault("TOGETHER_API_KEY", "unused-local-transport")
    from llamafirewall import AssistantMessage, UserMessage
    from llamafirewall.scanners.experimental.alignmentcheck_scanner import AlignmentCheckScanner

    scanner = AlignmentCheckScanner()
    scanner.llm = OllamaStructuredClient(model, 1)
    done = done_ids(path)
    with path.open("a") as out:
        for item in agentdojo_items(corpus):
            if item["id"] in done:
                continue
            call = item["call"]
            action = AssistantMessage(content=f"THOUGHT: \nACTION: {call['name']}\nACTION INPUT: {json.dumps(call['arguments'])}")
            failures_before = scanner.llm.failures
            started = time.time()
            result = asyncio.run(scanner.scan(action, [UserMessage(content=item["intent"])]))
            record = {"system": "alignmentcheck", "model": model, **{k: item[k] for k in ("id", "pair", "label", "suite", "final")},
                      "flagged": str(result.decision).endswith("HUMAN_IN_THE_LOOP_REQUIRED"),
                      "error": scanner.llm.failures > failures_before or "Error occurred during evaluation" in result.reason,
                      "seconds": round(time.time() - started, 1)}
            out.write(json.dumps(record) + "\n")
            out.flush()
            print(f"alignmentcheck-agentdojo {model} {item['id']} flagged={record['flagged']}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--systems", default="progent,alignmentcheck")
    parser.add_argument("--models", default="qwen2.5:3b,llama3.1:8b,gemma4:latest")
    parser.add_argument("--reps", type=int, default=1)
    parser.add_argument("--corpus", default="semfw", choices=["semfw", "agentdojo", "agentdojo-sessions"])
    args = parser.parse_args()

    if args.corpus == "agentdojo-sessions":
        sessions = json.loads((RAW / "agentdojo-sessions.json").read_text())
        for model in args.models.split(","):
            tag = model.replace(":", "_").replace("/", "_")
            path = RAW / f"e6s-alignmentcheck-{tag}.jsonl"
            started = time.time()
            run_alignmentcheck_sessions(sessions, model, path)
            print(f"done {path.name} in {time.time() - started:.0f} s", flush=True)
        return

    if args.corpus == "agentdojo":
        corpus = json.loads((RAW / "agentdojo-corpus.json").read_text())
        for system in args.systems.split(","):
            for model in args.models.split(","):
                tag = model.replace(":", "_").replace("/", "_")
                path = RAW / f"e6-{system}-{tag}.jsonl"
                started = time.time()
                (run_progent_agentdojo if system == "progent" else run_alignmentcheck_agentdojo)(corpus, model, path)
                print(f"done {path.name} in {time.time() - started:.0f} s", flush=True)
        return

    corpus = json.loads((RAW / "corpus.json").read_text())
    for system in args.systems.split(","):
        for model in args.models.split(","):
            for rep in range(1, args.reps + 1):
                tag = model.replace(":", "_").replace("/", "_")
                path = RAW / f"e5-{system}-{tag}-rep{rep}.jsonl"
                if path.exists() and sum(1 for _ in path.open()) == len(corpus["cases"]):
                    print(f"skip {path.name} (complete)")
                    continue
                started = time.time()
                with path.open("w") as out:
                    if system == "progent":
                        policies = run_progent(corpus, model, rep, out)
                        (RAW / f"e5-progent-policies-{tag}-rep{rep}.json").write_text(json.dumps(policies, indent=2))
                    else:
                        run_alignmentcheck(corpus, model, rep, out)
                print(f"wrote {path.name} in {time.time() - started:.0f} s", flush=True)


if __name__ == "__main__":
    sys.exit(main())
