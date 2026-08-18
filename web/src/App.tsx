import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Dispatch,
  type SetStateAction,
} from "react";
import {
  isAutomationModel,
  isAutomationReasoningEffort,
  isSupportedModelEffort,
  type AutomationModel,
  type AutomationReasoningEffort,
} from "../../shared/taskboard-automation-options.mjs";
import {
  ApiError,
  addTaskRelation,
  archiveTask as archiveTaskRequest,
  createProject as createProjectRequest,
  createTask as createTaskRequest,
  createIdentityProject,
  addIdentityProjectMember,
  getTaskboardRevision,
  getWorkflowWorkspace,
  getTaskboardMetadata,
  getIdentityUser,
  getProjectSyncStatus,
  getProjectTeamBinding,
  importIdentityTasks,
  joinIdentityProject,
  removeIdentityProjectMember,
  saveProjectTeamBinding,
  listIdentityProjects,
  listIdentityTasks,
  listAvailableIdentityDevelopers,
  listIdentityProjectMembers,
  listIdentityTaskSyncLogs,
  summarizeLocalProject,
  listDevelopmentContexts,
  listDeviceWorkspaces,
  listProjects,
  listTasks,
  moveTask as moveTaskRequest,
  removeTaskRelation,
  restoreTask as restoreTaskRequest,
  setCurrentUserActor,
  uploadAttachment,
  updateTask as updateTaskRequest,
} from "./api";
import { IdentityGate } from "./components/IdentityGate";
import { IdentityNavEntry } from "./components/IdentityNavEntry";
import {
  actorForAssigneeTarget,
  assigneeTargetForActor,
} from "./actors";
import { BoardColumn, STATUS_DETAILS } from "./components/BoardColumn";
import { AiChat } from "./components/AiChat";
import { BoardSettingsMenu } from "./components/BoardSettingsMenu";
import { HiddenColumns } from "./components/HiddenColumns";
import {
  resolveInlineMediaMarkdown,
  type PendingInlineImage,
} from "./components/InlineMediaComposer";
import { LinearIcon } from "./components/LinearIcon";
import { ProjectAutomationMenu } from "./components/ProjectAutomationMenu";
import { TaskContextMenu } from "./components/TaskContextMenu";
import { TaskDetail } from "./components/TaskDetail";
import { TaskEditor } from "./components/TaskEditor";
import { TaskFilterMenu } from "./components/TaskFilterMenu";
import { buildIssueUrl, readIssueIdentifier } from "./issueRoute";
import { DEFAULT_LABELS } from "./labels";
import {
  EMPTY_TASK_FILTERS,
  matchesTaskFilters,
  matchesTaskSearch,
  readTaskFilters,
  taskFilterCount,
  writeTaskFilters,
} from "./taskFilters";
import {
  TASK_STATUSES,
  type ActorIdentity,
  type DeviceProject,
  type DevelopmentScan,
  type HostContext,
  type IssueRelationType,
  type Project,
  type Task,
  type TaskboardMetadata,
  type TaskDraft,
  type TaskStatus,
  type WorkflowOption,
} from "./types";
import type { IdentityProjectMember, IdentityTaskSyncLog, ProjectSyncStatus, ProjectTeamBinding } from "./api";
import {
  DEFAULT_WORKFLOW_OPTIONS,
  readLegacyWorkflowWorkspace,
  workflowOptionsFromWorkspace,
} from "./workflowStore";
// The poller stays in ESM JavaScript so its lifecycle can be tested directly with node:test.
// @ts-expect-error The module's option contract is enforced by its focused node tests.
import { createRevisionPoller, getRevisionPollingInterval } from "./revisionPolling.mjs";

type ConnectionState = "connecting" | "live" | "reconnecting";
type Theme = "light" | "dark";
type BoardView = "issues" | "workflow";
const SHOW_WORKFLOW_BOARD_ENTRY = false;

const WorkflowBoard = lazy(() => import("./components/WorkflowBoard").then((module) => ({
  default: module.WorkflowBoard,
})));

interface EditorState {
  task: Task | null;
  status: TaskStatus;
}

interface ContextMenuState {
  taskId: string;
  x: number;
  y: number;
}

interface ProjectChoice {
  id: string;
  sourceProjectId?: string;
  teamProjectId?: string;
  code?: string;
  name: string;
  workspacePath: string | null;
  updatedAt: string;
  issueCount: number;
  inCodex: boolean;
  persisted: boolean;
  role?: "owner" | "developer" | null;
  ownerName?: string | null;
}

const TASK_PROGRESS_WEIGHTS: Record<string, number> = {
  todo: 0,
  in_progress: 50,
  in_review: 80,
  blocked: 0,
  done: 100,
};

function taskProgressPercent(tasks: Task[], fallbackTotal = 0) {
  const activeTasks = tasks.filter((task) => task.status !== "canceled");
  const total = activeTasks.length > 0 ? activeTasks.length : fallbackTotal;
  if (total <= 0) return 0;
  const weightedProgress = activeTasks.reduce((sum, task) => sum + (TASK_PROGRESS_WEIGHTS[task.status] ?? 0), 0);
  return Math.round(weightedProgress / total);
}

function localTaskProjectIds(
  project: Pick<ProjectChoice, "id" | "sourceProjectId" | "workspacePath">,
  projects: ProjectChoice[],
  deviceProjects: DeviceProject[],
): string[] {
  const ids = [project.id];
  const sameWorkspace = projects.find((candidate) => (
    candidate.persisted
    && candidate.workspacePath
    && project.workspacePath
    && candidate.workspacePath === project.workspacePath
  ));
  if (sameWorkspace?.sourceProjectId && !ids.includes(sameWorkspace.sourceProjectId)) ids.push(sameWorkspace.sourceProjectId);
  const deviceProject = deviceProjects.find((candidate) => (
    candidate.id === project.id || candidate.workspacePath === project.workspacePath
  ));
  if (deviceProject?.sourceProjectId && !ids.includes(deviceProject.sourceProjectId)) ids.push(deviceProject.sourceProjectId);
  if (project.sourceProjectId && !ids.includes(project.sourceProjectId)) ids.push(project.sourceProjectId);
  return ids;
}

function localProjectKey(project: Pick<ProjectChoice, "id" | "sourceProjectId">): string {
  return project.sourceProjectId ?? project.id;
}

type ProjectOverviewView = "overview" | "database-progress" | "team-board" | "tasks" | "members" | "analytics" | "mine" | "member-config" | "sync-log" | "attention" | "codex" | "activity";
type WorkspaceRole = "owner" | "developer" | "none";

interface ProjectProgressRow {
  id: string;
  name: string;
  health: string;
  progress: number;
  total: number;
  done: number;
  active: number;
  blocked: number;
  review: number;
  todo: number;
  updated: string;
  project: ProjectChoice;
}

interface UndoOperation {
  id: number;
  message: string;
  undo: () => Promise<void>;
}

interface UndoNotice {
  id: number;
  message: string;
}

type ColumnVisibilityByProject = Record<string, Partial<Record<TaskStatus, boolean>>>;
type ProjectAutomationStatus = "ACTIVE" | "PAUSED";
type AutomationQuotaState = "available" | "blocked" | "unknown" | "unavailable";
type AutomationIntervalMinutes = 5 | 10 | 15 | 30 | 60;

interface AutomationQuotaStatus {
  state: AutomationQuotaState;
  checkedAt: number;
  resetsAt?: number;
  reason?: "api-key";
}

interface ProjectAutomationRecord {
  automationId?: string;
  codexProjectId: string;
  status: ProjectAutomationStatus;
  enabledByUser: boolean;
  quotaAware: boolean;
  quota?: AutomationQuotaStatus;
  lastRun?: AutomationRunSummary;
  intervalMinutes: AutomationIntervalMinutes;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
}

type ProjectAutomations = Record<string, ProjectAutomationRecord>;

interface AutomationHostItem {
  id: string;
  status: ProjectAutomationStatus;
  model: AutomationModel;
  reasoningEffort: AutomationReasoningEffort;
  rrule: string;
}

interface AutomationHostResponse {
  requestId: string;
  ok: boolean;
  item?: AutomationHostItem;
  items?: AutomationHostItem[];
  quota?: AutomationQuotaStatus;
  run?: AutomationRunSummary;
  lastRun?: AutomationRunSummary;
  policy?: {
    automationId?: string;
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  };
  error?: string;
}

interface AutomationRunSummary {
  id: string;
  projectId: string;
  issueId?: string | null;
  aiThreadId?: string | null;
  aiRunId?: string | null;
  status: "running" | "completed" | "failed" | "skipped";
  startedAt: string;
  finishedAt?: string | null;
  error?: string | null;
}

interface PendingAutomationRequest {
  resolve: (response: AutomationHostResponse) => void;
  reject: (error: Error) => void;
  timeoutId: number;
}

const DEFAULT_USER_ACTOR: ActorIdentity = {
  type: "user",
  id: "local-user",
  name: "本地用户",
  avatarUrl: null,
};

const LAST_PROJECT_KEY = "taskboard.lastProjectId";
const FAVORITE_PROJECTS_KEY = "taskboard.favoriteProjectIds";
const DEVICE_WORKSPACE_PATHS_KEY = "taskboard.deviceWorkspacePaths.v1";
const SHOW_EMPTY_COLUMNS_KEY = "taskboard.showEmptyColumns.v1";
const COLUMN_VISIBILITY_KEY = "taskboard.columnVisibility.v1";
const PROJECT_AUTOMATIONS_KEY = "taskboard.projectAutomations.v1";
const DEFAULT_AUTOMATION_OPTIONS = {
  enabledByUser: false,
  quotaAware: false,
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
} as const;

const EVENT_NAMES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.archived",
  "task.restored",
  "task.relation.updated",
  "comment.created",
  "comment.updated",
  "comment.deleted",
  "attachment.created",
  "attachment.deleted",
  "project.created",
  "workflow.updated",
] as const;

function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

function getInitialTheme(): Theme {
  const fromQuery = new URLSearchParams(window.location.search).get("theme");
  if (isTheme(fromQuery)) return fromQuery;
  const stored = window.localStorage.getItem("taskboard.theme");
  if (isTheme(stored)) return stored;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readFavoriteProjectIds(): Set<string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(FAVORITE_PROJECTS_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function readDeviceWorkspacePaths(): Record<string, string> {
  try {
    const value = JSON.parse(window.localStorage.getItem(DEVICE_WORKSPACE_PATHS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
      typeof entry[1] === "string" && entry[1].trim().length > 0
    )));
  } catch {
    return {};
  }
}

function readShowEmptyColumns(): boolean {
  return window.localStorage.getItem(SHOW_EMPTY_COLUMNS_KEY) === "true";
}

function readProjectAutomations(): ProjectAutomations {
  try {
    const value = JSON.parse(window.localStorage.getItem(PROJECT_AUTOMATIONS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ProjectAutomations = {};
    for (const [projectId, record] of Object.entries(value)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      const candidate = record as Partial<ProjectAutomationRecord>;
      const model = candidate.model ?? "gpt-5.5";
      const reasoningEffort = candidate.reasoningEffort ?? "high";
      const enabledByUser = candidate.enabledByUser ?? candidate.status === "ACTIVE";
      const quotaAware = candidate.quotaAware ?? false;
      if (
        (candidate.automationId !== undefined && typeof candidate.automationId !== "string")
        || typeof candidate.codexProjectId !== "string"
        || (candidate.status !== "ACTIVE" && candidate.status !== "PAUSED")
        || !isAutomationIntervalMinutes(candidate.intervalMinutes ?? 5)
        || !isAutomationModel(model)
        || !isAutomationReasoningEffort(reasoningEffort)
        || !isSupportedModelEffort(model, reasoningEffort)
        || (candidate.status === "ACTIVE" && !candidate.automationId)
        || typeof enabledByUser !== "boolean"
        || typeof quotaAware !== "boolean"
      ) continue;
      const quota = isAutomationQuotaStatus(candidate.quota) ? candidate.quota : undefined;
      result[projectId] = {
        automationId: candidate.automationId,
        codexProjectId: candidate.codexProjectId,
        status: candidate.status,
        enabledByUser,
        quotaAware,
        ...(quota ? { quota } : {}),
        intervalMinutes: candidate.intervalMinutes ?? 5,
        model,
        reasoningEffort,
      };
    }
    return result;
  } catch {
    return {};
  }
}

function isAutomationQuotaStatus(value: unknown): value is AutomationQuotaStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<AutomationQuotaStatus>;
  return (
    (candidate.state === "available"
      || candidate.state === "blocked"
      || candidate.state === "unknown"
      || candidate.state === "unavailable")
    && Number.isFinite(candidate.checkedAt)
    && (candidate.resetsAt === undefined || Number.isFinite(candidate.resetsAt))
    && (candidate.reason === undefined || candidate.reason === "api-key")
  );
}

function isAutomationHostPolicy(
  value: AutomationHostResponse["policy"] | undefined,
): value is NonNullable<AutomationHostResponse["policy"]> {
  return Boolean(
    value
    && (value.automationId === undefined || typeof value.automationId === "string")
    && typeof value.enabledByUser === "boolean"
    && typeof value.quotaAware === "boolean"
    && isAutomationIntervalMinutes(value.intervalMinutes)
    && isAutomationModel(value.model)
    && isAutomationReasoningEffort(value.reasoningEffort)
    && isSupportedModelEffort(value.model, value.reasoningEffort),
  );
}

function isAutomationIntervalMinutes(value: unknown): value is AutomationIntervalMinutes {
  return value === 5 || value === 10 || value === 15 || value === 30 || value === 60;
}

function intervalMinutesFromRrule(value: string): AutomationIntervalMinutes | null {
  const match = /^RRULE:FREQ=MINUTELY;INTERVAL=(5|10|15|30|60)$/.exec(value);
  return match ? Number(match[1]) as AutomationIntervalMinutes : null;
}

function readColumnVisibilityByProject(): ColumnVisibilityByProject {
  try {
    const value = JSON.parse(window.localStorage.getItem(COLUMN_VISIBILITY_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: ColumnVisibilityByProject = {};
    for (const [projectId, visibilityValue] of Object.entries(value)) {
      if (!visibilityValue || typeof visibilityValue !== "object" || Array.isArray(visibilityValue)) continue;
      const visibility: Partial<Record<TaskStatus, boolean>> = {};
      for (const status of TASK_STATUSES) {
        const visible = (visibilityValue as Record<string, unknown>)[status];
        if (typeof visible === "boolean") visibility[status] = visible;
      }
      result[projectId] = visibility;
    }
    return result;
  } catch {
    return {};
  }
}

function workspaceName(path?: string): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong while loading your issues.";
}

function isAutomationHostItem(value: unknown): value is AutomationHostItem {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Partial<AutomationHostItem>;
  return (
    typeof item.id === "string"
    && (item.status === "ACTIVE" || item.status === "PAUSED")
    && isAutomationModel(item.model)
    && isAutomationReasoningEffort(item.reasoningEffort)
    && isSupportedModelEffort(item.model, item.reasoningEffort)
    && typeof item.rrule === "string"
    && intervalMinutesFromRrule(item.rrule) !== null
  );
}

function isLocalTaskboardOrigin(origin: string): boolean {
  try {
    const { protocol, hostname } = new URL(origin);
    return (protocol === "http:" || protocol === "https:")
      && (hostname === "127.0.0.1" || hostname === "localhost");
  } catch {
    return false;
  }
}

function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort(
    (left, right) => left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
  );
}

function HoverScrollingTitle({ title }: { title: string }) {
  const titleRef = useRef<HTMLSpanElement>(null);
  const [scrollDistance, setScrollDistance] = useState(0);
  const measure = () => {
    const element = titleRef.current;
    if (!element) return;
    const viewport = element.parentElement;
    if (!viewport) return;
    const titleWidth = element.getBoundingClientRect().width;
    const availableWidth = Math.max(0, viewport.clientWidth - 12);
    setScrollDistance(Math.min(0, availableWidth - titleWidth));
  };
  return <span
    ref={titleRef}
    className={`overview-member-task-title${scrollDistance < 0 ? " is-scrollable" : ""}`}
    style={scrollDistance < 0 ? { "--title-shift": `${scrollDistance}px` } as CSSProperties : undefined}
    onMouseEnter={measure}
    onFocus={measure}
  >{title}</span>;
}

function taskToDraft(task: Task): TaskDraft {
  return {
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    labels: task.labels,
    workflowId: task.workflowId,
    developmentContext: task.developmentContext,
    dueDate: task.dueDate,
    recurrence: task.recurrence,
  };
}

interface LocalRealtimeSyncProps {
  selectedProjectId: string;
  detailTaskId: string | null;
  refreshProjectList: () => Promise<void>;
  refreshTasks: (
    projectId: string,
    options?: { quiet?: boolean; signal?: AbortSignal },
  ) => Promise<void>;
  refreshWorkflowOptions: (projectId: string, signal?: AbortSignal) => Promise<void>;
  setConnection: Dispatch<SetStateAction<ConnectionState>>;
  setCommentsRevision: Dispatch<SetStateAction<number>>;
  setAttachmentsRevision: Dispatch<SetStateAction<number>>;
}

function LocalRealtimeSync({
  selectedProjectId,
  detailTaskId,
  refreshProjectList,
  refreshTasks,
  refreshWorkflowOptions,
  setConnection,
  setCommentsRevision,
  setAttachmentsRevision,
}: LocalRealtimeSyncProps) {
  useEffect(() => {
    const source = new EventSource("/api/events");
    let refreshTimer: number | undefined;
    let refreshProjectsPending = false;
    let refreshTasksPending = false;

    const scheduleRefresh = (options: { projects?: boolean; tasks?: boolean }) => {
      refreshProjectsPending ||= options.projects === true;
      refreshTasksPending ||= options.tasks === true;
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        if (refreshProjectsPending) void refreshProjectList();
        if (refreshTasksPending && selectedProjectId) {
          void refreshTasks(selectedProjectId, { quiet: true });
        }
        refreshProjectsPending = false;
        refreshTasksPending = false;
      }, 120);
    };

    const handleEvent = (event: Event) => {
      const message = event as MessageEvent<string>;
      let payload: { projectId?: string; taskId?: string } = {};
      try {
        payload = JSON.parse(message.data) as { projectId?: string; taskId?: string };
      } catch {
        // A malformed event should not interrupt later updates.
      }
      const affectsSelectedProject = Boolean(selectedProjectId)
        && (!payload.projectId || payload.projectId === selectedProjectId);
      if (event.type === "project.created") {
        scheduleRefresh({ projects: true });
        return;
      }
      if (event.type.startsWith("task.")) {
        scheduleRefresh({ projects: true, tasks: affectsSelectedProject });
        return;
      }
      if (!affectsSelectedProject) return;
      if (event.type === "workflow.updated") {
        if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
        return;
      }
      if (event.type.startsWith("comment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setCommentsRevision((current) => current + 1);
        }
        scheduleRefresh({ tasks: true });
        return;
      }
      if (event.type.startsWith("attachment.")) {
        if (!detailTaskId || !payload.taskId || payload.taskId === detailTaskId) {
          setAttachmentsRevision((current) => current + 1);
          setCommentsRevision((current) => current + 1);
        }
      }
    };

    EVENT_NAMES.forEach((name) => source.addEventListener(name, handleEvent));
    source.onopen = () => {
      setConnection("live");
      scheduleRefresh({ projects: true, tasks: Boolean(selectedProjectId) });
      if (selectedProjectId) void refreshWorkflowOptions(selectedProjectId);
      if (detailTaskId) {
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      }
    };
    source.onerror = () => setConnection("reconnecting");

    return () => {
      window.clearTimeout(refreshTimer);
      EVENT_NAMES.forEach((name) => source.removeEventListener(name, handleEvent));
      source.close();
    };
  }, [
    detailTaskId,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
    selectedProjectId,
    setAttachmentsRevision,
    setCommentsRevision,
    setConnection,
  ]);

  return null;
}

