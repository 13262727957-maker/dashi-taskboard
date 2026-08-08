#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.execPath;
const serviceUrl = process.env.CODEX_TASKBOARD_URL || "http://127.0.0.1:47824";
const panelUrl = `${serviceUrl}/?host=agent`;
const serverLabel = "com.dashi-taskboard.server";
const databasePath = path.join(projectRoot, ".data", "taskboard.sqlite");
const panelProfileDir = path.join(projectRoot, ".data", "panel-browser-profile");
const macosAppModeBrowsers = [
  { name: "Google Chrome", path: "/Applications/Google Chrome.app" },
  { name: "Chromium", path: "/Applications/Chromium.app" },
  { name: "Microsoft Edge", path: "/Applications/Microsoft Edge.app" },
  { name: "Brave Browser", path: "/Applications/Brave Browser.app" },
];
const windowsAppModeBrowsers = [
  path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
];
const linuxAppModeBrowsers = ["google-chrome", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function health() {
  try {
    const response = await fetch(`${serviceUrl}/health`, {
      signal: AbortSignal.timeout(1500),
    });
    return response.ok ? await response.json() : { status: "error", httpStatus: response.status };
  } catch (error) {
    return { status: "error", error: error.message };
  }
}

async function taskSummary() {
  try {
    const response = await fetch(`${serviceUrl}/api/tasks`, {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return { taskCount: null, sample: [] };
    const body = await response.json();
    const tasks = Array.isArray(body.tasks) ? body.tasks : [];
    return {
      taskCount: tasks.length,
      sample: tasks.slice(0, 3).map((task) => ({
        identifier: task.identifier,
        title: task.title,
        status: task.status,
      })),
    };
  } catch {
    return { taskCount: null, sample: [] };
  }
}

function launchAgentInstalled(label) {
  if (process.platform !== "darwin") return false;
  const result = spawnSync("/bin/launchctl", [
    "print",
    `gui/${process.getuid()}/${label}`,
  ], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0;
}

function kickstartLaunchAgent(label) {
  const result = spawnSync("/bin/launchctl", [
    "kickstart",
    "-k",
    `gui/${process.getuid()}/${label}`,
  ], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`launchctl kickstart failed${detail ? `\n${detail}` : ""}`);
  }
}

function startDetachedServer() {
  const child = spawn(nodePath, [path.join(projectRoot, "server", "index.mjs")], {
    cwd: projectRoot,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child.pid;
}

async function waitForHealthy(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await health();
    if (current.status === "ok") return current;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return health();
}

async function ensureServer() {
  const current = await health();
  if (current.status === "ok") {
    return { health: current, started: false, method: "already-running" };
  }

  if (launchAgentInstalled(serverLabel)) {
    kickstartLaunchAgent(serverLabel);
    const afterKickstart = await waitForHealthy(15_000);
    return { health: afterKickstart, started: afterKickstart.status === "ok", method: "launch-agent" };
  }

  const pid = startDetachedServer();
  const afterSpawn = await waitForHealthy(15_000);
  return { health: afterSpawn, started: afterSpawn.status === "ok", method: "detached-server", pid };
}

function openPanel(url) {
  if (process.platform === "darwin") {
    for (const browser of macosAppModeBrowsers) {
      if (!existsSync(browser.path)) continue;
      const focusResult = spawnSync("/usr/bin/osascript", [
        "-e",
        `tell application ${JSON.stringify(browser.name)}
          repeat with candidate in windows
            repeat with candidateTab in tabs of candidate
              if (URL of candidateTab) starts with ${JSON.stringify(url)} then
                set active tab index of candidate to index of candidateTab
                set index of candidate to 1
                activate
                return "focused"
              end if
            end repeat
          end repeat
          return "not-found"
        end tell`,
      ], {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (focusResult.status === 0 && focusResult.stdout.trim() === "focused") {
        return { method: "macos-existing-browser-window", browser: browser.name, url };
      }
    }

    for (const browser of macosAppModeBrowsers) {
      if (!existsSync(browser.path)) continue;
      const appResult = spawnSync("/usr/bin/open", [
        "-a",
        browser.name,
        "--args",
        `--user-data-dir=${panelProfileDir}`,
        `--app=${url}`,
      ], {
        encoding: "utf8",
        stdio: "pipe",
      });
      if (appResult.status === 0) {
        return { method: "macos-browser-app-mode", browser: browser.name, url };
      }
    }

    const result = spawnSync("/usr/bin/open", [url], {
      encoding: "utf8",
      stdio: "pipe",
    });
    if (result.status !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
      throw new Error(`open ${url} failed${detail ? `\n${detail}` : ""}`);
    }
    return { method: "macos-default-browser", url };
  }

  if (process.platform === "win32") {
    const browser = windowsAppModeBrowsers.find((candidate) => candidate && existsSync(candidate));
    if (browser) {
      const child = spawn(browser, [
        `--user-data-dir=${panelProfileDir}`,
        `--app=${url}`,
      ], { detached: true, stdio: "ignore" });
      child.unref();
      return { method: "windows-browser-app-mode", browser, url };
    }
  }

  if (process.platform === "linux") {
    for (const browser of linuxAppModeBrowsers) {
      const result = spawnSync("/usr/bin/env", ["which", browser], { encoding: "utf8", stdio: "pipe" });
      if (result.status !== 0) continue;
      const child = spawn(result.stdout.trim(), [
        `--user-data-dir=${panelProfileDir}`,
        `--app=${url}`,
      ], { detached: true, stdio: "ignore" });
      child.unref();
      return { method: "linux-browser-app-mode", browser, url };
    }
  }

  const opener = process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: "ignore" });
  child.unref();
  return { method: opener, url };
}

async function doctor() {
  const database = await stat(databasePath).catch(() => null);
  const service = await health();
  const data = await taskSummary();
  const result = {
    ok: service.status === "ok" && Boolean(database),
    checks: {
      service,
      database: {
        path: databasePath,
        exists: Boolean(database),
        bytes: database?.size ?? 0,
      },
      panel: {
        url: panelUrl,
      },
      data,
    },
  };
  print(result);
  if (!result.ok) process.exitCode = 1;
}

async function start() {
  const server = await ensureServer();
  const ok = server.health.status === "ok";
  print({ ok, serviceUrl, server });
  if (!ok) process.exitCode = 1;
}

async function open() {
  const server = await ensureServer();
  if (server.health.status !== "ok") {
    print({ ok: false, serviceUrl, server });
    process.exitCode = 1;
    return;
  }
  const opened = openPanel(panelUrl);
  print({ ok: true, serviceUrl, panelUrl, server, opened });
}

function help() {
  print({
    ok: true,
    usage: "cj-taskboard <open|start|doctor>",
    aliases: ["cj-task-dashboard", "dashi-taskboard"],
    commands: {
      open: "Start or reuse the local Taskboard server and open the standalone panel window.",
      start: "Start or reuse the local Taskboard server.",
      doctor: "Check the local Taskboard server, database, and sample task data.",
    },
  });
}

const command = process.argv[2] || "help";
try {
  if (command === "open") await open();
  else if (command === "start") await start();
  else if (command === "doctor") await doctor();
  else if (command === "help" || command === "--help" || command === "-h") help();
  else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
