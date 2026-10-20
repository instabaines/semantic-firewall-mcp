import Fastify from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import {
  deleteDataset,
  exportCustomerEmails,
  getDataset,
  getDatasetOverview,
  listDatasets,
  listReports,
  readDatasetRows,
  saveReport,
} from "./demo-db.js";
import { eventBus } from "../dashboard/event-bus.js";
import { verifyProtectedResourceRequest } from "./auth.js";
import { checkResourceBinding, checkResourceReadBinding, checkToolScope } from "../semantic-proxy/policy-engine.js";

function renderReportMarkdown(dataset, overview, objective, rows) {
  const topRegions = [...rows]
    .reduce((acc, row) => {
      acc.set(row.region, (acc.get(row.region) || 0) + row.amount);
      return acc;
    }, new Map());

  const ranking = [...topRegions.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([region, amount]) => `${region}: $${amount.toFixed(2)}`)
    .join(", ");

  return [
    `# ${dataset.name} Report`,
    "",
    `Objective: ${objective}`,
    "",
    `Total revenue: $${overview.totalRevenue}`,
    `Average deal size: $${overview.averageDealSize}`,
    `Coverage window: ${overview.firstOrderDate} to ${overview.lastOrderDate}`,
    "",
    `Top regional revenue: ${ranking || "No data"}`,
  ].join("\n");
}

function buildMcpServer(config) {
  const server = new McpServer({
    name: "hardened-demo-mcp",
    version: "1.0.0",
  });

  for (const dataset of listDatasets(config)) {
    server.registerResource(
      `${dataset.id}-resource`,
      dataset.uri,
      { mimeType: "application/json", description: dataset.description },
      async () => ({
        contents: [
          {
            uri: dataset.uri,
            text: JSON.stringify({
              id: dataset.id,
              name: dataset.name,
              description: dataset.description,
              rowCount: dataset.rowCount,
              totalRevenue: dataset.totalRevenue,
            }, null, 2),
          },
        ],
      }),
    );
  }

  server.registerTool("list_datasets", {
    description: "List datasets available for analysis and reporting.",
    inputSchema: {},
  }, async () => {
    const datasets = listDatasets(config);
    eventBus.publish("mcp.tool_executed", { tool: "list_datasets", datasets: datasets.length });
    return {
      content: [{ type: "text", text: `Found ${datasets.length} datasets.` }],
      structuredContent: { datasets },
    };
  });

  server.registerTool("get_dataset_overview", {
    description: "Return aggregate metrics for a dataset.",
    inputSchema: {
      datasetId: z.string().describe("Dataset identifier such as sales-q1"),
    },
  }, async ({ datasetId }) => {
    const dataset = getDataset(config, datasetId);
    const overview = getDatasetOverview(config, datasetId);
    if (!dataset || !overview) {
      return { content: [{ type: "text", text: `Dataset ${datasetId} not found.` }], isError: true };
    }

    eventBus.publish("mcp.tool_executed", { tool: "get_dataset_overview", datasetId });
    return {
      content: [{ type: "text", text: `Overview ready for ${dataset.name}.` }],
      structuredContent: { dataset, overview },
    };
  });

  server.registerTool("read_dataset_rows", {
    description: "Read a limited sample of dataset rows.",
    inputSchema: {
      datasetId: z.string().describe("Dataset identifier such as sales-q1"),
      limit: z.number().int().min(1).max(20).default(5),
    },
  }, async ({ datasetId, limit }) => {
    const rows = readDatasetRows(config, datasetId, limit);
    eventBus.publish("mcp.tool_executed", { tool: "read_dataset_rows", datasetId, limit });
    return {
      content: [{ type: "text", text: `Read ${rows.length} rows from ${datasetId}.` }],
      structuredContent: { datasetId, rows },
    };
  });

  server.registerTool("generate_report", {
    description: "Generate a markdown revenue report for a dataset.",
    inputSchema: {
      datasetId: z.string().describe("Dataset identifier such as sales-q1"),
      objective: z.string().describe("User's reporting objective"),
    },
  }, async ({ datasetId, objective }) => {
    const dataset = getDataset(config, datasetId);
    const overview = getDatasetOverview(config, datasetId);
    const rows = readDatasetRows(config, datasetId, 10);
    if (!dataset || !overview) {
      return { content: [{ type: "text", text: `Dataset ${datasetId} not found.` }], isError: true };
    }

    const markdown = renderReportMarkdown(dataset, overview, objective, rows);
    const report = saveReport(config, { datasetId, objective, markdown });
    eventBus.publish("mcp.tool_executed", { tool: "generate_report", datasetId, reportId: report.id });
    return {
      content: [{ type: "text", text: `Report ${report.id} created for ${dataset.name}.` }],
      structuredContent: { report },
    };
  });

  server.registerTool("export_customer_emails", {
    description: "Export customer email addresses from a dataset.",
    inputSchema: {
      datasetId: z.string().describe("Dataset identifier such as sales-q1"),
    },
  }, async ({ datasetId }) => {
    const rows = exportCustomerEmails(config, datasetId);
    eventBus.publish("mcp.tool_executed", { tool: "export_customer_emails", datasetId, count: rows.length });
    return {
      content: [{ type: "text", text: `Exported ${rows.length} customer emails from ${datasetId}.` }],
      structuredContent: { datasetId, emails: rows },
    };
  });

  server.registerTool("delete_dataset", {
    description: "Delete a dataset and all associated rows and reports.",
    inputSchema: {
      datasetId: z.string().describe("Dataset identifier such as sales-q1"),
      confirmation: z.string().describe("Must equal DELETE to execute"),
    },
  }, async ({ datasetId, confirmation }) => {
    if (confirmation !== "DELETE") {
      return {
        content: [{ type: "text", text: "Deletion aborted: confirmation must equal DELETE." }],
        isError: true,
      };
    }

    deleteDataset(config, datasetId);
    eventBus.publish("mcp.tool_executed", { tool: "delete_dataset", datasetId });
    return {
      content: [{ type: "text", text: `Dataset ${datasetId} deleted.` }],
      structuredContent: { datasetId, deleted: true },
    };
  });

  server.registerTool("list_reports", {
    description: "List generated reports in the demo environment.",
    inputSchema: {},
  }, async () => ({
    content: [{ type: "text", text: "Reports listed." }],
    structuredContent: { reports: listReports(config) },
  }));

  return server;
}

