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
const dashiCodexPath = path.join(userBinDir, "dashi-codex");
const codexSkillsDir = path.join(os.homedir(), ".codex", "skills");
const legacySkillPath = path.join(codexSkillsDir, "manage-taskboard");
const nodePath = process.execPath;
const managedMarker = "Managed by dashi-taskboard Codex plugin installer.";
const taskctlCliPath = path.join(projectRoot, "cli", "taskctl.mjs");
const openScriptPath = path.join(projectRoot, "scripts", "codex-plugin-open.mjs");

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
  await symlink(target, legacySkillPath, "dir");
  return legacySkillPath;
}

async function installTaskctlShim() {
  await mkdir(userBinDir, { recursive: true });
  const shim = `#!/bin/sh
# ${managedMarker}
exec ${JSON.stringify(nodePath)} ${JSON.stringify(taskctlCliPath)} "$@"
`;
  try {
    const existing = await readFile(taskctlPath, "utf8");
    if (!existing.includes(managedMarker) && !existing.includes(taskctlCliPath)) {
      throw new Error(`${taskctlPath} already exists and is not managed by this installer. Move it away before installing.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(taskctlPath, shim, { mode: 0o755 });
  return taskctlPath;
}

async function installDashiCodexShim() {
  await mkdir(userBinDir, { recursive: true });
  const shim = `#!/bin/sh
# ${managedMarker}
exec ${JSON.stringify(nodePath)} ${JSON.stringify(openScriptPath)} "$@"
`;
  try {
    const existing = await readFile(dashiCodexPath, "utf8");
    if (!existing.includes(managedMarker) && !existing.includes(openScriptPath)) {
      throw new Error(`${dashiCodexPath} already exists and is not managed by this installer. Move it away before installing.`);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await writeFile(dashiCodexPath, shim, { mode: 0o755 });
  return dashiCodexPath;
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

async function installLaunchAgents() {
  await mkdir(path.join(projectRoot, ".data"), { recursive: true });
  await mkdir(launchAgentsDir, { recursive: true });
  await writeFile(serverPlistPath, plist(
    "com.dashi-taskboard.server",
    [nodePath, path.join(projectRoot, "scripts", "codex-plugin-agent.mjs"), "server"],
    {
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: "47823",
      CODEX_TASKBOARD_DATA_DIR: path.join(projectRoot, ".data"),
      PATH: `${userBinDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  ));
  await writeFile(injectorPlistPath, plist(
    "com.dashi-taskboard.codex-injector",
    [
      nodePath,
      path.join(projectRoot, "scripts", "codex-plugin-agent.mjs"),
      "injector",
    ],
    {
      CODEX_TASKBOARD_HOST: "127.0.0.1",
      CODEX_TASKBOARD_PORT: "47823",
      PATH: `${userBinDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  ));

  const guiTarget = `gui/${process.getuid()}`;
  for (const file of [serverPlistPath, injectorPlistPath]) {
    launchctl(["bootout", guiTarget, file]);
    const result = launchctl(["bootstrap", guiTarget, file]);
    if (result.status !== 0) {
      throw new Error(`launchctl bootstrap failed for ${file}\n${result.stderr || result.stdout}`);
    }
    launchctl(["enable", `${guiTarget}/${path.basename(file, ".plist")}`]);
  }
}

function installCodexPlugin(marketplaceName) {
  const result = spawnSync("codex", ["plugin", "add", `${pluginName}@${marketplaceName}`], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`codex plugin add ${pluginName}@${marketplaceName} failed${detail ? `\n${detail}` : ""}`);
  }
  return { ok: true, output: result.stdout.trim() };
}

function openTaskboardPanel() {
  const result = spawnSync(nodePath, [openScriptPath], {
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
  if (process.platform === "win32") {
    await installPluginSource();
    const legacySkill = await installLegacySkillLink();
    const installedTaskctlPath = await installTaskctlShim();
    const installedDashiCodexPath = await installDashiCodexShim();
    const marketplaceName = await updateMarketplace();
    const codexPlugin = installCodexPlugin(marketplaceName);
    console.log(JSON.stringify({
      ok: true,
      platform: "win32",
      pluginInstallPath,
      marketplacePath,
      marketplaceName,
      codexPlugin,
      taskctlPath: installedTaskctlPath,
      dashiCodexPath: installedDashiCodexPath,
      legacySkillPath: legacySkill,
      note: "Windows service startup entry is reserved; run npm start and npm run codex:inject manually for now.",
      next: "On macOS, quit Codex/ChatGPT completely and run dashi-codex or npm run open:codex-taskboard.",
    }, null, 2));
    return;
  }

  if (process.platform !== "darwin") {
    throw new Error("The one-click persistent installer currently supports macOS and has a Windows placeholder.");
  }

  run("npm", ["install"], { stdio: "inherit" });
  run("npm", ["run", "build:web"], { stdio: "inherit" });
  await installPluginSource();
  const legacySkill = await installLegacySkillLink();
  const installedTaskctlPath = await installTaskctlShim();
  const installedDashiCodexPath = await installDashiCodexShim();
  const marketplaceName = await updateMarketplace();
  const codexPlugin = installCodexPlugin(marketplaceName);
  await installLaunchAgents();
  const taskboardOpen = openTaskboardPanel();

  console.log(JSON.stringify({
    ok: true,
    pluginInstallPath,
    marketplacePath,
    marketplaceName,
    serverPlistPath,
    injectorPlistPath,
    codexPlugin,
    taskctlPath: installedTaskctlPath,
    dashiCodexPath: installedDashiCodexPath,
    legacySkillPath: legacySkill,
    taskboardOpen,
    serviceUrl: "http://127.0.0.1:47823",
    next: taskboardOpen.ok
      ? "Taskboard mode opened. If you close Codex later, reopen it with dashi-codex."
      : "Install completed, but Taskboard mode did not open. If Codex/ChatGPT is open in normal mode, quit it completely, then run dashi-codex.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
