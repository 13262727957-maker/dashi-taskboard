#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const screenshotPath = path.join(projectRoot, ".data", "codex-taskboard-panel-proof.png");
const ports = (process.env.CODEX_TASKBOARD_CODEX_PORTS || "9229,9231")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isInteger(value) && value > 0 && value <= 65535);

async function codexTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return [];
    const targets = await response.json();
    return Array.isArray(targets)
      ? targets.filter((target) => (
        target.type === "page"
        && target.webSocketDebuggerUrl
        && (target.url?.startsWith("app://") || target.title === "Codex")
      ))
      : [];
  } catch {
    return [];
  }
}

function codexIsRunning() {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) return false;
  return result.stdout.split("\n").some((command) => (
    /\/Applications\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)$/.test(command.trim())
  ));
}

async function main() {
  for (const port of ports) {
    const targets = await codexTargets(port);
    if (targets.length === 0) continue;
    const result = spawnSync(process.execPath, [
      path.join(projectRoot, "scripts", "codex-injector.mjs"),
      "--port",
      String(port),
      "--open",
      "--screenshot",
      screenshotPath,
    ], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "inherit",
    });
    process.exitCode = result.status ?? 1;
    return;
  }

  if (codexIsRunning()) {
    console.error("Codex is running without a debuggable port. Completely quit Codex, start it again, then rerun this command.");
  } else {
    console.error("No debuggable Codex window found. Start Codex after installing the plugin, then rerun this command.");
  }
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
