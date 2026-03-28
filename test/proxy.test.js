import { afterEach, describe, expect, it } from "vitest";
import { config as baseConfig } from "../src/runtime/config.js";
import { issueIntentPassport } from "../src/protocol/contextual-passport.js";
import { buildInspectorServer } from "../src/inspector/server.js";
import { buildProxyServer } from "../src/semantic-proxy/server.js";

const config = {
  ...baseConfig,
  ollamaModel: "",
  requireModel: false,
  approvalTimeoutMs: 2000,
};

let proxy;
let inspector;

afterEach(async () => {
  await Promise.all([proxy?.close(), inspector?.close()]);
  proxy = undefined;
  inspector = undefined;
});

async function boot() {
  inspector = buildInspectorServer(config);
  proxy = buildProxyServer(config, {
    inspectAction: async ({ passport, toolCall }) => {
      const response = await inspector.inject({
        method: "POST",
        url: "/inspect",
        payload: {
          userIntent: passport.summary,
          originalPrompt: passport.prompt,
          tool: toolCall,
          allowedScopes: passport.tool_scopes,
          resources: passport.resource_indicators,
        },
      });
      return response.json();
    },
    forwardRpc: async (rpc) => ({
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        content: [{ type: "text", text: `Forwarded ${rpc.params.name}` }],
      },
    }),
  });

  await inspector.ready();
  await proxy.ready();
}

function passport({ toolScopes, resources, prompt = "Generate a revenue report for sales-q1." }) {
  return issueIntentPassport({
    prompt,
    summary: prompt,
    rationale: "test",
    intentType: "report",
    toolScopes,
    resources,
    sessionId: "test-session",
    config,
  }).token;
}

describe("semantic proxy", () => {
  it("allows an in-scope tool call on a bound resource", async () => {
    await boot();

    const response = await proxy.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${passport({
          toolScopes: ["generate_report"],
          resources: ["demo://datasets/sales-q1"],
        })}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "generate_report",
          arguments: { datasetId: "sales-q1", objective: "Summarize revenue." },
        },
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().result.content[0].text).toContain("Forwarded");
  });

  it("blocks a tool call that targets a different bound resource", async () => {
    await boot();

    const response = await proxy.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${passport({
          toolScopes: ["generate_report"],
          resources: ["demo://datasets/sales-q1"],
        })}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "generate_report",
          arguments: { datasetId: "sales-q2", objective: "Summarize revenue." },
        },
      },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toBe("Resource binding mismatch");
  });

  it("holds a risky but technically authorized tool until a human approves it", async () => {
    await boot();

    const pending = proxy.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${passport({
          toolScopes: ["generate_report", "export_customer_emails"],
          resources: ["demo://datasets/sales-q1"],
        })}`,
      },
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "export_customer_emails",
          arguments: { datasetId: "sales-q1" },
        },
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    const approvals = proxy.approvals.list();
    expect(approvals).toHaveLength(1);
    proxy.approvals.approve(approvals[0].id, "tester");

    const response = await pending;
    expect(response.statusCode).toBe(200);
    expect(response.json().result.content[0].text).toContain("Forwarded");
  });
});
