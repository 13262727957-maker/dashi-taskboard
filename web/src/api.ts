import type {
  ActorIdentity,
  AiChatCatalog,
  AiChatAttachmentInput,
  AiChatRun,
  AiChatSandbox,
  AiChatThread,
  AiChatThreadSnapshot,
  AutomationRunActivity,
  Attachment,
  Comment,
  DevelopmentScan,
  IssueRelationType,
  Project,
  Task,
  TaskboardMetadata,
  TaskDraft,
  TaskPriority,
  TaskStatus,
  WorkflowCapabilities,
  WorkflowWorkspaceRecord,
  DeviceProject,
} from "./types";

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const IDENTITY_SESSION_KEY = "taskboard.identity.session";
const IDENTITY_USER_KEY = "taskboard.identity.user";

interface IdentityUser {
  id: string;
  employeeNo: string;
  displayName: string;
  email: string | null;
  department: string | null;
  jobTitle: string | null;
  accountStatus: string;
}

export interface IdentityStatus {
  configured: boolean;
  initialized: boolean;
  userCount: number;
  employeeCount: number;
}

function readStorage(key: string): string | null {
  try { return window.localStorage.getItem(key); } catch { return null; }
}

function identitySession(): string | null {
  return readStorage(IDENTITY_SESSION_KEY);
}

export function getIdentityUser(): IdentityUser | null {
  const raw = readStorage(IDENTITY_USER_KEY);
  if (!raw) return null;
  try { return JSON.parse(raw) as IdentityUser; } catch { return null; }
}

export function setIdentitySession(session: { token: string; user: IdentityUser }): void {
  window.localStorage.setItem(IDENTITY_SESSION_KEY, session.token);
  window.localStorage.setItem(IDENTITY_USER_KEY, JSON.stringify(session.user));
  setCurrentUserActor({
    type: "user",
    id: session.user.id,
    name: session.user.displayName,
    avatarUrl: null,
  });
}

export function restoreIdentitySession(): boolean {
  const token = identitySession();
  const user = getIdentityUser();
  if (!token || !user) return false;
  setIdentitySession({ token, user });
  return true;
}

export function clearIdentitySession(): void {
  window.localStorage.removeItem(IDENTITY_SESSION_KEY);
  window.localStorage.removeItem(IDENTITY_USER_KEY);
  setCurrentUserActor();
}

let currentUserActor = DEFAULT_USER_ACTOR;

export function setCurrentUserActor(actor?: ActorIdentity) {
  currentUserActor = actor?.type === "user" ? actor : DEFAULT_USER_ACTOR;
}