function TeamProjectBoard({
  rows,
  onOpenProject,
}: {
  rows: ProjectProgressRow[];
  onOpenProject: (project: ProjectChoice) => void;
}) {
  const segmentWidth = (value: number, total: number) => `${total > 0 ? Math.round((value / total) * 100) : 0}%`;
  return (
    <section className="overview-project-section" aria-labelledby="overview-project-progress-title">
      <div className="overview-panel-heading">
        <h2 id="overview-project-progress-title">项目进度</h2>
        <span>{rows.length} 个项目</span>
      </div>
      <div className="overview-project-table" role="table" aria-label="团队项目进度">
        <div className="overview-project-table-head" role="row">
          <span>项目</span>
          <span>健康</span>
          <span>进度</span>
          <span>任务卡分布</span>
        </div>
        {rows.map((row) => (
          <div
            className="overview-project-row"
            key={row.id}
            role="button"
            tabIndex={0}
            onClick={() => onOpenProject(row.project)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") onOpenProject(row.project);
            }}
          >
            <span className="overview-project-name">
              <strong>{row.name}</strong>
              <small>{row.updated}更新</small>
            </span>
            <span className={`overview-health-pill is-${row.health === "正常" ? "healthy" : row.health === "阻塞" ? "blocked" : "risk"}`}>
              {row.health}
            </span>
            <span className="overview-progress-cell">
              <span className="overview-progress-bar" aria-hidden="true">
                <i style={{ width: `${row.progress}%` }} />
              </span>
              <small>{row.progress}%</small>
            </span>
            <span className="overview-task-mix">
              <span className="overview-task-stack" aria-hidden="true">
                <i className="is-done" style={{ width: segmentWidth(row.done, row.total) }} />
                <i className="is-active" style={{ width: segmentWidth(row.active, row.total) }} />
                <i className="is-review" style={{ width: segmentWidth(row.review, row.total) }} />
                <i className="is-blocked" style={{ width: segmentWidth(row.blocked, row.total) }} />
              </span>
              <small>待办 {row.todo} · 进行 {row.active} · 验收 {row.review} · 阻塞 {row.blocked}</small>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function DatabaseProgressPanel({
  rows,
  identityMode,
  loading,
  onOpenProject,
  onRefresh,
  embedded = false,
}: {
  rows: ProjectProgressRow[];
  identityMode: boolean;
  loading: boolean;
  onOpenProject: (project: ProjectChoice) => void;
  onRefresh: () => Promise<void>;
  embedded?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [healthFilter, setHealthFilter] = useState<"all" | "normal" | "risk" | "blocked">("all");
  const [refreshing, setRefreshing] = useState(false);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredRows = rows.filter((row) => {
    const matchesQuery = !normalizedQuery || row.name.toLowerCase().includes(normalizedQuery);
    const matchesHealth = healthFilter === "all"
      || (healthFilter === "normal" && row.health === "正常")
      || (healthFilter === "risk" && row.health === "有风险")
      || (healthFilter === "blocked" && row.health === "阻塞");
    return matchesQuery && matchesHealth;
  });
  const totalTasks = rows.reduce((sum, row) => sum + row.total, 0);
  const doneTasks = rows.reduce((sum, row) => sum + row.done, 0);
  const blockedProjects = rows.filter((row) => row.health === "阻塞").length;
  const riskProjects = rows.filter((row) => row.health === "有风险").length;
  const averageProgress = rows.length > 0 ? Math.round(rows.reduce((sum, row) => sum + row.progress, 0) / rows.length) : 0;
  const segmentWidth = (value: number, total: number) => `${total > 0 ? Math.round((value / total) * 100) : 0}%`;
  const runRefresh = async () => {
    setRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <section className="database-progress-page" aria-labelledby="database-progress-title">
      <section className="database-progress-board" aria-labelledby="database-progress-title">
        {!embedded && <div className="database-progress-header">
          <div>
            <h1 id="database-progress-title">项目进度总览</h1>
            <p>{filteredRows.length} / {rows.length} 个公司项目</p>
          </div>
          <div className="database-progress-header-actions">
            <span className={`database-connection-tag ${identityMode ? "is-online" : "is-offline"}`}>
              <i aria-hidden="true" />
              {identityMode ? "已连接公司库" : "未连接公司库"}
            </span>
            <button className="database-ant-button" type="button" onClick={() => void runRefresh()} disabled={refreshing}>
              <LinearIcon name="recurrence" />
              {refreshing ? "刷新中" : "刷新"}
            </button>
          </div>
          <div className="database-toolbar">
            <label className="database-search">
              <LinearIcon name="search" />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索项目名称" />
            </label>
            <div className="database-segmented" aria-label="健康状态筛选">
              {[
                ["all", "全部"],
                ["normal", "正常"],
                ["risk", "风险"],
                ["blocked", "阻塞"],
              ].map(([value, label]) => (
                <button
                  key={value}
                  className={healthFilter === value ? "is-active" : ""}
                  type="button"
                  onClick={() => setHealthFilter(value as typeof healthFilter)}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>}

        <div className="database-progress-content">
          <div className="database-stat-grid" aria-label="公司项目统计">
            {[
              { label: "公司项目", value: rows.length, detail: "已创建项目" },
              { label: "平均进度", value: `${averageProgress}%`, detail: "按项目均值" },
              { label: "已完成任务", value: doneTasks, detail: `共 ${totalTasks} 张任务卡` },
              { label: "风险项目", value: riskProjects + blockedProjects, detail: `阻塞 ${blockedProjects} 个` },
            ].map((item) => (
              <article className="database-stat-card" key={item.label}>
                <span>{item.label}</span>
                <strong>{item.value}</strong>
                <small>{item.detail}</small>
              </article>
            ))}
          </div>

          {loading ? (
            <div className="database-ant-loading" aria-busy="true"><span /><span /><span /></div>
          ) : !identityMode ? (
            <div className="database-ant-empty">
              <LinearIcon name="alert" />
              <strong>未连接公司数据库</strong>
              <span>请先在账号入口连接 SQL Server 公司库。</span>
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="database-ant-empty">
              <LinearIcon name="search" />
              <strong>没有匹配项目</strong>
              <span>调整搜索或筛选条件后重试。</span>
            </div>
          ) : (
            <div className="database-ant-table" role="table" aria-label="公司项目进度总览">
              <div className="database-ant-table-head" role="row">
                <span>项目名称</span>
                <span>健康状态</span>
                <span>整体进度</span>
                <span>任务分布</span>
                <span>更新时间</span>
                <span>操作</span>
              </div>
              {filteredRows.map((row) => (
                <div className="database-ant-table-row" role="row" key={row.id}>
                  <div className="database-project-title">
                    <strong>{row.name}</strong>
                    <small>{row.total} 张任务卡</small>
                  </div>
                  <span className={`database-health-tag is-${row.health === "正常" ? "normal" : row.health === "阻塞" ? "blocked" : "risk"}`}>{row.health}</span>
                  <div className="database-progress-line">
                    <span><i style={{ width: `${row.progress}%` }} /></span>
                    <b>{row.progress}%</b>
                  </div>
                  <div className="database-task-stack">
                    <span aria-hidden="true">
                      <i className="is-done" style={{ width: segmentWidth(row.done, row.total) }} />
                      <i className="is-active" style={{ width: segmentWidth(row.active, row.total) }} />
                      <i className="is-review" style={{ width: segmentWidth(row.review, row.total) }} />
                      <i className="is-blocked" style={{ width: segmentWidth(row.blocked, row.total) }} />
                    </span>
                    <small>待办 {row.todo} · 进行 {row.active} · 验收 {row.review} · 阻塞 {row.blocked}</small>
                  </div>
                  <time dateTime={row.updated === "暂无更新" ? undefined : row.updated}>{row.updated}</time>
                  <button className="database-link-button" type="button" onClick={() => onOpenProject(row.project)}>查看</button>
                </div>
              ))}
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

function ProjectOverviewDemo({
  projects,
  loading,
  deviceWorkspacePaths,
  onOpenProject,
  onOpenTaskProject,
  onPreviewAction,
  role,
  canManageMembers,
  activeView,
  onViewChange,
  onSummarizeProject,
  onRefreshProjects,
  currentUser,
  deviceProjects,
  overviewProjectId,
  standalonePanel = false,
  onOverviewProjectIdChange,
  teamProjects,
}: {
  projects: ProjectChoice[];
  loading: boolean;
  deviceWorkspacePaths: Record<string, string>;
  onOpenProject: (project: ProjectChoice) => void;
  onOpenTaskProject: (project: ProjectChoice) => void;
  onPreviewAction: (message: string) => void;
  role: WorkspaceRole;
  canManageMembers: boolean;
  activeView: ProjectOverviewView;
  onViewChange: (view: ProjectOverviewView) => void;
  onSummarizeProject: (project: ProjectChoice) => Promise<void>;
  onRefreshProjects: () => Promise<void>;
  currentUser: ActorIdentity;
  deviceProjects: DeviceProject[];
  overviewProjectId: string;
  standalonePanel?: boolean;
  onOverviewProjectIdChange?: (projectId: string) => void;
  teamProjects: ProjectChoice[];
}) {
  const identityMode = getIdentityUser() !== null;
  const [overviewTasks, setOverviewTasks] = useState<Task[]>([]);
  const [localProjects, setLocalProjects] = useState<ProjectChoice[]>([]);
  const [localTasks, setLocalTasks] = useState<Task[]>([]);
  const [overviewMembers, setOverviewMembers] = useState<IdentityProjectMember[]>([]);
  const [configProjectId, setConfigProjectId] = useState("");
  const [configMembers, setConfigMembers] = useState<IdentityProjectMember[]>([]);
  const [employeeDirectory, setEmployeeDirectory] = useState<Array<{ userId: string; employeeNo: string; displayName: string }>>([]);
  const [selectedEmployeeNo, setSelectedEmployeeNo] = useState("");
  const [configBusy, setConfigBusy] = useState(false);
  const [selectedLocalProjectId, setSelectedLocalProjectId] = useState("");
  const [bindBusy, setBindBusy] = useState(false);
  const [syncBusy, setSyncBusy] = useState(false);
  const [summaryBusyProjectIds, setSummaryBusyProjectIds] = useState<Set<string>>(new Set());
  const [joinProjectId, setJoinProjectId] = useState("");
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinDialogOpen, setJoinDialogOpen] = useState(false);
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [memberDialogProjectId, setMemberDialogProjectId] = useState("");
  const [syncLogs, setSyncLogs] = useState<IdentityTaskSyncLog[]>([]);
  const [syncLogsLoading, setSyncLogsLoading] = useState(false);
  const [projectBindings, setProjectBindings] = useState<Record<string, ProjectTeamBinding | null>>({});
  const [projectSyncStatuses, setProjectSyncStatuses] = useState<Record<string, ProjectSyncStatus | null>>({});
  const [analyticsRange, setAnalyticsRange] = useState<3 | 7 | 30>(7);
  const teamProjectIdFor = (project: ProjectChoice) => project.teamProjectId ?? project.id;
  useEffect(() => {
    let cancelled = false;
    void Promise.all(teamProjects.filter((project) => {
      const teamProjectId = project.teamProjectId ?? project.id;
      return project.persisted && (!overviewProjectId || teamProjectId === overviewProjectId || project.id === overviewProjectId);
    }).map((project) => (
      identityMode ? listIdentityTasks(project.teamProjectId ?? project.id) : listTasks(project.id)
    )))
      .then((taskGroups) => {
        if (!cancelled) setOverviewTasks(taskGroups.flat());
      })
      .catch(() => {
        if (!cancelled) setOverviewTasks([]);
      });
    return () => { cancelled = true; };
  }, [identityMode, overviewProjectId, teamProjects]);
  useEffect(() => {
    let cancelled = false;
    const codexProjects = projects.filter((project) => project.inCodex);
    void Promise.all(codexProjects.map(async (project) => {
      for (const projectId of localTaskProjectIds(project, projects, deviceProjects)) {
        const tasks = await listTasks(projectId).catch(() => []);
        if (tasks.length > 0) return tasks;
      }
      return [];
    }))
      .then((taskGroups) => {
        if (!cancelled) {
          setLocalProjects(codexProjects);
          setLocalTasks(taskGroups.flat());
        }
      })
      .catch(() => {
        if (!cancelled) {
          setLocalProjects([]);
          setLocalTasks([]);
        }
      });
    return () => { cancelled = true; };
  }, [deviceProjects, projects]);
  useEffect(() => {
    if (!getIdentityUser()) {
      setOverviewMembers([]);
      return;
    }
    let cancelled = false;
    void Promise.all(teamProjects.filter((project) => {
      const teamProjectId = project.teamProjectId ?? project.id;
      return project.persisted && (!overviewProjectId || teamProjectId === overviewProjectId || project.id === overviewProjectId);
    }).map((project) => listIdentityProjectMembers(project.teamProjectId ?? project.id)))
      .then((memberGroups) => {
        if (cancelled) return;
        const unique = new Map<string, IdentityProjectMember>();
        memberGroups.flat().forEach((member) => unique.set(member.userId, member));
        setOverviewMembers([...unique.values()]);
      })
      .catch(() => {
        if (!cancelled) setOverviewMembers([]);
      });
    return () => { cancelled = true; };
  }, [overviewProjectId, teamProjects]);
  useEffect(() => {
    if (activeView !== "member-config" || !getIdentityUser()) return;
    const manageableProjects = projects.filter((project) => project.role === "owner");
    const projectId = configProjectId && manageableProjects.some((project) => teamProjectIdFor(project) === configProjectId)
      ? configProjectId
      : manageableProjects[0] ? teamProjectIdFor(manageableProjects[0]) : "";
    if (!projectId || !canManageMembers) return;
    setConfigProjectId(projectId);
    void Promise.all([listAvailableIdentityDevelopers(projectId), listIdentityProjectMembers(projectId)])
      .then(([employees, members]) => {
        setEmployeeDirectory(employees);
        setConfigMembers(members);
        setSelectedEmployeeNo((current) => employees.some((employee) => employee.employeeNo === current) ? current : employees[0]?.employeeNo || "");
      })
      .catch(() => {
        setEmployeeDirectory([]);
        setConfigMembers([]);
      });
  }, [activeView, canManageMembers, configProjectId, projects]);

  useEffect(() => {
    if (!selectedLocalProjectId && deviceProjects[0]) setSelectedLocalProjectId(deviceProjects[0].id);
  }, [deviceProjects, selectedLocalProjectId]);

  useEffect(() => {
    const localProjectIds = [...new Set(localProjects.map((project) => localProjectKey(project)))];
    if (localProjectIds.length === 0) {
      setProjectBindings({});
      setProjectSyncStatuses({});
      return;
    }
    const controller = new AbortController();
    void Promise.all(localProjectIds.map(async (projectId) => {
      const localProject = localProjects.find((project) => localProjectKey(project) === projectId);
      const [binding, syncStatus] = await Promise.all([
        getProjectTeamBinding(projectId, controller.signal).catch(() => null),
        getProjectSyncStatus(projectId, controller.signal).catch(() => null),
      ]);
      if (!binding && localProject) {
        const matchedProject = projects.find((project) => (
          (Boolean(project.teamProjectId) || !project.inCodex)
          && (project.id === localProject.id
          || project.code === localProject.id
          || (project.workspacePath && project.workspacePath === localProject.workspacePath))
        ));
        if (matchedProject) {
          const teamProjectId = matchedProject.teamProjectId ?? matchedProject.id;
          await saveProjectTeamBinding({
            localProjectId: projectId,
            teamProjectId,
            teamProjectName: matchedProject.name,
          }).catch(() => undefined);
          const savedBinding = await getProjectTeamBinding(projectId, controller.signal).catch(() => null);
          return { projectId, binding: savedBinding, syncStatus };
        }
      }
      return { projectId, binding, syncStatus };
    })).then((records) => {
      const nextBindings: Record<string, ProjectTeamBinding | null> = {};
      const nextStatuses: Record<string, ProjectSyncStatus | null> = {};
      records.forEach((record) => {
        nextBindings[record.projectId] = record.binding;
        nextStatuses[record.projectId] = record.syncStatus;
      });
      setProjectBindings(nextBindings);
      setProjectSyncStatuses(nextStatuses);
    }).catch(() => {});
    return () => controller.abort();
  }, [localProjects, projects]);

  useEffect(() => {
    if (activeView !== "sync-log" || !getIdentityUser()) {
      setSyncLogs([]);
      setSyncLogsLoading(false);
      return;
    }
    const controller = new AbortController();
    setSyncLogsLoading(true);
    void listIdentityTaskSyncLogs(controller.signal)
      .then((logs) => setSyncLogs(logs))
      .catch(() => setSyncLogs([]))
      .finally(() => setSyncLogsLoading(false));
    return () => controller.abort();
  }, [activeView]);

  const addMemberFromDirectory = async () => {
    if (!configProjectId || !selectedEmployeeNo) return;
    setConfigBusy(true);
    try {
      const members = await addIdentityProjectMember(configProjectId, selectedEmployeeNo);
      setConfigMembers(members);
    } catch (error) {
      onPreviewAction(error instanceof Error ? error.message : "添加成员失败");
    } finally {
      setConfigBusy(false);
    }
  };
  const removeMember = async (member: IdentityProjectMember) => {
    if (!configProjectId) return;
    setConfigBusy(true);
    try {
      setConfigMembers(await removeIdentityProjectMember(configProjectId, member.userId));
    } catch (error) {
      onPreviewAction(error instanceof Error ? error.message : "移除成员失败");
    } finally {
      setConfigBusy(false);
    }
  };
  const summarizeProject = async (project: ProjectChoice) => {
    const projectId = project.id;
    setSummaryBusyProjectIds((current) => new Set(current).add(projectId));
    try {
      await onSummarizeProject({ ...project, persisted: true, inCodex: false, issueCount: project.issueCount });
    } finally {
      setSummaryBusyProjectIds((current) => {
        const next = new Set(current);
        next.delete(projectId);
        return next;
      });
    }
  };
  const joinSelectedProject = async () => {
    if (!joinProjectId) return;
    setJoinBusy(true);
    try {
      await joinIdentityProject(joinProjectId);
      const joined = projects.find((project) => teamProjectIdFor(project) === joinProjectId);
      onPreviewAction(`${joined?.name ?? "项目"}：已加入项目。`);
      setJoinProjectId("");
      setJoinDialogOpen(false);
      await onRefreshProjects();
    } catch (error) {
      onPreviewAction(error instanceof Error ? error.message : "加入项目失败");
    } finally {
      setJoinBusy(false);
    }
  };
  const refreshLocalProjectSyncMeta = async (localProjectId: string) => {
    const [binding, syncStatus] = await Promise.all([
      getProjectTeamBinding(localProjectId).catch(() => null),
      getProjectSyncStatus(localProjectId).catch(() => null),
    ]);
    setProjectBindings((current) => ({ ...current, [localProjectId]: binding }));
    setProjectSyncStatuses((current) => ({ ...current, [localProjectId]: syncStatus }));
  };
  const refreshIdentitySyncLogs = async () => {
    if (!getIdentityUser()) return;
    const logs = await listIdentityTaskSyncLogs().catch(() => null);
    if (logs) setSyncLogs(logs);
  };
  const syncLocalProjectTasks = async (sharedProject: ProjectChoice, localProject: { id: string; name: string; workspacePath: string | null }) => {
    setSyncBusy(true);
    try {
      const targetProjectId = sharedProject.teamProjectId ?? sharedProject.id;
      const sourceProject = localProjects.find((project) => (
        project.id === localProject.id || project.workspacePath === localProject.workspacePath
      ));
      const localProjectId = localProjectKey(sourceProject ?? localProject);
      let tasks: Task[] = [];
      for (const projectId of localTaskProjectIds(sourceProject ?? { ...localProject }, projects, deviceProjects)) {
        tasks = await listTasks(projectId).catch(() => []);
        if (tasks.length > 0) break;
      }
      await saveProjectTeamBinding({
        localProjectId,
        teamProjectId: targetProjectId,
        teamProjectName: sharedProject.name,
      });
      setProjectBindings((current) => ({
        ...current,
        [localProjectId]: {
          localProjectId,
          teamProjectId: targetProjectId,
          teamProjectName: sharedProject.name,
          boundAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      }));
      const result = await importIdentityTasks(targetProjectId, tasks, { localProjectId });
      await refreshLocalProjectSyncMeta(localProjectId);
      await refreshIdentitySyncLogs();
      const dedupeSummary = result.deduped ? `，去重 ${result.deduped} 张重复任务` : "";
      const syncSummary = result.unchanged
        ? "本次没有新的任务卡片"
        : `已提交 ${result.imported} 张新任务，更新 ${result.updated} 张已有任务${dedupeSummary}`;
      onPreviewAction(`${sharedProject.name}：${syncSummary}。同步日志已记录，团队进度以本次提交后的数据为准。`);
      await onRefreshProjects();
    } catch (error) {
      await refreshLocalProjectSyncMeta(localProjectKey(localProject));
      await refreshIdentitySyncLogs();
      onPreviewAction(error instanceof Error ? error.message : "提交任务卡片失败，本地草稿已保留");
    } finally {
      setSyncBusy(false);
    }
  };
  const findBoundProject = (localProject: ProjectChoice) => {
    const localProjectId = localProjectKey(localProject);
    const savedBinding = projectBindings[localProjectId] ?? projectBindings[localProject.id];
    if (savedBinding) {
      const savedProject = projects.find((project) => teamProjectIdFor(project) === savedBinding.teamProjectId);
      if (savedProject) return savedProject;
      return {
        id: savedBinding.teamProjectId,
        name: savedBinding.teamProjectName ?? localProject.name ?? "团队项目",
        workspacePath: localProject.workspacePath,
        updatedAt: savedBinding.updatedAt,
        issueCount: 0,
        inCodex: false,
        persisted: true,
        teamProjectId: savedBinding.teamProjectId,
      } satisfies ProjectChoice;
    }
    return projects.find((project) => (
      (Boolean(project.teamProjectId) || !project.inCodex)
      && (project.id === localProject.id
      || project.code === localProject.id
      || (project.workspacePath && project.workspacePath === localProject.workspacePath))
    ));
  };
  const becomeOwner = async () => {
    const localProject = deviceProjects.find((project) => project.id === selectedLocalProjectId);
    if (!localProject || !getIdentityUser()) return;
    setBindBusy(true);
    try {
      const project = await createIdentityProject({
        code: localProject.id.slice(0, 50),
        name: localProject.name,
        workspacePath: localProject.workspacePath,
        description: `本地项目 ${localProject.name} 的共享项目`,
      });
      onPreviewAction(`${project.name} 已创建为团队项目。任务卡片仍保存在本地，点击“提交任务卡片”后才会上传到公司数据库。`);
      await saveProjectTeamBinding({
        localProjectId: localProject.id,
        teamProjectId: project.id,
        teamProjectName: project.name,
      });
      await refreshLocalProjectSyncMeta(localProject.id);
      await onRefreshProjects();
      setConfigProjectId(project.id);
      setConfigMembers([]);
      setCreateDialogOpen(false);
      setMemberDialogProjectId(project.id);
    } catch (error) {
      onPreviewAction(error instanceof Error ? error.message : "绑定项目失败");
    } finally {
      setBindBusy(false);
    }
  };
  const mappedProjects = projects.filter((project) => project.workspacePath || deviceWorkspacePaths[project.id]);
  const totalIssues = projects.reduce((sum, project) => sum + project.issueCount, 0);
  const automationReady = mappedProjects.filter((project) => project.inCodex).length;
  const blockedCount = Math.max(1, Math.min(5, Math.ceil(totalIssues / 9)));
  const activeCount = Math.max(0, Math.min(7, Math.ceil(totalIssues / 5)));
  const focusItems = [
    { label: "自动化失败", value: "2", tone: "danger", detail: "有执行记录需要查看" },
    { label: "阻塞任务", value: String(blockedCount), tone: "warning", detail: "跨项目等待输入" },
  ];
  const workingItems = [
    { title: "读取项目上下文", project: projects[0]?.name ?? "任务面板", status: "运行中", progress: "正在整理项目执行信息" },
    { title: "等待用户确认", project: projects[1]?.name ?? "自动化项目", status: "暂停", progress: "有任务等待确认" },
  ];
  const activityItems = ["自动化执行等待确认", "项目映射状态已同步", "项目任务状态已更新"];
  const projectProgressRows = teamProjects.map((project) => {
    const teamProjectId = project.teamProjectId ?? project.id;
    const projectTasks = overviewTasks.filter((task) => task.projectId === teamProjectId);
    const total = project.issueCount || projectTasks.length;
    const done = projectTasks.filter((task) => task.status === "done").length;
    const blocked = projectTasks.filter((task) => task.status === "blocked").length;
    const active = projectTasks.filter((task) => task.status === "in_progress").length;
    const review = projectTasks.filter((task) => task.status === "in_review").length;
    const todo = Math.max(0, total - done - active - review - blocked);
    const progress = taskProgressPercent(projectTasks, total);
    const health = blocked > 0 ? "阻塞" : review > 0 || total - done > 0 ? "有风险" : "正常";
    return {
      id: project.id,
      name: project.name,
      health,
      progress,
      total,
      done,
      active,
      blocked,
      review,
      todo,
      owner: "未设置",
      updated: project.updatedAt ? project.updatedAt.slice(0, 10) : "暂无更新",
      automation: "未接入",
      project,
    };
  });
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const taskProgressRows = overviewTasks.map((task) => ({
    title: task.title,
    project: projectNames.get(task.projectId) ?? task.projectId,
    owner: task.assignee.name,
    status: task.status,
    updated: task.updatedAt.slice(0, 10),
    signal: task.dueDate ? `截止 ${task.dueDate}` : `优先级 ${task.priority}`,
    task,
  }));
  const localProjectNames = new Map(localProjects.map((project) => [project.id, project.name]));
  const localTaskRows = localTasks.map((task) => ({
    title: task.title,
    project: localProjectNames.get(task.projectId) ?? task.projectId,
    owner: task.assignee.name,
    status: task.status,
    updated: task.updatedAt.slice(0, 10),
    signal: task.dueDate ? `截止 ${task.dueDate}` : `优先级 ${task.priority}`,
    task,
  }));
  const localProjectProgressRows = localProjects.map((project) => {
    const localProjectId = localProjectKey(project);
    const taskProjectIds = localTaskProjectIds(project, projects, deviceProjects);
    const projectTasks = localTasks.filter((task) => taskProjectIds.includes(task.projectId));
    const binding = projectBindings[localProjectId] ?? projectBindings[project.id] ?? null;
    const matchedProject = findBoundProject(project);
    const syncStatus = projectSyncStatuses[localProjectId] ?? projectSyncStatuses[project.id] ?? null;
    const total = projectTasks.length;
    const done = projectTasks.filter((task) => task.status === "done").length;
    const blocked = projectTasks.filter((task) => task.status === "blocked").length;
    const active = projectTasks.filter((task) => task.status === "in_progress").length;
    const review = projectTasks.filter((task) => task.status === "in_review").length;
    const todo = Math.max(0, total - done - active - review - blocked);
    const health = blocked > 0 ? "阻塞" : review > 0 || total - done > 0 ? "有风险" : "正常";
    const latestTaskUpdatedAt = projectTasks.reduce((latest, task) => Math.max(latest, Date.parse(task.updatedAt) || 0), 0);
    const submittedAt = syncStatus ? Date.parse(syncStatus.submittedAt) || 0 : 0;
    const isSubmittedCurrentBatch = syncStatus?.status === "success" && submittedAt >= latestTaskUpdatedAt;
    return {
      project,
      localProjectId,
      name: project.name,
      updated: project.updatedAt?.slice(0, 10) || "暂无更新",
      total,
      done,
      blocked,
      active,
      review,
      todo,
      health,
      binding,
      matchedProject,
      syncStatus,
      isSubmittedCurrentBatch,
    };
  });
  const localDoneCount = localTasks.filter((task) => task.status === "done").length;
  const localBlockedCount = localTasks.filter((task) => task.status === "blocked").length;
  const localReviewCount = localTasks.filter((task) => task.status === "in_review").length;
  const memberMap = overviewMembers.reduce((members, member) => {
    members.set(member.userId, { name: member.displayName, todo: [], active: [], blocked: [], review: [], total: 0 });
    return members;
  }, new Map<string, { name: string; todo: Task[]; active: Task[]; blocked: Task[]; review: Task[]; total: number }>());
  overviewTasks.reduce((members, task) => {
    const assigneeId = task.assignee?.id ?? "unassigned";
    const current = members.get(assigneeId) ?? { name: task.assignee?.name ?? "未分配", todo: [], active: [], blocked: [], review: [], total: 0 };
    current.total += 1;
    if (task.status === "in_progress") current.active.push(task);
    else if (task.status === "blocked") current.blocked.push(task);
    else if (task.status === "in_review") current.review.push(task);
    else if (task.status === "backlog" || task.status === "todo") current.todo.push(task);
    members.set(assigneeId, current);
    return members;
  }, memberMap as Map<string, { name: string; todo: Task[]; active: Task[]; blocked: Task[]; review: Task[]; total: number }>);
  const memberRows = [...memberMap.values()];
  const myTaskRows = taskProgressRows.filter((row) => row.task.assignee.id === currentUser.id);
  const actionItems = [
    { label: "阻塞任务", value: String(blockedCount), view: "attention" as const },
    { label: "等待确认", value: "3", view: "codex" as const },
    { label: "最近活动", value: "12", view: "activity" as const },
  ];
  const portfolioStats: Array<{ label: string; value: number; detail: string; view: ProjectOverviewView }> = [
    { label: "健康项目", value: projectProgressRows.filter((row) => row.health === "正常").length, detail: "查看正常推进的项目", view: "overview" },
    { label: "风险项目", value: projectProgressRows.filter((row) => row.health !== "正常").length, detail: "查看有风险和阻塞的项目", view: "attention" },
    { label: "阻塞任务", value: blockedCount, detail: "查看阻塞任务卡片", view: "overview" },
    { label: "待验收", value: memberRows.reduce((sum, member) => sum + member.review.length, 0), detail: "查看等待验收的任务卡片", view: "overview" },
    { label: "Codex 执行中", value: workingItems.filter((item) => item.status === "运行中").length, detail: "查看 Codex 执行中心", view: "codex" },
    { label: "本周到期", value: 4, detail: "查看本周到期任务", view: "overview" },
  ];
  const viewTitles: Record<ProjectOverviewView, string> = {
    overview: "项目进度总览",
    "database-progress": "公司项目进度",
    "team-board": "团队项目看板",
    tasks: "任务卡片",
    members: "成员负载",
    analytics: "统计分析",
    mine: "我的任务",
    "member-config": "项目成员",
    "sync-log": "同步日志",
    attention: "关注事项",
    codex: "Codex 执行中心",
    activity: "活动日志",
  };
  const viewDescriptions: Record<ProjectOverviewView, string> = {
    overview: "查看项目健康状态、任务卡片进度和需要关注的项目。",
    "database-progress": "只展示公司数据库中已经创建出来的项目和任务推进状态。",
    "team-board": "只展示公司库中已经创建的团队项目及其任务推进状态。",
    tasks: "按项目、负责人和任务状态查看跨项目进度。",
    members: "查看当前项目每位成员的任务数量和当前队列。",
    analytics: "按近 3 天、近 7 天和近 30 天分析趋势、积压、负载和风险洞察。",
    mine: "只查看当前身份需要处理的任务。",
    "member-config": "维护当前项目的开发人员和项目负责人。",
    "sync-log": "查看自己的提交，以及所属项目成员提交到公司库的记录。",
    attention: "聚合自动化失败、阻塞任务和项目映射风险。",
    codex: "查看 Codex 自动化正在做什么、卡在哪里、等待谁确认。",
    activity: "按时间线审计扫描、自动化、任务变化和项目状态更新。",
  };
  const [activeOverviewItem, setActiveOverviewItem] = useState("全部项目");
  const overviewView = activeView;
  const overviewProject = projects.find((project) => project.id === overviewProjectId) ?? null;
  const hideDetailHeader = overviewView === "member-config" || overviewView === "sync-log";
  const chooseOverviewItem = (label: string, message: string) => {
    setActiveOverviewItem(label);
    onPreviewAction(message);
  };
  const openOverviewView = (view: ProjectOverviewView, label: string) => {
    onViewChange(view);
    setActiveOverviewItem(label);
  };
  const returnToOverview = () => {
    onViewChange("overview");
    setActiveOverviewItem("全部项目");
  };
  const standaloneViews: ProjectOverviewView[] = ["database-progress", "members", "analytics", "sync-log"];
  const standaloneActiveView = standaloneViews.includes(overviewView) ? overviewView : "database-progress";
  const selectedTeamProjectId = overviewProject ? teamProjectIdFor(overviewProject) : "";
  const selectedProjectName = overviewProject?.name ?? "全部项目";
  const allTasks = overviewTasks;
  const rangeStart = Date.now() - analyticsRange * 24 * 60 * 60 * 1000;
  const rangeTasks = allTasks.filter((task) => (Date.parse(task.createdAt) || Date.parse(task.updatedAt) || 0) >= rangeStart);
  const rangeDoneTasks = allTasks.filter((task) => task.status === "done" && (Date.parse(task.updatedAt) || 0) >= rangeStart);
  const rangeBlockedTasks = allTasks.filter((task) => task.status === "blocked" && (Date.parse(task.updatedAt) || 0) >= rangeStart);
  const rangeReviewTasks = allTasks.filter((task) => task.status === "in_review" && (Date.parse(task.updatedAt) || 0) >= rangeStart);
  const taskCountByProject = projectProgressRows.map((row) => ({
    name: row.name,
    total: row.total,
    done: row.done,
    blocked: row.blocked,
    review: row.review,
    progress: row.progress,
    health: row.health,
  }));
  const trendPoints = Array.from({ length: analyticsRange }, (_, index) => {
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    dayStart.setDate(dayStart.getDate() - (analyticsRange - 1 - index));
    const start = dayStart.getTime();
    const end = start + 24 * 60 * 60 * 1000;
    const created = allTasks.filter((task) => {
      const time = Date.parse(task.createdAt) || 0;
      return time >= start && time < end;
    }).length;
    const done = allTasks.filter((task) => {
      const time = Date.parse(task.updatedAt) || 0;
      return task.status === "done" && time >= start && time < end;
    }).length;
    const blocked = allTasks.filter((task) => {
      const time = Date.parse(task.updatedAt) || 0;
      return task.status === "blocked" && time >= start && time < end;
    }).length;
    return { label: `${dayStart.getMonth() + 1}/${dayStart.getDate()}`, created, done, blocked };
  });
  const maxTrendValue = Math.max(1, ...trendPoints.flatMap((point) => [point.created, point.done, point.blocked]));
  const linePointsFor = (key: "created" | "done" | "blocked") => trendPoints.map((point, index) => {
    const x = trendPoints.length === 1 ? 50 : 8 + (index / (trendPoints.length - 1)) * 84;
    const y = 82 - (point[key] / maxTrendValue) * 64;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(" ");
  const healthNormal = projectProgressRows.filter((row) => row.health === "正常").length;
  const healthRisk = projectProgressRows.filter((row) => row.health === "有风险").length;
  const healthBlocked = projectProgressRows.filter((row) => row.health === "阻塞").length;
  const healthGroups = [
    { label: "正常", rows: projectProgressRows.filter((row) => row.health === "正常"), tone: "normal" },
    { label: "风险", rows: projectProgressRows.filter((row) => row.health === "有风险"), tone: "risk" },
    { label: "阻塞", rows: projectProgressRows.filter((row) => row.health === "阻塞"), tone: "blocked" },
  ];
  const totalHealth = Math.max(1, projectProgressRows.length);
  const normalDegrees = Math.round((healthNormal / totalHealth) * 360);
  const riskDegrees = Math.round((healthRisk / totalHealth) * 360);
  const backlogProjects = taskCountByProject
    .map((project) => ({ ...project, backlog: project.review + project.blocked }))
    .sort((a, b) => b.backlog - a.backlog);
  const maxBacklog = Math.max(1, ...backlogProjects.map((project) => project.backlog));
  const overloadedMembers = memberRows
    .map((member) => ({
      name: member.name,
      total: member.total,
      blocked: member.blocked.length,
      review: member.review.length,
      load: member.blocked.length > 0 ? "有阻塞" : member.total >= 10 ? "过载" : member.total >= 7 ? "偏忙" : member.total >= 3 ? "正常" : "空闲",
    }))
    .sort((left, right) => right.total - left.total);
  const riskInsights = [
    ...taskCountByProject
      .filter((project) => project.blocked > 0 || project.review >= 5 || (project.total > 0 && project.progress === 0))
      .slice(0, 4)
      .map((project) => ({
        level: project.blocked > 0 ? "高风险" : "关注",
        target: project.name,
        reason: project.blocked > 0
          ? `存在 ${project.blocked} 个阻塞任务`
          : project.review >= 5
            ? `待验收积压 ${project.review} 个`
            : "项目有任务但进度仍为 0%",
        action: project.blocked > 0 ? "优先清理阻塞" : "安排负责人确认推进状态",
      })),
    ...overloadedMembers
      .filter((member) => member.total >= 10 || member.blocked > 0)
      .slice(0, 2)
      .map((member) => ({
        level: member.blocked > 0 ? "高风险" : "关注",
        target: member.name,
        reason: `${member.total} 个任务，阻塞 ${member.blocked} 个`,
        action: "评估是否需要转派或拆分任务",
      })),
  ].slice(0, 5);
  const standaloneTabs: Array<{ view: ProjectOverviewView; label: string }> = [
    { view: "database-progress", label: "项目总览" },
    { view: "members", label: "成员负载" },
    { view: "analytics", label: "统计分析" },
    { view: "sync-log", label: "操作日志" },
  ];
  const standaloneHeaderStats = [
    { label: "正常", value: projectProgressRows.filter((row) => row.health === "正常").length, tone: "normal" },
    { label: "风险", value: projectProgressRows.filter((row) => row.health === "有风险").length, tone: "warning" },
    { label: "阻塞", value: projectProgressRows.filter((row) => row.health === "阻塞").length, tone: "danger" },
    { label: "待验收", value: projectProgressRows.reduce((sum, row) => sum + row.review, 0), tone: "info" },
  ];
  const renderStandaloneMembers = () => (
    <section className="progress-work-card progress-member-page progress-member-board-page" aria-labelledby="standalone-members-title">
      <div className="progress-card-head">
        <div>
          <h2 id="standalone-members-title">成员负载</h2>
          <p>{selectedProjectName} · {memberRows.length} 位成员</p>
        </div>
        <label className="progress-project-select">
          <span>项目</span>
          <select
            value={selectedTeamProjectId}
            onChange={(event) => {
              const value = event.target.value;
              onOverviewProjectIdChange?.(value);
              const nextProject = teamProjects.find((project) => teamProjectIdFor(project) === value);
              if (nextProject) onOpenProject(nextProject);
              else onViewChange("members");
            }}
          >
            <option value="">全部项目</option>
            {teamProjects.map((project) => <option value={teamProjectIdFor(project)} key={teamProjectIdFor(project)}>{project.name}</option>)}
          </select>
        </label>
      </div>
      <div className="progress-member-board" aria-label="成员负载任务列表">
        {memberRows.length > 0 ? memberRows.map((member) => {
          const load = member.blocked.length > 0 ? "有阻塞" : member.total >= 10 ? "过载" : member.total >= 7 ? "偏忙" : member.total >= 3 ? "正常" : "空闲";
          const groups = [
            { label: "待办", tasks: member.todo, tone: "todo" },
            { label: "进行中", tasks: member.active, tone: "active" },
            { label: "阻塞", tasks: member.blocked, tone: "blocked" },
            { label: "待验收", tasks: member.review, tone: "review" },
          ];
          return <article className="progress-member-card-row" key={member.name}>
            <div className="progress-member-profile">
              <span aria-hidden="true">{member.name.slice(0, 1)}</span>
              <strong>{member.name}</strong>
              <small>{member.total} 张任务卡</small>
              <i className={`progress-load-tag is-${load === "有阻塞" || load === "过载" ? "danger" : load === "偏忙" ? "warning" : "normal"}`}>{load}</i>
            </div>
            <div className="progress-member-task-cards">
              {groups.map((group) => (
                <section className={`progress-member-task-card is-${group.tone}`} key={group.label}>
                  <div className="progress-member-task-head"><strong>{group.label}</strong><span>{group.tasks.length}</span></div>
                  <div className="progress-member-task-list">
                    {group.tasks.length > 0
                      ? group.tasks.slice(0, 6).map((task) => <button type="button" key={task.id} onClick={() => { if (overviewProject) onOpenTaskProject({ ...overviewProject, inCodex: false, persisted: true }); }} title={task.title}>{task.title}</button>)
                      : <span>暂无任务</span>}
                  </div>
                </section>
              ))}
            </div>
          </article>;
        }) : <div className="overview-inline-empty">当前项目暂无成员负载数据。</div>}
      </div>
    </section>
  );
  const renderStandaloneAnalytics = () => (
    <section className="progress-analytics-page" aria-labelledby="standalone-analytics-title">
      <div className="progress-card-head">
        <div>
          <h2 id="standalone-analytics-title">统计分析</h2>
          <p>分析趋势、积压、负载不均和风险洞察，不重复项目总览的静态总数。</p>
        </div>
        <div className="progress-range-switch" aria-label="统计时间范围">
          {[3, 7, 30].map((range) => (
            <button className={analyticsRange === range ? "is-active" : ""} type="button" key={range} onClick={() => setAnalyticsRange(range as 3 | 7 | 30)}>近 {range === 30 ? "30" : range} 天</button>
          ))}
        </div>
      </div>
      <div className="progress-analytics-grid">
        <article className="progress-work-card progress-chart-card">
          <h3>趋势分析</h3>
          <div className="progress-line-chart" aria-label={`近 ${analyticsRange} 天任务趋势`}>
            <svg viewBox="0 0 100 90" role="img" aria-label="新增、完成、阻塞任务趋势">
              <polyline className="is-created" points={linePointsFor("created")} />
              <polyline className="is-done" points={linePointsFor("done")} />
              <polyline className="is-blocked" points={linePointsFor("blocked")} />
            </svg>
            <div className="progress-chart-legend">
              <span className="is-created">新增 {rangeTasks.length}</span>
              <span className="is-done">完成 {rangeDoneTasks.length}</span>
              <span className="is-blocked">阻塞 {rangeBlockedTasks.length}</span>
              <span>待验收 {rangeReviewTasks.length}</span>
            </div>
          </div>
        </article>
        <article className="progress-work-card progress-chart-card">
          <h3>项目健康分布</h3>
          <div className="progress-donut-wrap">
            <div className="progress-donut" style={{ background: `conic-gradient(#14b8a6 0 ${normalDegrees}deg, #d99a00 ${normalDegrees}deg ${normalDegrees + riskDegrees}deg, #e5484d ${normalDegrees + riskDegrees}deg 360deg)` }}>
              <span>{projectProgressRows.length}</span>
            </div>
            <div className="progress-health-projects">
              {healthGroups.map((group) => (
                <section className={`progress-health-group is-${group.tone}`} key={group.label}>
                  <div><span><i />{group.label}</span><strong>{group.rows.length}</strong></div>
                  {group.rows.length > 0 ? (
                    <ul>
                      {group.rows.map((row) => <li key={row.id}><b>{row.name}</b><em>{row.progress}%</em></li>)}
                    </ul>
                  ) : <small>暂无项目</small>}
                </section>
              ))}
            </div>
          </div>
        </article>
        <article className="progress-work-card progress-chart-card">
          <h3>积压分析</h3>
          {backlogProjects.slice(0, 5).map((project) => (
            <div className="progress-bar-rank-row" key={project.name}>
              <div><span>{project.name}</span><strong>验收 {project.review} · 阻塞 {project.blocked}</strong></div>
              <i><b style={{ width: `${Math.round((project.backlog / maxBacklog) * 100)}%` }} /></i>
            </div>
          ))}
        </article>
        <article className="progress-work-card progress-chart-card">
          <h3>负载不均</h3>
          {overloadedMembers.slice(0, 5).map((member) => (
            <div className="progress-bar-rank-row" key={member.name}>
              <div><span>{member.name}</span><strong>{member.total} 个任务 · {member.load}</strong></div>
              <i><b style={{ width: `${Math.round((member.total / Math.max(1, overloadedMembers[0]?.total ?? 1)) * 100)}%` }} /></i>
            </div>
          ))}
        </article>
        <article className="progress-work-card progress-chart-card">
          <h3>项目对比</h3>
          {taskCountByProject.sort((a, b) => a.progress - b.progress).slice(0, 5).map((project) => (
            <div className="progress-rank-row" key={project.name}><span>{project.name}</span><strong>{project.progress}% · {project.health}</strong></div>
          ))}
        </article>
      </div>
      <section className="progress-work-card progress-insight-card">
        <h3>风险洞察</h3>
        {riskInsights.length > 0 ? riskInsights.map((insight) => (
          <div className="progress-insight-row" key={`${insight.target}-${insight.reason}`}>
            <span className={insight.level === "高风险" ? "is-danger" : "is-warning"}>{insight.level}</span>
            <strong>{insight.target}</strong>
            <p>{insight.reason}，建议{insight.action}。</p>
          </div>
        )) : <div className="overview-inline-empty">当前时间范围内暂无明显异常。</div>}
      </section>
    </section>
  );
  const renderStandaloneLogs = () => (
    <section className="progress-work-card progress-log-page" aria-labelledby="standalone-log-title">
      <div className="progress-card-head">
        <div>
          <h2 id="standalone-log-title">操作日志</h2>
          <p>第一版展示已监控的公司库任务提交记录，后续可扩展项目、成员和任务变更。</p>
        </div>
        <span className="progress-log-count">{syncLogsLoading ? "加载中" : `${syncLogs.length} 条`}</span>
      </div>
      {syncLogsLoading ? (
        <div className="overview-inline-empty">正在读取操作日志…</div>
      ) : syncLogs.length > 0 ? (
        <div className="progress-log-table" role="table" aria-label="操作日志">
          <div className="progress-log-head" role="row"><span>时间</span><span>类型</span><span>项目</span><span>操作人</span><span>状态</span><span>结果</span></div>
          {syncLogs.map((log) => (
            <div className="progress-log-row" role="row" key={log.id}>
              <time dateTime={log.createdAt}>{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(log.createdAt))}</time>
              <span>任务提交</span>
              <strong title={log.projectName}>{log.projectName}</strong>
              <span>{log.operatorName}</span>
              <i className={`sync-log-status is-${log.status}`}>{log.status === "success" ? "成功" : "失败"}</i>
              <small title={log.error ?? undefined}>{log.status === "success" ? `新增 ${log.imported}，更新 ${log.updated}` : log.error ?? `失败 ${log.failed}`}</small>
            </div>
          ))}
        </div>
      ) : (
        <div className="overview-inline-empty">{getIdentityUser() ? "暂无已监控操作日志。" : "未连接公司账号，暂无公司库操作日志。"}</div>
      )}
    </section>
  );

  if (standalonePanel && standaloneViews.includes(standaloneActiveView)) {
    return (
      <section className="progress-shell" aria-label="公司项目进度中心">
        <header className="progress-shell-header">
          <div className="progress-brand">
            <span aria-hidden="true">P</span>
            <div><strong>项目进度中心</strong><small>公司项目协同看板</small></div>
          </div>
          <div className="progress-status-strip">
            {standaloneHeaderStats.map((item) => <button className={`progress-status-pill is-${item.tone}`} type="button" key={item.label}><b>{item.value}</b>{item.label}</button>)}
          </div>
          <div className="progress-shell-actions">
            <span className={`database-connection-tag ${identityMode ? "is-online" : "is-offline"}`}><i aria-hidden="true" />{identityMode ? "已连接公司库" : "未连接公司库"}</span>
            <button className="database-ant-button" type="button" onClick={() => void onRefreshProjects()}><LinearIcon name="recurrence" />刷新</button>
          </div>
        </header>
        <nav className="progress-shell-tabs" aria-label="项目进度中心导航">
          {standaloneTabs.map((tab) => <button className={standaloneActiveView === tab.view ? "is-active" : ""} type="button" key={tab.view} onClick={() => onViewChange(tab.view)}>{tab.label}</button>)}
        </nav>
        <main className="progress-shell-main">
          {standaloneActiveView === "database-progress" && <DatabaseProgressPanel rows={projectProgressRows} identityMode={identityMode} loading={loading} onOpenProject={onOpenProject} onRefresh={onRefreshProjects} embedded />}
          {standaloneActiveView === "members" && renderStandaloneMembers()}
          {standaloneActiveView === "analytics" && renderStandaloneAnalytics()}
          {standaloneActiveView === "sync-log" && renderStandaloneLogs()}
        </main>
      </section>
    );
  }

  return (
    <section className="project-home project-overview-demo">
      {overviewView !== "database-progress" && <div className="project-home-heading project-overview-heading">
        <span className="project-overview-kicker">
          任务面板
          <span className={`overview-sync-inline ${identityMode ? "is-online" : "is-local"}`} role="status">
            <i aria-hidden="true" />
            {identityMode ? "已连接公司库" : "本地草稿模式"}
          </span>
        </span>
        <div>
          <h1>{viewTitles[overviewView]}</h1>
        </div>
        <p>{viewDescriptions[overviewView]}</p>
      </div>}

      {(overviewView === "overview" || overviewView === "mine") && (
        <>
          <div className="overview-stats" aria-label={overviewView === "mine" ? "我的任务统计" : "项目总览统计"}>
            {(overviewView === "mine" ? [
              { label: "本地项目", value: localProjects.length, detail: "查看本地项目任务", view: "mine" as const },
              { label: "任务卡片", value: localTasks.length, detail: "查看我的任务卡片", view: "mine" as const },
              { label: "已完成", value: localDoneCount, detail: "查看已完成任务", view: "mine" as const },
              { label: "阻塞任务", value: localBlockedCount, detail: "查看阻塞任务", view: "mine" as const },
              { label: "待验收", value: localReviewCount, detail: "查看待验收任务", view: "mine" as const },
            ] : portfolioStats).map((item) => (
              <button
                className={`overview-stat${activeOverviewItem === item.label ? " is-active" : ""}`}
                type="button"
                key={item.label}
                aria-pressed={activeOverviewItem === item.label}
                onClick={() => item.view === "overview"
                  ? chooseOverviewItem(item.label, `${item.label}：${item.detail}。`)
                  : openOverviewView(item.view, item.label)}
              >
                <strong>{item.value}</strong>
                <span>{item.label}</span>
              </button>
            ))}
          </div>
          <div className="overview-active-filter" role="status">
            <span>当前查看</span>
            <strong>{overviewView === "mine" ? "本地项目" : activeOverviewItem}</strong>
            <button
              type="button"
              onClick={() => chooseOverviewItem(overviewView === "mine" ? "本地项目" : "全部项目", overviewView === "mine" ? "当前显示全部本地项目。" : "已回到总览 demo 的全部项目视图。")}
            >
              清除
            </button>
          </div>
        </>
      )}

      {loading ? (
        <div className="project-grid project-grid-loading" aria-label="正在加载项目" aria-busy="true">
          <span /><span /><span />
        </div>
      ) : overviewView === "mine" ? (
        <div className="overview-layout overview-mine-layout">
          <div className="overview-main">
            <div className="overview-mine-page">
              <section className="overview-project-section overview-mine-project-section" aria-labelledby="mine-project-progress-title">
                <div className="overview-panel-heading"><h2 id="mine-project-progress-title">我的项目进度</h2><span>{localProjectProgressRows.length} 个项目</span></div>
                <div className="overview-project-table" role="table" aria-label="我的本地项目进度">
                  <div className="overview-project-table-head overview-mine-project-table-head" role="row"><span>项目</span><span>健康</span><span>任务卡分布</span><span>团队绑定</span><span>提交状态</span><span>操作</span></div>
                  {localProjectProgressRows.map((row) => (
                    <div className="overview-project-row overview-mine-project-row" key={row.project.id} role="row">
                      <button className="overview-project-name overview-project-name-button" type="button" onClick={() => onOpenTaskProject(row.project)}><strong>{row.name}</strong><small>{row.updated} 更新</small></button>
                      <span className={`overview-health-pill is-${row.health === "正常" ? "healthy" : row.health === "阻塞" ? "blocked" : "risk"}`}>{row.health}</span>
                      <span className="overview-task-mix"><span className="overview-task-stack" aria-hidden="true"><i className="is-done" style={{ width: `${row.total ? Math.round(row.done / row.total * 100) : 0}%` }} /><i className="is-active" style={{ width: `${row.total ? Math.round(row.active / row.total * 100) : 0}%` }} /><i className="is-review" style={{ width: `${row.total ? Math.round(row.review / row.total * 100) : 0}%` }} /><i className="is-blocked" style={{ width: `${row.total ? Math.round(row.blocked / row.total * 100) : 0}%` }} /></span><small>待办 {row.todo} · 进行 {row.active} · 验收 {row.review} · 阻塞 {row.blocked}</small></span>
                      <span className={`overview-binding-pill ${row.binding || row.matchedProject ? "is-bound" : "is-unbound"}`} title={row.binding?.teamProjectName ?? row.matchedProject?.name ?? undefined}>
                        {row.binding?.teamProjectName ?? row.matchedProject?.name ?? (row.binding ? "已绑定" : "未绑定")}
                      </span>
                      <span className={`overview-sync-status-pill ${row.syncStatus?.status === "success" ? "is-success" : row.syncStatus?.status === "failed" ? "is-failed" : "is-pending"}`} title={row.syncStatus?.error ?? undefined}>
                        {row.syncStatus
                          ? row.syncStatus.status === "success"
                            ? `成功 ${new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(row.syncStatus.submittedAt))}`
                            : "提交失败"
                          : "未提交"}
                      </span>
                      <div className="overview-mine-project-actions">
                        {row.matchedProject && <button className="overview-project-summary-button" type="button" disabled={syncBusy || !identityMode || row.isSubmittedCurrentBatch} onClick={() => { if (row.matchedProject) void syncLocalProjectTasks(row.matchedProject, row.project); }}>{syncBusy ? "提交中…" : row.isSubmittedCurrentBatch ? "已提交" : "提交任务卡片"}</button>}
                        <button className="overview-project-summary-button" type="button" disabled={summaryBusyProjectIds.has(row.project.id)} onClick={() => void summarizeProject({ ...row.project, issueCount: row.total })}>{summaryBusyProjectIds.has(row.project.id) ? "生成中…" : "生成卡片"}</button>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </div>
        </div>
      ) : overviewView === "database-progress" ? (
        <DatabaseProgressPanel
          rows={projectProgressRows}
          identityMode={identityMode}
          loading={loading}
          onOpenProject={onOpenProject}
          onRefresh={onRefreshProjects}
        />
      ) : overviewView === "team-board" ? (
        <div className="overview-layout overview-team-board-layout">
          <div className="overview-main">
            {teamProjects.length > 0 ? (
              <TeamProjectBoard rows={projectProgressRows} onOpenProject={onOpenProject} />
            ) : (
              <div className="project-home-empty">
                <h2>还没有团队项目</h2>
                <p>在配置中心创建团队项目后，这里会单独展示它们的进度。</p>
              </div>
            )}
          </div>
        </div>
      ) : teamProjects.length > 0 && overviewView !== "overview" ? (
        <section className={`overview-detail-page${overviewView === "member-config" ? " overview-config-detail-page" : ""}`} aria-labelledby={hideDetailHeader ? undefined : "overview-detail-title"} aria-label={hideDetailHeader ? viewTitles[overviewView] : undefined}>
          {!hideDetailHeader && (
            <div className="overview-detail-header">
              <button className="overview-back-button" type="button" onClick={returnToOverview}>
                <LinearIcon name="chevronLeft" />
                <span>返回总览</span>
              </button>
              <div>
                <h2 id="overview-detail-title">{overviewView === "members" && overviewProject ? overviewProject.name : viewTitles[overviewView]}</h2>
                <p>{viewDescriptions[overviewView]}</p>
              </div>
            </div>
          )}

          {overviewView === "members" && (
            <div className="overview-member-detail-grid">
              {memberRows.map((member) => {
                const groups = [
                  { label: "待办", tasks: member.todo, tone: "todo" },
                  { label: "进行中", tasks: member.active, tone: "active" },
                  { label: "阻塞", tasks: member.blocked, tone: "blocked" },
                  { label: "待验收", tasks: member.review, tone: "review" },
                ];
                return <article className="overview-member-detail-row" key={member.name}>
                  <div className="overview-member-detail-summary">
                    <strong>{member.name}</strong>
                    <span>{member.total} 张任务卡</span>
                    <div className="overview-member-counts" aria-label={`${member.name} 的任务状态统计`}>
                      <span>待办 <b>{member.todo.length}</b></span>
                      <span>进行中 <b>{member.active.length}</b></span>
                      <span>阻塞 <b>{member.blocked.length}</b></span>
                      <span>待验收 <b>{member.review.length}</b></span>
                    </div>
                  </div>
                  <div className="overview-member-task-groups">
                    {groups.map((group) => <section className={`overview-member-task-group is-${group.tone}`} key={group.label}>
                      <div className="overview-member-task-group-heading"><strong>{group.label}</strong><span>{group.tasks.length}</span></div>
                      <div className="overview-member-task-list">
                        {group.tasks.length > 0 ? group.tasks.map((task) => <button type="button" key={task.id} onClick={() => { if (overviewProject) onOpenTaskProject({ ...overviewProject, inCodex: false, persisted: true }); }}><HoverScrollingTitle title={task.title} /></button>) : <span className="overview-member-task-empty">暂无任务</span>}
                      </div>
                    </section>)}
                  </div>
                </article>;
              })}
            </div>
          )}

          {overviewView === "member-config" && (
            <div className="overview-config-layout">
              {getIdentityUser() ? <>
                <section className="overview-panel overview-config-section">
                  <div className="overview-panel-heading"><div><h2>我加入的项目</h2><p>查看已经参与的团队项目。</p></div><button className="overview-panel-open-button" type="button" onClick={() => setJoinDialogOpen(true)}>加入项目</button></div>
                  <div className="overview-config-project-list">
                    {projects.filter((project) => project.role).map((project) => <div className="overview-config-project-card" key={project.id}>
                      <div><strong>{project.name}</strong><small>负责人：{project.ownerName ?? "未设置"} · 我的角色：{project.role === "owner" ? "项目负责人" : "开发人员"}</small></div>
                      <button className="overview-panel-open-button" type="button" onClick={() => onOpenProject({ ...project, inCodex: false, persisted: true })}>查看项目</button>
                    </div>)}
                    {projects.every((project) => !project.role) && <div className="overview-inline-empty">暂未加入项目，请点击“加入项目”。</div>}
                  </div>
                  {joinDialogOpen && <div className="overview-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setJoinDialogOpen(false); }}><section className="overview-dialog" role="dialog" aria-modal="true" aria-labelledby="join-project-title"><div className="overview-dialog-heading"><h3 id="join-project-title">加入项目</h3><button type="button" onClick={() => setJoinDialogOpen(false)} aria-label="关闭">×</button></div><p>选择一个已创建的团队项目，加入后会立即出现在列表中。</p><select value={joinProjectId} onChange={(event) => setJoinProjectId(event.target.value)} aria-label="选择要加入的项目"><option value="">选择项目</option>{projects.filter((project) => !project.role && (project.teamProjectId || !project.inCodex)).map((project) => <option value={teamProjectIdFor(project)} key={teamProjectIdFor(project)}>{project.name} · 负责人：{project.ownerName ?? "未设置"}</option>)}</select><div className="overview-dialog-actions"><button type="button" onClick={() => setJoinDialogOpen(false)}>取消</button><button className="overview-panel-open-button" type="button" disabled={joinBusy || !joinProjectId} onClick={() => void joinSelectedProject()}>{joinBusy ? "加入中…" : "确认加入"}</button></div></section></div>}
                </section>

                <section className="overview-panel overview-config-section">
                  <div className="overview-panel-heading"><div><h2>我负责的项目</h2><p>从本地项目创建团队项目，并在项目内配置负责人和成员。</p></div><button className="overview-panel-open-button" type="button" onClick={() => setCreateDialogOpen(true)}>创建团队项目</button></div>
                  <div className="overview-config-project-list">
                    {projects.filter((project) => project.role === "owner").map((project) => <div className="overview-config-project-card" key={project.id}><div><strong>{project.name}</strong><small>负责人项目 · {project.issueCount} 张任务卡</small></div><div className="overview-mine-project-actions"><button className="overview-project-summary-button" type="button" onClick={() => { setConfigProjectId(teamProjectIdFor(project)); setMemberDialogProjectId(teamProjectIdFor(project)); setConfigMembers([]); }}>配置人员</button><button className="overview-project-summary-button" type="button" onClick={() => onOpenProject({ ...project, inCodex: false, persisted: true })}>查看项目</button></div></div>)}
                    {projects.filter((project) => project.role === "owner").length === 0 && <div className="overview-inline-empty">暂时没有我负责的项目，请点击“创建团队项目”。</div>}
                  </div>
                  {(createDialogOpen || memberDialogProjectId) && <div className="overview-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) { setCreateDialogOpen(false); setMemberDialogProjectId(""); } }}><section className="overview-dialog overview-dialog-wide" role="dialog" aria-modal="true"><div className="overview-dialog-heading"><h3>{createDialogOpen ? "创建团队项目" : "配置项目人员"}</h3><button type="button" onClick={() => { setCreateDialogOpen(false); setMemberDialogProjectId(""); }} aria-label="关闭">×</button></div>{createDialogOpen ? <><p>选择 Codex 项目后创建团队项目，你会自动成为第一位负责人。</p><select value={selectedLocalProjectId} onChange={(event) => setSelectedLocalProjectId(event.target.value)} aria-label="选择 Codex 项目"><option value="">选择 Codex 项目</option>{deviceProjects.map((project) => <option value={project.id} key={project.id}>{project.name} · Codex</option>)}</select><div className="overview-dialog-actions"><button type="button" onClick={() => setCreateDialogOpen(false)}>取消</button><button className="overview-panel-open-button overview-claim-project-button" type="button" disabled={bindBusy || !selectedLocalProjectId} onClick={() => void becomeOwner()}>{bindBusy ? "创建中…" : "确认创建"}</button></div></> : <><p>项目负责人已经确定，只需选择并添加开发成员。</p><div className="overview-config-add-row"><select value={selectedEmployeeNo} onChange={(event) => setSelectedEmployeeNo(event.target.value)} aria-label="选择开发成员">{employeeDirectory.map((employee) => <option value={employee.employeeNo} key={employee.employeeNo}>{employee.displayName}</option>)}</select><button className="overview-panel-open-button" type="button" disabled={configBusy || !selectedEmployeeNo} onClick={() => void addMemberFromDirectory()}>{configBusy ? "添加中…" : "添加成员"}</button></div><div className="overview-config-list">{configMembers.map((member) => <div className="overview-config-row" key={member.userId}><span className="overview-config-avatar">{member.displayName.slice(0, 1)}</span><div><strong>{member.displayName}</strong><small>{member.projectRole === "owner" ? "项目负责人（固定）" : "开发成员"}</small></div>{member.projectRole === "developer" && <button className="overview-member-remove-button" type="button" disabled={configBusy} onClick={() => void removeMember(member)}>移除</button>}</div>)}</div></>}</section></div>}
                </section>
              </> : <div className="overview-inline-empty">请先在左侧账号入口登记姓名和工号。</div>}
            </div>
          )}

          {overviewView === "attention" && (
            <div className="overview-detail-grid">
              {focusItems.map((item) => (
                <button
                  className={`overview-detail-card is-${item.tone}`}
                  type="button"
                  key={item.label}
                  onClick={() => chooseOverviewItem(item.label, `${item.label}会在真实版本中打开跨项目筛选结果。`)}
                >
                  <strong>{item.value}</strong>
                  <span>{item.label}</span>
                  <small>{item.detail}</small>
                </button>
              ))}
            </div>
          )}

          {overviewView === "codex" && (
            <div className="overview-detail-grid">
              {workingItems.map((item) => (
                <button
                  className="overview-detail-row overview-execution-row"
                  type="button"
                  key={item.title}
                  onClick={() => chooseOverviewItem(item.title, "真实版本会打开执行日志、关联任务和当前阶段。")}
                >
                  <span className={`overview-work-dot ${item.status === "运行中" ? "is-running" : ""}`} />
                  <strong>{item.title}</strong>
                  <span>{item.project} · {item.status}</span>
                  <small>{item.progress}</small>
                </button>
              ))}
            </div>
          )}

          {overviewView === "activity" && (
            <section className="overview-panel">
              <div className="overview-panel-heading">
                <h2>时间线</h2>
                <span>最近</span>
              </div>
              <div className="overview-detail-list">
                {activityItems.map((activity) => (
                  <button
                    className="overview-detail-row"
                    type="button"
                    key={activity}
                    onClick={() => chooseOverviewItem(activity, "真实版本会跳转到这条活动关联的对象。")}
                  >
                    <strong>{activity}</strong>
                    <span>刚刚 · 系统事件</span>
                    <small>关联对象会显示在这里，比如候选任务、项目、执行记录或任务详情。</small>
                  </button>
                ))}
              </div>
            </section>
          )}

          {overviewView === "sync-log" && (
            <section className="overview-panel sync-log-panel">
              <div className="overview-panel-heading">
                <div>
                  <h2>提交记录</h2>
                  <p>包含自己的提交，以及你所属项目中其他成员提交到公司库的记录。</p>
                </div>
                <span>{syncLogsLoading ? "加载中" : `${syncLogs.length} 条`}</span>
              </div>
              {syncLogsLoading ? (
                <div className="overview-inline-empty">正在读取公司库同步日志…</div>
              ) : syncLogs.length > 0 ? (
                <div className="sync-log-table" role="table" aria-label="同步日志">
                  <div className="sync-log-head" role="row">
                    <span>时间</span>
                    <span>项目</span>
                    <span>提交人</span>
                    <span>结果</span>
                    <span>任务</span>
                    <span>详情</span>
                  </div>
                  {syncLogs.map((log) => (
                    <div className={`sync-log-row is-${log.status}`} role="row" key={log.id}>
                      <time dateTime={log.createdAt}>{new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(log.createdAt))}</time>
                      <strong title={log.projectName}>{log.projectName}</strong>
                      <span title={log.operatorEmployeeNo}>{log.operatorName}</span>
                      <span className={`sync-log-status is-${log.status}`}>{log.status === "success" ? "成功" : "失败"}</span>
                      <span>{log.taskCount}</span>
                      <small title={log.error ?? undefined}>
                        {log.status === "success"
                          ? `新增 ${log.imported}，更新 ${log.updated}`
                          : log.error ?? `失败 ${log.failed}`}
                      </small>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="overview-inline-empty">{getIdentityUser() ? "暂无同步日志。" : "未连接公司账号，暂无公司库同步日志。"}</div>
              )}
            </section>
          )}
        </section>
      ) : teamProjects.length > 0 ? (
        <div className="overview-layout">
          <div className="overview-main">
            <TeamProjectBoard rows={projectProgressRows} onOpenProject={onOpenProject} />

          </div>
        </div>
      ) : (
        <div className="project-home-empty">
          <span className="empty-orbit" aria-hidden="true"><i /><i /></span>
          <h2>还没有项目</h2>
          <p>在 Codex 中创建项目后，再打开任务面板。</p>
        </div>
      )}
    </section>
  );
}

export function App() {
  return <IdentityGate><AppWorkspace /></IdentityGate>;
}

function AppWorkspace() {
  const query = useMemo(() => new URLSearchParams(window.location.search), []);
  const embedded = query.get("host") === "codex";
  const standalonePanelView: ProjectOverviewView | null = query.get("panel") === "database-progress" ? "database-progress" : null;
  const panelOnly = standalonePanelView !== null;
  const undoShortcut = navigator.userAgent.includes("Macintosh") ? "⌘Z" : "Ctrl+Z";
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const [projectHomeView, setProjectHomeView] = useState<ProjectOverviewView>(standalonePanelView ?? "overview");
  const [hostContext, setHostContext] = useState<HostContext | null>(null);
  const [developmentScan, setDevelopmentScan] = useState<DevelopmentScan>({ workspacePath: null, contexts: [] });
  const [developmentScanLoading, setDevelopmentScanLoading] = useState(false);
  const [manageTaskboardSkillPath, setManageTaskboardSkillPath] = useState("");
  const [taskboardMetadata, setTaskboardMetadata] = useState<TaskboardMetadata | null>(null);
  const [localAiChatAvailable, setLocalAiChatAvailable] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [deviceProjects, setDeviceProjects] = useState<DeviceProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [overviewProjectId, setOverviewProjectId] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [tasksLoading, setTasksLoading] = useState(false);
  const [hasLoadedTasks, setHasLoadedTasks] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState(readTaskFilters);
  const [showEmptyColumns, setShowEmptyColumns] = useState(readShowEmptyColumns);
  const [columnVisibilityByProject, setColumnVisibilityByProject] = useState(readColumnVisibilityByProject);
  const [boardView, setBoardView] = useState<BoardView>("issues");
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [detailTaskIdentifier, setDetailTaskIdentifier] = useState<string | null>(
    () => readIssueIdentifier(window.location.search),
  );
  const [commentsRevision, setCommentsRevision] = useState(0);
  const [attachmentsRevision, setAttachmentsRevision] = useState(0);
  const [workflowRevision, setWorkflowRevision] = useState(0);
  const [workflowOptions, setWorkflowOptions] = useState<WorkflowOption[]>(DEFAULT_WORKFLOW_OPTIONS);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [draggedTaskHeight, setDraggedTaskHeight] = useState(0);
  const [dropTarget, setDropTarget] = useState<TaskStatus | null>(null);
  const [movingTaskId, setMovingTaskId] = useState<string | null>(null);
  const [settlingTaskId, setSettlingTaskId] = useState<string | null>(null);
  const [openingProjectId, setOpeningProjectId] = useState<string | null>(null);
  const [openingThreadTaskId, setOpeningThreadTaskId] = useState<string | null>(null);
  const [projectMenuOpen, setProjectMenuOpen] = useState(false);
  const [favoriteProjectIds, setFavoriteProjectIds] = useState(readFavoriteProjectIds);
  const [deviceWorkspacePaths, setDeviceWorkspacePaths] = useState(readDeviceWorkspacePaths);
  const [projectAutomations, setProjectAutomations] = useState(readProjectAutomations);
  const [automationPending, setAutomationPending] = useState(false);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [announcement, setAnnouncementValue] = useState("");
  const [undoNotice, setUndoNotice] = useState<UndoNotice | null>(null);
  const tasksRequestRef = useRef(0);
  const tasksRef = useRef<Task[]>([]);
  const undoSequenceRef = useRef(0);
  const undoStackRef = useRef<UndoOperation[]>([]);
  const undoInFlightRef = useRef(false);
  const dragRegionRef = useRef<HTMLDivElement>(null);
  const selectedProjectIdRef = useRef(selectedProjectId);
  const projectsRef = useRef(projects);
  selectedProjectIdRef.current = selectedProjectId;
  projectsRef.current = projects;

  const revisionPollingInterval = getRevisionPollingInterval(taskboardMetadata);
  const pendingAutomationRequestsRef = useRef(new Map<string, PendingAutomationRequest>());
  const automationRequestInFlightRef = useRef(false);
  const projectAutomationsRef = useRef(projectAutomations);

  const setAnnouncement = useCallback((message: string) => {
    setUndoNotice(null);
    setAnnouncementValue(message);
  }, []);

  const rememberDeviceWorkspacePath = useCallback((projectId: string, workspacePath: string) => {
    const normalizedPath = workspacePath.trim();
    setDeviceWorkspacePaths((current) => {
      if (current[projectId] === normalizedPath || (!normalizedPath && !(projectId in current))) {
        return current;
      }
      const next = { ...current };
      if (normalizedPath) next[projectId] = normalizedPath;
      else delete next[projectId];
      window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const identityUser = getIdentityUser();
  const workspaceRole: WorkspaceRole = selectedProject?.role ?? "none";
  const canManageMembers = Boolean(selectedProject?.role === "owner" || (!selectedProjectId && projects.some((project) => project.role === "owner")));
  const currentUser = hostContext?.user ?? (identityUser
    ? { type: "user" as const, id: identityUser.id, name: identityUser.displayName, avatarUrl: null }
    : DEFAULT_USER_ACTOR);
  const selectedDeviceWorkspacePath = deviceWorkspacePaths[selectedProjectId];
  const selectedProjectAutomation = projectAutomations[selectedProjectId];
  const automationProjectContext = useMemo(() => {
    if (!isLocalTaskboardOrigin(window.location.origin)) {
      return { unavailableReason: "仅本地任务面板可用" };
    }
    if (!selectedProject) return { unavailableReason: "请先选择项目" };

    const hostProjects = hostContext?.projects ?? [];
    const directCodexProject = hostProjects.some(
      (project) => project.id === selectedProject.id,
    );
    const workspacePath = deviceWorkspacePaths[selectedProject.id]
      ?? selectedProject.workspacePath
      ?? (
        directCodexProject && hostContext?.projectId === selectedProject.id
          ? hostContext.workspacePath
          : undefined
      );
    const codexProjectId = directCodexProject
      ? selectedProject.id
      : hostProjects.find(
        (project) => deviceWorkspacePaths[project.id] === workspacePath,
      )?.id ?? selectedProject.id;

    if (!workspacePath) {
      return { unavailableReason: "请先为该项目映射本地目录" };
    }
    if (!manageTaskboardSkillPath) {
      return { unavailableReason: "任务面板还没有读取到 Skill 路径" };
    }
    return { workspacePath, codexProjectId, unavailableReason: null };
  }, [
    deviceWorkspacePaths,
    hostContext,
    manageTaskboardSkillPath,
    selectedProject,
  ]);
  const detailTask = detailTaskIdentifier
    ? tasks.find((task) => task.identifier === detailTaskIdentifier) ?? null
    : null;
  const detailTaskId = detailTask?.id ?? null;
  const contextMenuTask = contextMenu
    ? tasks.find((task) => task.id === contextMenu.taskId) ?? null
    : null;
  const availableLabels = useMemo(
    () => [...new Set([
      ...DEFAULT_LABELS.map((label) => label.name),
      ...tasks.flatMap((task) => task.labels),
    ])],
    [tasks],
  );
  const projectChoices = useMemo<ProjectChoice[]>(() => {
    const persistedById = new Map(projects.map((project) => [project.id, project]));
    const persistedByWorkspace = new Map<string, Project[]>();
    projects.forEach((project) => {
      const workspacePath = project.workspacePath ?? deviceWorkspacePaths[project.id] ?? null;
      if (!workspacePath) return;
      const candidates = persistedByWorkspace.get(workspacePath) ?? [];
      candidates.push(project);
      persistedByWorkspace.set(workspacePath, candidates);
    });
    /* A workspace can contain several logical Codex projects. Only use a
       workspace match when it is unambiguous or has the same display name. */
    const persistedForWorkspace = (workspacePath: string | null, projectName: string) => {
      if (!workspacePath) return undefined;
      const candidates = persistedByWorkspace.get(workspacePath) ?? [];
      return candidates.find((candidate) => candidate.name === projectName)
        ?? (candidates.length === 1 ? candidates[0] : undefined);
    };
    const seen = new Set<string>();
    const seenTeamProjectIds = new Set<string>();
    const seenWorkspaces = new Set<string>();
    const workspaceKey = (value: string | null) => value
      ? value.trim().replaceAll("\\\\", "/").replace(/[\\/]+$/, "").toLowerCase()
      : "";
    const choices: ProjectChoice[] = [];
    for (const project of [...(hostContext?.projects ?? []), ...deviceProjects]) {
      const deviceProject = project as Partial<DeviceProject>;
      const workspacePath = typeof deviceProject.workspacePath === "string"
        ? deviceProject.workspacePath
        : deviceWorkspacePaths[project.id] ?? null;
      const normalizedWorkspace = workspaceKey(workspacePath);
      const persisted = persistedById.get(project.id)
        ?? persistedForWorkspace(workspacePath, project.name);
      const id = project.id;
      if (!id || !project.name || seen.has(id) || (normalizedWorkspace && seenWorkspaces.has(normalizedWorkspace))) continue;
      seen.add(id);
      if (persisted?.id) seenTeamProjectIds.add(persisted.id);
      if (normalizedWorkspace) seenWorkspaces.add(normalizedWorkspace);
      choices.push({
        id,
        sourceProjectId: deviceProject.sourceProjectId,
        teamProjectId: persisted?.id,
        code: persisted?.code,
        name: persisted?.name ?? project.name,
        workspacePath,
        updatedAt: persisted?.updatedAt ?? "",
        issueCount: persisted?.issueCount ?? 0,
        inCodex: true,
        persisted: Boolean(persisted),
        role: persisted?.role,
        ownerName: persisted?.ownerName,
      });
    }
    for (const project of projects) {
      if (seen.has(project.id) || seenTeamProjectIds.has(project.id)) continue;
      choices.push({
        id: project.id,
        code: project.code,
        name: project.name,
        workspacePath: project.workspacePath,
        updatedAt: project.updatedAt,
        issueCount: project.issueCount,
        inCodex: false,
        persisted: true,
        role: project.role,
        ownerName: project.ownerName,
      });
    }
    return choices.sort((left, right) => (
      Number(favoriteProjectIds.has(right.id)) - Number(favoriteProjectIds.has(left.id))
    ));
  }, [deviceProjects, deviceWorkspacePaths, favoriteProjectIds, hostContext?.projects, projects]);
  const teamProjectChoices = useMemo(
    () => getIdentityUser()
      ? projectChoices.filter((project) => project.persisted && (Boolean(project.teamProjectId) || !project.inCodex || Boolean(project.role) || Boolean(project.ownerName)))
      : [],
    [projectChoices],
  );
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const writeProjectAutomation = useCallback((
    projectId: string,
    record: ProjectAutomationRecord | null | undefined,
  ) => {
    setProjectAutomations((current) => {
      if (
        record
        && current[projectId]?.automationId === record.automationId
        && current[projectId]?.codexProjectId === record.codexProjectId
        && current[projectId]?.status === record.status
        && current[projectId]?.enabledByUser === record.enabledByUser
        && current[projectId]?.quotaAware === record.quotaAware
        && JSON.stringify(current[projectId]?.quota) === JSON.stringify(record.quota)
        && JSON.stringify(current[projectId]?.lastRun) === JSON.stringify(record.lastRun)
        && current[projectId]?.intervalMinutes === record.intervalMinutes
        && current[projectId]?.model === record.model
        && current[projectId]?.reasoningEffort === record.reasoningEffort
      ) {
        return current;
      }
      const next = { ...current };
      if (record) next[projectId] = record;
      else delete next[projectId];
      projectAutomationsRef.current = next;
      window.localStorage.setItem(PROJECT_AUTOMATIONS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const sendAutomationRequest = useCallback((
    operation: "ensure-active" | "pause" | "list" | "apply-policy" | "run-once",
    options: Pick<
      ProjectAutomationRecord,
      "enabledByUser" | "quotaAware" | "intervalMinutes" | "model" | "reasoningEffort"
    >,
    automationId?: string,
  ) => {
    if (
      !selectedProject
      || !selectedProjectId
      || !automationProjectContext.codexProjectId
      || !automationProjectContext.workspacePath
    ) {
      return Promise.reject(new Error(
        automationProjectContext.unavailableReason ?? "无法读取项目自动化信息",
      ));
    }
    const requestId = window.crypto.randomUUID();
    const payload = {
      requestId,
      operation,
      taskboardProjectId: selectedProjectId,
      codexProjectId: automationProjectContext.codexProjectId,
      projectName: selectedProject.name,
      workspacePath: automationProjectContext.workspacePath,
      skillPath: manageTaskboardSkillPath,
      ...(automationId ? { automationId } : {}),
      enabledByUser: options.enabledByUser,
      quotaAware: options.quotaAware,
      intervalMinutes: options.intervalMinutes,
      model: options.model,
      reasoningEffort: options.reasoningEffort,
    };
    if (isLocalTaskboardOrigin(window.location.origin) || !embedded || window.parent === window) {
      return fetch("/api/local/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
        .then(async (response) => {
          const body = await response.json().catch(() => null) as Partial<AutomationHostResponse> | null;
          if (!response.ok) {
            throw new Error(
              typeof body?.error === "string"
                ? body.error
                : `自动化请求失败：HTTP ${response.status}`,
            );
          }
          if (!body?.ok) {
            throw new Error(typeof body?.error === "string" ? body.error : "Codex 无法更新自动化");
          }
          return body as AutomationHostResponse;
        });
    }
    const response = new Promise<AutomationHostResponse>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        pendingAutomationRequestsRef.current.delete(requestId);
        reject(new Error("Codex 自动化没有响应，请稍后重试"));
      }, 10_000);
      pendingAutomationRequestsRef.current.set(requestId, { resolve, reject, timeoutId });
    });
    window.parent.postMessage({
      type: "taskboard:automation-request",
      payload,
    }, "*");
    return response;
  }, [
    automationProjectContext,
    embedded,
    manageTaskboardSkillPath,
    selectedProject,
    selectedProjectId,
  ]);

  const reconcileProjectAutomation = useCallback(async () => {
    if (automationProjectContext.unavailableReason) {
      setAutomationError(null);
      return;
    }
    if (!selectedProjectId || !automationProjectContext.codexProjectId || automationRequestInFlightRef.current) return;
    const stored = projectAutomationsRef.current[selectedProjectId];
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const options = stored ?? {
        status: "PAUSED" as const,
        ...DEFAULT_AUTOMATION_OPTIONS,
      };
      const response = await sendAutomationRequest(
        stored ? "apply-policy" : "list",
        options,
        stored?.automationId,
      );
      const items = Array.isArray(response.items)
        ? response.items.filter(isAutomationHostItem)
        : [];
      if (!stored) {
        const policy = isAutomationHostPolicy(response.policy) ? response.policy : null;
        if (!policy) return;
        const item = items.find((candidate) => candidate.id === policy.automationId)
          ?? (items.length === 1 ? items[0] : undefined);
        writeProjectAutomation(selectedProjectId, {
          automationId: item?.id ?? policy.automationId,
          codexProjectId: automationProjectContext.codexProjectId,
          status: item?.status ?? "PAUSED",
          enabledByUser: policy.enabledByUser,
          quotaAware: policy.quotaAware,
          ...(response.lastRun ? { lastRun: response.lastRun } : {}),
          intervalMinutes: policy.intervalMinutes,
          model: policy.model,
          reasoningEffort: policy.reasoningEffort,
        });
        return;
      }
      const item = (isAutomationHostItem(response.item) ? response.item : undefined)
        ?? items.find((item) => item.id === stored?.automationId)
        ?? (items.length === 1 ? items[0] : undefined);
      if (!item) {
        if (stored) {
          writeProjectAutomation(selectedProjectId, {
            ...stored,
            automationId: undefined,
            status: "PAUSED",
            ...(response.quota ? { quota: response.quota } : {}),
            ...(response.lastRun ? { lastRun: response.lastRun } : {}),
          });
        }
        return;
      }
      const intervalMinutes = intervalMinutesFromRrule(item.rrule);
      if (!intervalMinutes) return;
      writeProjectAutomation(selectedProjectId, {
        automationId: item.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item.status,
        enabledByUser: stored.enabledByUser,
        quotaAware: stored.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        ...(response.lastRun ? { lastRun: response.lastRun } : {}),
        intervalMinutes,
        model: item.model,
        reasoningEffort: item.reasoningEffort,
      });
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : "无法读取自动化状态");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  const saveProjectAutomation = useCallback(async (options: {
    enabledByUser: boolean;
    quotaAware: boolean;
    intervalMinutes: AutomationIntervalMinutes;
    model: AutomationModel;
    reasoningEffort: AutomationReasoningEffort;
  }) => {
    const stored = projectAutomations[selectedProjectId];
    if (
      !selectedProjectId
      || automationProjectContext.unavailableReason
      || !automationProjectContext.codexProjectId
      || automationRequestInFlightRef.current
    ) return;
    const previousRecord = stored;
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const response = await sendAutomationRequest("apply-policy", options, stored?.automationId);
      const item = isAutomationHostItem(response.item) ? response.item : undefined;
      writeProjectAutomation(selectedProjectId, {
        automationId: item?.id,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item?.status ?? "PAUSED",
        enabledByUser: options.enabledByUser,
        quotaAware: options.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        ...(response.lastRun ? { lastRun: response.lastRun } : {}),
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
    } catch (error) {
      writeProjectAutomation(selectedProjectId, previousRecord);
      setAutomationError(error instanceof Error ? error.message : "无法更新自动化");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    projectAutomations,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  const runProjectAutomationOnce = useCallback(async () => {
    const stored = projectAutomations[selectedProjectId];
    const options = stored ?? DEFAULT_AUTOMATION_OPTIONS;
    if (
      !selectedProjectId
      || automationProjectContext.unavailableReason
      || !automationProjectContext.codexProjectId
      || automationRequestInFlightRef.current
    ) return;
    automationRequestInFlightRef.current = true;
    setAutomationPending(true);
    setAutomationError(null);
    try {
      const response = await sendAutomationRequest("run-once", options, stored?.automationId);
      const item = isAutomationHostItem(response.item) ? response.item : undefined;
      writeProjectAutomation(selectedProjectId, {
        automationId: item?.id ?? stored?.automationId,
        codexProjectId: automationProjectContext.codexProjectId,
        status: item?.status ?? stored?.status ?? "PAUSED",
        enabledByUser: stored?.enabledByUser ?? options.enabledByUser,
        quotaAware: stored?.quotaAware ?? options.quotaAware,
        ...(response.quota ? { quota: response.quota } : {}),
        ...(response.lastRun ?? response.run ? { lastRun: response.lastRun ?? response.run } : {}),
        intervalMinutes: options.intervalMinutes,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
      });
    } catch (error) {
      setAutomationError(error instanceof Error ? error.message : "无法执行自动化");
    } finally {
      automationRequestInFlightRef.current = false;
      setAutomationPending(false);
    }
  }, [
    automationProjectContext,
    projectAutomations,
    selectedProjectId,
    sendAutomationRequest,
    writeProjectAutomation,
  ]);

  function openTaskDetail(task: Pick<Task, "identifier" | "projectId">) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(task.identifier);
    const currentIssue = readIssueIdentifier(window.location.search);
    const boardUrl = buildIssueUrl(window.location.href, task.projectId, null);
    if (!currentIssue) {
      window.history.replaceState(window.history.state, "", boardUrl);
    }
    const detailUrl = buildIssueUrl(
      currentIssue ? window.location.href : boardUrl.href,
      task.projectId,
      task.identifier,
    );
    window.history.pushState(window.history.state, "", detailUrl);
  }

  function closeTaskDetail() {
    setDetailTaskIdentifier(null);
    const url = buildIssueUrl(window.location.href, selectedProjectId || null, null);
    window.history.replaceState(window.history.state, "", url);
  }

  useEffect(() => {
    function syncRouteFromLocation() {
      const url = new URL(window.location.href);
      const routeProjectId = url.searchParams.get("project") ?? "";
      setDetailTaskIdentifier(readIssueIdentifier(url.search));
      if (routeProjectId === selectedProjectId) return;
      setBoardView("issues");
      setSelectedProjectId(routeProjectId);
      if (routeProjectId) window.localStorage.setItem(LAST_PROJECT_KEY, routeProjectId);
      else window.localStorage.removeItem(LAST_PROJECT_KEY);
    }

    window.addEventListener("popstate", syncRouteFromLocation);
    return () => window.removeEventListener("popstate", syncRouteFromLocation);
  }, [selectedProjectId]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.embedded = String(embedded);
    document.documentElement.style.colorScheme = theme;
    if (!embedded) window.localStorage.setItem("taskboard.theme", theme);
  }, [embedded, theme]);

  useEffect(() => {
    writeTaskFilters(filters);
  }, [filters]);

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    if (!projectMenuOpen) return;
    function closeProjectMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest("[data-project-switcher]")) setProjectMenuOpen(false);
    }
    function closeProjectMenuWithEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setProjectMenuOpen(false);
    }
    document.addEventListener("pointerdown", closeProjectMenu);
    window.addEventListener("keydown", closeProjectMenuWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeProjectMenu);
      window.removeEventListener("keydown", closeProjectMenuWithEscape);
    };
  }, [projectMenuOpen]);

  useEffect(() => {
    setAutomationError(null);
    void reconcileProjectAutomation();
  }, [selectedProjectId, reconcileProjectAutomation]);

  useEffect(() => {
    if (!embedded || window.parent === window) return;

    function receiveHostMessage(event: MessageEvent) {
      if (event.source !== window.parent || !event.data || typeof event.data !== "object") return;
      const message = event.data as { type?: string; payload?: unknown; theme?: unknown };

      if (message.type === "taskboard:automation-response" && message.payload) {
        const payload = message.payload as Partial<AutomationHostResponse>;
        if (typeof payload.requestId !== "string") return;
        const pending = pendingAutomationRequestsRef.current.get(payload.requestId);
        if (!pending) return;
        window.clearTimeout(pending.timeoutId);
        pendingAutomationRequestsRef.current.delete(payload.requestId);
        if (payload.ok) pending.resolve(payload as AutomationHostResponse);
        else pending.reject(new Error(
          typeof payload.error === "string" ? payload.error : "Codex 无法更新自动化",
        ));
        return;
      }

      if (message.type === "taskboard:theme" && isTheme(message.theme)) {
        setTheme(message.theme);
        return;
      }

      if (message.type === "taskboard:thread-prepared") {
        setOpeningThreadTaskId(null);
        return;
      }

      if (message.type === "taskboard:thread-create-error" && message.payload) {
        const payload = message.payload as { taskId?: unknown; error?: unknown };
        setOpeningThreadTaskId(null);
        setActionError(typeof payload.error === "string" ? payload.error : "无法在 Codex 中创建对话。");
        return;
      }

      if (message.type !== "taskboard:host-context" || !message.payload) return;
      const payload = message.payload as HostContext;
      setHostContext(payload);
      setCurrentUserActor(payload.user);
      if (isTheme(payload.theme)) setTheme(payload.theme);
    }

    window.addEventListener("message", receiveHostMessage);
    window.parent.postMessage({ type: "taskboard:ready" }, "*");
    return () => {
      window.removeEventListener("message", receiveHostMessage);
      for (const pending of pendingAutomationRequestsRef.current.values()) {
        window.clearTimeout(pending.timeoutId);
      }
      pendingAutomationRequestsRef.current.clear();
    };
  }, [embedded]);

  useLayoutEffect(() => {
    if (!embedded || window.parent === window || !dragRegionRef.current) return;
    const region = dragRegionRef.current;
    const publish = () => {
      const rect = region.getBoundingClientRect();
      window.parent.postMessage({
        type: "taskboard:drag-region",
        payload: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      }, "*");
    };
    const observer = new ResizeObserver(publish);
    observer.observe(region);
    window.addEventListener("resize", publish);
    publish();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", publish);
      window.parent.postMessage({ type: "taskboard:drag-region", payload: null }, "*");
    };
  }, [detailTaskId, embedded, selectedProjectId]);

  const loadProjectList = useCallback(async (signal?: AbortSignal) => {
    setProjectsLoading(true);
    setLoadError(null);
    try {
      const projectRequest = getIdentityUser()
        ? listIdentityProjects(signal).catch((error) => {
          if ((error as Error).name === "AbortError") throw error;
          return listProjects(signal);
        })
        : listProjects(signal);
      const [nextProjects, metadata, deviceWorkspaceInfo] = await Promise.all([
        projectRequest,
        getTaskboardMetadata(signal),
        listDeviceWorkspaces(signal),
      ]);
      setTaskboardMetadata((current) => (
        current
        && current.mode === metadata.mode
        && current.realtime?.transport === metadata.realtime?.transport
        && current.realtime?.intervalMs === metadata.realtime?.intervalMs
        && current.manageTaskboardSkillPath === metadata.manageTaskboardSkillPath
        && current.localCapabilities?.available === metadata.localCapabilities?.available
          ? current
          : metadata
      ));
      setManageTaskboardSkillPath(metadata.manageTaskboardSkillPath ?? "");
      setLocalAiChatAvailable(metadata.capabilities?.localAiChat === true);
      setDeviceProjects(deviceWorkspaceInfo.projects);
      setDeviceWorkspacePaths((current) => {
        const next = { ...current, ...deviceWorkspaceInfo.workspaces };
        if (JSON.stringify(next) === JSON.stringify(current)) return current;
        window.localStorage.setItem(DEVICE_WORKSPACE_PATHS_KEY, JSON.stringify(next));
        return next;
      });
      setProjects(nextProjects);
      setSelectedProjectId((current) => {
        const fromQuery = new URLSearchParams(window.location.search).get("project");
        const remembered = window.localStorage.getItem(LAST_PROJECT_KEY);
        if (fromQuery && nextProjects.some((project) => project.id === fromQuery)) return fromQuery;
        if (current && nextProjects.some((project) => project.id === current)) return current;
        if (remembered && nextProjects.some((project) => project.id === remembered)) return remembered;
        return "";
      });
    } catch (error) {
      if ((error as Error).name !== "AbortError") setLoadError(errorMessage(error));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjectList(controller.signal);
    return () => controller.abort();
  }, [loadProjectList]);

  const refreshProjectList = useCallback(async () => {
    try {
      if (!getIdentityUser()) {
        setProjects(await listProjects());
        return;
      }
      setProjects(await listIdentityProjects().catch(() => listProjects()));
    } catch (error) {
      setLoadError(errorMessage(error));
    }
  }, []);

  const summarizeProjectWork = useCallback(async (project: ProjectChoice) => {
    try {
      const localProjectId = project.code ?? project.id;
      const sourceProjectIds = [project.id, project.sourceProjectId]
        .filter((value): value is string => Boolean(value && value !== localProjectId));
      const result = await summarizeLocalProject(localProjectId, sourceProjectIds);
      setAnnouncement(`${project.name}：${result.message}`);
      await refreshProjectList();
    } catch (error) {
      setAnnouncement(error instanceof Error ? error.message : "本地任务卡片生成失败");
    }
  }, [refreshProjectList, setAnnouncement]);

  const refreshTasks = useCallback(async (
    projectId: string,
    options: { quiet?: boolean; signal?: AbortSignal } = {},
  ) => {
    const requestId = ++tasksRequestRef.current;
    if (!options.quiet) setTasksLoading(true);
    setLoadError(null);
    try {
      const nextTasks = await listTasks(projectId, options.signal);
      if (requestId !== tasksRequestRef.current) return;
      setTasks(sortTasks(nextTasks));
      setHasLoadedTasks(true);
    } catch (error) {
      if ((error as Error).name !== "AbortError" && requestId === tasksRequestRef.current) {
        setLoadError(errorMessage(error));
      }
    } finally {
      if (!options.quiet && requestId === tasksRequestRef.current) setTasksLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setTasks([]);
      setHasLoadedTasks(false);
      return;
    }
    setHasLoadedTasks(false);
    const controller = new AbortController();
    void refreshTasks(selectedProjectId, { signal: controller.signal });
    return () => controller.abort();
  }, [refreshTasks, selectedProjectId]);

  const refreshWorkflowOptions = useCallback(async (projectId: string, signal?: AbortSignal) => {
    const record = await getWorkflowWorkspace<unknown>(projectId, signal);
    if (!signal?.aborted) setWorkflowOptions(workflowOptionsFromWorkspace(record.workspace));
  }, []);

  useEffect(() => {
    if (!selectedProjectId) {
      setWorkflowOptions(DEFAULT_WORKFLOW_OPTIONS);
      return;
    }
    setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
    const controller = new AbortController();
    void refreshWorkflowOptions(selectedProjectId, controller.signal).catch((error) => {
      if ((error as Error).name !== "AbortError") {
        setWorkflowOptions(workflowOptionsFromWorkspace(readLegacyWorkflowWorkspace(selectedProjectId)));
      }
    });
    return () => controller.abort();
  }, [refreshWorkflowOptions, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId) {
      setDevelopmentScan({ workspacePath: null, contexts: [] });
      return;
    }
    const controller = new AbortController();
    const codexProjectId = selectedProjectId === "local" ? hostContext?.projectId : selectedProjectId;
    const codexThreadId = hostContext?.threadId ?? detailTask?.threadId ?? undefined;
    setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
    setDevelopmentScanLoading(true);
    void listDevelopmentContexts(
      selectedProjectId,
      codexProjectId,
      codexThreadId,
      controller.signal,
      selectedDeviceWorkspacePath,
    )
      .then((scan) => {
        setDevelopmentScan(scan);
        if (scan.workspacePath) rememberDeviceWorkspacePath(selectedProjectId, scan.workspacePath);
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setDevelopmentScan({ workspacePath: selectedDeviceWorkspacePath ?? null, contexts: [] });
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDevelopmentScanLoading(false);
      });
    return () => controller.abort();
  }, [
    detailTask?.threadId,
    hostContext?.projectId,
    hostContext?.threadId,
    rememberDeviceWorkspacePath,
    selectedProjectId,
    selectedDeviceWorkspacePath,
  ]);

  useEffect(() => {
    if (revisionPollingInterval === null) return;
    const controller = new AbortController();
    setConnection("connecting");
    const poller = createRevisionPoller({
      intervalMs: revisionPollingInterval,
      fetchRevision: async (since: number) => {
        try {
          const result = await getTaskboardRevision(since, controller.signal);
          setConnection("live");
          return result;
        } catch (error) {
          if (!controller.signal.aborted) setConnection("reconnecting");
          throw error;
        }
      },
      onInvalidate: () => {
        void refreshProjectList();
        const projectId = selectedProjectIdRef.current;
        if (projectId) {
          void refreshTasks(projectId, { quiet: true });
          void refreshWorkflowOptions(projectId).catch(() => {});
        }
        setWorkflowRevision((current) => current + 1);
        setCommentsRevision((current) => current + 1);
        setAttachmentsRevision((current) => current + 1);
      },
    });
    poller.start();
    return () => {
      controller.abort();
      poller.stop();
    };
  }, [
    revisionPollingInterval,
    refreshProjectList,
    refreshTasks,
    refreshWorkflowOptions,
  ]);

  function pushUndo(message: string, undo: () => Promise<void>, showNotice = true) {
    const operation = { id: ++undoSequenceRef.current, message, undo };
    undoStackRef.current = [...undoStackRef.current.slice(-19), operation];
    setAnnouncementValue("");
    setUndoNotice(showNotice ? { id: operation.id, message } : null);
  }

  async function performUndo() {
    if (undoInFlightRef.current) return;
    const operation = undoStackRef.current.at(-1);
    if (!operation) return;
    undoStackRef.current = undoStackRef.current.slice(0, -1);
    undoInFlightRef.current = true;
    setUndoNotice(null);
    setProjectMenuOpen(false);
    closeContextMenu();
    setActionError(null);
    try {
      await operation.undo();
    } catch (error) {
      setActionError(`无法撤回这次操作：${errorMessage(error)}`);
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      undoInFlightRef.current = false;
    }
  }

  async function restoreTaskDetails(
    snapshot: Task,
    changed: Task,
    assigneeTarget = assigneeTargetForActor(snapshot.assignee, currentUser),
  ) {
    const candidate = tasksRef.current.find((task) => task.id === changed.id);
    const current = candidate && candidate.version >= changed.version ? candidate : changed;
    const restored = await updateTaskRequest(current, {
      ...taskToDraft(snapshot),
      ...(assigneeTarget ? { assigneeTarget } : {}),
    });
    setTasks((tasks) => sortTasks(tasks.map((task) => task.id === restored.id ? restored : task)));
  }

  useEffect(() => {
    function handleShortcut(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const isTyping = target?.matches("input, textarea, select, [contenteditable='true']");
      if (
        event.key.toLowerCase() === "z"
        && (event.metaKey || event.ctrlKey)
        && !event.shiftKey
        && !isTyping
        && !editor
      ) {
        event.preventDefault();
        void performUndo();
        return;
      }
      if (isTyping || contextMenu || projectMenuOpen) return;
      if (
        event.key.toLowerCase() === "c"
        && !event.metaKey
        && !event.ctrlKey
        && selectedProjectId
        && boardView === "issues"
      ) {
        event.preventDefault();
        setEditor({ task: null, status: "backlog" });
      }
      if (event.key === "/" && !detailTaskId && selectedProjectId && boardView === "issues") {
        event.preventDefault();
        document.getElementById("task-search")?.focus();
      }
      if (event.key === "Escape" && detailTaskId) {
        closeTaskDetail();
      }
    }

    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [boardView, contextMenu, detailTaskId, editor, projectMenuOpen, selectedProjectId]);

  const filteredTasks = useMemo(() => {
    return tasks.filter(
      (task) => matchesTaskSearch(task, search) && matchesTaskFilters(task, filters),
    );
  }, [filters, search, tasks]);

  const activeFilterCount = taskFilterCount(filters);

  const tasksByStatus = useMemo(() => {
    return Object.fromEntries(
      TASK_STATUSES.map((status) => [status, filteredTasks.filter((task) => task.status === status)]),
    ) as Record<TaskStatus, Task[]>;
  }, [filteredTasks]);

  const columnVisibility = columnVisibilityByProject[selectedProjectId];

  const visibleStatuses = useMemo(
    () => TASK_STATUSES.filter((status) => (
      tasksByStatus[status].length === 0
        ? showEmptyColumns
        : (columnVisibility?.[status] ?? true)
    )),
    [columnVisibility, showEmptyColumns, tasksByStatus],
  );

  const hiddenStatuses = useMemo(
    () => TASK_STATUSES.filter((status) => (
      tasksByStatus[status].length === 0
        ? !showEmptyColumns
        : !(columnVisibility?.[status] ?? true)
    )),
    [columnVisibility, showEmptyColumns, tasksByStatus],
  );

  function updateShowEmptyColumns(show: boolean) {
    window.localStorage.setItem(SHOW_EMPTY_COLUMNS_KEY, String(show));
    setShowEmptyColumns(show);
  }

  function updateColumnVisibility(status: TaskStatus, visible: boolean) {
    if (!selectedProjectId || tasksByStatus[status].length === 0) return;
    setColumnVisibilityByProject((current) => {
      const next = {
        ...current,
        [selectedProjectId]: {
          ...current[selectedProjectId],
          [status]: visible,
        },
      };
      window.localStorage.setItem(COLUMN_VISIBILITY_KEY, JSON.stringify(next));
      return next;
    });
  }

  function selectBoardView(view: BoardView) {
    closeContextMenu();
    setBoardView(view);
  }

  async function saveEditor(
    draft: TaskDraft,
    attachments: File[],
    inlineImages: PendingInlineImage[],
  ) {
    if (!selectedProjectId || !editor) return;
    setActionError(null);
    try {
      const creating = editor.task === null;
      let saved = editor.task
        ? await updateTaskRequest(editor.task, draft)
        : await createTaskRequest(selectedProjectId, draft);
      if (creating && !getIdentityUser()) {
        setProjects((current) => current.map((project) => (
          project.id === selectedProjectId
            ? { ...project, issueCount: project.issueCount + 1 }
            : project
        )));
      }
      let uploadedAttachments = 0;
      let failedAttachments = 0;
      if (creating && (attachments.length > 0 || inlineImages.length > 0)) {
        const [results, inlineAttachments] = await Promise.all([
          Promise.allSettled(
            attachments.map((file) => uploadAttachment(saved.id, file)),
          ),
          Promise.all(
            inlineImages.map((image) => uploadAttachment(saved.id, image.file)),
          ),
        ]);
        uploadedAttachments = results.filter((result) => result.status === "fulfilled").length;
        failedAttachments = results.length - uploadedAttachments;
        if (inlineImages.length > 0) {
          const description = resolveInlineMediaMarkdown(
            draft.description,
            inlineImages,
            inlineAttachments,
          );
          saved = await updateTaskRequest(saved, { ...draft, description });
        }
      }
      setTasks((current) => sortTasks([
        ...current.filter((task) => task.id !== saved.id),
        saved,
      ]));
      setEditor(null);
      if (failedAttachments > 0) {
        setActionError(`${saved.identifier} 已创建，但有 ${failedAttachments} 个附件上传失败，可在详情页重试。`);
      }
      if (creating) {
        const totalUploaded = uploadedAttachments + inlineImages.length;
        const message = `${saved.identifier} 已创建${totalUploaded > 0 ? `，已上传 ${totalUploaded} 个附件` : ""}。`;
        pushUndo(message, async () => {
          const candidate = tasksRef.current.find((task) => task.id === saved.id);
          const current = candidate && candidate.version >= saved.version ? candidate : saved;
          await archiveTaskRequest(current);
          setTasks((tasks) => tasks.filter((task) => task.id !== saved.id));
        });
      } else if (editor.task) {
        const previous = editor.task;
        const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
        if (!draft.assigneeTarget || previousAssigneeTarget) {
          pushUndo(
            `${saved.identifier} 已更新。`,
            () => restoreTaskDetails(previous, saved, previousAssigneeTarget),
          );
        }
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
        void refreshTasks(selectedProjectId, { quiet: true });
      }
      throw error;
    }
  }

  async function moveTask(
    task: Task,
    status: TaskStatus,
    beforeTaskId: string | null = null,
    silent = false,
  ) {
    if (movingTaskId) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }

    const destination = tasks.filter((candidate) => candidate.status === status && candidate.id !== task.id);
    const insertionIndex = beforeTaskId
      ? destination.findIndex((candidate) => candidate.id === beforeTaskId)
      : destination.length;
    const targetIndex = insertionIndex < 0 ? destination.length : insertionIndex;
    const desiredOrder = [...destination];
    desiredOrder.splice(targetIndex, 0, task);
    const currentOrder = tasks.filter((candidate) => candidate.status === status);
    if (
      task.status === status
      && currentOrder.length === desiredOrder.length
      && currentOrder.every((candidate, index) => candidate.id === desiredOrder[index].id)
    ) {
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
      return;
    }
    const previousTask = destination[targetIndex - 1] ?? null;
    const nextTask = destination[targetIndex] ?? null;
    const sortOrder = previousTask && nextTask
      ? (previousTask.sortOrder + nextTask.sortOrder) / 2
      : previousTask
        ? previousTask.sortOrder + 1024
        : nextTask
          ? nextTask.sortOrder - 1024
          : 1024;
    const previous = task;
    setActionError(null);
    setMovingTaskId(task.id);
    setTasks((current) => sortTasks(current.map((candidate) =>
      candidate.id === task.id ? { ...candidate, status, sortOrder } : candidate,
    )));

    try {
      const moved = await moveTaskRequest(task, status, sortOrder);
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === moved.id ? moved : candidate,
      )));
      const message = task.status === status
        ? `${task.identifier} 排序已调整。`
        : `${task.identifier} 已移至${STATUS_DETAILS[status].label}。`;
      pushUndo(message, async () => {
        const candidate = tasksRef.current.find((current) => current.id === moved.id);
        const current = candidate && candidate.version >= moved.version ? candidate : moved;
        const restored = await moveTaskRequest(current, previous.status, previous.sortOrder);
        setTasks((tasks) => sortTasks(tasks.map((item) => item.id === restored.id ? restored : item)));
      }, !silent);
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "That issue changed elsewhere. The board has been refreshed."
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    } finally {
      setMovingTaskId(null);
      setDropTarget(null);
      setDraggedTaskId(null);
      setDraggedTaskHeight(0);
    }
  }

  function finishTaskDrop(destination: TaskStatus, taskId: string, beforeTaskId: string | null = null) {
    const task = tasks.find((candidate) => candidate.id === taskId);
    setDraggedTaskId(null);
    setDraggedTaskHeight(0);
    setDropTarget(null);
    if (!task) return;
    setSettlingTaskId(task.id);
    window.setTimeout(() => {
      setSettlingTaskId((current) => current === task.id ? null : current);
    }, 220);
    void moveTask(task, destination, beforeTaskId, true);
  }

  async function updateTaskProperties(task: Task, changes: Partial<TaskDraft>, message?: string): Promise<Task> {
    const previous = task;
    const { assigneeTarget, ...taskChanges } = changes;
    const optimisticAssignee = assigneeTarget
      ? actorForAssigneeTarget(assigneeTarget, currentUser)
      : task.assignee;
    setActionError(null);
    setTasks((current) => current.map((candidate) =>
      candidate.id === task.id
        ? { ...candidate, ...taskChanges, assignee: optimisticAssignee }
        : candidate,
    ));

    try {
      const updated = await updateTaskRequest(task, { ...taskToDraft(task), ...changes });
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      )));
      const previousAssigneeTarget = assigneeTargetForActor(previous.assignee, currentUser);
      if (!assigneeTarget || previousAssigneeTarget) {
        pushUndo(
          message ?? `${task.identifier} 已更新。`,
          () => restoreTaskDetails(previous, updated, previousAssigneeTarget),
        );
      }
      return updated;
    } catch (error) {
      setTasks((current) => sortTasks(current.map((candidate) =>
        candidate.id === previous.id ? previous : candidate,
      )));
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function mutateTaskRelation(
    action: "add" | "remove",
    task: Task,
    type: IssueRelationType,
    relatedTaskId: string,
  ) {
    setActionError(null);
    try {
      const result = action === "add"
        ? await addTaskRelation(task, type, relatedTaskId)
        : await removeTaskRelation(task, type, relatedTaskId);
      setTasks((current) => sortTasks(current.map((candidate) => {
        if (candidate.id === result.task.id) return result.task;
        if (candidate.id === result.relatedTask.id) return result.relatedTask;
        return candidate;
      })));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      return result;
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
      throw error;
    }
  }

  async function duplicateTask(task: Task) {
    setActionError(null);
    try {
      const duplicated = await createTaskRequest(task.projectId, {
        ...taskToDraft(task),
        assigneeTarget: assigneeTargetForActor(task.assignee, currentUser),
        developmentContext: null,
      });
      setTasks((current) => sortTasks([...current, duplicated]));
      pushUndo(`${duplicated.identifier} 副本已创建。`, async () => {
        const candidate = tasksRef.current.find((current) => current.id === duplicated.id);
        const current = candidate && candidate.version >= duplicated.version ? candidate : duplicated;
        await archiveTaskRequest(current);
        setTasks((tasks) => tasks.filter((item) => item.id !== duplicated.id));
      });
    } catch (error) {
      setActionError(errorMessage(error));
    }
  }

  async function archiveTask(task: Task) {
    setActionError(null);
    try {
      const archived = await archiveTaskRequest(task);
      setTasks((current) => current.filter((candidate) => candidate.id !== task.id));
      pushUndo(`${task.identifier} 已归档。`, async () => {
        const restored = await restoreTaskRequest(archived);
        setTasks((current) => sortTasks([
          ...current.filter((candidate) => candidate.id !== restored.id),
          restored,
        ]));
      });
    } catch (error) {
      setActionError(error instanceof ApiError && error.code === "VERSION_CONFLICT"
        ? "该议题已在其他位置更新，看板已重新同步。"
        : errorMessage(error));
      if (selectedProjectId) void refreshTasks(selectedProjectId, { quiet: true });
    }
  }

  async function copyText(text: string, message: string) {
    try {
      await navigator.clipboard.writeText(text);
      setAnnouncement(message);
    } catch {
      setActionError("无法写入剪贴板。");
    }
  }

  function openThread(threadId: string) {
    if (embedded && window.parent !== window) {
      window.parent.postMessage({ type: "taskboard:open-thread", payload: { threadId } }, "*");
      return;
    }

    window.location.assign(`codex://threads/${encodeURIComponent(threadId.trim())}`);
  }

  function expandCodexSidebar() {
    if (!embedded || window.parent === window) return;
    window.parent.postMessage({ type: "taskboard:expand-sidebar" }, "*");
  }

  function openTaskInThread(task: Task) {
    if (!manageTaskboardSkillPath) {
      setActionError("任务面板还没有读取到 manage-taskboard Skill 路径，请刷新后重试。");
      return;
    }
    const worktreePath = task.developmentContext?.type === "worktree"
      ? task.developmentContext.path
      : null;
    const workspacePath = worktreePath
      ?? selectedDeviceWorkspacePath
      ?? developmentScan.workspacePath
      ?? hostContext?.workspacePath;
    const instruction = `e-taskboard Addressing the issues mentioned in ${task.identifier}`;
    const prompt = `[$manage-taskboard](${manageTaskboardSkillPath}) ${instruction}`;

    if (!embedded || window.parent === window) {
      const query = new URLSearchParams();
      if (workspacePath) query.set("path", workspacePath);
      query.set("prompt", prompt);
      window.location.assign(`codex://new?${query.toString().replace(/\+/g, "%20")}`);
      return;
    }
    if (openingThreadTaskId) return;
    const codexProject = hostContext?.projects?.find((project) => project.id === selectedProject?.id);
    setOpeningThreadTaskId(task.id);
    setActionError(null);
    window.parent.postMessage({
      type: "taskboard:create-thread",
      payload: {
        taskId: task.id,
        identifier: task.identifier,
        instruction,
        skillName: "manage-taskboard",
        skillDisplayName: "Manage Taskboard",
        skillPath: manageTaskboardSkillPath,
        codexProjectId: codexProject?.id ?? (selectedProject?.id === "local" ? hostContext?.projectId : selectedProject?.id),
        projectName: selectedProject?.name,
        workspacePath,
        workspaceLabel: worktreePath ? workspaceName(worktreePath) : undefined,
      },
    }, "*");
  }

  function changeProject(projectId: string) {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setBoardView("issues");
    setSelectedProjectId(projectId);
    setOverviewProjectId("");
    setProjectHomeView("overview");
    window.localStorage.setItem(LAST_PROJECT_KEY, projectId);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, projectId, null);
    window.history.replaceState(null, "", url);
  }

  function returnToProjectHome() {
    closeContextMenu();
    setProjectMenuOpen(false);
    setDetailTaskIdentifier(null);
    setSelectedProjectId("");
    setOverviewProjectId("");
    setProjectHomeView("overview");
    window.localStorage.removeItem(LAST_PROJECT_KEY);
    setSearch("");
    setFilters(EMPTY_TASK_FILTERS);
    setActionError(null);
    undoStackRef.current = [];
    setUndoNotice(null);
    const url = buildIssueUrl(window.location.href, null, null);
    window.history.replaceState(null, "", url);
    void loadProjectList();
  }

  function toggleFavoriteProject() {
    if (!selectedProjectId) return;
    const shouldFavorite = !favoriteProjectIds.has(selectedProjectId);
    setFavoriteProjectIds((current) => {
      const next = new Set(current);
      if (shouldFavorite) next.add(selectedProjectId);
      else next.delete(selectedProjectId);
      window.localStorage.setItem(FAVORITE_PROJECTS_KEY, JSON.stringify([...next]));
      return next;
    });
    setAnnouncement(`${selectedProject?.name ?? "项目"}${shouldFavorite ? "已收藏。" : "已取消收藏。"}`);
  }

  async function selectProject(choice: ProjectChoice) {
    if (openingProjectId) return;
    setOpeningProjectId(choice.id);
    setActionError(null);
    try {
      let project = projects.find((candidate) => candidate.id === choice.id) ?? null;
      if (!project) {
        try {
          project = await createProjectRequest({
            id: choice.id,
            name: choice.name,
            workspacePath: choice.workspacePath ?? deviceWorkspacePaths[choice.id] ?? null,
          });
          setProjects((current) => [...current, project!]);
        } catch (error) {
          if (!(error instanceof ApiError) || error.code !== "PROJECT_EXISTS") throw error;
          const localProjects = await listProjects();
          project = localProjects.find((candidate) => candidate.id === choice.id) ?? null;
          if (project) {
            setProjects((current) => [
              ...current.filter((candidate) => candidate.id !== project!.id),
              project!,
            ]);
          }
          if (!project) throw error;
        }
      }
      changeProject(project.id);
    } catch (error) {
      setActionError(errorMessage(error));
    } finally {
      setOpeningProjectId(null);
    }
  }

  function openProjectMembers(choice: ProjectChoice) {
    setOverviewProjectId(choice.id);
    setProjectHomeView("members");
    setSelectedProjectId("");
    setActionError(null);
  }

  const contextName = workspaceName(hostContext?.workspacePath);
  const headerProjectName = selectedProject?.name ?? "任务面板";
  const appShellStyle = embedded
    ? { "--codex-titlebar-left-inset": `${hostContext?.titlebarLeftInset ?? 0}px` } as CSSProperties
    : undefined;

  return (
    <div className={`app-shell${embedded ? " embedded" : ""}${panelOnly ? " panel-only" : ""}`} style={appShellStyle}>
      {taskboardMetadata && taskboardMetadata.mode !== "cloud" && (
        <LocalRealtimeSync
          selectedProjectId={selectedProjectId}
          detailTaskId={detailTaskId}
          refreshProjectList={refreshProjectList}
          refreshTasks={refreshTasks}
          refreshWorkflowOptions={refreshWorkflowOptions}
          setConnection={setConnection}
          setCommentsRevision={setCommentsRevision}
          setAttachmentsRevision={setAttachmentsRevision}
        />
      )}
      {!embedded && !panelOnly && (
        <aside className="app-nav" aria-label="Taskboard navigation">
          <div className="brand-row">
            <span className="brand-mark" aria-hidden="true"><LinearIcon name="project" /></span>
            <span>CJ任务面板</span>
          </div>

          <nav className="primary-nav" aria-label="Views">
            <span className="nav-label">工作区</span>
            <button className="nav-item active" type="button" aria-current="page">
              <span className="nav-glyph" aria-hidden="true">
                <LinearIcon name="myIssues" />
              </span>
              议题
              <span className="nav-count">{tasks.length}</span>
            </button>
          </nav>

          <div className="overview-sidebar-nav" aria-label="项目总览导航">
            <span className="nav-label">总览</span>
            <button className={`nav-item${!selectedProjectId && projectHomeView === "overview" ? " active" : ""}`} type="button" onClick={() => { returnToProjectHome(); setProjectHomeView("overview"); }}>
              <span className="nav-glyph" aria-hidden="true"><LinearIcon name="home" /></span>
              项目总览
            </button>
            <button className={`nav-item${!selectedProjectId && projectHomeView === "mine" ? " active" : ""}`} type="button" onClick={() => { returnToProjectHome(); setProjectHomeView("mine"); }}>
              <span className="nav-glyph" aria-hidden="true"><LinearIcon name="myIssues" /></span>
              我的任务
            </button>
            <button className={`nav-item${!selectedProjectId && projectHomeView === "member-config" ? " active" : ""}`} type="button" onClick={() => { returnToProjectHome(); setProjectHomeView("member-config"); }}>
              <span className="nav-glyph" aria-hidden="true"><LinearIcon name="project" /></span>
              配置中心
            </button>
            <button className={`nav-item${!selectedProjectId && projectHomeView === "sync-log" ? " active" : ""}`} type="button" onClick={() => { returnToProjectHome(); setProjectHomeView("sync-log"); }}>
              <span className="nav-glyph" aria-hidden="true"><LinearIcon name="recurrence" /></span>
              同步日志
            </button>
          </div>

          <div className="overview-sidebar-nav" aria-label="公司项目进度导航">
            <span className="nav-label">看板</span>
            <button className={`nav-item${!selectedProjectId && projectHomeView === "database-progress" ? " active" : ""}`} type="button" onClick={() => { returnToProjectHome(); setProjectHomeView("database-progress"); }}>
              <span className="nav-glyph" aria-hidden="true"><LinearIcon name="project" /></span>
              公司项目进度
            </button>
          </div>

          <div className="overview-sidebar-nav" aria-label="团队项目导航">
            <span className="nav-label">团队</span>
            <button className={`nav-item${!selectedProjectId && projectHomeView === "team-board" ? " active" : ""}`} type="button" onClick={() => { returnToProjectHome(); setProjectHomeView("team-board"); }}>
              <span className="nav-glyph" aria-hidden="true"><LinearIcon name="project" /></span>
              团队看板
            </button>
          </div>

          <div className="project-nav">
            <span className="nav-label">项目</span>
            {projectChoices.filter((project) => project.inCodex).map((project) => (
              <button
                key={project.id}
                type="button"
                className={`project-nav-item${selectedProjectId === project.id ? " active" : ""}`}
                onClick={() => void selectProject(project)}
              >
                <span className="project-dot" aria-hidden="true" />
                <span>{project.name}</span>
              </button>
            ))}
          </div>

          <div className="nav-spacer" />
          <div className="nav-footer">
            <IdentityNavEntry />
            <div className={`connection connection-${connection}`}>
              <span aria-hidden="true" />
              {connection === "live" ? "实时同步" : "正在重新连接…"}
            </div>
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")}
              aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}
            >
              <span aria-hidden="true"><LinearIcon name={theme === "dark" ? "sun" : "moon"} /></span>
              {theme === "dark" ? "浅色模式" : "深色模式"}
            </button>
          </div>
        </aside>
      )}

      <main className="workspace">
        {!panelOnly && selectedProjectId ? (
          <header className="workspace-header">
          <div className="workspace-title">
            <div className="workspace-kicker">
              <button
                className="detail-back-button project-up-button"
                type="button"
                aria-label={detailTask ? "返回上一级：议题看板" : "返回上一级：项目首页"}
                title={detailTask ? "返回议题看板 (Esc)" : "返回项目首页"}
                onClick={detailTask ? closeTaskDetail : returnToProjectHome}
              >
                <LinearIcon name="chevronLeft" />
                <span>上一级</span>
              </button>
              {embedded && hostContext?.sidebarCollapsed && (
                <button
                  className="detail-back-button codex-sidebar-expand-button"
                  type="button"
                  aria-label="展开 Codex 侧边栏"
                  title="展开侧边栏"
                  onClick={expandCodexSidebar}
                >
                  <LinearIcon name="codexSidebarExpand" />
                </button>
              )}
              {selectedProjectId && <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>}
              {selectedProjectId ? (
                <div className="header-project-switcher" data-project-switcher>
                  <button
                    className="header-project-button"
                    type="button"
                    aria-label="切换项目"
                    aria-haspopup="menu"
                    aria-expanded={projectMenuOpen}
                    onClick={() => setProjectMenuOpen((current) => !current)}
                  >
                    <span className="project-avatar" aria-hidden="true">
                      {headerProjectName.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="project-name">{headerProjectName}</span>
                    <LinearIcon className="project-switcher-chevron" name="chevronDown" />
                  </button>
                  {projectMenuOpen && (
                    <div className="header-project-menu" role="menu" aria-label="项目">
                      <span>切换项目</span>
                      {projectChoices.map((project) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={project.id === selectedProjectId}
                          disabled={openingProjectId !== null}
                          key={project.id}
                          onClick={() => {
                            if (project.id === selectedProjectId) setProjectMenuOpen(false);
                            else void selectProject(project);
                          }}
                        >
                          <span className="project-avatar" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
                          <span>{project.name}</span>
                          {favoriteProjectIds.has(project.id) && <span className="project-menu-favorite" aria-label="已收藏"><LinearIcon name="favorite" /></span>}
                          {project.id === selectedProjectId && <span className="project-menu-check" aria-hidden="true"><LinearIcon name="check" /></span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <span className="project-avatar" aria-hidden="true">
                    {headerProjectName.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="project-name">{headerProjectName}</span>
                </>
              )}
              {!selectedProjectId && (
                <>
                  <span className="breadcrumb-chevron" aria-hidden="true"><LinearIcon name="chevronRight" /></span>
                  <strong>项目</strong>
                </>
              )}
              {!detailTask && selectedProjectId && (
                <button
                  className={`favorite-button${favoriteProjectIds.has(selectedProjectId) ? " active" : ""}`}
                  type="button"
                  aria-label={favoriteProjectIds.has(selectedProjectId) ? "取消收藏项目" : "收藏项目"}
                  aria-pressed={favoriteProjectIds.has(selectedProjectId)}
                  title={favoriteProjectIds.has(selectedProjectId) ? "取消收藏" : "收藏项目"}
                  onClick={toggleFavoriteProject}
                >
                  <LinearIcon className="favorite-icon" name="favorite" />
                </button>
              )}
              {!detailTask && selectedProjectId && embedded && contextName && <span className="codex-context">{contextName}</span>}
            </div>
          </div>

          <div ref={dragRegionRef} className="workspace-drag-region" aria-hidden="true" />

          <div className="header-actions">
            {selectedProjectId && (
              <ProjectAutomationMenu
                automation={selectedProjectAutomation}
                pending={automationPending}
                error={automationError}
                unavailableReason={automationProjectContext.unavailableReason}
                onOpen={() => void reconcileProjectAutomation()}
                onChange={(options) => void saveProjectAutomation(options)}
                onRunOnce={() => void runProjectAutomationOnce()}
              />
            )}
            {selectedProjectId && boardView === "issues" && (
              <button
                className="icon-button header-create-button"
                type="button"
                onClick={() => setEditor({ task: null, status: "backlog" })}
                aria-label="新建议题"
                title="新建议题 (C)"
              >
                <LinearIcon name="plus" />
              </button>
            )}
          </div>
          </header>
        ) : (
          <div ref={dragRegionRef} className="home-window-drag-region" aria-hidden="true" />
        )}

        {!panelOnly && selectedProjectId && !detailTask && <div className="board-toolbar">
          <div className="view-tabs" aria-label="看板视图">
            <button
              className={`view-tab${boardView === "issues" ? " active" : ""}`}
              type="button"
              aria-pressed={boardView === "issues"}
              onClick={() => selectBoardView("issues")}
            >
              议题看板
            </button>
            {SHOW_WORKFLOW_BOARD_ENTRY && (
              <button
                className={`view-tab${boardView === "workflow" ? " active" : ""}`}
                type="button"
                aria-pressed={boardView === "workflow"}
                onClick={() => selectBoardView("workflow")}
              >
                节点模式
              </button>
            )}
          </div>
          {boardView === "issues" && <div className="toolbar-tools">
            <label className={`search-field${search ? " has-value" : ""}`} title="搜索议题 (/)" >
              <LinearIcon className="search-icon" name="search" />
              <span className="sr-only">搜索议题</span>
              <input
                id="task-search"
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索议题…"
              />
              {!search && <kbd>/</kbd>}
            </label>
            <TaskFilterMenu
              tasks={tasks}
              search={search}
              labels={availableLabels}
              filters={filters}
              onChange={setFilters}
            />
            <BoardSettingsMenu
              showEmptyColumns={showEmptyColumns}
              onShowEmptyColumnsChange={updateShowEmptyColumns}
            />
            {(search || activeFilterCount > 0) && (
              <button
                className="clear-filter"
                type="button"
                aria-label="清除筛选"
                title="清除筛选"
                onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
              >
                <LinearIcon name="close" />
              </button>
            )}
          </div>}
        </div>}

        {(loadError || actionError) && (
          <div className="error-banner" role="alert">
            <span className="error-mark" aria-hidden="true"><LinearIcon name="alert" /></span>
            <div><strong>任务面板提示</strong><p>{actionError ?? loadError}</p></div>
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                if (selectedProjectId) void refreshTasks(selectedProjectId);
                else void loadProjectList();
              }}
            >
              重试
            </button>
          </div>
        )}

        {!selectedProjectId ? (
          <ProjectOverviewDemo
            projects={projectChoices}
            teamProjects={teamProjectChoices}
            loading={projectsLoading}
            deviceWorkspacePaths={deviceWorkspacePaths}
            onOpenProject={(project) => openProjectMembers(project)}
            onPreviewAction={setAnnouncement}
            role={workspaceRole}
            canManageMembers={canManageMembers}
            activeView={projectHomeView}
            onViewChange={setProjectHomeView}
            onSummarizeProject={(project) => summarizeProjectWork(project)}
            onRefreshProjects={refreshProjectList}
            currentUser={currentUser}
            deviceProjects={deviceProjects}
            overviewProjectId={overviewProjectId}
            standalonePanel={panelOnly}
            onOverviewProjectIdChange={setOverviewProjectId}
            onOpenTaskProject={(project) => void selectProject(project)}
          />
        ) : detailTask && selectedProject ? (
          <TaskDetail
            key={detailTask.id}
            task={detailTask}
            tasks={tasks}
            currentUser={currentUser}
            availableLabels={availableLabels}
            workflows={workflowOptions}
            developmentScan={developmentScan}
            developmentScanLoading={developmentScanLoading}
            commentsRevision={commentsRevision}
            attachmentsRevision={attachmentsRevision}
            onUpdate={(current, changes) => updateTaskProperties(current, changes)}
            onOpenTask={openTaskDetail}
            onAddRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("add", current, type, relatedTaskId)
            )}
            onRemoveRelation={(current, type, relatedTaskId) => (
              mutateTaskRelation("remove", current, type, relatedTaskId)
            )}
            onOpenThread={openThread}
            onOpenInThread={openTaskInThread}
            openingThread={openingThreadTaskId === detailTask.id}
            onError={setActionError}
            onAnnounce={setAnnouncement}
          />
        ) : boardView === "workflow" ? (
          <Suspense fallback={<div className="workflow-board-loading">正在打开节点模式…</div>}>
            <WorkflowBoard
              key={selectedProject?.id ?? "local"}
              projectId={selectedProject?.id ?? "local"}
              projectName={selectedProject?.name ?? "当前项目"}
              workspacePath={
                selectedDeviceWorkspacePath
                ?? developmentScan.workspacePath
                ?? hostContext?.workspacePath
              }
              revision={workflowRevision}
              onWorkflowsChange={setWorkflowOptions}
            />
          </Suspense>
        ) : tasksLoading && !hasLoadedTasks ? (
          <div className="loading-board" aria-label="Loading issues" aria-busy="true">
            {TASK_STATUSES.map((status) => (
              <div className="loading-column" key={status}>
                <span /><div /><div />
              </div>
            ))}
          </div>
        ) : (
          <div className="board-scroll" aria-label="Issue board">
            <div className="board">
              {filteredTasks.length === 0 && tasks.length > 0 && !showEmptyColumns && (
                <section className="page-empty filter-empty board-filter-empty">
                  <span className="empty-search" aria-hidden="true"><LinearIcon name="search" /></span>
                  <h2>没有匹配的议题</h2>
                  <p>请更换搜索词，或移除一个筛选条件。</p>
                  <button
                    className="button secondary"
                    type="button"
                    onClick={() => { setSearch(""); setFilters(EMPTY_TASK_FILTERS); }}
                  >
                    清除筛选
                  </button>
                </section>
              )}
              {visibleStatuses.map((status) => (
                <BoardColumn
                  key={status}
                  status={status}
                  statusIndex={TASK_STATUSES.indexOf(status)}
                  tasks={tasksByStatus[status]}
                  isDropTarget={dropTarget === status}
                  draggedTaskId={draggedTaskId}
                  draggedTaskHeight={draggedTaskHeight}
                  movingTaskId={movingTaskId}
                  settlingTaskId={settlingTaskId}
                  contextMenuTaskId={contextMenu?.taskId ?? null}
                  onCreate={(initialStatus) => setEditor({ task: null, status: initialStatus })}
                  onEdit={openTaskDetail}
                  onContextMenu={(task, position) => setContextMenu({ taskId: task.id, ...position })}
                  onMove={(task, destination) => void moveTask(task, destination)}
                  onDragStart={(task, height) => {
                    setDraggedTaskId(task.id);
                    setDraggedTaskHeight(height);
                    setDropTarget(task.status);
                  }}
                  onDragEnd={() => {
                    setDraggedTaskId(null);
                    setDraggedTaskHeight(0);
                    setDropTarget(null);
                  }}
                  onDragEnter={setDropTarget}
                  onDrop={finishTaskDrop}
                  onOpenThread={openThread}
                  onHide={(hiddenStatus) => updateColumnVisibility(hiddenStatus, false)}
                />
              ))}
              {hiddenStatuses.length > 0 && (
                <HiddenColumns
                  statuses={hiddenStatuses}
                  counts={Object.fromEntries(
                    TASK_STATUSES.map((status) => [status, tasksByStatus[status].length]),
                  ) as Record<TaskStatus, number>}
                  dropTarget={dropTarget}
                  onDragTargetChange={setDropTarget}
                  onDrop={(destination, taskId) => finishTaskDrop(destination, taskId)}
                  onShow={(shownStatus) => updateColumnVisibility(shownStatus, true)}
                />
              )}
            </div>
          </div>
        )}
      </main>

      {editor && (
        <TaskEditor
          key={editor.task?.id ?? `new-${editor.status}`}
          task={editor.task}
          initialStatus={editor.status}
          labels={availableLabels}
          workflows={workflowOptions}
          currentUser={currentUser}
          developmentScan={developmentScan}
          developmentScanLoading={developmentScanLoading}
          onCancel={() => setEditor(null)}
          onSave={saveEditor}
        />
      )}

      {contextMenu && contextMenuTask && (
        <TaskContextMenu
          task={contextMenuTask}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          labels={availableLabels}
          onClose={closeContextMenu}
          onEdit={openTaskDetail}
          onStatusChange={(task, status) => void moveTask(task, status)}
          onPriorityChange={(task, nextPriority) => void updateTaskProperties(
            task,
            { priority: nextPriority },
            `${task.identifier} 优先级已更新。`,
          ).catch(() => {})}
          onLabelsChange={(task, labels) => void updateTaskProperties(
            task,
            { labels },
            `${task.identifier} 标签已更新。`,
          ).catch(() => {})}
          onDuplicate={(task) => void duplicateTask(task)}
          onCopy={(text, message) => void copyText(text, message)}
          onOpenInThread={openTaskInThread}
          onArchive={(task) => void archiveTask(task)}
        />
      )}

      <AiChat
        available={localAiChatAvailable}
        projectId={selectedProjectId || null}
        projectOptions={projectChoices.filter((project) => project.inCodex).map((project) => ({ id: project.id, name: project.name }))}
        onProjectChange={changeProject}
        issueId={detailTaskId}
      />

      <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
      {undoNotice && (
        <div
          className="toast undo-toast"
          role="status"
          onAnimationEnd={() => setUndoNotice((current) => current?.id === undoNotice.id ? null : current)}
        >
          <span className="toast-check" aria-hidden="true"><LinearIcon name="check" /></span>
          <span className="undo-toast-message">{undoNotice.message}</span>
          <button type="button" onClick={() => void performUndo()}>
            撤回 <kbd>{undoShortcut}</kbd>
          </button>
        </div>
      )}
      {announcement && (
        <div className="toast" role="status" onAnimationEnd={() => setAnnouncementValue("")}>
          <span aria-hidden="true"><LinearIcon name="check" /></span>{announcement}
        </div>
      )}
      {draggedTaskId && <div className="drag-hint" aria-hidden="true">拖到目标位置后松开</div>}
    </div>
  );
}
