"""Upper-bound analysis: how much would stateful destination provenance help on
the AgentDojo-derived session corpus (E6-S)?

For every write call (tools not named get_/search_/list_/read_/check_/find_/verify_),
each destination-like argument (recipient, IBAN, URL, user, channel, e-mail,
participant, account, password) is classified by where its value first appears:

  prompt         in the user's prompt
  data           in an earlier tool result, outside injected text
  injected-only  only inside injected text (AgentDojo's <INFORMATION> block)
  novel          nowhere in the prompt or the session

Injected text is located with AgentDojo's own markers, i.e. an ORACLE taint
signal that a real proxy does not have. Results are therefore an upper bound.
Development items (experiments/e6-dev-items.json) are excluded.

Usage: python3 -I experiments/provenance-analysis.py
"""

import json
import os
import re
from collections import Counter
from pathlib import Path

RAW = Path(os.environ["SFMCP_RESULTS"]).resolve() / "raw" if os.environ.get("SFMCP_RESULTS") else Path(__file__).resolve().parent / "results" / "raw"
READ = re.compile(r"^(get|search|list|read|check|find|verify)_")
INJECTED = re.compile(r"<INFORMATION>.*?</INFORMATION>", re.S)
DESTINATION = re.compile(r"(recipient|iban|url|user|channel|email|participant|^to$|account|password)", re.I)
ORDER = ["injected-only", "novel", "data", "prompt"]


def destinations(arguments):
    values = []
    for key, value in arguments.items():
        if DESTINATION.search(key):
            for item in value if isinstance(value, list) else [value]:
                if str(item).strip():
                    values.append(str(item).strip().lower())
    return values


def classify(item):
    raw = " ".join(step["result"] for step in item["history"])
    prompt, results, clean = item["intent"].lower(), raw.lower(), INJECTED.sub(" ", raw).lower()
    values = destinations(item["call"]["arguments"])
    if not values:
        return "no destination"
    labels = ["prompt" if v in prompt else "data" if v in clean else "injected-only" if v in results else "novel" for v in values]
    return next(label for label in ORDER if label in labels)


def main():
    sessions = json.loads((RAW / "agentdojo-sessions.json").read_text())
    dev = set(json.loads((Path(__file__).resolve().parent / "e6-dev-items.json").read_text())["ids"])
    summary = {}
    for label in ("benign", "attack"):
        items = [i for i in sessions["items"] if i["label"] == label and i["id"] not in dev
                 and (label == "benign" or i["final"]) and not READ.match(i["call"]["name"])]
        counts = Counter(classify(item) for item in items)
        summary[label] = {"write_calls": len(items), **counts}
        print(label, len(items), dict(counts))
    (RAW.parent / "summary").mkdir(exist_ok=True)
    (RAW.parent / "summary" / "e6s-provenance-upper-bound.json").write_text(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