interface ApiErrorBody {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.error?.message ?? `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.code = body.error?.code ?? "REQUEST_FAILED";
    this.details = body.error?.details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  const session = identitySession();
  if (session) headers.set("Authorization", `Bearer ${session}`);
  if (init?.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const method = (init?.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    headers.set("X-Taskboard-User-Id", currentUserActor.id);
    headers.set("X-Taskboard-User-Name", encodeURIComponent(currentUserActor.name));
    if (currentUserActor.avatarUrl) {
      headers.set("X-Taskboard-User-Avatar", currentUserActor.avatarUrl);
    }
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiError(0, {
      error: {
        code: "SERVICE_UNAVAILABLE",
        message: "无法连接本地 Taskboard 服务，请重新通过 Taskboard 启动 Codex。",
      },
    });
  }
  const body = (await response.json().catch(() => ({}))) as T & ApiErrorBody;

  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

export async function getIdentityStatus(signal?: AbortSignal): Promise<IdentityStatus> {
  return request<IdentityStatus>("/api/identity/status", { signal });
}

export async function registerDeveloperIdentity(employeeNo: string, displayName: string): Promise<{ token: string; user: IdentityUser }> {
  return request<{ token: string; user: IdentityUser }>("/api/identity/register", {
    method: "POST",
    body: JSON.stringify({ employeeNo, displayName }),
  });
}

export async function importEmployeeWorkbook(file: File): Promise<{ count: number; employees: unknown[]; sheetName: string }> {
  return request<{ count: number; employees: unknown[]; sheetName: string }>("/api/identity/employees/import", {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "X-Taskboard-Filename": encodeURIComponent(file.name),
    },
    body: file,
  });
}

export async function listProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Project[] }>("/api/projects", { signal });
  return data.projects;
}

export async function listIdentityProjects(signal?: AbortSignal): Promise<Project[]> {
  const data = await request<{ projects: Array<{
    id: string;
    code: string;
    name: string;
    workspacePath: string | null;
    createdAt: string;
    updatedAt: string;
    role: "owner" | "developer" | null;
    ownerName?: string | null;
    issueCount: number;
  }> }>("/api/identity/projects", { signal });
  return data.projects.map((project) => ({ ...project }));
}

export async function listIdentityTasks(projectId: string, signal?: AbortSignal): Promise<Task[]> {
  const data = await request<{ tasks: Array<{
    id: string;
    projectId: string;
    taskKey: string;
    title: string;
    description: string;
    status: TaskStatus;
    priority: TaskPriority;
    assignee: { id: string; name: string | null } | null;
    createdBy: { id: string; name: string | null };
    version: number;
    createdAt: string;
    updatedAt: string;
  }> }>(`/api/identity/projects/${encodeURIComponent(projectId)}/tasks`, { signal });
  return data.tasks.map((task) => ({
    id: task.id,
    identifier: task.taskKey,
    projectId: task.projectId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: [],
    sortOrder: 0,
    threadId: null,
    creatorType: "user",
    creatorId: task.createdBy.id,
    creatorName: task.createdBy.name ?? task.createdBy.id,
    creatorAvatarUrl: null,
    assignee: task.assignee
      ? { type: "user", id: task.assignee.id, name: task.assignee.name ?? task.assignee.id, avatarUrl: null }
      : { type: "user", id: "unassigned", name: "未分配", avatarUrl: null },
    workflowId: null,
    developmentContext: null,
    dueDate: null,
    recurrence: null,
    archivedAt: null,
    relations: { parent: null, subIssues: [], blockedBy: [], blocks: [], related: [] },
    version: task.version,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  }));
}

export async function importIdentityTasks(
  projectId: string,
  tasks: Task[],
  options: { localProjectId?: string | null } = {},
): Promise<{ syncId?: string; imported: number; updated: number; deduped?: number; unchanged?: boolean }> {
  return request(`/api/identity/projects/${encodeURIComponent(projectId)}/tasks/import`, {
    method: "POST",
    body: JSON.stringify({
      localProjectId: options.localProjectId ?? null,
      tasks: tasks.map((task) => ({
        sourceId: task.id,
        title: task.title,
        description: task.description,
        status: task.status === "backlog" ? "todo" : task.status,
        priority: task.priority === "none" ? "normal" : task.priority,
        updatedAt: task.updatedAt,
      })),
    }),
  });
}

export async function saveProjectTeamBinding(input: {
  localProjectId: string;
  teamProjectId: string;
  teamProjectName?: string | null;
}): Promise<void> {
  await request(`/api/local/project-bindings/${encodeURIComponent(input.localProjectId)}`, {
    method: "PUT",
    body: JSON.stringify({
      teamProjectId: input.teamProjectId,
      teamProjectName: input.teamProjectName ?? null,
    }),
  });
}

export async function summarizeLocalProject(projectId: string, sourceProjectIds: string[] = []): Promise<{ created: number; message: string }> {
  return request(`/api/projects/${encodeURIComponent(projectId)}/summaries`, {
    method: "POST",
    body: JSON.stringify(sourceProjectIds.length > 0 ? { sourceProjectIds } : {}),
  });
}

export interface IdentityProjectMember {
  userId: string;
  employeeNo: string;
  displayName: string;
  email: string | null;
  department: string | null;
  projectRole: "owner" | "developer";
  joinedAt: string;
}

export interface IdentityTaskSyncLog {
  id: string;
  projectId: string;
  projectName: string;
  projectCode: string;
  operatorUserId: string;
  operatorName: string;
  operatorEmployeeNo: string;
  localProjectId: string | null;
  taskCount: number;
  imported: number;
  updated: number;
  failed: number;
  status: "success" | "failed";
  error: string | null;
  createdAt: string;
}

export interface ProjectTeamBinding {
  localProjectId: string;
  teamProjectId: string;
  teamProjectName: string | null;
  boundAt: string;
  updatedAt: string;
}

export interface ProjectSyncStatus {
  localProjectId: string;
  teamProjectId: string | null;
  status: "success" | "failed";
  taskCount: number;
  imported: number;
  updated: number;
  failed: number;
  error: string | null;
  submittedBy: string | null;
  submittedAt: string;
}

export async function listIdentityTaskSyncLogs(signal?: AbortSignal): Promise<IdentityTaskSyncLog[]> {
  const data = await request<{ logs: IdentityTaskSyncLog[] }>("/api/identity/task-sync-logs", { signal });
  return data.logs;
}

export async function getProjectTeamBinding(localProjectId: string, signal?: AbortSignal): Promise<ProjectTeamBinding | null> {
  const data = await request<{ binding: ProjectTeamBinding | null }>(
    `/api/local/project-bindings/${encodeURIComponent(localProjectId)}`,
    { signal },
  );
  return data.binding;
}

export async function getProjectSyncStatus(localProjectId: string, signal?: AbortSignal): Promise<ProjectSyncStatus | null> {
  const data = await request<{ syncStatus: ProjectSyncStatus | null }>(
    `/api/local/project-sync-status/${encodeURIComponent(localProjectId)}`,
    { signal },
  );
  return data.syncStatus;
}

export async function listIdentityEmployees(): Promise<Array<{ employeeNo: string; displayName: string; isActive: boolean }>> {
  const data = await request<{ employees: Array<{ employeeNo: string; displayName: string; isActive: boolean }> }>("/api/identity/employees");
  return data.employees;
}

export async function listAvailableIdentityDevelopers(projectId: string): Promise<Array<{ userId: string; employeeNo: string; displayName: string }>> {
  const data = await request<{ developers: Array<{ userId: string; employeeNo: string; displayName: string }> }>(
    `/api/identity/developers/available?projectId=${encodeURIComponent(projectId)}`,
  );
  return data.developers;
}

export async function listIdentityProjectMembers(projectId: string): Promise<IdentityProjectMember[]> {
  const data = await request<{ members: IdentityProjectMember[] }>(`/api/identity/projects/${encodeURIComponent(projectId)}/members`);
  return data.members;
}

export async function addIdentityProjectMember(projectId: string, employeeNo: string): Promise<IdentityProjectMember[]> {
  const data = await request<{ members: IdentityProjectMember[] }>(`/api/identity/projects/${encodeURIComponent(projectId)}/members`, {
    method: "POST",
    body: JSON.stringify({ employeeNo }),
  });
  return data.members;
}

export async function removeIdentityProjectMember(projectId: string, memberUserId: string): Promise<IdentityProjectMember[]> {
  const data = await request<{ members: IdentityProjectMember[] }>(`/api/identity/projects/${encodeURIComponent(projectId)}/members`, {
    method: "POST",
    body: JSON.stringify({ action: "remove", memberUserId }),
  });
  return data.members;
}

export async function joinIdentityProject(projectId: string): Promise<IdentityProjectMember[]> {
  const data = await request<{ members: IdentityProjectMember[] }>(`/api/identity/projects/${encodeURIComponent(projectId)}/join`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  return data.members;
}

export async function createIdentityProject(input: {
  code: string;
  name: string;
  workspacePath: string | null;
  description?: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/identity/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function getTaskboardMetadata(signal?: AbortSignal): Promise<TaskboardMetadata> {
  return request<TaskboardMetadata>("/api/meta", { signal });
}

export async function getTaskboardRevision(
  since: number,
  signal?: AbortSignal,
): Promise<{ changed: boolean; revision: number }> {
  const query = new URLSearchParams({ since: String(since) });
  return request<{ changed: boolean; revision: number }>(`/api/revisions?${query}`, { signal });
}

export async function getAiChatCatalog(
  projectId: string,
  signal?: AbortSignal,
): Promise<AiChatCatalog> {
  return request<AiChatCatalog>(
    `/api/local/ai/catalog?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
}

