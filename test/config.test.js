import { describe, expect, it } from "vitest";
import { resolveOllamaUrl } from "../src/runtime/config.js";

describe("resolveOllamaUrl", () => {
  it("adds the default Ollama port when only a host is provided", () => {
    expect(resolveOllamaUrl({ OLLAMA_HOST: "192.168.0.141" })).toBe("http://192.168.0.141:11434/api/generate");
  });

  it("preserves an explicit host and port", () => {
    expect(resolveOllamaUrl({ OLLAMA_HOST: "192.168.0.141:11434" })).toBe("http://192.168.0.141:11434/api/generate");
  });

  it("prefers a fully specified OLLAMA_URL", () => {
    expect(resolveOllamaUrl({ OLLAMA_URL: "http://192.168.0.141:11434/api/generate" })).toBe("http://192.168.0.141:11434/api/generate");
  });
});
