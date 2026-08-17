import { randomUUID } from "node:crypto";

import { readCodexQuotaStatus } from "../scripts/codex-rate-limits.mjs";
import { isSupportedModelEffort } from "../shared/taskboard-automation-options.mjs";
import { buildTaskboardAutomationPrompt } from "../shared/taskboard-automation.mjs";
import { ApiError } from "./database.mjs";

const DEFAULT_ADAPTER = "local-codex-exec";
const AUTOMATION_ACTOR = {
  type: "agent",
  id: "codex-agent",
  name: "Codex Agent",
  avatarUrl: null,
};

function now() {
  return new Date().toISOString();
}

function automationItem(policy, quota = null) {
  const quotaPaused = policy.quotaAware && quota?.state !== "available";
  return {
    id: `local-${policy.projectId}`,
    status: policy.enabledByUser && !quotaPaused ? "ACTIVE" : "PAUSED",
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    rrule: `RRULE:FREQ=MINUTELY;INTERVAL=${policy.intervalMinutes}`,
    adapter: policy.adapter,
  };
}

function policyResponse(policy) {
  if (!policy) return null;
  return {
    enabledByUser: policy.enabledByUser,
    quotaAware: policy.quotaAware,
    intervalMinutes: policy.intervalMinutes,
    model: policy.model,
    reasoningEffort: policy.reasoningEffort,
    adapter: policy.adapter,
  };
}

function failureComment(error, run) {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "自动化执行失败，已将任务标记为 blocked。",
    "",
    `运行 ID：${run.id}`,
    `失败原因：${message}`,
    "",
    "可以修复后手动移回 todo，再由自动化重新认领。",
  ].join("\n");
}

function localRunPrompt(request, task) {
  return [
    buildTaskboardAutomationPrompt(request),
    "",
    `本轮已经认领任务：${task.identifier}。`,
    "请只处理这个已认领任务，不要再认领其他 todo。",
    "如果执行失败或缺少必要环境，请给该任务添加失败评论并移动到 blocked。",
  ].join("\n");
}

export class AutomationService {
  constructor({ database, aiChat, codexExecutable = "codex", events = null }) {
    this.database = database;
    this.aiChat = aiChat;
    this.codexExecutable = codexExecutable;
    this.events = events;
    this.timers = new Map();
    this.activeRuns = new Map();
    this.#restoreTimers();
  }

  async list(projectId) {
    const policy = this.database.getAutomationPolicy(projectId);
    const lastRun = this.database.getLastAutomationRun(projectId);
    const quota = await this.#quotaStatus(policy);
    return {
      items: policy ? [automationItem(policy, quota)] : [],
      ...(policy ? { item: automationItem(policy, quota), policy: policyResponse(policy) } : {}),
      ...(quota ? { quota } : {}),
      ...(lastRun ? { lastRun } : {}),
    };
  }

  activity(projectId) {
    const runs = this.database.listAutomationRuns(projectId, 10).map((run) => {
      const task = run.issueId ? this.database.getTask(run.issueId) : null;
      return {
        ...run,
        task: task
          ? {
              id: task.id,
              identifier: task.identifier,
              title: task.title,
              status: task.status,
            }
          : null,
      };
    });
    return { runs };
  }

  async applyPolicy(request) {
    const policy = this.database.saveAutomationPolicy({
      projectId: request.taskboardProjectId,
      enabledByUser: request.enabledByUser === true,
      quotaAware: request.quotaAware === true,
      intervalMinutes: request.intervalMinutes,
      model: request.model,
      reasoningEffort: request.reasoningEffort,
      adapter: DEFAULT_ADAPTER,
    });
    this.#syncTimer(policy);
    const quota = await this.#quotaStatus(policy);
    return {
      item: automationItem(policy, quota),
      policy: policyResponse(policy),
      ...(quota ? { quota } : {}),
      lastRun: this.database.getLastAutomationRun(policy.projectId),
    };
  }

  pause(projectId) {
    const current = this.database.getAutomationPolicy(projectId);
    if (!current) return { error: "not-found" };
    const policy = this.database.saveAutomationPolicy({
      ...current,
      enabledByUser: false,
      updatedAt: now(),
    });
    this.#syncTimer(policy);
    return {
      item: automationItem(policy),
      policy: policyResponse(policy),
      lastRun: this.database.getLastAutomationRun(projectId),
    };
  }

  async runOnce(request) {
    const policy = this.database.getAutomationPolicy(request.taskboardProjectId)
      ?? this.database.saveAutomationPolicy({
        projectId: request.taskboardProjectId,
        enabledByUser: request.enabledByUser === true,
        quotaAware: request.quotaAware === true,
        intervalMinutes: request.intervalMinutes,
        model: request.model,
        reasoningEffort: request.reasoningEffort,
        adapter: DEFAULT_ADAPTER,
      });
    const quota = await this.#quotaStatus(policy);
    const run = await this.#startProjectRun(policy, request, { quota });
    return {
      item: automationItem(policy, quota),
      policy: policyResponse(policy),
      ...(quota ? { quota } : {}),
      lastRun: run,
      run,
    };
  }

  close() {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }

