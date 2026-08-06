#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const injectorLabel = "com.dashi-taskboard.codex-injector";
const candidatePorts = [9229, 9231];

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

function launchAgentInstalled() {
  const result = spawnSync("/bin/launchctl", [
    "print",
    `gui/${process.getuid()}/${injectorLabel}`,
  ], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

async function openTaskboardCodex() {
  if (process.platform !== "darwin") {
    throw new Error("open:codex-taskboard currently supports the macOS installed path.");
  }

  const existingPort = await debuggableCodexPort();
  if (existingPort) {
    run(process.execPath, [
      path.join(projectRoot, "scripts", "codex-injector.mjs"),
      "--daemon",
      "--open",
      "--port",
      String(existingPort),
    ], { stdio: "inherit" });
    console.log(JSON.stringify({ ok: true, action: "attached", port: existingPort }, null, 2));
    return;
  }

  const runningCodex = mainCodexProcesses();
  if (runningCodex.length > 0) {
    throw new Error([
      "Codex/ChatGPT is already open in normal mode, so the Taskboard panel cannot be injected.",
      "Completely quit Codex/ChatGPT first, then run dashi-codex or npm run open:codex-taskboard again.",
    ].join("\n"));
  }

  if (!launchAgentInstalled()) {
    throw new Error("The Dashi Taskboard injector LaunchAgent is not installed. Run npm run install:codex-plugin first.");
  }

  run("/bin/launchctl", ["kickstart", "-k", `gui/${process.getuid()}/${injectorLabel}`]);
  const launchedPort = await waitForDebuggableCodex(45_000);
  if (!launchedPort) {
    throw new Error("Timed out waiting for Codex to open in Taskboard mode. Run npm run doctor:codex-plugin for details.");
  }
  run(process.execPath, [
    path.join(projectRoot, "scripts", "codex-injector.mjs"),
    "--daemon",
    "--open",
    "--port",
    String(launchedPort),
  ], { stdio: "inherit" });
  console.log(JSON.stringify({ ok: true, action: "launched", port: launchedPort }, null, 2));
}

openTaskboardCodex().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
