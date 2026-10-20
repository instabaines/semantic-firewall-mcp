import { request } from "undici";
import { createInspectionRequest } from "../protocol/inspection.js";

export async function inspectAction({ config, passport, toolCall }) {
  const body = createInspectionRequest({ passport, toolCall });

  const response = await request(config.inspectorUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });

  return response.body.json();
}

