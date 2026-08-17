import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const pipeName = `\\\\.\\pipe\\dashi-taskboard-panel-${String(process.env.USERNAME ?? "user").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const url = process.argv[2] || "http://127.0.0.1:47824/?host=agent";
const idleTimeoutMs = 60_000;

const browsers = [
  path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env.PROGRAMFILES ?? "C:\\Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
  path.join(process.env.LOCALAPPDATA ?? "", "Microsoft", "Edge", "Application", "msedge.exe"),
];

function focusOrOpen(targetUrl) {
  const escapedUrl = targetUrl.replaceAll("'", "''");
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
$panel = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*--app=${escapedUrl}*' }
if ($panel) {
  $p = Get-Process -Id $panel[0].ProcessId
  if ($p.MainWindowHandle -ne 0) {
    Add-Type -AssemblyName Microsoft.VisualBasic
    [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id)
    exit 0
  }
  exit 2
}
`;
  return new Promise((resolve) => {
    const focused = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, stdio: "ignore" });
    focused.on("error", () => resolve("failed"));
    focused.on("close", (code) => {
      if (code === 0) {
        resolve("focused");
        return;
      }
      if (code === 2) {
        resolve("opening");
        return;
      }
      const browser = browsers.find((candidate) => {
        return existsSync(candidate);
      });
      if (!browser) {
        resolve("failed");
        return;
      }
      const child = spawn(browser, [`--app=${targetUrl}`], {
        detached: true,
        windowsHide: true,
        stdio: "ignore",
      });
      child.once("error", () => resolve("failed"));
      child.once("spawn", () => resolve("started"));
      child.unref();
    });
  });
}

let requestQueue = Promise.resolve();
let idleTimer = null;

function refreshIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => server.close(() => process.exit(0)), idleTimeoutMs);
  idleTimer.unref();
}

const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      try {
        const message = JSON.parse(line);
        if (message.type !== "open") continue;
        requestQueue = requestQueue.then(async () => {
          refreshIdleTimer();
          const result = await focusOrOpen(message.url || url);
          if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: result !== "failed", result })}\n`);
          return result;
        }).catch(() => {
          if (!socket.destroyed) socket.write(`${JSON.stringify({ ok: false, result: "failed" })}\n`);
        });
      } catch {}
    }
  });
  socket.on("end", () => {
    if (!socket.destroyed) socket.end();
  });
});

server.on("error", () => process.exit(0));
server.listen(pipeName, () => {
  // Keep this process alive as the single window coordinator.
  refreshIdleTimer();
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
