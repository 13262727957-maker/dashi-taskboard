#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstat, readFile, readlink, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const pluginName = "dashi-taskboard";
const pluginInstallPath = path.join(os.homedir(), "plugins", pluginName);
const marketplacePath = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
const taskctlPath = path.join(os.homedir(), ".local", "bin", "taskctl");
const legacySkillPath = path.join(os.homedir(), ".codex", "skills", "manage-taskboard");
const launchAgentsDir = path.join(os.homedir(), "Library", "LaunchAgents");
const plists = [
  path.join(launchAgentsDir, "com.dashi-taskboard.server.plist"),
  path.join(launchAgentsDir, "com.dashi-taskboard.codex-injector.plist"),
];
const managedMarker = "Managed by dashi-taskboard Codex plugin installer.";
const taskctlCliSuffix = path.join("dashi-taskboard", "cli", "taskctl.mjs");

function launchctl(args) {
  return spawnSync("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: "pipe",
  });
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
  const marketplaceUpdated = await removeMarketplaceEntry();
  const removedTaskctl = await removeManagedTaskctlShim();
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
    legacySkill: {
      path: legacySkillPath,
      ...removedLegacySkill,
    },
    marketplaceUpdated,
    note: "Restart Codex to clear any enabled plugin UI state.",
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
