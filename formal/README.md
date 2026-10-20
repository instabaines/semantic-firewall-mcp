# Formal model

`semantic_firewall.spthy` is a Tamarin model of the gateway's credential and
mediation protocol: passport issuance, proxy mediation, human approval, and
sender-constrained forwarding to the MCP server, under a Dolev–Yao adversary that
receives every passport (the agent is the adversary).

**Proved for v1.1:** authentic intent (P1), scope and resource confinement (P2/P3),
sender constraint and replay freedom (P5), and consent integrity (P7), each
conditioned on the relevant keys staying secret. Two executability lemmas check
that the properties do not hold vacuously.

**Abstractions.** The inspector is not modelled: it can only turn an allow into a
hold or block, so omitting it is the worst case and the results hold for any
inspector. The approver approves every call it is shown, so P7 states who can
release a held call, not how well they judge. Message parsing and error handling
are outside a symbolic model and are covered by the regression tests and the E2
exploits.

**Variants.** `run.py` builds the model with compile flags that each reinstate one
flaw, and proves every lemma in every variant:

| Variant | Flag(s) |
|---|---|
| v1.1 (proof binds the request body) | `BODY_BINDING` |
| v1.1 without body binding | none |
| unauthenticated issuance | `LEGACY_ISSUANCE` |
| unauthenticated approval | `LEGACY_APPROVAL` |
| no replay cache | `NO_REPLAY_CACHE` |
| no server re-check | `NO_SERVER_RECHECK` |
| v1.0 (all of the above) | all four legacy flags |

Results are in `results.json` (verified / falsified / timeout per lemma, with
steps and seconds). Each lemma runs in its own process with a time limit
(`TAMARIN_TIMEOUT`, default 600 s).

## Running

`../reproduce.sh` installs the tools and runs this step automatically. To run it
alone:

```bash
# Tamarin 1.12.0 and Maude 3.5.1 on PATH, or unpacked into formal/.tools/
python3 formal/run.py                      # all variants (about 25 minutes)
python3 formal/run.py "v1.1+body-binding"  # one variant
```
