import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { request } from "undici";
import { config } from "../runtime/config.js";

const presenterPorts = {
  ...config,
  proxyPort: Number(process.env.PROXY_PORT || 4500),
  protectedPort: Number(process.env.PROTECTED_PORT || 4510),
  inspectorPort: Number(process.env.INSPECTOR_PORT || 4520),
  orchestratorPort: Number(process.env.ORCHESTRATOR_PORT || 4530),
};

function prefixedEnv() {
  return {
    ...process.env,
    PROXY_PORT: String(presenterPorts.proxyPort),
    PROTECTED_PORT: String(presenterPorts.protectedPort),
    INSPECTOR_PORT: String(presenterPorts.inspectorPort),
    ORCHESTRATOR_PORT: String(presenterPorts.orchestratorPort),
  };
}

function startStack() {
  return spawn("npm", ["start"], {
    cwd: process.cwd(),
    env: prefixedEnv(),
    stdio: "inherit",
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitFor(url, attempts = 40) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await request(url);
      if (response.statusCode < 500) {
        return true;
      }
    } catch {
      await delay(500);
    }
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function callDemo(script) {
  const child = spawn("npm", ["run", script], {
    cwd: process.cwd(),
    env: prefixedEnv(),
    stdio: "inherit",
  });

  await new Promise((resolve, reject) => {
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${script} exited with code ${code}`));
      }
    });
  });
}

export async function main() {
  const autoRun = process.env.PRESENTER_AUTO_RUN !== "0";

  console.log("");
  console.log("Presenter mode starting");
  console.log(`Dashboard: http://127.0.0.1:${presenterPorts.proxyPort}/dashboard/`);
  console.log(`Manual demo target: proxy ${presenterPorts.proxyPort}, orchestrator ${presenterPorts.orchestratorPort}`);
  console.log("");

  const stack = startStack();
  let releaseShutdownWait;
  const shutdownWait = new Promise((resolve) => {
    releaseShutdownWait = resolve;
  });

  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    releaseShutdownWait?.();
    if (!stack.killed) {
      stack.kill("SIGTERM");
    }
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    await waitFor(`http://127.0.0.1:${presenterPorts.proxyPort}/health`);
    console.log("Presenter stack is live. External demo commands will use the active runtime file.");

    if (autoRun) {
      console.log("Phase 1: benign report request");
      await callDemo("demo:allow");
      await delay(1500);

      console.log("");
      console.log("Phase 2: cross-resource attack attempt");
      await callDemo("demo:block");
      await delay(1500);

      console.log("");
      console.log("Phase 3: in-scope but suspicious export requiring approval");
      await callDemo("demo:approve");
      await delay(1000);

      console.log("");
      console.log("Scripted presenter sequence complete.");
    } else {
      console.log("Auto-run disabled. Trigger demo commands manually from another terminal.");
    }

    console.log("Presenter stack will stay up until you press Ctrl+C.");
    await shutdownWait;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    shutdown();
    await waitForExit(stack);
    process.off("SIGINT", shutdown);
    process.off("SIGTERM", shutdown);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
