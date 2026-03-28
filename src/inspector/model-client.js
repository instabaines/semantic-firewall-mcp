import { request } from "undici";

// Local model gateway used by the inspector and intent summarizer.
export async function generateJsonWithModel({
  config,
  prompt,
  model = config.ollamaModel,
  maxTokens = 300,
}) {
  if (!model) {
    throw new Error("No model configured");
  }

  const response = await request(config.ollamaUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      format: "json",
      stream: false,
      options: {
        num_predict: maxTokens,
        temperature: 0.1,
      },
    }),
  });

  if (response.statusCode >= 400) {
    const body = await response.body.text();
    throw new Error(`Model request failed (${response.statusCode}): ${body}`);
  }

  const body = await response.body.json();
  const text = typeof body.response === "string" ? body.response.trim() : "";
  return JSON.parse(text);
}