// Diagram box: Protected MCP Server / Tools
export function buildProtectedServer(config) {
  const app = Fastify({ logger: { level: config.logLevel } });

  // Keep the exact request bytes: the proof's body hash is checked against them.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, raw, done) => {
    request.rawBody = raw;
    try {
      done(null, JSON.parse(raw));
    } catch (error) {
      error.statusCode = 400;
      done(error);
    }
  });

  app.post("/mcp", async (request, reply) => {
    let authContext;
    try {
      authContext = verifyProtectedResourceRequest({ config, request });
    } catch (error) {
      return reply.code(401).send({
        jsonrpc: "2.0",
        id: request.body?.id ?? null,
        error: {
          code: 401,
          message: error.message,
        },
      });
    }

    // Defense in depth: the resource server re-checks scope and resource binding
    // from the passport, so a proxy misconfiguration cannot widen access.
    const rpc = request.body;
    const passport = authContext.passport;
    const scopeError = Array.isArray(rpc)
      ? "Batch requests are not accepted"
      : rpc?.method === "tools/call" && !checkToolScope(passport, rpc.params?.name)
        ? "Tool outside passport scope"
        : rpc?.method === "tools/call" && !checkResourceBinding(passport, { name: rpc.params?.name, arguments: rpc.params?.arguments || {} })
          ? "Resource outside passport binding"
          : rpc?.method === "resources/read" && !checkResourceReadBinding(passport, rpc.params?.uri)
            ? "Resource outside passport binding"
            : null;
    if (scopeError) {
      eventBus.publish("resource.denied", { reason: scopeError });
      return reply.code(403).send({
        jsonrpc: "2.0",
        id: Array.isArray(rpc) ? null : rpc?.id ?? null,
        error: { code: 403, message: scopeError },
      });
    }

    eventBus.publish("resource.auth_verified", {
      audience: authContext.audience,
      senderConstraintThumbprint: authContext.senderConstraintThumbprint,
      dpopVerified: authContext.dpopVerified,
    });

    const server = buildMcpServer(config);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    await server.connect(transport);
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
    reply.raw.on("close", async () => {
      await transport.close();
      await server.close();
    });
  });

  app.get("/api/demo-state", async () => ({
    datasets: listDatasets(config),
    reports: listReports(config),
  }));

  return app;
}
