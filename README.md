# Hardened MCP Gateway

Hardened MCP Gateway is a demonstration system for enforcing user intent across MCP tool calls.

![Semantic enforcement flow](docs/semantic-enforcement-flow.png)

The architecture image referenced above should be stored at `docs/semantic-enforcement-flow.png`.

Instead of asking only whether an agent is authorized to call a tool, this project asks a stricter question:

`Should this tool call happen right now, given the user's original request?`

The demo is designed for security presentations, architecture reviews, and proof-of-concept work around:

- semantic policy enforcement for MCP
- intent-bound tool access
- resource binding for agent actions
- local-model inspection of suspicious tool use
- human approval for high-risk but technically authorized actions

## Overview

The system contains five cooperating components:

1. An `Orchestrator` that receives the original user prompt and issues a signed Contextual Passport JWT.
2. A `Semantic Proxy` that intercepts MCP JSON-RPC tool calls before they reach the protected MCP server.
3. An `Inspector` that evaluates whether the attempted tool action still aligns with the original user intent.
4. A `Protected MCP Server` that exposes real typed tools backed by a SQLite demo dataset.
5. A `Dashboard` that shows live events, approvals, reports, and the current runtime configuration.

The current implementation is intended to be honest, runnable, and inspectable. It includes real enforcement logic, a real MCP server, real database-backed tools, and a live demo UI.

## Architecture

### Contextual Passport

When the orchestrator receives the original prompt, it creates a signed JWT with claims such as:

- `summary`
- `intent_type`
- `tool_scopes`
- `resource_indicators`
- `rationale`
- JWT timing claims

Relevant files:

- `src/orchestrator/server.js`
- `src/orchestrator/semantic-summary.js`
- `src/protocol/contextual-passport.js`

### Semantic Proxy

The proxy intercepts MCP requests at `POST /mcp` and enforces:

- JWT verification
- tool scope checks
- resource binding checks
- semantic inspection
- human approval for suspicious calls

Relevant files:

- `src/semantic-proxy/server.js`
- `src/semantic-proxy/policy-engine.js`
- `src/semantic-proxy/approval-gate.js`

### Inspector

The inspector evaluates whether a tool call is consistent with the original intent summary.

When a model is available, it uses Ollama-style `POST /api/generate`. If `REQUIRE_MODEL=1` is set, failures in model-backed summarization or inspection are treated as hard failures rather than falling back silently.

Relevant files:

- `src/inspector/server.js`
- `src/inspector/model-client.js`

### Protected MCP Server

The protected server uses the official MCP SDK and exposes real tools over Streamable HTTP.

Tools currently included:

- `list_datasets`
- `get_dataset_overview`
- `read_dataset_rows`
- `generate_report`
- `export_customer_emails`
- `delete_dataset`
- `list_reports`

Relevant files:

- `src/protected-resource/server.js`
- `src/protected-resource/demo-db.js`

### Dashboard and Approval Flow

The dashboard shows:

- live or polled state updates
- event timeline
- pending approvals
- generated reports
- active runtime ports and PID

Relevant files:

- `public/index.html`
- `public/app.js`
- `public/styles.css`
- `src/dashboard/event-bus.js`

## Diagram Mapping

The repository is organized to match the presentation diagram directly:

- `User / Demo Driver`
- `src/demo/client.js`
- `src/demo/guided-attack.js`
- `src/demo/presenter-mode.js`
- `Agent Orchestrator`
  - `src/orchestrator/server.js`
  - `src/orchestrator/semantic-summary.js`
- `Contextual Passport`
  - `src/protocol/contextual-passport.js`
- `Semantic Proxy (PEP)`
  - `src/semantic-proxy/server.js`
  - `src/semantic-proxy/policy-engine.js`
  - `src/semantic-proxy/approval-gate.js`
- `Inspector SLM (Local)`
  - `src/inspector/server.js`
  - `src/inspector/model-client.js`
- `Protected MCP Server / Tools`
  - `src/protected-resource/server.js`
  - `src/protected-resource/demo-db.js`
- `Runtime / Active Stack Discovery`
  - `src/runtime/config.js`
  - `src/runtime/active-stack.js`

## Exportable Protocol Surface

The repository now includes a protocol-oriented layer intended to be reusable outside this demo:

- `src/protocol/contextual-passport.js`
- `src/protocol/inspection.js`
- `src/protocol/events.js`
- `src/protocol/index.js`

These files define the shared concepts that other projects can adopt even if they implement their own:

- orchestrator
- proxy
- inspector
- approval workflow
- protected MCP server

## What Is Implemented

This repository includes:

- a real MCP SDK server
- a real semantic enforcement proxy
- a persistent SQLite demo database
- resource-bound policy checks
- local-model integration points for summarization and inspection
- browser-based approval UX
- presenter mode for a scripted end-to-end demo

This repository does not claim:

- full OAuth 2.0 / RFC 8707 production integration
- a hardened production identity system
- audited LLM safety guarantees
- benchmarked SLOs for every environment

It is best understood as a production-style security demo and reference implementation.

## Security Claims

This project demonstrates the following security properties:

