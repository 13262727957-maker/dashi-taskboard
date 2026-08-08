import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readCodexQuotaStatus } from "../scripts/codex-rate-limits.mjs";
import { defaultTaskboardDataDirectory } from "../shared/taskboard-paths.mjs";
import {
  parseTaskboardAutomationHostRequest,
  reconcileTaskboardAutomation,
} from "../shared/taskboard-automation.mjs";

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CODEX_DEBUGGING_PORT = 9229;
const AUTOMATION_POLICIES_PATH = path.join(defaultTaskboardDataDirectory(), "codex-automation-policies.json");
const CODEX_AUTOMATION_METHODS = new Set([
  "list-automations",
  "automation-create",
  "automation-update",
]);

let requestSequence = 0;
let policiesStarted = false;
const policyTimers = new Map();

class CdpConnection {
  constructor(url) {
    this.socket = new WebSocket(url);
    this.sequence = 0;
    this.pending = new Map();
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), {
        once: true,
      });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id) return;
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
    this.socket.addEventListener("close", () => {
      const error = new Error("CDP WebSocket closed");
      this.pending.forEach((pending) => pending.reject(error));
      this.pending.clear();
    });
  }

  send(method, params = {}) {
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.socket.close();
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

async function isReachable(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1_500) });
    return response.ok;
  } catch {
    return false;
  }
}

async function codexTargets(port) {
  const targets = await fetchJson(`http://127.0.0.1:${port}/json/list`);
  return targets.filter(
    (target) =>
      target.type === "page" &&
      target.webSocketDebuggerUrl &&
      !target.url?.includes("initialRoute=%2Fglobal-dictation") &&
      !target.url?.includes("initialRoute=%2Favatar-overlay") &&
      (target.url?.startsWith("app://") || target.title === "Codex"),
  );
}

