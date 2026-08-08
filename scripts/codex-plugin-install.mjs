#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { cp, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const pluginName = "dashi-taskboard";
const pluginSource = path.join(projectRoot, "plugins", pluginName);
const pluginInstallRoot = path.join(os.homedir(), "plugins");
const pluginInstallPath = path.join(pluginInstallRoot, pluginName);
const marketplacePath = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const serverPlistPath = path.join(launchAgentsDir, "com.dashi-taskboard.server.plist");
const injectorPlistPath = path.join(launchAgentsDir, "com.dashi-taskboard.codex-injector.plist");
const userBinDir = path.join(os.homedir(), ".local", "bin");
const taskctlPath = path.join(userBinDir, "taskctl");
const dashiTaskboardPath = path.join(userBinDir, "dashi-taskboard");
const cjTaskboardPath = path.join(userBinDir, "cj-taskboard");
const cjTaskDashboardPath = path.join(userBinDir, "cj-task-dashboard");
const taskctlCmdPath = path.join(userBinDir, "taskctl.cmd");
const dashiTaskboardCmdPath = path.join(userBinDir, "dashi-taskboard.cmd");
const cjTaskboardCmdPath = path.join(userBinDir, "cj-taskboard.cmd");
const cjTaskDashboardCmdPath = path.join(userBinDir, "cj-task-dashboard.cmd");
const dashiCodexPath = path.join(userBinDir, "dashi-codex");
const codexSkillsDir = path.join(os.homedir(), ".codex", "skills");
const legacySkillPath = path.join(codexSkillsDir, "manage-taskboard");
const nodePath = process.execPath;
const managedMarker = "Managed by dashi-taskboard Codex plugin installer.";
const taskctlCliPath = path.join(projectRoot, "cli", "taskctl.mjs");
const dashiTaskboardCliPath = path.join(projectRoot, "scripts", "dashi-taskboard.mjs");
const openScriptPath = path.join(projectRoot, "scripts", "codex-plugin-open.mjs");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function executablePath(command) {
  if (process.platform === "win32") {
    const result = spawnSync("where.exe", [command], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: "pipe",
    });
    return result.status === 0 ? result.stdout.split(/\r?\n/).find(Boolean)?.trim() ?? null : null;
  }

  const result = spawnSync("/usr/bin/env", ["which", command], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function requiredExecutablePath(command) {
  const resolved = executablePath(command);
  if (!resolved) {
    throw new Error(`Cannot find ${command}. Make sure it is installed and available in your terminal PATH.`);
  }
  return resolved;
}

function launchAgentPath(codexExecutable) {
  const entries = [
    userBinDir,
    path.dirname(codexExecutable),
    "/usr/local/bin",
    "/opt/homebrew/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return [...new Set(entries.filter(Boolean))].join(":");
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function plist(label, args, environment = {}) {
  const envEntries = Object.entries(environment).map(([key, value]) => `
    <key>${xml(key)}</key>
    <string>${xml(value)}</string>`).join("");
  const argEntries = args.map((arg) => `
    <string>${xml(arg)}</string>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(label)}</string>
  <key>WorkingDirectory</key>
  <string>${xml(projectRoot)}</string>
  <key>ProgramArguments</key>
  <array>${argEntries}
  </array>
  <key>EnvironmentVariables</key>
  <dict>${envEntries}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(path.join(projectRoot, ".data", `${label}.out.log`))}</string>
  <key>StandardErrorPath</key>
  <string>${xml(path.join(projectRoot, ".data", `${label}.err.log`))}</string>
</dict>
</plist>
`;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

async function installPluginSource() {
  await rm(pluginInstallPath, { recursive: true, force: true });
  await mkdir(pluginInstallRoot, { recursive: true });
  await cp(pluginSource, pluginInstallPath, { recursive: true });
}

async function installLegacySkillLink() {
  await mkdir(codexSkillsDir, { recursive: true });
  const target = path.join(pluginInstallPath, "skills", "manage-taskboard");
  let existing = null;
  try {
    existing = await lstat(legacySkillPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new Error(`${legacySkillPath} already exists and is not managed by this installer. Move it away before installing.`);
    }
    const currentTarget = await readlink(legacySkillPath);
    if (path.resolve(path.dirname(legacySkillPath), currentTarget) !== target) {
      throw new Error(`${legacySkillPath} points to ${currentTarget}, not this plugin. Move it away before installing.`);
    }
    await rm(legacySkillPath, { force: true });
  }
  await symlink(target, legacySkillPath, process.platform === "win32" ? "junction" : "dir");
  return legacySkillPath;
}

async function installCommandShim(targetPath, cmdPath, scriptPath) {
  await mkdir(userBinDir, { recursive: true });
  if (process.platform === "win32") {
    const shim = `@echo off\r\nrem ${managedMarker}\r\n"${nodePath}" "${scriptPath}" %*\r\n`;
    try {
      const existing = await readFile(cmdPath, "utf8");
      if (!existing.includes(managedMarker) && !existing.includes(scriptPath)) {
        throw new Error(`${cmdPath} already exists and is not managed by this installer. Move it away before installing.`);
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await writeFile(cmdPath, shim);
    try {
      const legacyShim = await readFile(targetPath, "utf8");
      if (!legacyShim.includes(managedMarker) && !legacyShim.includes(scriptPath)) {
        throw new Error(`${targetPath} already exists and is not managed by this installer. Move it away before installing.`);
      }
      await rm(targetPath, { force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return cmdPath;
  }

  const shim = `#!/bin/sh
# ${managedMarker}
exec ${JSON.stringify(nodePath)} ${JSON.stringify(scriptPath)} "$@"
`;
  try {
    const existing = await readFile(targetPath, "utf8");
    if (!existing.includes(managedMarker) && !existing.includes(scriptPath)) {
      throw new Error(`${targetPath} already exists and is not managed by this installer. Move it away before installing.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(targetPath, shim, { mode: 0o755 });
  return targetPath;
}

async function installTaskctlShim() {
  return installCommandShim(taskctlPath, taskctlCmdPath, taskctlCliPath);
}

async function installDashiTaskboardShim() {
  return installCommandShim(dashiTaskboardPath, dashiTaskboardCmdPath, dashiTaskboardCliPath);
}

async function installCjTaskboardShims() {
  return {
    cjTaskboardPath: await installCommandShim(cjTaskboardPath, cjTaskboardCmdPath, dashiTaskboardCliPath),
    cjTaskDashboardPath: await installCommandShim(cjTaskDashboardPath, cjTaskDashboardCmdPath, dashiTaskboardCliPath),
  };
}

async function updateMarketplace() {
  const marketplace = await readJson(marketplacePath, {
    name: "personal",
    interface: { displayName: "Personal" },
    plugins: [],
  });
  marketplace.name ||= "personal";
  marketplace.interface ||= { displayName: "Personal" };
  marketplace.interface.displayName ||= "Personal";
  marketplace.plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];

  const entry = {
    name: pluginName,
    source: {
      source: "local",
      path: `./plugins/${pluginName}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };
  const existingIndex = marketplace.plugins.findIndex((plugin) => plugin?.name === pluginName);
  if (existingIndex >= 0) marketplace.plugins[existingIndex] = entry;
  else marketplace.plugins.push(entry);

  await mkdir(path.dirname(marketplacePath), { recursive: true });
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  return marketplace.name;
}

function launchctl(args) {
  return spawnSync("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function managedRuntimePids() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) return [];
  const managedScripts = [
    path.join(projectRoot, "scripts", "codex-plugin-agent.mjs"),
    path.join(projectRoot, "scripts", "codex-injector.mjs"),
    path.join(projectRoot, "server", "index.mjs"),
  ];
  return result.stdout.split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    .filter(({ pid, command }) => (
      pid !== process.pid
      && managedScripts.some((script) => command.includes(script))
    ))
    .map(({ pid }) => pid);
}

function managedInjectorPids() {
  const result = spawnSync("/bin/ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) return [];
  const injectorScripts = [
    path.join(projectRoot, "scripts", "codex-plugin-agent.mjs"),
    path.join(projectRoot, "scripts", "codex-injector.mjs"),
  ];
  return result.stdout.split("\n")
    .map((line) => line.trim().match(/^(\d+)\s+(.+)$/))
    .filter(Boolean)
    .map((match) => ({ pid: Number(match[1]), command: match[2] }))
    .filter(({ pid, command }) => (
      pid !== process.pid
      && injectorScripts.some((script) => command.includes(script))
      && (command.includes(" injector") || command.includes("codex-injector.mjs"))
    ))
    .map(({ pid }) => pid);
}

async function stopPids(pids, currentPids) {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const remaining = currentPids().filter((pid) => pids.includes(pid));
    if (remaining.length === 0) return pids;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const pid of currentPids().filter((candidate) => pids.includes(candidate))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return pids;
}

async function stopManagedRuntimeProcesses() {
  return stopPids(managedRuntimePids(), managedRuntimePids);
}

async function stopManagedInjectorProcesses() {
  return stopPids(managedInjectorPids(), managedInjectorPids);
}

async function removeManagedDashiCodexShim() {
  try {
    const existing = await readFile(dashiCodexPath, "utf8");
    if (!existing.includes(managedMarker) && !existing.includes(openScriptPath)) return { removed: false };
    await rm(dashiCodexPath, { force: true });
    return { removed: true };
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false };
    throw error;
  }
}

async function installLaunchAgents(codexExecutable) {
  await mkdir(path.join(projectRoot, ".data"), { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  const pathValue = launchAgentPath(codexExecutable);
  await writeFile(serverPlistPath, plist(
    "com.dashi-taskboard.server",
    [nodePath, path.join(projectRoot, "scripts", "codex-plugin-agent.mjs"), "server"],
    {
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: "47824",
      CODEX_TASKBOARD_DATA_DIR: path.join(projectRoot, ".data"),
      CODEX_EXECUTABLE: codexExecutable,
      PATH: pathValue,
    },
  ));

  const guiTarget = `gui/${process.getuid()}`;
  launchctl(["bootout", guiTarget, serverPlistPath]);
  launchctl(["bootout", guiTarget, injectorPlistPath]);
  await rm(injectorPlistPath, { force: true });
  await stopManagedInjectorProcesses();
  await stopManagedRuntimeProcesses();
  const result = launchctl(["bootstrap", guiTarget, serverPlistPath]);
  if (result.status !== 0) {
    throw new Error(`launchctl bootstrap failed for ${serverPlistPath}\n${result.stderr || result.stdout}`);
  }
  launchctl(["enable", `${guiTarget}/com.dashi-taskboard.server`]);
}

function installCodexPlugin(marketplaceName, codexExecutable) {
  const result = spawnSync(codexExecutable, ["plugin", "add", `${pluginName}@${marketplaceName}`], {
    cwd: projectRoot,
    encoding: "utf8",
    shell: process.platform === "win32",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`codex plugin add ${pluginName}@${marketplaceName} failed${detail ? `\n${detail}` : ""}`);
  }
  return { ok: true, output: result.stdout.trim() };
}

function openStandaloneTaskboardPanel() {
  const result = spawnSync(nodePath, [dashiTaskboardCliPath, "open"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  return {
    ok: result.status === 0,
    output: result.status === 0 ? output : null,
    error: result.status === 0 ? null : output,
  };
}

async function main() {
  if (!["darwin", "win32"].includes(process.platform)) {
    throw new Error("The one-click persistent installer currently supports macOS and Windows.");
  }

  run("npm", ["install"], { stdio: "inherit" });
  run("npm", ["run", "build:web"], { stdio: "inherit" });
  const codexExecutable = requiredExecutablePath("codex");
  await installPluginSource();
  const legacySkill = await installLegacySkillLink();
  const installedTaskctlPath = await installTaskctlShim();
  const installedDashiTaskboardPath = await installDashiTaskboardShim();
  const installedCjTaskboardPaths = await installCjTaskboardShims();
  const removedDashiCodex = await removeManagedDashiCodexShim();
  const marketplaceName = await updateMarketplace();
  const codexPlugin = installCodexPlugin(marketplaceName, codexExecutable);
  if (process.platform === "darwin") {
    await installLaunchAgents(codexExecutable);
  }
  const taskboardOpen = openStandaloneTaskboardPanel();

  console.log(JSON.stringify({
    ok: true,
    platform: process.platform,
    pluginInstallPath,
    marketplacePath,
    marketplaceName,
    serverPlistPath: process.platform === "darwin" ? serverPlistPath : null,
    injector: {
      installed: false,
      removedPlistPath: process.platform === "darwin" ? injectorPlistPath : null,
    },
    codexPlugin,
    taskctlPath: installedTaskctlPath,
    dashiTaskboardPath: installedDashiTaskboardPath,
    ...installedCjTaskboardPaths,
    dashiCodex: removedDashiCodex,
    legacySkillPath: legacySkill,
    taskboardOpen,
    serviceUrl: "http://127.0.0.1:47824",
    next: taskboardOpen.ok
      ? "Standalone Taskboard panel opened. In any AI app with this skill, ask it to run cj-taskboard open."
      : "Install completed, but the standalone panel did not open. Run cj-taskboard open when you are ready.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
