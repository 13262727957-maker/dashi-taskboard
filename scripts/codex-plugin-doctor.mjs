#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginName = "dashi-taskboard";
const pluginInstallPath = path.join(os.homedir(), "plugins", pluginName);
const marketplacePath = path.join(os.homedir(), ".agents", "plugins", "marketplace.json");
const databasePath = path.join(projectRoot, ".data", "taskboard.sqlite");
const serviceUrl = "http://127.0.0.1:47823";
const taskctlPath = path.join(os.homedir(), ".local", "bin", "taskctl");
const dashiCodexPath = path.join(os.homedir(), ".local", "bin", "dashi-codex");
const legacySkillPath = path.join(os.homedir(), ".codex", "skills", "manage-taskboard");

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function jsonFile(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
}

function launchctlPrint(label) {
  if (process.platform !== "darwin") return { supported: false };
  const result = spawnSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    supported: true,
    ok: result.status === 0,
  };
}

function pgrep(pattern) {
  if (process.platform !== "darwin") return [];
  const result = spawnSync("/usr/bin/pgrep", ["-fl", pattern], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) return [];
  return result.stdout.trim().split("\n").filter((line) => (
    line
    && !line.includes("rg ")
    && !line.includes("pgrep ")
    && !line.includes("__CODEX_SNAPSHOT")
  ));
}

function mainCodexProcesses() {
  if (process.platform !== "darwin") return [];
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

function codexProcesses() {
  if (process.platform !== "darwin") return [];
  return mainCodexProcesses();
}

async function debuggableCodexPorts() {
  const ports = [];
  for (const port of [9229, 9231]) {
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
      ))) ports.push(port);
    } catch {}
  }
  return ports;
}

async function health() {
  try {
    const response = await fetch(`${serviceUrl}/health`, { signal: AbortSignal.timeout(1500) });
    return response.ok ? await response.json() : { status: "error", httpStatus: response.status };
  } catch (error) {
    return { status: "error", error: error.message };
  }
}

async function taskSummary() {
  try {
    const response = await fetch(`${serviceUrl}/api/tasks`, { signal: AbortSignal.timeout(1500) });
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

function codexPluginStatus() {
  const result = spawnSync("codex", ["plugin", "list"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    return {
      ok: false,
      error: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
    };
  }
  const line = result.stdout.split("\n").find((entry) => entry.includes(`${pluginName}@`));
  return {
    ok: Boolean(line?.includes("installed, enabled")),
    line: line?.trim() ?? null,
  };
}

function taskctlStatus() {
  const result = spawnSync(taskctlPath, ["project", "list", "--json"], {
    cwd: projectRoot,
    encoding: "utf8",
    stdio: "pipe",
  });
  return {
    path: taskctlPath,
    exists: result.status !== null && result.error === undefined,
    ok: result.status === 0,
    error: result.status === 0 ? null : (result.stderr || result.error?.message || "").trim(),
  };
}

async function dashiCodexStatus() {
  return {
    path: dashiCodexPath,
    exists: await exists(dashiCodexPath),
  };
}

function injectorRecommendation(state) {
  if (state === "injected-or-injecting") {
    return "Taskboard panel injection is active or in progress.";
  }
  if (state === "debuggable-codex-detected") {
    return "Run dashi-codex or npm run open:codex-taskboard to attach and open the Taskboard panel.";
  }
  if (state === "waiting-for-codex-restart") {
    return "Codex/ChatGPT is open in normal mode. Completely quit it, then run dashi-codex or npm run open:codex-taskboard.";
  }
  return "Run dashi-codex or npm run open:codex-taskboard to launch Codex with the Taskboard panel.";
}

async function main() {
  const marketplace = await jsonFile(marketplacePath);
  const marketplaceEntry = marketplace?.plugins?.find((plugin) => plugin?.name === pluginName);
  const database = await stat(databasePath).catch(() => null);
  const runningCodexProcesses = codexProcesses();
  const debuggablePorts = await debuggableCodexPorts();
  const injectorAgentProcesses = pgrep("codex-plugin-agent.mjs injector");
  const injectorProcesses = pgrep("codex-injector.mjs");
  const data = await taskSummary();
  const codexPlugin = codexPluginStatus();
  const taskctl = taskctlStatus();
  const dashiCodex = await dashiCodexStatus();
  const injectorState = injectorProcesses.length > 0
    ? "injected-or-injecting"
    : debuggablePorts.length > 0
      ? "debuggable-codex-detected"
      : runningCodexProcesses.length > 0
        ? "waiting-for-codex-restart"
        : "will-launch-codex";
  const checks = {
    plugin: {
      path: pluginInstallPath,
      manifest: await exists(path.join(pluginInstallPath, ".codex-plugin", "plugin.json")),
      skill: await exists(path.join(pluginInstallPath, "skills", "manage-taskboard", "SKILL.md")),
      legacySkill: await exists(path.join(legacySkillPath, "SKILL.md")),
      legacySkillPath,
    },
    marketplace: {
      path: marketplacePath,
      name: marketplace?.name ?? null,
      registered: Boolean(marketplaceEntry),
      sourcePath: marketplaceEntry?.source?.path ?? null,
    },
    codexPlugin,
    taskctl,
    dashiCodex,
    launchAgents: {
      server: launchctlPrint("com.dashi-taskboard.server"),
      injector: launchctlPrint("com.dashi-taskboard.codex-injector"),
    },
    service: await health(),
    database: {
      path: databasePath,
      exists: Boolean(database),
      bytes: database?.size ?? 0,
    },
    injector: {
      agentProcesses: injectorAgentProcesses,
      injectorProcesses,
      codexProcesses: runningCodexProcesses,
      debuggablePorts,
      state: injectorState,
      recommendation: injectorRecommendation(injectorState),
    },
    data,
  };
  const ok = checks.plugin.manifest
    && checks.plugin.skill
    && checks.plugin.legacySkill
    && checks.marketplace.registered
    && checks.codexPlugin.ok
    && checks.taskctl.ok
    && checks.dashiCodex.exists
    && checks.service.status === "ok"
    && checks.database.exists;
  console.log(JSON.stringify({ ok, checks }, null, 2));
  if (!ok) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