function codexDebuggingPorts(preferredPort) {
  const ports = new Set([preferredPort]);
  if (process.platform !== "darwin") return [...ports];
  const processes = spawnSync("/bin/ps", ["-axo", "command="], {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (processes.status !== 0) return [...ports];

  for (const command of processes.stdout.split("\n")) {
    if (!command.includes("/ChatGPT.app/") && !command.includes("/Codex.app/")) continue;
    const match = command.match(/--remote-debugging-port=(\d+)/);
    if (match) ports.add(Number(match[1]));
  }
  return [...ports];
}

async function requestCodexAutomationViaCdp(cdp, method, params) {
  if (!CODEX_AUTOMATION_METHODS.has(method)) {
    throw new Error(`Unsupported Codex automation method: ${method}`);
  }
  const requestId = [
    "taskboard-automation",
    process.pid,
    Date.now().toString(36),
    (++requestSequence).toString(36),
  ].join("-");
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => new Promise((resolve) => {
      const method = ${JSON.stringify(method)};
      const params = ${JSON.stringify(params)};
      const requestId = ${JSON.stringify(requestId)};
      const bridge = window.electronBridge;
      if (!bridge || typeof bridge.sendMessageFromView !== "function") {
        resolve({ ok: false, error: "当前 Codex 版本没有提供原生自动任务能力" });
        return;
      }
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
        resolve(result);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (
          !message
          || typeof message !== "object"
          || message.type !== "fetch-response"
          || message.requestId !== requestId
        ) return;
        finish({
          ok: true,
          responseType: message.responseType,
          status: message.status,
          bodyJsonString: message.bodyJsonString,
        });
      };
      const timeout = window.setTimeout(
        () => finish({ ok: false, error: "Codex 自动任务接口没有响应" }),
        10_000,
      );
      window.addEventListener("message", onMessage);
      Promise.resolve(bridge.sendMessageFromView({
        type: "fetch",
        requestId,
        method: "POST",
        url: \`vscode://codex/${method}\`,
        body: JSON.stringify(params),
      })).catch((error) => {
        finish({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }))()`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (evaluation.exceptionDetails) {
    throw new Error(
      evaluation.exceptionDetails.exception?.description
      || "Codex automation request failed",
    );
  }
  const response = evaluation.result.value;
  if (!response?.ok) throw new Error(response?.error || "Codex automation request failed");
  if (!Number.isInteger(response.status) || response.status < 200 || response.status >= 300) {
    throw new Error(`Codex automation request returned HTTP ${response.status}`);
  }
  if (typeof response.bodyJsonString !== "string" || response.bodyJsonString.length === 0) {
    return {};
  }
  try {
    return JSON.parse(response.bodyJsonString);
  } catch {
    throw new Error("Codex automation request returned invalid JSON");
  }
}

async function codexAutomationBridgeStatus(cdp) {
  const evaluation = await cdp.send("Runtime.evaluate", {
    expression: `(() => {
      const bridge = window.electronBridge;
      return Boolean(bridge && typeof bridge.sendMessageFromView === "function");
    })()`,
    returnByValue: true,
  });
  return evaluation.result.value === true;
}

function automationUnavailableMessage(failures) {
  const detail = failures.length > 0 ? `：${failures.join("；")}` : "";
  return [
    `没有找到可用的 Codex 自动化接口${detail}`,
    "为了避免影响当前 ChatGPT/Codex 窗口，任务面板不会自动关闭或重启主应用。",
  ].join("。");
}

export async function launchLocalAutomationMode() {
  const status = await getLocalAutomationStatus();
  if (status.available) {
    return {
      ok: true,
      action: "attached-existing",
      port: status.port,
      status,
    };
  }
  return {
    ok: false,
    action: "manual-start-required",
    port: null,
    status,
    error: status.guidance,
  };
}

export async function getLocalAutomationStatus(options = {}) {
  const ports = codexDebuggingPorts(options.port ?? DEFAULT_CODEX_DEBUGGING_PORT);
  const failures = [];
  for (const port of ports) {
    try {
      if (!(await isReachable(`http://127.0.0.1:${port}/json/version`))) {
        failures.push(`127.0.0.1:${port} 未监听`);
        continue;
      }
      const targets = await codexTargets(port);
      if (targets.length === 0) {
        failures.push(`127.0.0.1:${port} 没有 Codex 窗口`);
        continue;
      }
      const cdp = new CdpConnection(targets[0].webSocketDebuggerUrl);
      await cdp.open();
      try {
        await cdp.send("Runtime.enable");
        const bridgeAvailable = await codexAutomationBridgeStatus(cdp);
        if (!bridgeAvailable) {
          failures.push(`127.0.0.1:${port} 的 Codex 没有原生自动任务接口`);
          continue;
        }
        return {
          available: true,
          port,
          targetTitle: targets[0].title ?? null,
          guidance: null,
        };
      } finally {
        cdp.close();
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  return {
    available: false,
    port: null,
    targetTitle: null,
    guidance: automationUnavailableMessage(failures),
    failures,
  };
}

function storedAutomationPolicy(request) {
  return {
    taskboardProjectId: request.taskboardProjectId,
    codexProjectId: request.codexProjectId,
    projectName: request.projectName,
    workspacePath: request.workspacePath,
    skillPath: request.skillPath,
    ...(request.automationId ? { automationId: request.automationId } : {}),
    enabledByUser: request.enabledByUser,
    quotaAware: request.quotaAware,
    intervalMinutes: request.intervalMinutes,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
  };
}

function restoredAutomationPolicy(value) {
  return parseTaskboardAutomationHostRequest({
    ...value,
    id: "stored-policy",
    action: "automation",
    requestId: "stored-policy",
    operation: "apply-policy",
  });
}

async function readAutomationPolicies() {
  try {
    const stored = JSON.parse(await readFile(AUTOMATION_POLICIES_PATH, "utf8"));
    return stored && typeof stored === "object" && !Array.isArray(stored) ? stored : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeAutomationPolicies(policies) {
  await mkdir(path.dirname(AUTOMATION_POLICIES_PATH), { recursive: true });
  await writeFile(AUTOMATION_POLICIES_PATH, `${JSON.stringify(policies, null, 2)}\n`, {
    mode: 0o600,
  });
}

async function readStoredAutomationPolicy(projectId) {
  const policies = await readAutomationPolicies();
  return policies[projectId] ?? null;
}

async function updateStoredAutomationPolicy(request) {
  const policies = await readAutomationPolicies();
  policies[request.taskboardProjectId] = storedAutomationPolicy(request);
  await writeAutomationPolicies(policies);
}

async function writeStoredAutomationId(request, automationId) {
  if (!automationId) return;
  const policies = await readAutomationPolicies();
  const current = restoredAutomationPolicy(policies[request.taskboardProjectId]);
  if (!current) return;
  policies[request.taskboardProjectId] = storedAutomationPolicy({ ...current, automationId });
  await writeAutomationPolicies(policies);
}

function clearPolicyTimer(projectId) {
  const timer = policyTimers.get(projectId);
  if (timer) clearTimeout(timer);
  policyTimers.delete(projectId);
}

function schedulePolicyRetry(request, delayMs) {
  clearPolicyTimer(request.taskboardProjectId);
  if (!request.enabledByUser || !request.quotaAware) return;
  const timer = setTimeout(() => {
    void runLocalTaskboardAutomation({
      ...request,
      id: randomUUID(),
      requestId: randomUUID(),
      operation: "apply-policy",
    }, { background: true }).then((result) => {
      if (result?.ok === false) schedulePolicyRetry(request, 60_000);
    }).catch((error) => {
      console.error(`Taskboard quota policy check failed: ${error.message}`);
      schedulePolicyRetry(request, 60_000);
    });
  }, Math.max(1_000, delayMs));
  timer.unref();
  policyTimers.set(request.taskboardProjectId, timer);
}

function scheduleQuotaPolicyCheck(request, result) {
  clearPolicyTimer(request.taskboardProjectId);
  if (!request.enabledByUser || !request.quotaAware) return;

  const nextRunAt = Number(result?.item?.nextRunAt);
  const nextRunDelay = Number.isFinite(nextRunAt) && nextRunAt > Date.now()
    ? Math.max(1_000, nextRunAt - Date.now() - 15_000)
    : 60_000;
  const resetDelay = result?.quota?.state === "blocked" && Number.isFinite(result.quota.resetsAt)
    ? Math.max(1_000, result.quota.resetsAt * 1_000 - Date.now() + 1_000)
    : nextRunDelay;
  schedulePolicyRetry(request, Math.min(nextRunDelay, resetDelay));
}

async function applyTaskboardAutomationPolicy(request, rpc) {
  await updateStoredAutomationPolicy(request);
  const quota = request.quotaAware
    ? await readCodexQuotaStatus(request.model)
    : null;
  const shouldRun = request.enabledByUser
    && (!request.quotaAware || quota?.state === "available");
  const result = await reconcileTaskboardAutomation(
    { ...request, operation: shouldRun ? "ensure-active" : "pause" },
    rpc,
  );
  if (result?.error === "not-found") {
    return { ...(quota ? { quota } : {}) };
  }
  if (result?.item?.id) {
    await writeStoredAutomationId(request, result.item.id);
  }
  return { ...result, ...(quota ? { quota } : {}) };
}

export async function startLocalAutomationPolicyScheduler() {
  if (policiesStarted) return;
  policiesStarted = true;
  const policies = await readAutomationPolicies();
  for (const value of Object.values(policies)) {
    const request = restoredAutomationPolicy(value);
    if (request?.enabledByUser && request.quotaAware) {
      schedulePolicyRetry(request, 1_000);
    }
  }
}

export async function runLocalTaskboardAutomation(request, options = {}) {
  const ports = codexDebuggingPorts(options.port ?? DEFAULT_CODEX_DEBUGGING_PORT);
  const failures = [];

  for (const port of ports) {
    try {
      if (!(await isReachable(`http://127.0.0.1:${port}/json/version`))) {
        failures.push(`127.0.0.1:${port} 未监听`);
        continue;
      }
      const targets = await codexTargets(port);
      if (targets.length === 0) {
        failures.push(`127.0.0.1:${port} 没有 Codex 窗口`);
        continue;
      }

      const cdp = new CdpConnection(targets[0].webSocketDebuggerUrl);
      await cdp.open();
      try {
        await cdp.send("Runtime.enable");
        const rpc = (method, body) => requestCodexAutomationViaCdp(cdp, method, body);
        const result = request.operation === "apply-policy"
          ? await applyTaskboardAutomationPolicy(request, rpc)
          : await reconcileTaskboardAutomation(request, rpc);
        if (request.operation === "apply-policy") scheduleQuotaPolicyCheck(request, result);
        if (request.operation === "list") {
          const policy = await readStoredAutomationPolicy(request.taskboardProjectId);
          return { ...result, ...(policy ? { policy } : {}) };
        }
        return result;
      } finally {
        cdp.close();
      }
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    requestId: request.requestId ?? randomUUID(),
    ok: false,
    error: automationUnavailableMessage(failures),
    automationStatus: {
      available: false,
      guidance: automationUnavailableMessage(failures),
      failures,
    },
  };
}