  #restoreTimers() {
    for (const policy of this.database.listAutomationPolicies()) {
      this.#syncTimer(policy);
    }
  }

  #syncTimer(policy) {
    const existing = this.timers.get(policy.projectId);
    if (existing) {
      clearInterval(existing);
      this.timers.delete(policy.projectId);
    }
    if (!policy.enabledByUser) return;
    const timer = setInterval(() => {
      void this.#startProjectRun(policy, null, { recordQuotaSkip: false }).catch(() => {});
    }, policy.intervalMinutes * 60_000);
    timer.unref();
    this.timers.set(policy.projectId, timer);
  }

  async #startProjectRun(policy, requestOverride, options = {}) {
    if (policy.adapter !== DEFAULT_ADAPTER) {
      throw new ApiError(
        400,
        "UNSUPPORTED_AUTOMATION_ADAPTER",
        `Unsupported automation adapter '${policy.adapter}'`,
      );
    }
    if (!isSupportedModelEffort(policy.model, policy.reasoningEffort)) {
      throw new ApiError(400, "INVALID_AUTOMATION_POLICY", "Automation model settings are invalid");
    }
    if (this.activeRuns.has(policy.projectId)) {
      return this.activeRuns.get(policy.projectId);
    }
    const quota = Object.hasOwn(options, "quota") ? options.quota : await this.#quotaStatus(policy);
    if (policy.quotaAware && quota?.state !== "available") {
      if (options.recordQuotaSkip === false) return null;
      return this.database.createAutomationRun({
        projectId: policy.projectId,
        status: "skipped",
        startedAt: now(),
        finishedAt: now(),
        error: quota?.state === "blocked"
          ? "额度已用尽"
          : quota?.state === "unavailable"
            ? "额度不可用"
            : "额度状态未知",
      });
    }

    const task = this.database.listTasks({
      projectId: policy.projectId,
      status: "todo",
      archived: "false",
    })[0];
    if (!task) {
      return this.database.createAutomationRun({
        projectId: policy.projectId,
        status: "skipped",
        startedAt: now(),
        finishedAt: now(),
        error: "没有待办任务",
      });
    }

    try {
      await this.aiChat.getCatalog(policy.projectId);
    } catch (error) {
      return this.database.createAutomationRun({
        projectId: policy.projectId,
        status: "failed",
        finishedAt: now(),
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const run = this.database.createAutomationRun({
      projectId: policy.projectId,
      issueId: task.id,
      status: "running",
    });
    this.activeRuns.set(policy.projectId, run);
    void this.#executeClaimedTask(policy, requestOverride, task, run)
      .finally(() => this.activeRuns.delete(policy.projectId));
    return run;
  }

  async #executeClaimedTask(policy, requestOverride, task, run) {
    let claimed = null;
    try {
      claimed = this.database.moveTask(task.id, task.version, "in_progress", undefined, null);
      this.events?.emit("task.moved", { task: claimed });
      const thread = await this.aiChat.createThread({
        projectId: policy.projectId,
        issueId: claimed.id,
        title: `自动执行 ${claimed.identifier}`,
        model: policy.model,
        reasoningEffort: policy.reasoningEffort,
        sandbox: "workspace-write",
      });
      const request = requestOverride ?? {
        taskboardProjectId: policy.projectId,
        projectName: thread.origin.projectName,
        workspacePath: thread.origin.workspacePath,
        skillPath: this.aiChat.manageTaskboardSkillPath,
        intervalMinutes: policy.intervalMinutes,
        model: policy.model,
        reasoningEffort: policy.reasoningEffort,
      };
      const aiRun = await this.aiChat.startTurn(thread.id, {
        message: localRunPrompt(
          {
            ...request,
            taskboardProjectId: policy.projectId,
            projectName: thread.origin.projectName,
            workspacePath: thread.origin.workspacePath,
            skillPath: this.aiChat.manageTaskboardSkillPath,
            intervalMinutes: policy.intervalMinutes,
            model: policy.model,
            reasoningEffort: policy.reasoningEffort,
          },
          claimed,
        ),
      });
      this.database.updateAutomationRun(run.id, {
        aiThreadId: thread.id,
        aiRunId: aiRun.id,
      });
      const finished = await this.aiChat.waitForRun(aiRun.id);
      this.database.updateAutomationRun(run.id, {
        status: finished.status === "completed" ? "completed" : "failed",
        finishedAt: now(),
        error: finished.error,
      });
      if (finished.status !== "completed") {
        this.#blockClaimedTask(claimed, run, new Error(finished.error ?? "Codex run failed"));
      }
    } catch (error) {
      this.database.updateAutomationRun(run.id, {
        status: "failed",
        finishedAt: now(),
        error: error instanceof Error ? error.message : String(error),
      });
      if (claimed) this.#blockClaimedTask(claimed, run, error);
    }
  }

  async #quotaStatus(policy) {
    if (!policy?.quotaAware) return null;
    return readCodexQuotaStatus(policy.model, { codexExecutable: this.codexExecutable });
  }

  #blockClaimedTask(task, run, error) {
    const current = this.database.getTask(task.id);
    if (!current || current.archivedAt !== null || current.status === "blocked") return;
    const comment = this.database.createComment(current.id, {
      body: failureComment(error, run),
      actor: AUTOMATION_ACTOR,
      threadId: null,
    });
    this.events?.emit("comment.created", { comment, task: current });
    const latest = this.database.getTask(current.id);
    if (latest?.status === "in_progress") {
      const blocked = this.database.moveTask(latest.id, latest.version, "blocked", undefined, null);
      this.events?.emit("task.moved", { task: blocked });
    }
  }
}
