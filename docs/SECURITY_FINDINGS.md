# Security Findings and Remediations (v1.0.0 → v1.1.0)

This document records the vulnerabilities found in the original reference
implementation (commit `ce51701`, v1.0.0), the change that fixes each one, and how
the fix is verified. Every finding marked *confirmed* was exploited end to end
against a running v1.0.0 stack by `experiments/run-protocol-attacks.js` (E2); the
same attack fails against v1.1.0. Raw evidence: `experiments/results/raw/e2-*.json`.

Threat model in one line: the **agent is untrusted** (it may be steered by prompt
injection in data it reads). It holds a legitimately issued passport and can send
arbitrary MCP JSON-RPC to the proxy. It does not hold the orchestrator client
credential, the approver token, or any private key.

| ID | Finding | Severity | v1.0.0 | v1.1.0 fix | Verified by |
|----|---------|----------|--------|------------|-------------|
| F1 | Inspector errors fail open | Critical | confirmed (X7) | Proxy validates status and schema of every verdict; any failure → `503 inspector_unavailable` | E2 X7, `security-regressions.test.js` |
| F2 | Anyone can mint passports with arbitrary `toolScopes` | Critical | confirmed (X1) | Orchestrator requires a client credential the agent never holds; explicit scopes recorded as `scope_source: user_granted` and limited to known tools | E2 X1, tests |
| F3 | Shared HS256 secret with a published default | Critical | confirmed (X2) | Passports signed ES256 by the orchestrator key; verifiers hold only the public key | E2 X2, tests |
| F4 | JSON-RPC batch bypasses all policy checks | Critical | confirmed (X4) | Proxy accepts exactly one request object; resource server also rejects batches | E2 X4, tests |
| F5 | `resources/read` passes through without resource binding | High | confirmed (X5) | Binding enforced on `resources/read`; MCP method allowlist; unknown methods denied | E2 X5, tests |
| F6 | Approval endpoint unauthenticated (agent can self-approve) | High | confirmed (X6) | `x-approver-token` required; timeout resolves as denial | E2 X6, tests |
| F7 | Empty resource binding allows every resource | High | confirmed (X10) | Binding fails closed when a call names a resource and the passport binds none | E2 X10, tests |
| F8 | DPoP proofs replayable; resource server trusts proxy for scope | High | confirmed (X9) | `jti` replay cache; resource server re-checks scope and binding from the passport | E2 X9, tests |
| F9 | Stored XSS in approval dashboard (agent-controlled args rendered as HTML) | High | confirmed by inspection (X11) | All rendered values escaped; CSP `script-src 'self'` on dashboard | E2 X11 (static) |
| F10 | Prompt injection into the inspector via tool arguments | High | measured (E1, A4/A5) | Hardened prompt (system role, JSON-encoded args in an unforgeable delimiter) + deterministic injection/exfiltration rules OR-combined with the model | E1 |
| F11 | Raw user prompt embedded in the (unencrypted) passport | Medium | by inspection | Only `prompt_sha256` is carried | tests |
| F12 | Resources smuggled under undeclared argument names | Medium | by inspection | Per-tool resource-argument registry plus scan of all URI-shaped values | tests |
| F13 | Model confidence on a 0–100 scale treated as a probability (every verdict exceeds every threshold) | Low | observed (qwen2.5) | Verdict normalization | tests |
| F14 | Thinking models return empty output under a token cap | Low | observed (gemma4) | `think: false` in model requests | E1 |

Controls (expected to fail on both versions, and do): X3 unsigned `alg=none`
passport; X8 stolen passport sent directly to the resource server without a
DPoP proof.

## Residual risks (not fixed, documented)

- **Inspector judgement is probabilistic.** E1 reports both attack success and the
  benign-call cost; small local models over-flag legitimate supporting calls.
- **The heuristic rules were written by the same authors as the corpus.** The A5
  category was written after the rules were frozen to measure this; see
  `experiments/README.md`.
- **Single-process secrets.** For the demo, all keys live in `.runtime/`. A real
  deployment must give each component only its own private key and peers' public
  keys, and keep the approver token out of the agent's environment.
- **In-memory replay cache and approval store** do not survive restarts and do not
  span replicas.
- **Coarse intent→scope mapping.** For example, `list_reports` is not in the
  `report` scope (benign case B15 is blocked). Mapping design is deployment policy.
- **Read-only dashboard endpoints are unauthenticated** (`/api/state`, `/approvals`,
  `/events`). They expose intent summaries and tool arguments of all sessions to
  anyone who can reach the proxy. Put them behind the same authentication as the
  approval endpoint in any shared deployment.
