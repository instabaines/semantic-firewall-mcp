import { request } from "undici";

function parseJsonLines(rawText) {
  const lines = String(rawText || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [];
  }

  return lines.map((line) => JSON.parse(line));
}

function extractTextFromModelBody(body) {
  if (typeof body?.response === "string" && body.response.trim()) {
    return body.response.trim();
  }

  if (typeof body?.thinking === "string" && body.thinking.trim()) {
    return body.thinking.trim();
  }

  if (typeof body?.message?.content === "string" && body.message.content.trim()) {
    return body.message.content.trim();
  }

  if (typeof body?.content === "string" && body.content.trim()) {
    return body.content.trim();
  }

  if (Array.isArray(body?.output)) {
    const combined = body.output
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (typeof entry?.content === "string") {
          return entry.content;
        }
        if (typeof entry?.text === "string") {
          return entry.text;
        }
        return "";
      })
      .join("\n")
      .trim();

    if (combined) {
      return combined;
    }
  }

  if (Array.isArray(body?.content)) {
    const combined = body.content
      .map((entry) => {
        if (typeof entry === "string") {
          return entry;
        }
        if (typeof entry?.text === "string") {
          return entry.text;
        }
        return "";
      })
      .join("\n")
      .trim();

    if (combined) {
      return combined;
    }
  }

  return "";
}

function extractTextFromJsonLines(entries) {
  const combined = entries
    .map((entry) => {
      if (typeof entry?.response === "string") {
        return entry.response;
      }
      if (typeof entry?.thinking === "string") {
        return entry.thinking;
      }
      if (typeof entry?.message?.content === "string") {
        return entry.message.content;
      }
      return "";
    })
    .join("")
    .trim();

  return combined;
}

function extractJsonCandidate(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Model returned an empty response");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart) {
    return trimmed.slice(objectStart, objectEnd + 1);
  }

  return trimmed;
}

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

  const rawBody = await response.body.text();

  let text = "";
  try {
    const parsed = JSON.parse(rawBody);
    text = extractTextFromModelBody(parsed);
    if (!text) {
      throw new Error(`Model returned an empty response body: ${JSON.stringify(parsed).slice(0, 240)}`);
    }
  } catch (singleJsonError) {
    try {
      const entries = parseJsonLines(rawBody);
      text = extractTextFromJsonLines(entries);
      if (!text) {
        throw new Error(`Model returned empty streamed chunks: ${rawBody.slice(0, 240)}`);
      }
    } catch {
      throw singleJsonError;
    }
  }

  const candidate = extractJsonCandidate(text);

  try {
    return JSON.parse(candidate);
  } catch (error) {
    throw new Error(`Model returned non-JSON output: ${candidate.slice(0, 240)}`);
  }
}
