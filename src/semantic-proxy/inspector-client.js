import { request } from "undici";
import { createInspectionRequest, parseInspectionResponse } from "../protocol/inspection.js";

// Throws on transport errors, non-2xx responses, and malformed verdicts.
// The proxy turns any throw into a deny (fail closed).
export async function inspectAction({ config, passport, toolCall, history }) {
  const body = createInspectionRequest({ passport, toolCall, history });

  const response = await request(config.inspectorUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    headersTimeout: config.inspectorTimeoutMs,
    bodyTimeout: config.inspectorTimeoutMs,
  });

  const payload = await response.body.json().catch(() => null);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Inspector failed (${response.statusCode}): ${payload?.message || "no body"}`);
  }

  return parseInspectionResponse(payload);
}
