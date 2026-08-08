#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  defaultTaskboardDataDirectory,
  defaultTaskboardPanelProfileDirectory,
} from "../shared/taskboard-paths.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodePath = process.execPath;
const serviceUrl = process.env.CODEX_TASKBOARD_URL || "http://127.0.0.1:47824";
const panelUrl = `${serviceUrl}/?host=agent`;
const serverLabel = "com.dashi-taskboard.server";
const dataDir = process.env.CODEX_TASKBOARD_DATA_DIR
  ? path.resolve(process.env.CODEX_TASKBOARD_DATA_DIR)
  : defaultTaskboardDataDirectory();
const databasePath = path.join(dataDir, "taskboard.sqlite");
const panelProfileDir = defaultTaskboardPanelProfileDirectory();
const panelLaunchLockDir = path.join(dataDir, "panel-launch.lock");
const panelDebugPort = Number(process.env.CODEX_TASKBOARD_PANEL_DEBUG_PORT || "47825");
const macosAppModeBrowsers = [
  {
    name: "Google Chrome",
    path: "/Applications/Google Chrome.app",
    executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  {
    name: "Chromium",
    path: "/Applications/Chromium.app",
    executable: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  },
  {
    name: "Microsoft Edge",
    path: "/Applications/Microsoft Edge.app",
    executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  },
  {
    name: "Brave Browser",
    path: "/Applications/Brave Browser.app",
    executable: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  },
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function existingPanelTarget() {
  if (!Number.isInteger(panelDebugPort) || panelDebugPort < 1 || panelDebugPort > 65535) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${panelDebugPort}/json/list`, {
      signal: AbortSignal.timeout(600),
    });
    if (!response.ok) return null;
    const targets = await response.json();
    const target = Array.isArray(targets)
      ? targets.find((candidate) => typeof candidate?.url === "string" && candidate.url.startsWith(panelUrl))
      : null;
    if (!target?.id) return null;
    return { targetId: target.id };
  } catch {
    return null;
  }
}

async function activateExistingPanelTarget() {
  const target = await existingPanelTarget();
  if (!target) return null;
  try {
    const activateResponse = await fetch(
      `http://127.0.0.1:${panelDebugPort}/json/activate/${encodeURIComponent(target.targetId)}`,
      { signal: AbortSignal.timeout(600) },
    );
    if (!activateResponse.ok) return null;
    bringWindowsPanelWindowToFront();
    return target;
  } catch {
    return null;
  }
}

function bringWindowsPanelWindowToFront() {
  if (process.platform !== "win32") return;
  spawnSync("powershell.exe", [
    "-NoProfile",
    "-WindowStyle",
    "Hidden",
    "-Command",
    "Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate('Taskboard') | Out-Null",
  ], {
    encoding: "utf8",
    stdio: "ignore",
    windowsHide: true,
  });
}

async function waitForExistingPanelTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  do {
    const existingPanel = await existingPanelTarget();
    if (existingPanel) return existingPanel;
    await sleep(200);
  } while (Date.now() < deadline);
  return null;
}

async function acquirePanelLaunchLock() {
  await mkdir(dataDir, { recursive: true });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await mkdir(panelLaunchLockDir);
      return {
        acquired: true,
        release: () => rm(panelLaunchLockDir, { recursive: true, force: true }),
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const lockStat = await stat(panelLaunchLockDir).catch(() => null);
      if (lockStat && Date.now() - lockStat.mtimeMs > 15_000) {
        await rm(panelLaunchLockDir, { recursive: true, force: true });
        continue;
      }
      const existingPanel = await waitForExistingPanelTarget(1_500);
      if (existingPanel) {
        return {
          acquired: false,
          existingPanel,
          release: async () => {},
        };
      }
    }
  }
  return {
    acquired: false,
    release: async () => {},
  };
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

function launchPanelBrowser(url) {
  if (process.platform === "darwin") {
    for (const browser of macosAppModeBrowsers) {
      if (!existsSync(browser.executable)) continue;
      const child = spawn(browser.executable, [
        `--user-data-dir=${panelProfileDir}`,
        `--remote-debugging-port=${panelDebugPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--app=${url}`,
      ], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      return { method: "macos-browser-app-mode", browser: browser.name, debugPort: panelDebugPort, url };
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
        `--remote-debugging-port=${panelDebugPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--app=${url}`,
      ], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      return { method: "windows-browser-app-mode", browser, debugPort: panelDebugPort, url };
    }
  }

  if (process.platform === "linux") {
    for (const browser of linuxAppModeBrowsers) {
      const result = spawnSync("/usr/bin/env", ["which", browser], { encoding: "utf8", stdio: "pipe" });
      if (result.status !== 0) continue;
      const child = spawn(result.stdout.trim(), [
        `--user-data-dir=${panelProfileDir}`,
        `--remote-debugging-port=${panelDebugPort}`,
        "--remote-debugging-address=127.0.0.1",
        `--app=${url}`,
      ], { detached: true, stdio: "ignore", windowsHide: true });
      child.unref();
      return { method: "linux-browser-app-mode", browser, debugPort: panelDebugPort, url };
    }
  }

  const opener = process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  return { method: opener, url };
}

async function openPanel(url) {
  const existingPanel = await waitForExistingPanelTarget(1_200);
  if (existingPanel) {
    await activateExistingPanelTarget();
    return {
      method: "existing-panel-app-window",
      debugPort: panelDebugPort,
      url,
      ...existingPanel,
    };
  }

  const lock = await acquirePanelLaunchLock();
  try {
    if (lock.existingPanel) {
      await activateExistingPanelTarget();
      return {
        method: "existing-panel-app-window",
        debugPort: panelDebugPort,
        url,
        ...lock.existingPanel,
      };
    }

    const existingAfterLock = await waitForExistingPanelTarget(800);
    if (existingAfterLock) {
      await activateExistingPanelTarget();
      return {
        method: "existing-panel-app-window",
        debugPort: panelDebugPort,
        url,
        ...existingAfterLock,
      };
    }

    if (!lock.acquired) {
      const existingAfterWait = await waitForExistingPanelTarget(5_000);
      if (existingAfterWait) {
        await activateExistingPanelTarget();
        return {
          method: "existing-panel-app-window",
          debugPort: panelDebugPort,
          url,
          ...existingAfterWait,
        };
      }
      return {
        method: "panel-launch-skipped-lock-busy",
        debugPort: panelDebugPort,
        url,
      };
    }

    const launched = launchPanelBrowser(url);
    const launchedTarget = launched.debugPort
      ? await waitForExistingPanelTarget(5_000)
      : null;
    if (launchedTarget) await activateExistingPanelTarget();
    return launchedTarget
      ? { ...launched, targetId: launchedTarget.targetId }
      : launched;
  } finally {
    await lock.release();
  }
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
  const opened = await openPanel(panelUrl);
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