export async function listAiChatThreads(signal?: AbortSignal): Promise<AiChatThread[]> {
  const data = await request<{ threads: AiChatThread[] }>("/api/local/ai/threads", { signal });
  return data.threads;
}

export async function createAiChatThread(input: {
  projectId: string;
  issueId?: string;
  title?: string;
  model?: string;
  reasoningEffort?: string;
  sandbox?: AiChatSandbox;
}): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>("/api/local/ai/threads", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.thread;
}

export async function getAiChatThread(
  threadId: string,
  signal?: AbortSignal,
): Promise<AiChatThreadSnapshot> {
  return request<AiChatThreadSnapshot>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { signal },
  );
}

export async function updateAiChatThread(
  threadId: string,
  input: {
    title?: string;
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  },
): Promise<AiChatThread> {
  const data = await request<{ thread: AiChatThread }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
  return data.thread;
}

export async function deleteAiChatThread(threadId: string): Promise<void> {
  await request<void>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}`,
    { method: "DELETE" },
  );
}

export async function startAiChatTurn(
  threadId: string,
  input: {
    message: string;
    skillIds?: string[];
    attachments?: AiChatAttachmentInput[];
    dangerFullAccessConfirmed?: boolean;
  },
): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/threads/${encodeURIComponent(threadId)}/turns`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
  return data.run;
}

