const RUN_INTERVAL_MS = 30_000;
const RUN_HOUR = 17;

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class TaskSyncScheduler {
  constructor({ database, getIdentity }) {
    this.database = database;
    this.getIdentity = getIdentity;
    this.timer = setInterval(() => void this.#tick(), RUN_INTERVAL_MS);
    this.timer.unref();
  }

  async #tick() {
    const now = new Date();
    if (now.getHours() < RUN_HOUR) return;
    const dateKey = localDateKey(now);
    if (this.database.getTaskSyncSchedulerState("last_run_date") === dateKey) return;
    const runOwner = `scheduler-${process.pid}-${Date.now()}`;
    if (!this.database.tryAcquireTaskSyncLock(`task-sync-daily:${dateKey}`, runOwner, 30 * 60_000)) return;
    try {
      if (this.database.getTaskSyncSchedulerState("last_run_date") === dateKey) return;
      const token = this.database.getTaskSyncSchedulerState("session_token");
      const identity = this.getIdentity();
      if (!token || !identity) return;
      const user = await identity.session(token);
      if (!user) return;
      const projects = this.database.listProjects();
      const bindings = projects
        .map((project) => ({ project, binding: this.database.getProjectTeamBinding(project.id) }))
        .filter((item) => item.binding?.teamProjectId);
      await Promise.all(bindings.map(async ({ project, binding }) => {
        const lockKey = `task-sync:${project.id}:${binding.teamProjectId}`;
        const owner = `${runOwner}:${project.id}`;
        if (!this.database.tryAcquireTaskSyncLock(lockKey, owner)) return;
        try {
          const tasks = this.database.listTasks({ projectId: project.id, archived: "false" });
          const pending = this.database.excludeSubmittedTasks(project.id, binding.teamProjectId, this.database.excludeMirroredTasks(project.id, tasks));
          if (pending.length === 0) return;
          const result = await identity.importProjectTasks(user.id, binding.teamProjectId, pending, { localProjectId: project.id });
          this.database.recordSubmittedTasks({ localProjectId: project.id, teamProjectId: binding.teamProjectId, tasks: pending });
          this.database.recordProjectSyncStatus({
            localProjectId: project.id,
            teamProjectId: binding.teamProjectId,
            status: "success",
            taskCount: pending.length,
            imported: result.imported,
            updated: result.updated + (result.deduped ?? 0),
            failed: 0,
            submittedBy: user.displayName ?? user.employeeNo ?? user.id,
          });
        } finally {
          this.database.releaseTaskSyncLock(lockKey, owner);
        }
      }));
      this.database.setTaskSyncSchedulerState("last_run_date", dateKey);
    } finally {
      this.database.releaseTaskSyncLock(`task-sync-daily:${dateKey}`, runOwner);
    }
  }

  close() {
    clearInterval(this.timer);
  }
}
