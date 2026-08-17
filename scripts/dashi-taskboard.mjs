#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
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
const macosAppModeBrowsers = [
  {
    name: "Google Chrome",
    appPath: "/Applications/Google Chrome.app",
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  },
  {
    name: "Chromium",
    appPath: "/Applications/Chromium.app",
    executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
  },
  {
    name: "Microsoft Edge",
    appPath: "/Applications/Microsoft Edge.app",
    executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  },
  {
    name: "Brave Browser",
    appPath: "/Applications/Brave Browser.app",
    executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  },
];
const windowsAppModeBrowsers = [
  {
    name: "Google Chrome",
    executablePath: path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  },
  {
    name: "Google Chrome",
    executablePath: path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  },
  {
    name: "Microsoft Edge",
    executablePath: path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  },
  {
    name: "Microsoft Edge",
    executablePath: path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  },
  {
    name: "Google Chrome",
    executablePath: path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  },
  {
    name: "Microsoft Edge",
    executablePath: path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
  },
];
const linuxAppModeBrowsers = [
  { name: "Google Chrome", executablePath: "/usr/bin/google-chrome" },
  { name: "Google Chrome Stable", executablePath: "/usr/bin/google-chrome-stable" },
  { name: "Chromium", executablePath: "/usr/bin/chromium" },
  { name: "Chromium Browser", executablePath: "/usr/bin/chromium-browser" },
  { name: "Microsoft Edge", executablePath: "/usr/bin/microsoft-edge" },
  { name: "Brave Browser", executablePath: "/usr/bin/brave-browser" },
];

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

async function openPanel(url) {
  if (process.platform === "darwin") {
    for (const browser of macosAppModeBrowsers) {
      if (!existsSync(browser.appPath) || !existsSync(browser.executablePath)) continue;
      const focused = focusExistingPanelWindow(browser.name, url);
      if (focused) {
        return { method: "macos-focus-existing", browser: browser.name, url };
      }
      openBrowserAppWindow(browser.executablePath, url);
      return { method: "macos-browser-app-window", browser: browser.name, url };
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
    const broker = await openWindowsPanelViaBroker(url);
    if (broker) return { method: broker, url };
    const existing = focusExistingWindowsPanelWindow(url);
    if (existing === "focused") return { method: "windows-focus-existing", url };
    if (existing === "opening") return { method: "windows-already-opening", url };
    const lockPath = path.join(os.tmpdir(), "dashi-taskboard-panel-open.lock");
    if (!claimWindowsPanelLock(lockPath)) return { method: "windows-already-opening", url };
    for (const browser of windowsAppModeBrowsers) {
      if (!existsSync(browser.executablePath)) continue;
      openBrowserAppWindow(browser.executablePath, url, { reuseExistingProcess: true });
      setTimeout(() => {
        try { unlinkSync(lockPath); } catch {}
      }, 10000).unref();
      return { method: "windows-browser-app-window", browser: browser.name, url };
    }
    try { unlinkSync(lockPath); } catch {}
  }

  if (process.platform === "linux") {
    for (const browser of linuxAppModeBrowsers) {
      if (!existsSync(browser.executablePath)) continue;
      openBrowserAppWindow(browser.executablePath, url);
      return { method: "linux-browser-app-window", browser: browser.name, url };
    }
  }

  const opener = process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(opener, args, {
    detached: true,
    windowsHide: process.platform === "win32",
    stdio: "ignore",
  });
  child.unref();
  return { method: opener, url };
}

function windowsBrokerPipeName() {
  return `\\\\.\\pipe\\dashi-taskboard-panel-${String(process.env.USERNAME ?? "user").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function sendWindowsBrokerCommand(pipeName, message) {
  return new Promise((resolve) => {
    const socket = net.createConnection(pipeName);
    let settled = false;
    let response = "";
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(500);
    socket.on("connect", () => socket.write(`${JSON.stringify(message)}\n`));
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
      const line = response.split("\n")[0];
      try {
        const parsed = JSON.parse(line);
        finish(parsed.ok === true ? parsed.result : false);
      } catch {}
    });
    socket.on("timeout", () => finish(false));
    socket.on("error", () => finish(false));
    socket.on("close", () => finish(false));
  });
}

async function openWindowsPanelViaBroker(url) {
  const pipeName = windowsBrokerPipeName();
  const existingResult = await sendWindowsBrokerCommand(pipeName, { type: "open", url });
  if (existingResult) return `windows-broker-${existingResult}`;
  const brokerPath = path.join(projectRoot, "scripts", "windows-taskboard-broker.mjs");
  const child = spawn(nodePath, [brokerPath, url], {
    cwd: projectRoot,
    detached: true,
    windowsHide: true,
    stdio: "ignore",
  });
  child.unref();
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const result = await sendWindowsBrokerCommand(pipeName, { type: "open", url });
    if (result) return `windows-broker-${result}`;
  }
  return null;
}

function openBrowserAppWindow(executablePath, url, options = {}) {
  const args = [`--app=${url}`];
  if (!options.reuseExistingProcess) args.push("--new-window");
  const child = spawn(executablePath, args, {
    detached: true,
    windowsHide: process.platform === "win32",
    stdio: "ignore",
  });
  child.unref();
}

function windowsPanelOpenLocked(lockPath) {
  try {
    const [pidText, timestampText] = readFileSync(lockPath, "utf8").trim().split(/\s+/);
    const pid = Number(pidText);
    const timestamp = Number(timestampText);
    if (Number.isInteger(pid) && timestamp > 0 && Date.now() - timestamp < 15000) return true;
  } catch {}
  try { unlinkSync(lockPath); } catch {}
  return false;
}

function claimWindowsPanelLock(lockPath) {
  const content = `${process.pid}\n${Date.now()}\n`;
  try {
    writeFileSync(lockPath, content, { encoding: "utf8", flag: "wx" });
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    if (windowsPanelOpenLocked(lockPath)) return false;
    try {
      writeFileSync(lockPath, content, { encoding: "utf8", flag: "wx" });
      return true;
    } catch (retryError) {
      if (retryError?.code === "EEXIST") return false;
      throw retryError;
    }
  }
}

function focusExistingWindowsPanelWindow(url) {
  const escapedUrl = url.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$panelProcesses = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--app=${escapedUrl}*' }
if ($panelProcesses) {
  $panelProcess = Get-Process -Id $panelProcesses[0].ProcessId
  if ($panelProcess.MainWindowHandle -ne 0) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.Interaction]::AppActivate($panelProcess.Id)
    exit 0
  }
  exit 2
}
$processes = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -match 'Taskboard|任务面板' }
if ($processes) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  [Microsoft.VisualBasic.Interaction]::AppActivate($processes[0].Id)
  exit 0
}
exit 1
`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8",
    stdio: "pipe",
    windowsHide: true,
  });
  if (result.status === 0) return "focused";
  if (result.status === 2) return "opening";
  return "missing";
}