export async function interruptAiChatRun(runId: string): Promise<AiChatRun> {
  const data = await request<{ run: AiChatRun }>(
    `/api/local/ai/runs/${encodeURIComponent(runId)}/interrupt`,
    { method: "POST" },
  );
  return data.run;
}

export async function listAutomationRunActivity(
  projectId: string,
  signal?: AbortSignal,
): Promise<AutomationRunActivity[]> {
  const data = await request<{ runs: AutomationRunActivity[] }>(
    `/api/local/automation/runs?projectId=${encodeURIComponent(projectId)}`,
    { signal },
  );
  return data.runs;
}

export function subscribeAiChatThread(
  threadId: string,
  onHint: (type: "ai.event" | "ai.run") => void,
  onError?: () => void,
): () => void {
  const source = new EventSource(`/api/local/ai/threads/${encodeURIComponent(threadId)}/events`);
  source.addEventListener("ai.event", () => onHint("ai.event"));
  source.addEventListener("ai.run", () => onHint("ai.run"));
  if (onError) source.addEventListener("error", onError);
  return () => source.close();
}

export async function listDeviceWorkspaces(signal?: AbortSignal): Promise<{
  workspaces: Record<string, string>;
  projects: DeviceProject[];
}> {
  try {
    const data = await request<{
      workspaces: Record<string, string>;
      projects?: DeviceProject[];
    }>("/api/device-workspaces", { signal });
    return { workspaces: data.workspaces, projects: data.projects ?? [] };
  } catch (error) {
    if (error instanceof ApiError && error.code === "LOCAL_COMPANION_REQUIRED") {
      return { workspaces: {}, projects: [] };
    }
    throw error;
  }
}

export async function listWorkflowCapabilities(
  workspacePath?: string,
  signal?: AbortSignal,
): Promise<WorkflowCapabilities> {
  const query = new URLSearchParams();
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<WorkflowCapabilities>(`/api/workflow-capabilities${suffix}`, { signal });
}

export async function getWorkflowWorkspace<T>(
  projectId: string,
  signal?: AbortSignal,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    { signal },
  );
  return data.workflow;
}

export async function saveWorkflowWorkspace<T>(
  projectId: string,
  workspace: T,
  version: number,
): Promise<WorkflowWorkspaceRecord<T>> {
  const data = await request<{ workflow: WorkflowWorkspaceRecord<T> }>(
    `/api/projects/${encodeURIComponent(projectId)}/workflow-workspace`,
    {
      method: "PUT",
      body: JSON.stringify({ version, workspace }),
    },
  );
  return data.workflow;
}

export async function createProject(input: {
  id: string;
  name: string;
  workspacePath: string | null;
}): Promise<Project> {
  const data = await request<{ project: Project }>("/api/projects", {
    method: "POST",
    body: JSON.stringify(input),
  });
  return data.project;
}