- Intent-bound authorization: tool use is evaluated against the original user request, not only static tool permissions.
- Signed contextual binding: the orchestrator issues a signed JWT that carries the semantic summary, allowed tool scopes, and resource indicators for the session.
- Resource binding enforcement: a tool call can be denied even if the tool itself is authorized, when the requested dataset or target resource falls outside the bound context.
- Semantic inspection before execution: suspicious calls are evaluated before they reach the protected MCP server.
- Human approval for high-risk actions: calls that are technically authorized but semantically suspicious can be paused for review instead of immediately executing.
- Protected-side isolation: the protected MCP server is not reached when the proxy denies or holds a call.
- Auditability for demos and reviews: the dashboard and event stream make enforcement decisions visible in real time.

This project does not claim the following:

- formal proof of semantic correctness
- comprehensive protection against all prompt injection or jailbreak techniques
- complete standards-compliant OAuth or RFC 8707 deployment
- production-grade identity, key management, or distributed approval workflows
- guaranteed model behavior under all inputs or hardware conditions

The recommended framing is: this repository is a working reference implementation and security demo for semantic MCP enforcement, not a finished enterprise security product.

## Installation

Requirements:

- Node.js 20+
- npm
- optional: Ollama-compatible model host

Install dependencies:

```bash
npm install
```

## Model Configuration

The model integration expects an Ollama-compatible endpoint.

Default:

```bash
OLLAMA_HOST=127.0.0.1:11434
```

Example startup:

```bash
OLLAMA_HOST=127.0.0.1:11434 OLLAMA_MODEL=qwen3-vl:8b REQUIRE_MODEL=1 npm start
```

If the model host is running elsewhere:

```bash
OLLAMA_HOST=HOST:11434
```

If necessary, the full generate endpoint can be overridden directly:

```bash
OLLAMA_URL=http://HOST:11434/api/generate
```

Notes:

- `REQUIRE_MODEL=1` forces model-backed paths to succeed or fail explicitly.
- Without `REQUIRE_MODEL=1`, the system may fall back to deterministic logic if the model call fails.

## Running the System

### Standard Mode

Start the stack:

```bash
npm start
```

Open the dashboard:

```text
http://127.0.0.1:4000/dashboard/
```

### Presenter Mode

Presenter mode starts the stack on presenter-safe ports and runs the full scripted story automatically.

```bash
npm run presenter
```

Open:

```text
http://127.0.0.1:4500/dashboard/
```

Presenter mode is the recommended path for live demos.

## Port Alignment and Runtime Discovery

When the stack starts, it writes the active runtime configuration to:

`.runtime/active-stack.json`

The demo scripts read this file automatically. That means:

- if `npm start` is the active stack, `npm run demo:allow` targets that stack
- if `npm run presenter` is the active stack, `npm run demo:allow` targets the presenter stack

The dashboard also shows the active proxy and orchestrator ports so mismatches are visible.

## Demo Commands

The demo commands are designed to be run against the currently active stack:

```bash
npm run demo:allow
npm run demo:block
npm run demo:approve
npm run demo:guided
```

What they do:

- `demo:allow`
  Sends a benign, in-scope report-generation request that should succeed.
- `demo:block`
  Sends a request that violates resource binding and should be blocked by policy.
- `demo:approve`
  Sends a suspicious but technically authorized request that should pause for human approval.
- `demo:guided`
  Runs a narrated, step-by-step version of the full attacker story.

## What to Expect in the Dashboard

During a successful demo run, the dashboard should show:

- new entries in the event timeline
- new reports after successful report-generation flows
- a temporary approval request during approval-gated scenarios
- runtime metadata showing which stack the dashboard belongs to

If reports appear but the timeline does not update, that usually indicates you are looking at a different running stack than the one receiving the demo traffic.

## Testing

Run the automated tests:

```bash
npm test
```

The test suite covers:

- allow path
- resource binding deny path
- approval-gated forward path

## Project Structure

- `src/index.js`: entry point for the full stack
- `src/protocol/`: shared protocol contracts for passports, inspection, and policy events
- `src/orchestrator/`: prompt registration, semantic summary, and passport issuance
- `src/semantic-proxy/`: interception, policy enforcement, inspection calls, and approval gate
- `src/inspector/`: local model-backed inspection service
- `src/protected-resource/`: protected MCP server and demo dataset
- `src/runtime/`: runtime configuration and active stack discovery
- `src/dashboard/`: dashboard-facing event infrastructure
- `src/demo/`: scenario runners and presenter mode

## Known Limitations

- Event history is in-memory and resets when the process restarts.
- Generated reports are stored in SQLite and therefore persist across restarts unless the database is cleared.
- Model-backed behavior depends on the availability and health of the configured Ollama-compatible host.
- Large local models may fail for environment-specific reasons such as memory pressure.

## Recommended Demo Flow

For a live presentation:

1. Start with `npm run presenter`.
2. Open `http://127.0.0.1:4500/dashboard/`.
3. Narrate the three phases:
   benign request, blocked attack, approval-gated suspicious request.
4. Use the timeline and approval panel as the primary visual story.

## License / Usage

No explicit license has been added in this repository beyond the current package metadata. Add a project license if the repository will be shared publicly.
