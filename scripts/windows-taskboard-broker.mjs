import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import net from "node:net";
import path from "node:path";

const pipeName = `\\\\.\\pipe\\dashi-taskboard-panel-${String(process.env.USERNAME ?? "user").replace(/[^a-zA-Z0-9_-]/g, "_")}`;
const url = process.argv[2] || "http://127.0.0.1:47824/?host=agent";

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
  const focused = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], { windowsHide: true, stdio: "ignore" });
  focused.on("close", (code) => {
    if (code === 0 || code === 2) return;
    const browser = browsers.find((candidate) => {
      return existsSync(candidate);
    });
    if (!browser) return;
    const child = spawn(browser, [`--app=${targetUrl}`], {
      detached: true,
      windowsHide: false,
      stdio: "ignore",
    });
    child.unref();
  });
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
        if (message.type === "open") focusOrOpen(message.url || url);
      } catch {}
    }
  });
  socket.end("ok\n");
});

server.on("error", () => process.exit(0));
server.listen(pipeName, () => {
  // Keep this process alive as the single window coordinator.
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