export async function listDevelopmentContexts(
  projectId: string,
  codexProjectId?: string,
  codexThreadId?: string,
  signal?: AbortSignal,
  workspacePath?: string,
): Promise<DevelopmentScan> {
  const query = new URLSearchParams();
  if (codexProjectId) query.set("codexProjectId", codexProjectId);
  if (codexThreadId) query.set("codexThreadId", codexThreadId);
  if (workspacePath) query.set("workspacePath", workspacePath);
  const suffix = query.size > 0 ? `?${query}` : "";
  return request<DevelopmentScan>(
    `/api/projects/${encodeURIComponent(projectId)}/development-contexts${suffix}`,
    { signal },
  );
}

export async function listTasks(projectId: string, signal?: AbortSignal): Promise<Task[]> {
  const params = new URLSearchParams({ projectId, archived: "false" });
  const data = await request<{ tasks: Task[] }>(`/api/tasks?${params}`, { signal });
  return data.tasks;
}

export async function createTask(projectId: string, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>("/api/tasks", {
    method: "POST",
    body: JSON.stringify({ projectId, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function updateTask(task: Task, draft: TaskDraft, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ version: task.version, ...draft, ...(threadId ? { threadId } : {}) }),
  });
  return data.task;
}

export async function moveTask(
  task: Task,
  status: TaskStatus,
  sortOrder: number,
  threadId?: string,
): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/move`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, status, sortOrder, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function archiveTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/archive`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function restoreTask(task: Task, threadId?: string): Promise<Task> {
  const data = await request<{ task: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/restore`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.task;
}

export async function addTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "POST",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function removeTaskRelation(
  task: Task,
  type: IssueRelationType,
  relatedTaskId: string,
  threadId?: string,
): Promise<{ task: Task; relatedTask: Task }> {
  return request<{ task: Task; relatedTask: Task }>(
    `/api/tasks/${encodeURIComponent(task.id)}/relations/${type}/${encodeURIComponent(relatedTaskId)}`,
    {
      method: "DELETE",
      body: JSON.stringify({ version: task.version, ...(threadId ? { threadId } : {}) }),
    },
  );
}

export async function listComments(taskId: string, signal?: AbortSignal): Promise<Comment[]> {
  const data = await request<{ comments: Comment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    { signal },
  );
  return data.comments;
}

export async function createComment(taskId: string, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function updateComment(comment: Comment, body: string, threadId?: string): Promise<Comment> {
  const data = await request<{ comment: Comment }>(
    `/api/comments/${encodeURIComponent(comment.id)}`,
    {
      method: "PATCH",
      body: JSON.stringify({ version: comment.version, body, ...(threadId ? { threadId } : {}) }),
    },
  );
  return data.comment;
}

export async function deleteComment(comment: Comment, threadId?: string): Promise<void> {
  await request(`/api/comments/${encodeURIComponent(comment.id)}`, {
    method: "DELETE",
    body: JSON.stringify({ version: comment.version, ...(threadId ? { threadId } : {}) }),
  });
}

export async function listAttachments(taskId: string, signal?: AbortSignal): Promise<Attachment[]> {
  const data = await request<{ attachments: Attachment[] }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    { signal },
  );
  return data.attachments;
}

export async function uploadAttachment(taskId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/tasks/${encodeURIComponent(taskId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function uploadCommentAttachment(commentId: string, file: File): Promise<Attachment> {
  const data = await request<{ attachment: Attachment }>(
    `/api/comments/${encodeURIComponent(commentId)}/attachments`,
    {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "X-Taskboard-Filename": encodeURIComponent(file.name),
      },
      body: file,
    },
  );
  return data.attachment;
}

export async function deleteAttachment(attachment: Attachment): Promise<void> {
  await request(`/api/attachments/${encodeURIComponent(attachment.id)}`, {
    method: "DELETE",
  });
}

export function attachmentContentUrl(attachment: Attachment): string {
  return `/api/attachments/${encodeURIComponent(attachment.id)}/content`;
}
