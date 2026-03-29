import { describe, expect, it } from "vitest";

function parseLikeModelClient(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    throw new Error("Model returned an empty response");
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return JSON.parse(fenced[1].trim());
  }

  const objectStart = trimmed.indexOf("{");
  const objectEnd = trimmed.lastIndexOf("}");
  const candidate = objectStart !== -1 && objectEnd !== -1 && objectEnd > objectStart
    ? trimmed.slice(objectStart, objectEnd + 1)
    : trimmed;

  return JSON.parse(candidate);
}

describe("model JSON parsing", () => {
  it("parses fenced JSON", () => {
    expect(parseLikeModelClient("```json\n{\"summary\":\"ok\"}\n```")).toEqual({ summary: "ok" });
  });

  it("parses wrapped JSON with leading prose", () => {
    expect(parseLikeModelClient("Here is the result:\n{\"summary\":\"ok\",\"intentType\":\"report\"}")).toEqual({
      summary: "ok",
      intentType: "report",
    });
  });

  it("can parse json embedded in chat-style content", () => {
    expect(parseLikeModelClient("Assistant:\n{\"summary\":\"ok\",\"intentType\":\"read\"}")).toEqual({
      summary: "ok",
      intentType: "read",
    });
  });

  it("can parse concatenated streamed chunks", () => {
    expect(parseLikeModelClient("{\"summary\":\"ok\",\"intentType\":\"report\"}")).toEqual({
      summary: "ok",
      intentType: "report",
    });
  });

  it("can parse json returned in a thinking field", () => {
    expect(parseLikeModelClient("{\"summary\":\"ok\",\"intentType\":\"report\",\"requestedResourceUris\":[]}")).toEqual({
      summary: "ok",
      intentType: "report",
      requestedResourceUris: [],
    });
  });
});