function focusExistingPanelWindow(browserName, url) {
  const result = spawnSync("/usr/bin/osascript", ["-e", `
set targetUrl to ${JSON.stringify(url)}
tell application "System Events"
  if not (exists process ${JSON.stringify(browserName)}) then return "not-running"
end tell
tell application ${JSON.stringify(browserName)}
  repeat with browserWindow in windows
    repeat with tabIndex from 1 to count of tabs of browserWindow
      set browserTab to tab tabIndex of browserWindow
      set tabUrl to URL of browserTab as text
      if tabUrl begins with targetUrl then
        -- Reusing the single panel window must also refresh the document;
        -- focusing the old tab alone leaves stale JS/CSS visible.
        set URL of browserTab to targetUrl
        reload browserTab
        set active tab index of browserWindow to tabIndex
        set index of browserWindow to 1
        activate
        return "focused"
      end if
    end repeat
  end repeat
end tell
return "missing"
`], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status === 0 && result.stdout.trim() === "focused") return true;
  return focusExistingPanelSystemWindow(browserName) === "focused";
}

function focusExistingPanelSystemWindow(browserName) {
  const result = spawnSync("/usr/bin/osascript", ["-e", `
set targetTitle to "Taskboard"
tell application "System Events"
  if not (exists process ${JSON.stringify(browserName)}) then return "not-running"
  tell process ${JSON.stringify(browserName)}
    -- App-mode windows can be discoverable but not focusable from AppleScript.
    -- Remove only stale Taskboard windows so the caller can create one fresh instance.
    repeat while (count of windows) > 0
      set foundPanel to false
      repeat with browserWindow in windows
        if (name of browserWindow as text) is targetTitle then
          set foundPanel to true
          try
            click button 1 of browserWindow
          on error
            try
              perform action "AXClose" of browserWindow
            end try
          end try
          exit repeat
        end if
      end repeat
      if not foundPanel then exit repeat
      delay 0.25
    end repeat
  end tell
end tell
return "missing"
`], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0 && result.stdout.trim() === "focused";
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
    usage: "dashi-taskboard <open|start|doctor>",
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
