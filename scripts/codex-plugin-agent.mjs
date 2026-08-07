#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const nodePath = process.execPath;
const serviceUrl = `http://127.0.0.1:${process.env.CODEX_TASKBOARD_PORT || "47824"}`;
const injectorUsesExternalServer = process.env.DASHI_TASKBOARD_EXTERNAL_SERVER === "1";
let stopping = false;
let child = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function reachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return response.ok;
  } catch {
    return false;
  }
}

function spawnNode(args) {
  const started = spawn(nodePath, args, {
    cwd: projectRoot,
    env: process.env,
    stdio: "inherit",
  });
  child = started;
  started.once("exit", () => {
    if (child === started) child = null;
  });
  return started;
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

async function hasDebuggableCodex() {
  const ports = [9229, 9231];
  for (const port of ports) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1000),
      });
      if (!response.ok) continue;
      const targets = await response.json();
      if (targets.some((target) => (
        target.type === "page"
        && target.webSocketDebuggerUrl
        && (target.url?.startsWith("app://") || target.title === "Codex")
      ))) return true;
    } catch {}
  }
  return false;
}

async function waitForChildExit() {
  if (!child) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

async function runServerAgent() {
  while (!stopping) {
    if (await reachable(`${serviceUrl}/health`)) {
      await sleep(5000);
      continue;
    }
    const server = spawnNode([path.join(projectRoot, "server", "index.mjs")]);
    await waitForChildExit();
    if (!stopping) await sleep(2000);
  }
}

async function runInjectorAgent() {
  let launchedCodexThisRun = false;
  while (!stopping) {
    if (!(await reachable(`${serviceUrl}/health`))) {
      await sleep(3000);
      continue;
    }
    if (await hasDebuggableCodex()) {
      spawnNode([
        path.join(projectRoot, "scripts", "codex-injector.mjs"),
        "--daemon",
        "--open",
        ...(injectorUsesExternalServer ? ["--no-server"] : []),
      ]);
      await waitForChildExit();
      await sleep(5000);
      continue;
    }
    if (!codexIsRunning() && !launchedCodexThisRun) {
      launchedCodexThisRun = true;
      spawnNode([
        path.join(projectRoot, "scripts", "codex-injector.mjs"),
        "--launch",
        "--watch",
        "--open",
        ...(injectorUsesExternalServer ? ["--no-server"] : []),
      ]);
      await waitForChildExit();
      await sleep(3000);
      continue;
    }
    if (!codexIsRunning()) {
      console.error("Codex is not running; waiting without relaunching because Codex was already launched once in this agent session.");
      await sleep(10000);
      continue;
    }
    console.error("Codex is running without a debuggable port; quit Codex completely and start it again for automatic injection.");
    await sleep(10000);
  }
}

process.once("SIGINT", () => {
  stopping = true;
  child?.kill("SIGTERM");
});
process.once("SIGTERM", () => {
  stopping = true;
  child?.kill("SIGTERM");
});

const mode = process.argv[2];
if (mode === "server") {
  await runServerAgent();
} else if (mode === "injector") {
  await runInjectorAgent();
} else {
  console.error("Usage: codex-plugin-agent.mjs <server|injector>");
  process.exitCode = 1;
}
