#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injectorLabel = "com.dashi-taskboard.codex-injector";
const serverLabel = "com.dashi-taskboard.server";
const candidatePorts = [9229, 9231];
const appPath = "/Applications/ChatGPT.app";
const taskboardHealthUrl = "http://127.0.0.1:47823/health";

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function mainCodexProcesses() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) return [];
  return result.stdout.split("\n")
    .map((line) => line.trim())
    .filter((line) => (
      /^\d+\s+\/Applications\/(?:ChatGPT|Codex)\.app\/Contents\/MacOS\/(?:ChatGPT|Codex)(?:\s|$)/.test(line)
    ));
}

async function debuggableCodexPort() {
  for (const port of candidatePorts) {
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
      ))) return port;
    } catch {}
  }
  return null;
}

async function waitForDebuggableCodex(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = await debuggableCodexPort();
    if (port) return port;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function waitForNoMainCodex(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (mainCodexProcesses().length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function taskboardHealthy() {
  try {
    const response = await fetch(taskboardHealthUrl, {
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForTaskboard(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await taskboardHealthy()) return true;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return false;
}

function launchAgentInstalled(label) {
  const result = spawnSync("/bin/launchctl", [
    "print",
    `gui/${process.getuid()}/${label}`,
  ], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

async function ensureTaskboardService() {
  if (await taskboardHealthy()) return;
  if (!launchAgentInstalled(serverLabel)) {
    throw new Error("The Dashi Taskboard server LaunchAgent is not installed. Run npm run install:codex-plugin first.");
  }
  run("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${serverLabel}`]);
  if (!(await waitForTaskboard(15_000))) {
    throw new Error("Timed out waiting for the Dashi Taskboard server. Run npm run doctor:codex-plugin for details.");
  }
}

function quitCodexApps() {
  for (const appName of ["ChatGPT", "Codex"]) {
    spawnSync("/usr/bin/osascript", [
      "-e",
      `tell application ${JSON.stringify(appName)} to quit`,
    ], {
      encoding: "utf8",
      stdio: "pipe",
    });
  }
}

function runPanelOpen(port) {
  run(process.execPath, [
    path.join(projectRoot, "scripts", "codex-injector.mjs"),
    "--port",
    String(port),
    "--open",
    "--no-server",
  ], { stdio: "inherit" });
}

function runPanelDaemon(port) {
  run(process.execPath, [
    path.join(projectRoot, "scripts", "codex-injector.mjs"),
    "--daemon",
    "--open",
    "--port",
    String(port),
    "--no-server",
  ], { stdio: "inherit" });
}

function launchTaskboardCodex(port) {
  run("/usr/bin/open", [
    "-a",
    appPath,
    "--args",
    `--remote-debugging-port=${port}`,
    `--remote-allow-origins=http://127.0.0.1:${port}`,
  ]);
}

async function openTaskboardCodex() {
  if (process.platform !== "darwin") {
    throw new Error("open:codex-taskboard currently supports the macOS installed path.");
  }
  await ensureTaskboardService();

  const existingPort = await debuggableCodexPort();
  if (existingPort) {
    runPanelOpen(existingPort);
    runPanelDaemon(existingPort);
    console.log(JSON.stringify({ ok: true, action: "opened-and-attached", port: existingPort }, null, 2));
    return;
  }

  const runningCodex = mainCodexProcesses();
  if (runningCodex.length > 0) {
    quitCodexApps();
    if (!(await waitForNoMainCodex(20_000))) {
      throw new Error("Codex/ChatGPT is still running. Completely quit it, then run dashi-codex again.");
    }
    const port = 9229;
    launchTaskboardCodex(port);
    const launchedPort = await waitForDebuggableCodex(45_000);
    if (!launchedPort) {
      throw new Error("Timed out reopening Codex in Taskboard mode. Run npm run doctor:codex-plugin for details.");
    }
    runPanelOpen(launchedPort);
    runPanelDaemon(launchedPort);
    console.log(JSON.stringify({ ok: true, action: "restarted-in-taskboard-mode", port: launchedPort }, null, 2));
    return;
  }

  if (!launchAgentInstalled(injectorLabel)) {
    throw new Error("The Dashi Taskboard injector LaunchAgent is not installed. Run npm run install:codex-plugin first.");
  }

  run("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${injectorLabel}`]);
  const launchedPort = await waitForDebuggableCodex(45_000);
  if (!launchedPort) {
    throw new Error("Timed out waiting for Codex to open in Taskboard mode. Run npm run doctor:codex-plugin for details.");
  }
  runPanelOpen(launchedPort);
  runPanelDaemon(launchedPort);
  console.log(JSON.stringify({ ok: true, action: "launched", port: launchedPort }, null, 2));
}

openTaskboardCodex().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
