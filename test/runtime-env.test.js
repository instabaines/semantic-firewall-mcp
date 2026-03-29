import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getRuntimeFilePath, readRuntimeEnv } from "../src/runtime/active-stack.js";

const runtimeFile = getRuntimeFilePath();

afterEach(() => {
  if (fs.existsSync(runtimeFile)) {
    fs.unlinkSync(runtimeFile);
  }
});

describe("active runtime discovery", () => {
  it("ignores a stale runtime file whose pid is no longer alive", () => {
    fs.mkdirSync(path.dirname(runtimeFile), { recursive: true });
    fs.writeFileSync(runtimeFile, JSON.stringify({
      proxyPort: 4000,
      orchestratorPort: 4300,
      pid: 999999,
    }));

    expect(readRuntimeEnv()).toBeNull();
  });
});
