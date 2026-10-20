import { request } from "undici";
import { config } from "../runtime/config.js";
import { readRuntimeEnv } from "../runtime/active-stack.js";

const runtime = readRuntimeEnv();
const ports = {
  proxyPort: Number(process.env.PROXY_PORT || runtime?.proxyPort || config.proxyPort),
  orchestratorPort: Number(process.env.ORCHESTRATOR_PORT || runtime?.orchestratorPort || config.orchestratorPort),
};

async function createPassport(prompt, extra = {}) {
  const response = await request(`http://127.0.0.1:${ports.orchestratorPort}/intent-passports`, {
    method: "POST",
    // The demo plays the trusted user front end here; a real agent never holds this credential.
    headers: { "content-type": "application/json", authorization: `Bearer ${config.orchestratorClientToken}` },
    body: JSON.stringify({ prompt, ...extra }),
  });

  return response.body.json();
}

async function mcpCall(token, name, args = {}) {
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

async function listApprovals() {
  const response = await request(`http://127.0.0.1:${ports.proxyPort}/approvals`);
  return response.body.json();
}

async function approve(id) {
  await request(`http://127.0.0.1:${ports.proxyPort}/approvals/${id}/decision`, {
    method: "POST",
    // The demo plays the human approver here.
    headers: { "content-type": "application/json", "x-approver-token": config.approverToken },
    body: JSON.stringify({ approved: true, approver: "guided-attack-script" }),
  });
}

function banner(title) {
  console.log("");
  console.log("=".repeat(title.length));
  console.log(title);
  console.log("=".repeat(title.length));
}

export async function main() {
  banner("Phase 1: Legitimate Reporting Request");
  const reportPassport = await createPassport("Generate a revenue report for sales-q1.");
  console.log("Intent summary:", reportPassport.payload.summary);
  console.log("Bound resources:", reportPassport.payload.resource_indicators.join(", "));
  const allowResult = await mcpCall(reportPassport.token, "generate_report", {
    datasetId: "sales-q1",
    objective: "Summarize the strongest regional revenue performance.",
  });
  console.log(JSON.stringify(allowResult, null, 2));

  banner("Phase 2: Hijacked Cross-Resource Deletion Attempt");
  const blockResult = await mcpCall(reportPassport.token, "delete_dataset", {
    datasetId: "sales-q2",
    confirmation: "DELETE",
  });
  console.log(JSON.stringify(blockResult, null, 2));

  banner("Phase 3: Suspicious In-Scope Export Requires Human Approval");
  const riskyPassport = await createPassport("Generate a revenue report for sales-q1.", {
    toolScopes: [
      "list_datasets",
      "get_dataset_overview",
      "read_dataset_rows",
      "generate_report",
      "export_customer_emails",
    ],
  });

  const pendingCall = mcpCall(riskyPassport.token, "export_customer_emails", {
    datasetId: "sales-q1",
  });

  await new Promise((resolve) => setTimeout(resolve, 250));
  const approvals = await listApprovals();
  console.log("Pending approvals:");
  console.log(JSON.stringify(approvals, null, 2));

  if (approvals.pending[0]) {
    console.log("Approving suspicious export to continue the story.");
    await approve(approvals.pending[0].id);
  }

  const approvedResult = await pendingCall;
  console.log(JSON.stringify(approvedResult, null, 2));

  console.log("");
  console.log(`Open the dashboard at http://127.0.0.1:${ports.proxyPort}/dashboard/ to narrate the timeline.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
