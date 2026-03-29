import { request } from "undici";
import { config } from "../runtime/config.js";
import { readRuntimeEnv } from "../runtime/active-stack.js";

function resolvePorts() {
  const runtime = readRuntimeEnv();
  return {
    proxyPort: Number(process.env.PROXY_PORT || runtime?.proxyPort || config.proxyPort),
    orchestratorPort: Number(process.env.ORCHESTRATOR_PORT || runtime?.orchestratorPort || config.orchestratorPort),
  };
}

async function createPassport(ports, prompt, extra = {}) {
  const response = await request(`http://127.0.0.1:${ports.orchestratorPort}/intent-passports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, ...extra }),
  });

  const body = await response.body.json();
  if (response.statusCode >= 400 || !body?.token) {
    throw new Error(`Intent passport request failed on port ${ports.orchestratorPort}: ${JSON.stringify(body)}`);
  }

  return body;
}

async function mcpCall(ports, token, name, args = {}) {
  const response = await request(`http://127.0.0.1:${ports.proxyPort}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });

  return {
    statusCode: response.statusCode,
    body: await response.body.json(),
  };
}

async function verifyStack(ports) {
  const proxyHealth = await request(`http://127.0.0.1:${ports.proxyPort}/health`);
  const proxyBody = await proxyHealth.body.json();
  if (proxyHealth.statusCode >= 400 || proxyBody?.status !== "ok") {
    throw new Error(`No semantic proxy available on port ${ports.proxyPort}`);
  }

  const orchestratorCatalog = await request(`http://127.0.0.1:${ports.orchestratorPort}/catalog`);
  const catalogBody = await orchestratorCatalog.body.json();
  if (orchestratorCatalog.statusCode >= 400 || !Array.isArray(catalogBody?.datasets)) {
    throw new Error(`No orchestrator available on port ${ports.orchestratorPort}`);
  }
}

async function pollApprovals() {
  const ports = resolvePorts();
  const response = await request(`http://127.0.0.1:${ports.proxyPort}/approvals`);
  return response.body.json();
}

async function decideApproval(id, approved) {
  const ports = resolvePorts();
  await request(`http://127.0.0.1:${ports.proxyPort}/approvals/${id}/decision`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ approved, approver: "demo-client" }),
  });
}

export async function run() {
  const scenario = process.argv[2] || "allow";
  const ports = resolvePorts();

  console.log(`Using proxy ${ports.proxyPort} and orchestrator ${ports.orchestratorPort}`);
  await verifyStack(ports);

  if (scenario === "allow") {
    const passport = await createPassport(ports, "Generate a revenue report for sales-q1.");
    const result = await mcpCall(ports, passport.token, "generate_report", {
      datasetId: "sales-q1",
      objective: "Summarize the strongest regional revenue performance.",
    });
    console.log(JSON.stringify({ passport: passport.payload, result }, null, 2));
    return;
  }

  if (scenario === "block") {
    const passport = await createPassport(ports, "Generate a revenue report for sales-q1.");
    const result = await mcpCall(ports, passport.token, "delete_dataset", {
      datasetId: "sales-q2",
      confirmation: "DELETE",
    });
    console.log(JSON.stringify({ passport: passport.payload, result }, null, 2));
    return;
  }

  if (scenario === "approve") {
    const passport = await createPassport(ports, "Generate a revenue report for sales-q1.", {
      toolScopes: [
        "list_datasets",
        "get_dataset_overview",
        "read_dataset_rows",
        "generate_report",
        "export_customer_emails",
      ],
    });
    const pendingCall = mcpCall(ports, passport.token, "export_customer_emails", {
      datasetId: "sales-q1",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const approvals = await pollApprovals();
    if (approvals.pending[0]) {
      await decideApproval(approvals.pending[0].id, true);
    }
    const result = await pendingCall;
    console.log(JSON.stringify({ passport: passport.payload, approvals, result }, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
