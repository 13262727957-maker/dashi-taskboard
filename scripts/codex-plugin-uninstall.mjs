#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginName = "dashi-taskboard";
const pluginInstallPath = path.join(os.homedir(), "plugins", pluginName);
const marketplacePath = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
const taskctlPath = path.join(os.homedir(), ".local", "bin", "taskctl");
const dashiTaskboardPath = path.join(os.homedir(), ".local", "bin", "dashi-taskboard");
const dashiCodexPath = path.join(os.homedir(), ".local", "bin", "dashi-codex");
const legacySkillPath = path.join(os.homedir(), ".codex", "skills", "manage-taskboard");
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plists = [
  path.join(launchAgentsDir, "com.dashi-taskboard.server.plist"),
  path.join(launchAgentsDir, "com.dashi-taskboard.codex-injector.plist"),
];
const managedMarker = "Managed by dashi-taskboard Codex plugin installer.";
const taskctlCliSuffix = path.join("dashi-taskboard", "cli", "taskctl.mjs");
const dashiTaskboardCliSuffix = path.join("dashi-taskboard", "scripts", "dashi-taskboard.mjs");
const openScriptSuffix = path.join("dashi-taskboard", "scripts", "codex-plugin-open.mjs");
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function launchctl(args) {
  return spawnSync("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
}

function managedRuntimePids() {
  if (process.platform !== "darwin") return [];
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

async function stopManagedRuntimeProcesses() {
  const pids = managedRuntimePids();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const remaining = managedRuntimePids().filter((pid) => pids.includes(pid));
    if (remaining.length === 0) return pids;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const pid of managedRuntimePids().filter((candidate) => pids.includes(candidate))) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
  return pids;
}

async function removeMarketplaceEntry() {
  let marketplace;
  try {
    marketplace = JSON.parse(await readFile(marketplacePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!Array.isArray(marketplace.plugins)) return false;
  const nextPlugins = marketplace.plugins.filter((plugin) => plugin?.name !== pluginName);
  if (nextPlugins.length === marketplace.plugins.length) return false;
  marketplace.plugins = nextPlugins;
  await writeFile(marketplacePath, `${JSON.stringify(marketplace, null, 2)}\n`);
  return true;
}

function removeCodexPlugin() {
  const result = spawnSync("codex", ["plugin", "remove", `${pluginName}@personal`, "--json"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    ok: result.status === 0,
    skipped: result.status !== 0,
    output: result.status === 0 ? result.stdout.trim() : null,
    error: result.status === 0 ? null : [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

async function removeManagedTaskctlShim() {
  let existing;
  try {
    existing = await readFile(taskctlPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false, reason: "missing" };
    throw error;
  }
  if (!existing.includes(managedMarker)) {
    if (!existing.includes(taskctlCliSuffix)) {
      return { removed: false, reason: "not-managed" };
    }
  }
  await rm(taskctlPath, { force: true });
  return { removed: true };
}

async function removeManagedDashiTaskboardShim() {
  let existing;
  try {
    existing = await readFile(dashiTaskboardPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false, reason: "missing" };
    throw error;
  }
  if (!existing.includes(managedMarker)) {
    if (!existing.includes(dashiTaskboardCliSuffix)) {
      return { removed: false, reason: "not-managed" };
    }
  }
  await rm(dashiTaskboardPath, { force: true });
  return { removed: true };
}

async function removeManagedDashiCodexShim() {
  let existing;
  try {
    existing = await readFile(dashiCodexPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false, reason: "missing" };
    throw error;
  }
  if (!existing.includes(managedMarker)) {
    if (!existing.includes(openScriptSuffix)) {
      return { removed: false, reason: "not-managed" };
    }
  }
  await rm(dashiCodexPath, { force: true });
  return { removed: true };
}

async function removeManagedLegacySkillLink() {
  let existing;
  try {
    existing = await lstat(legacySkillPath);
  } catch (error) {
    if (error.code === "ENOENT") return { removed: false, reason: "missing" };
    throw error;
  }
  if (!existing.isSymbolicLink()) {
    return { removed: false, reason: "not-managed" };
  }
  const target = await readlink(legacySkillPath);
  const expectedTarget = path.join(pluginInstallPath, "skills", "manage-taskboard");
  if (path.resolve(path.dirname(legacySkillPath), target) !== expectedTarget) {
    return { removed: false, reason: "points-elsewhere", target };
  }
  await rm(legacySkillPath, { force: true });
  return { removed: true };
}

async function main() {
  const codexPlugin = removeCodexPlugin();
  if (process.platform === "darwin") {
    const guiTarget = `gui/${process.getuid()}`;
    for (const file of plists) {
      launchctl(["bootout", guiTarget, file]);
      await rm(file, { force: true });
    }
  }
  const stoppedRuntimePids = await stopManagedRuntimeProcesses();
  const marketplaceUpdated = await removeMarketplaceEntry();
  const removedTaskctl = await removeManagedTaskctlShim();
  const removedDashiTaskboard = await removeManagedDashiTaskboardShim();
  const removedDashiCodex = await removeManagedDashiCodexShim();
  const removedLegacySkill = await removeManagedLegacySkillLink();
  await rm(pluginInstallPath, { recursive: true, force: true });
  console.log(JSON.stringify({
    ok: true,
    codexPlugin,
    removedPluginPath: pluginInstallPath,
    taskctl: {
      path: taskctlPath,
      ...removedTaskctl,
    },
    dashiTaskboard: {
      path: dashiTaskboardPath,
      ...removedDashiTaskboard,
    },
    dashiCodex: {
      path: dashiCodexPath,
      ...removedDashiCodex,
    },
    legacySkill: {
      path: legacySkillPath,
      ...removedLegacySkill,
    },
    stoppedRuntimePids,
    marketplaceUpdated,
    note: "Restart Codex to clear any enabled plugin UI state.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
