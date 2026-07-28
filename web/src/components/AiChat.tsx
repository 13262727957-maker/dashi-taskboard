import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent as ReactClipboardEvent,
  type ChangeEvent,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createAiChatThread,
  deleteAiChatThread,
  getAiChatCatalog,
  getAiChatThread,
  interruptAiChatRun,
  listAiChatThreads,
  startAiChatTurn,
  subscribeAiChatThread,
  updateAiChatThread,
} from "../api";
import {
  aiChatEventStatus,
  buildThreadCreateInput,
  buildTurnInput,
  chatPrimaryAction,
  createAiSnapshotRefreshQueue,
  filterVisibleAiEvents,
  insertSkillMention,
  needsDangerConfirmation,
  normalizeChatSelection,
  patchAiChatSnapshot,
  readSkillMention,
  settingsForNewAiThread,
} from "../aiChatState";
import type {
  AiChatCatalog,
  AiChatEvent,
  AiChatImageAttachmentInput,
  AiChatModel,
  AiChatRun,
  AiChatSandbox,
  AiChatSkill,
  AiChatThread,
  AiChatThreadSnapshot,
} from "../types";
import { LinearIcon } from "./LinearIcon";

interface AiChatProps {
  available: boolean;
  projectId: string | null;
  issueId: string | null;
}

type MenuName = "model" | "model-list" | "effort-list" | "sandbox" | null;
type PendingDangerInput = {
  message: string;
  skillIds: string[];
  attachments: AiChatImageAttachmentInput[];
  clearDraftOnSuccess: boolean;
};
type ComposerAttachment = AiChatImageAttachmentInput & {
  id: string;
  previewUrl: string;
};

const LAST_THREAD_KEY = "taskboard.aiChat.lastThreadId";
const IMAGE_ATTACHMENT_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

const SANDBOX_LABELS: Record<AiChatSandbox, string> = {
  "read-only": "请求批准",
  "workspace-write": "替我审批",
  "danger-full-access": "完全访问权限",
};

const SANDBOX_DESCRIPTIONS: Record<AiChatSandbox, string> = {
  "read-only": "编辑外部文件和使用互联网时始终询问",
  "workspace-write": "仅对检测到的风险操作请求批准",
  "danger-full-access": "不受限制地访问互联网和您电脑上的任何文件",
};

const SANDBOX_ICONS: Record<AiChatSandbox, "hand" | "terminal" | "shieldAlert"> = {
  "read-only": "hand",
  "workspace-write": "terminal",
  "danger-full-access": "shieldAlert",
};

const EFFORT_LABELS: Record<string, string> = {
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极高",
};

function modelDisplayName(value: string): string {
  return value.replace(/^GPT-/i, "").replaceAll("-", " ");
}

const ACTIVITY_LABELS: Record<string, string> = {
  plan: "执行计划",
  todo: "任务进度",
  todo_list: "任务进度",
  command: "运行命令",
  command_execution: "运行命令",
  file: "文件修改",
  file_change: "文件修改",
  mcp: "调用 MCP",
  mcp_tool_call: "调用 MCP",
  skill: "调用 Skill",
  web: "搜索资料",
  web_search: "搜索资料",
  error: "执行失败",
  "turn.failed": "执行失败",
};

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : "AI 对话暂时不可用";
}

function isAiChatSandbox(value: string): value is AiChatSandbox {
  return value === "read-only"
    || value === "workspace-write"
    || value === "danger-full-access";
}

function dateLabel(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function activityDetail(event: AiChatEvent): string | null {
  for (const key of ["output", "command", "detail", "path"]) {
    const value = event.data?.[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  const files = event.data?.files;
  if (Array.isArray(files)) {
    const visibleFiles = files.filter((value): value is string => typeof value === "string");
    if (visibleFiles.length > 0) return visibleFiles.join("\n");
  }
  return null;
}

function MarkdownMessage({ children }: { children: string }) {
  return (
    <div className="ai-chat-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ node: _node, ...props }) => <a {...props} target="_blank" rel="noreferrer" />,
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

function ActivityGroup({ events }: { events: AiChatEvent[] }) {
  const statuses = events.map(aiChatEventStatus);
  const status = statuses.includes("running")
    ? "running"
    : statuses.includes("failed") ? "failed" : "completed";
  return (
    <details className={`ai-chat-activity-group is-${status}`} open={status !== "completed"}>
      <summary>
        <span className="ai-chat-activity-status" aria-hidden="true">
          {status === "running"
            ? <span className="ai-chat-spinner" />
            : <LinearIcon name={status === "failed" ? "alert" : "check"} />}
        </span>
        <span className="ai-chat-activity-group-label">
          {status === "running" ? "处理中" : status === "failed" ? "处理失败" : "已处理"}
          <span> · {events.length} 项</span>
        </span>
        <LinearIcon className="ai-chat-activity-chevron" name="chevronDown" />
      </summary>
      <div className="ai-chat-activity-list">
        {events.map((event) => {
          const eventStatus = aiChatEventStatus(event);
          const detail = activityDetail(event);
          return (
            <div className={`ai-chat-activity-row is-${eventStatus}`} key={event.id}>
              <span className="ai-chat-activity-row-icon" aria-hidden="true">
                {eventStatus === "running"
                  ? <span className="ai-chat-spinner" />
                  : <LinearIcon name={eventStatus === "failed" ? "alert" : "check"} />}
              </span>
              <div>
                <div className="ai-chat-activity-row-heading">
                  <strong>{ACTIVITY_LABELS[event.type] ?? "执行活动"}</strong>
                  <span>{event.content}</span>
                </div>
                {detail && <pre><code>{detail}</code></pre>}
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

function EventAttachments({ event }: { event: AiChatEvent }) {
  const rawAttachments = event.data?.attachments;
  if (!Array.isArray(rawAttachments)) return null;
  const attachments = rawAttachments.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const attachment = value as Record<string, unknown>;
    if (
      typeof attachment.filename !== "string"
      || typeof attachment.contentType !== "string"
      || typeof attachment.size !== "number"
    ) return [];
    return [{
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
    }];
  });
  if (attachments.length === 0) return null;
  return (
    <div className="ai-chat-event-attachments">
      {attachments.map((attachment, index) => (
        <span key={`${attachment.filename}-${index}`}>
          <LinearIcon name="attachment" />
          <span>{attachment.filename}</span>
        </span>
      ))}
    </div>
  );
}

function MessageTimeline({ events }: { events: AiChatEvent[] }) {
  const timeline = filterVisibleAiEvents(events).reduce<Array<AiChatEvent | AiChatEvent[]>>(
    (items, event) => {
      const isMessage = event.role === "user"
        || event.type === "user"
        || event.type === "user_message"
        || event.role === "assistant"
        || event.type === "assistant"
        || event.type === "agent_message";
      if (isMessage) {
        items.push(event);
        return items;
      }
      const previous = items[items.length - 1];
      if (Array.isArray(previous)) previous.push(event);
      else items.push([event]);
      return items;
    },
    [],
  );
  return (
    <>
      {timeline.map((entry) => {
        if (Array.isArray(entry)) {
          return (
            <ActivityGroup
              events={entry}
              key={`activity-${entry[0]?.id ?? "empty"}`}
            />
          );
        }
        const event = entry;
        if (event.role === "user" || event.type === "user" || event.type === "user_message") {
          return (
            <article className="ai-chat-user-message" key={event.id}>
              <MarkdownMessage>{event.content}</MarkdownMessage>
              <EventAttachments event={event} />
            </article>
          );
        }
        if (event.role === "assistant" || event.type === "assistant" || event.type === "agent_message") {
          return (
            <article className="ai-chat-assistant-message" key={event.id}>
              <MarkdownMessage>{event.content}</MarkdownMessage>
            </article>
          );
        }
        return null;
      })}
    </>
  );
}

function OptionMenu({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="ai-chat-option-menu" role="menu" aria-label={label}>
      {children}
    </div>
  );
}

export function AiChat({ available, projectId, issueId }: AiChatProps) {
  const [panelOpen, setPanelOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [menu, setMenu] = useState<MenuName>(null);
  const [threads, setThreads] = useState<AiChatThread[]>([]);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(
    () => window.localStorage.getItem(LAST_THREAD_KEY),
  );
  const [snapshot, setSnapshot] = useState<AiChatThreadSnapshot | null>(null);
  const [catalog, setCatalog] = useState<AiChatCatalog | null>(null);
  const [catalogLoadedProjectId, setCatalogLoadedProjectId] = useState<string | null>(null);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [skillMention, setSkillMention] = useState<ReturnType<typeof readSkillMention>>(null);
  const [pendingDangerInput, setPendingDangerInput] = useState<PendingDangerInput | null>(null);
  const [unread, setUnread] = useState(false);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState("");
  const [draftSandbox, setDraftSandbox] = useState<AiChatSandbox>("workspace-write");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [deletingThreadId, setDeletingThreadId] = useState<string | null>(null);
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const selectedThreadRef = useRef(selectedThreadId);
  const panelOpenRef = useRef(panelOpen);
  const snapshotRequestRef = useRef(0);
  const snapshotLoadingRequestRef = useRef(0);
  const observedRunStatusesRef = useRef(new Map<string, AiChatRun["status"]>());
  const dangerConfirmOpen = pendingDangerInput !== null;

  const selectThread = useCallback((threadId: string | null) => {
    selectedThreadRef.current = threadId;
    setSelectedThreadId(threadId);
  }, []);

  useEffect(() => {
    selectedThreadRef.current = selectedThreadId;
    if (selectedThreadId) window.localStorage.setItem(LAST_THREAD_KEY, selectedThreadId);
    else window.localStorage.removeItem(LAST_THREAD_KEY);
  }, [selectedThreadId]);

  useEffect(() => {
    panelOpenRef.current = panelOpen;
    if (panelOpen) setUnread(false);
  }, [panelOpen]);

  const replaceThread = useCallback((thread: AiChatThread) => {
    setThreads((current) => {
      const next = current.filter((candidate) => candidate.id !== thread.id);
      return [thread, ...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }, []);

  const observeRunTransitions = useCallback((runs: AiChatRun[]) => {
    let completedWhileClosed = false;
    for (const run of runs) {
      const previous = observedRunStatusesRef.current.get(run.id);
      observedRunStatusesRef.current.set(run.id, run.status);
      if (
        previous === "running"
        && run.status !== "running"
        && !panelOpenRef.current
      ) completedWhileClosed = true;
    }
    if (completedWhileClosed) setUnread(true);
  }, []);

  const loadSnapshot = useCallback(async (threadId: string, quiet = false) => {
    const requestId = ++snapshotRequestRef.current;
    if (!quiet) {
      snapshotLoadingRequestRef.current = requestId;
      setLoading(true);
    }
    try {
      const next = await getAiChatThread(threadId);
      if (requestId !== snapshotRequestRef.current || selectedThreadRef.current !== threadId) return;
      setSnapshot(next);
      replaceThread(next.thread);
      observeRunTransitions(next.runs);
      if (!quiet) setError(null);
    } catch (nextError) {
      if (
        !quiet
        && requestId === snapshotRequestRef.current
        && selectedThreadRef.current === threadId
      ) setError(messageFor(nextError));
    } finally {
      if (!quiet && requestId === snapshotLoadingRequestRef.current) setLoading(false);
    }
  }, [observeRunTransitions, replaceThread]);

  const selectedHintRefreshQueue = useMemo(
    () => createAiSnapshotRefreshQueue((threadId) => loadSnapshot(threadId, true)),
    [loadSnapshot],
  );
  useEffect(() => () => selectedHintRefreshQueue.clear(), [selectedHintRefreshQueue]);

  const loadThreads = useCallback(async () => {
    try {
      const next = await listAiChatThreads();
      setThreads(next);
      setSelectedThreadId((current) => {
        const selected = current && next.some((thread) => thread.id === current)
          ? current
          : next[0]?.id ?? null;
        selectedThreadRef.current = selected;
        return selected;
      });
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }, []);

  useEffect(() => {
    if (!available) {
      setPanelOpen(false);
      return;
    }
    void loadThreads();
  }, [available, loadThreads]);

  useEffect(() => {
    setSnapshot(null);
    if (!selectedThreadId) return;
    let initialPending = true;
    let refreshQueued = false;
    let disposed = false;
    void loadSnapshot(selectedThreadId).finally(() => {
      initialPending = false;
      if (refreshQueued && !disposed) {
        void selectedHintRefreshQueue.request(selectedThreadId);
      }
    });
    const unsubscribe = subscribeAiChatThread(
      selectedThreadId,
      () => {
        if (initialPending) refreshQueued = true;
        else void selectedHintRefreshQueue.request(selectedThreadId);
      },
    );
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [loadSnapshot, selectedHintRefreshQueue, selectedThreadId]);

  const backgroundRunningThreadIds = threads
    .filter((thread) => thread.status === "running" && thread.id !== selectedThreadId)
    .map((thread) => thread.id);
  useEffect(() => {
    if (!available || backgroundRunningThreadIds.length === 0) return;
    const refresh = async (threadId: string) => {
      try {
        const next = await getAiChatThread(threadId);
        replaceThread(next.thread);
        observeRunTransitions(next.runs);
      } catch {
        // The selected thread surfaces request errors; background history refresh stays quiet.
      }
    };
    const refreshQueue = createAiSnapshotRefreshQueue(refresh);
    const unsubscribers = backgroundRunningThreadIds.map((threadId) => (
      subscribeAiChatThread(threadId, () => void refreshQueue.request(threadId))
    ));
    return () => {
      refreshQueue.clear();
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [
    available,
    backgroundRunningThreadIds.join(","),
    observeRunTransitions,
    replaceThread,
    selectedThreadId,
  ]);

  const catalogProjectId = snapshot?.thread.origin.projectId ?? projectId;
  const activeCatalog = catalogLoadedProjectId === catalogProjectId ? catalog : null;
  useEffect(() => {
    if (!available || !catalogProjectId) {
      setCatalog(null);
      setCatalogLoadedProjectId(null);
      setCatalogError(null);
      return;
    }
    const controller = new AbortController();
    setCatalog(null);
    setCatalogLoadedProjectId(null);
    setCatalogError(null);
    void getAiChatCatalog(catalogProjectId, controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        setCatalog(next);
        setCatalogLoadedProjectId(catalogProjectId);
        setCatalogError(null);
      },
      (nextError) => {
        if (controller.signal.aborted) return;
        if ((nextError as Error).name !== "AbortError") {
          setCatalog(null);
          setCatalogLoadedProjectId(null);
          setCatalogError(messageFor(nextError));
        }
      },
    );
    return () => controller.abort();
  }, [available, catalogProjectId]);

  const restoreDraftSettings = useCallback((thread: AiChatThread) => {
    setDraftModel(thread.model);
    setDraftEffort(thread.reasoningEffort);
    setDraftSandbox(thread.sandbox);
  }, []);

  useEffect(() => {
    const thread = snapshot?.thread;
    if (thread) {
      restoreDraftSettings(thread);
      return;
    }
    const normalized = normalizeChatSelection(activeCatalog?.models ?? [], draftModel, draftEffort);
    if (normalized) {
      setDraftModel(normalized.model);
      setDraftEffort(normalized.reasoningEffort);
    }
    const defaultSandbox = activeCatalog?.sandboxes.find(
      (sandbox): sandbox is AiChatSandbox => sandbox === "workspace-write",
    ) ?? activeCatalog?.sandboxes.find(isAiChatSandbox);
    if (defaultSandbox) setDraftSandbox(defaultSandbox);
  }, [activeCatalog, restoreDraftSettings, snapshot?.thread.id]);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "0px";
    textarea.style.height = `${Math.min(240, Math.max(42, textarea.scrollHeight))}px`;
  }, [draft]);

  useEffect(() => {
    const container = messagesRef.current;
    if (!container || !panelOpen) return;
    container.scrollTop = container.scrollHeight;
  }, [panelOpen, snapshot?.events.length, snapshot?.thread.status]);

  useEffect(() => {
    if (!panelOpen) return;
    function closeWithEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      if (typeof event.stopImmediatePropagation === "function") event.stopImmediatePropagation();
      if (dangerConfirmOpen) setPendingDangerInput(null);
      else if (skillMention) setSkillMention(null);
      else if (menu) setMenu(null);
      else if (historyOpen) setHistoryOpen(false);
      else setPanelOpen(false);
    }
    document.addEventListener("keydown", closeWithEscape, true);
    return () => document.removeEventListener("keydown", closeWithEscape, true);
  }, [dangerConfirmOpen, historyOpen, menu, panelOpen, skillMention]);

  const visibleSkills = useMemo(
    () => (activeCatalog?.skills ?? []).filter((skill) => (
      skill.id !== "manage-taskboard"
      && !skill.id.endsWith(":manage-taskboard")
      && (
        !skillMention?.query
        || skill.label.toLocaleLowerCase().includes(skillMention.query)
        || skill.id.toLocaleLowerCase().includes(skillMention.query)
        || skill.description.toLocaleLowerCase().includes(skillMention.query)
        || skill.path.toLocaleLowerCase().includes(skillMention.query)
      )
    )),
    [activeCatalog?.skills, skillMention?.query],
  );

  const selectedModel = activeCatalog?.models.find((model) => model.slug === draftModel) ?? null;
  const availableSandboxes = (activeCatalog?.sandboxes ?? []).filter(isAiChatSandbox);
  const currentRun = snapshot?.thread.currentRun
    ?? snapshot?.runs.find((run) => run.status === "running")
    ?? null;
  const composerBlocked = loading
    || settingsSaving
    || deletingThreadId === selectedThreadId
    || Boolean(selectedThreadId && !snapshot);
  const attachmentBlocked = composerBlocked || snapshot?.thread.status === "running";
  const primaryAction = chatPrimaryAction(
    snapshot?.thread.status ?? "idle",
    draft,
    composerBlocked,
    attachments.length > 0,
  );
  const anyRunning = threads.some((thread) => thread.status === "running");
  const anyFailed = threads.some((thread) => thread.status === "failed");
  const launcherState = anyRunning ? "running" : anyFailed ? "failed" : unread ? "unread" : "idle";

  useEffect(() => {
    if (attachmentBlocked) setAttachmentDragActive(false);
  }, [attachmentBlocked]);

  async function createThreadForCurrentOrigin(): Promise<AiChatThread | null> {
    const input = buildThreadCreateInput(projectId ?? "", issueId);
    if (!input) {
      setError("请先进入一个已映射的项目，再新建对话");
      return null;
    }
    setLoading(true);
    try {
      const settings = settingsForNewAiThread(
        input.projectId,
        activeCatalog ? catalogLoadedProjectId : null,
        {
          model: draftModel,
          reasoningEffort: draftEffort,
          sandbox: draftSandbox,
        },
      );
      const thread = await createAiChatThread({
        ...input,
        ...settings,
      });
      replaceThread(thread);
      selectThread(thread.id);
      setSnapshot({ thread, events: [], runs: [] });
      setHistoryOpen(false);
      setError(null);
      return thread;
    } catch (nextError) {
      setError(messageFor(nextError));
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function deleteThread(thread: AiChatThread) {
    if (!window.confirm(`删除本地对话“${thread.title}”？`)) return;
    setDeletingThreadId(thread.id);
    try {
      await deleteAiChatThread(thread.id);
      const remainingThreads = threads.filter((candidate) => candidate.id !== thread.id);
      setThreads(remainingThreads);
      if (selectedThreadRef.current === thread.id) {
        setSnapshot(null);
        selectThread(remainingThreads[0]?.id ?? null);
      }
      setError(null);
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setDeletingThreadId(null);
    }
  }

  async function saveThreadSettings(changes: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  }) {
    const previousThread = snapshot?.thread;
    if (!previousThread) return;
    const threadId = previousThread.id;
    setSettingsSaving(true);
    try {
      const thread = await updateAiChatThread(threadId, changes);
      setSnapshot((current) => patchAiChatSnapshot(current, threadId, thread));
      replaceThread(thread);
      if (selectedThreadRef.current === threadId) setError(null);
    } catch (nextError) {
      if (selectedThreadRef.current === threadId) {
        restoreDraftSettings(previousThread);
        setError(messageFor(nextError));
      }
    } finally {
      setSettingsSaving(false);
    }
  }

  async function chooseModel(model: AiChatModel) {
    setMenu(null);
    setDraftModel(model.slug);
    setDraftEffort(model.defaultReasoningEffort);
    await saveThreadSettings({
      model: model.slug,
      reasoningEffort: model.defaultReasoningEffort,
    });
  }

  async function chooseEffort(reasoningEffort: string) {
    setMenu(null);
    setDraftEffort(reasoningEffort);
    await saveThreadSettings({ reasoningEffort });
  }

  async function chooseSandbox(sandbox: AiChatSandbox) {
    setMenu(null);
    setDraftSandbox(sandbox);
    await saveThreadSettings({ sandbox });
  }

  function selectSkill(skill: AiChatSkill) {
    if (!skillMention) return;
    const next = insertSkillMention(
      draft,
      skillMention.start,
      skillMention.end,
      skill,
    );
    setDraft(next.value);
    setSkillIds((current) => [...new Set([...current, next.skillId])]);
    setSkillMention(null);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(next.caret, next.caret);
    });
  }

  function realSkillIdsForMessage(message: string): string[] {
    const visible = (activeCatalog?.skills ?? []).filter((skill) => (
      skill.id !== "manage-taskboard"
      && !skill.id.endsWith(":manage-taskboard")
      && message.includes(`@${skill.label}`)
    )).map((skill) => skill.id);
    return [...new Set([...skillIds, ...visible])].filter((id) => (
      (activeCatalog?.skills ?? []).some((skill) => skill.id === id && message.includes(`@${skill.label}`))
    ));
  }

  async function startMessage(
    message: string,
    dangerConfirmed: boolean,
    boundSkillIds?: string[],
    clearDraftOnSuccess = true,
    boundAttachments?: AiChatImageAttachmentInput[],
  ) {
    if (composerBlocked) return;
    const trimmed = message.trim();
    const messageAttachments = boundAttachments ?? attachments.map((attachment) => ({
      filename: attachment.filename,
      contentType: attachment.contentType,
      dataBase64: attachment.dataBase64,
    }));
    if (!trimmed && messageAttachments.length === 0) return;
    let thread = snapshot?.thread ?? null;
    if (!thread) thread = await createThreadForCurrentOrigin();
    if (!thread) return;
    const messageSkillIds = boundSkillIds ?? (
      catalogLoadedProjectId === thread.origin.projectId ? realSkillIdsForMessage(trimmed) : []
    );
    if (needsDangerConfirmation(thread.sandbox, dangerConfirmed)) {
      setPendingDangerInput({
        message: trimmed,
        skillIds: messageSkillIds,
        attachments: messageAttachments,
        clearDraftOnSuccess,
      });
      return;
    }
    setPendingDangerInput(null);
    setError(null);
    try {
      const run = await startAiChatTurn(
        thread.id,
        buildTurnInput(trimmed, messageSkillIds, dangerConfirmed, messageAttachments),
      );
      if (clearDraftOnSuccess) {
        setDraft("");
        setAttachments([]);
        setSkillIds([]);
        setSkillMention(null);
      }
      observedRunStatusesRef.current.set(run.id, run.status);
      setSnapshot((current) => current?.thread.id === thread.id ? {
          ...current,
          thread: { ...current.thread, status: "running", currentRun: run },
          runs: [run, ...current.runs.filter((candidate) => candidate.id !== run.id)],
        } : current);
      replaceThread({ ...thread, status: "running", currentRun: run });
      if (selectedThreadRef.current === thread.id) {
        void selectedHintRefreshQueue.request(thread.id);
      }
    } catch (nextError) {
      if (selectedThreadRef.current === thread.id) setError(messageFor(nextError));
      if (selectedThreadRef.current === thread.id) {
        void selectedHintRefreshQueue.request(thread.id);
      }
    }
  }

  function imageFiles(files: FileList | File[]): File[] {
    return Array.from(files).filter((file) => IMAGE_ATTACHMENT_TYPES.has(file.type));
  }

  async function addImageAttachments(files: File[]) {
    if (attachmentBlocked) return;
    const acceptedFiles = imageFiles(files);
    if (acceptedFiles.length === 0) return;
    try {
      const nextAttachments = await Promise.all(acceptedFiles.map((file, index) => (
        new Promise<ComposerAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => {
            if (typeof reader.result !== "string") {
              reject(new Error(`无法读取附件 ${file.name}`));
              return;
            }
            const separator = reader.result.indexOf(",");
            resolve({
              id: `${file.name}-${file.size}-${file.lastModified}-${Date.now()}-${index}`,
              filename: file.name,
              contentType: file.type,
              dataBase64: reader.result.slice(separator + 1),
              previewUrl: reader.result,
            });
          };
          reader.onerror = () => reject(new Error(`无法读取附件 ${file.name}`));
          reader.readAsDataURL(file);
        })
      )));
      setAttachments((current) => [...current, ...nextAttachments]);
      setError(null);
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }

  async function handleAttachmentSelection(event: ChangeEvent<HTMLInputElement>) {
    const files = imageFiles(event.target.files ?? []);
    event.target.value = "";
    await addImageAttachments(files);
  }

  function hasDraggedImage(event: ReactDragEvent<HTMLDivElement>): boolean {
    return Array.from(event.dataTransfer.items).some((item) => (
      item.kind === "file" && IMAGE_ATTACHMENT_TYPES.has(item.type)
    )) || imageFiles(event.dataTransfer.files).length > 0;
  }

  function handleAttachmentDragEnter(event: ReactDragEvent<HTMLDivElement>) {
    if (!hasDraggedImage(event)) return;
    event.preventDefault();
    if (attachmentBlocked) return;
    setAttachmentDragActive(true);
  }

  function handleAttachmentDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (!attachmentDragActive && !hasDraggedImage(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = attachmentBlocked ? "none" : "copy";
  }

  function handleAttachmentDragLeave(event: ReactDragEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setAttachmentDragActive(false);
  }

  function handleAttachmentDrop(event: ReactDragEvent<HTMLDivElement>) {
    setAttachmentDragActive(false);
    const files = imageFiles(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    if (attachmentBlocked) return;
    void addImageAttachments(files);
  }

  function handleAttachmentPaste(event: ReactClipboardEvent<HTMLTextAreaElement>) {
    if (attachmentBlocked) return;
    const files = imageFiles(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    void addImageAttachments(files);
  }

  async function stopRun(run: AiChatRun | null) {
    if (!run) return;
    try {
      await interruptAiChatRun(run.id);
      if (selectedThreadRef.current === run.threadId) {
        void selectedHintRefreshQueue.request(run.threadId);
      }
    } catch (nextError) {
      if (selectedThreadRef.current === run.threadId) setError(messageFor(nextError));
    }
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (composerBlocked) return;
    if (event.key === "Enter" && skillMention && visibleSkills[0]) {
      event.preventDefault();
      selectSkill(visibleSkills[0]);
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (primaryAction === "stop") void stopRun(currentRun);
      else if (primaryAction === "send") void startMessage(draft, false);
    }
  }

  if (!available) return null;

  return (
    <div
      className={`ai-chat-root is-${launcherState}`}
      onPointerDown={(event) => {
        if (!(event.target as HTMLElement).closest(".ai-chat-menu-wrap")) setMenu(null);
      }}
    >
      {panelOpen && (
        <section className="ai-chat-panel" aria-label="Codex AI 对话" data-screen-label="Codex AI 对话">
          <header className="ai-chat-panel-header">
            <div className="ai-chat-panel-title">
              <strong>{snapshot?.thread.title ?? "新对话"}</strong>
              <span>{snapshot?.thread.origin.projectName ?? "选择对话或从当前项目新建"}</span>
            </div>
            <button
              type="button"
              aria-label="对话历史"
              aria-pressed={historyOpen}
              title="对话历史"
              onClick={() => { setHistoryOpen((current) => !current); setMenu(null); }}
            >
              <LinearIcon name="conversation" />
            </button>
            <button
              type="button"
              aria-label="新建对话"
              title={projectId ? "新建对话" : "请先进入项目"}
              disabled={!projectId || loading}
              onClick={() => void createThreadForCurrentOrigin()}
            >
              <LinearIcon name="plus" />
            </button>
            <button
              type="button"
              aria-label="关闭 AI 对话"
              title="关闭"
              onClick={() => setPanelOpen(false)}
            >
              <LinearIcon name="close" />
            </button>
          </header>

          {historyOpen && (
            <div className="ai-chat-history" aria-label="对话历史">
              <div className="ai-chat-history-heading">
                <strong>对话历史</strong>
                <span>{threads.length}</span>
              </div>
              {threads.length > 0 ? threads.map((thread) => (
                <div
                  className={`ai-chat-history-row${thread.id === selectedThreadId ? " is-active" : ""}`}
                  key={thread.id}
                >
                  <button
                    type="button"
                    onClick={() => {
                      selectThread(thread.id);
                      setHistoryOpen(false);
                    }}
                  >
                    <span className={`ai-chat-thread-status is-${thread.status}`} aria-hidden="true" />
                    <span>
                      <strong>{thread.title}</strong>
                      <small>{thread.origin.projectName} · {dateLabel(thread.updatedAt)}</small>
                    </span>
                  </button>
                  <button
                    className="ai-chat-history-delete"
                    type="button"
                    aria-label={`删除对话 ${thread.title}`}
                    title="删除本地记录"
                    disabled={thread.status === "running" || deletingThreadId === thread.id}
                    onClick={() => void deleteThread(thread)}
                  >
                    <LinearIcon name="trash" />
                  </button>
                </div>
              )) : (
                <p>还没有本地对话</p>
              )}
            </div>
          )}

          <div
            className="ai-chat-messages"
            ref={messagesRef}
            aria-busy={loading}
            aria-live="polite"
          >
            {loading && !snapshot ? (
              <div className="ai-chat-empty"><span className="ai-chat-spinner" />正在恢复对话…</div>
            ) : snapshot ? (
              <>
                <MessageTimeline events={snapshot.events} />
                {snapshot.thread.status === "running" && (
                  <div className="ai-chat-running" role="status">
                    <span className="ai-chat-spinner" />
                    Codex 正在处理
                  </div>
                )}
                {snapshot.thread.status === "failed" && (
                  <button
                    className="ai-chat-retry"
                    type="button"
                    onClick={() => {
                      const lastUserEvent = [...snapshot.events].reverse().find((event) => (
                        event.role === "user"
                        || event.type === "user"
                        || event.type === "user_message"
                      ));
                      if (lastUserEvent) {
                        void startMessage(lastUserEvent.content, false, undefined, false, []);
                      }
                    }}
                  >
                    <LinearIcon name="recurrence" />
                    重试上一条消息
                  </button>
                )}
              </>
            ) : (
              <div className="ai-chat-empty">
                <LinearIcon name="conversation" />
                <strong>{projectId ? "在当前项目中开始对话" : "打开一个历史对话"}</strong>
                <p>{projectId
                  ? "Codex 会在新对话创建时记住当前项目。"
                  : "进入项目后可以新建对话。"}</p>
              </div>
            )}
          </div>

          {(error || catalogError) && (
            <div className="ai-chat-error" role="alert">
              <LinearIcon name="alert" />
              <span>{error ?? catalogError}</span>
            </div>
          )}

          <div
            className={`ai-chat-composer${attachmentDragActive ? " is-attachment-drag-active" : ""}`}
            onDragEnter={handleAttachmentDragEnter}
            onDragOver={handleAttachmentDragOver}
            onDragLeave={handleAttachmentDragLeave}
            onDrop={handleAttachmentDrop}
          >
            {attachmentDragActive && (
              <div className="ai-chat-attachment-drop-hint" aria-hidden="true">
                松开添加图片
              </div>
            )}
            <div className="ai-chat-input-wrap">
              {attachments.length > 0 && (
                <div className="ai-chat-composer-attachments">
                  {attachments.map((attachment) => (
                    <div className="ai-chat-composer-attachment" key={attachment.id}>
                      <img src={attachment.previewUrl} alt="" />
                      <button
                        type="button"
                        aria-label={`移除附件 ${attachment.filename}`}
                        title="移除附件"
                        onClick={() => {
                          setAttachments((current) => current.filter((item) => item.id !== attachment.id));
                        }}
                      >
                        <LinearIcon name="close" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={draft}
                rows={1}
                placeholder="询问 Codex"
                aria-label="发送给 Codex 的消息"
                disabled={
                  composerBlocked
                  || snapshot?.thread.status === "running"
                }
                onChange={(event) => {
                  const next = event.target.value;
                  const caret = event.target.selectionStart ?? next.length;
                  setDraft(next);
                  setSkillMention(readSkillMention(next, caret));
                }}
                onClick={(event) => {
                  const target = event.currentTarget;
                  setSkillMention(readSkillMention(target.value, target.selectionStart ?? target.value.length));
                }}
                onKeyDown={handleComposerKeyDown}
                onPaste={handleAttachmentPaste}
              />
              {skillMention && visibleSkills.length > 0 && (
                <div className="ai-chat-skill-menu" role="listbox" aria-label="可用 Skill">
                  {visibleSkills.map((skill, index) => (
                    <button
                      className={index === 0 ? "is-selected" : undefined}
                      type="button"
                      role="option"
                      aria-selected={index === 0}
                      key={skill.id}
                      title={skill.path}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => selectSkill(skill)}
                    >
                      <LinearIcon name="project" />
                      <span>
                        <strong>{skill.label}</strong>
                        {skill.description && <small>{skill.description}</small>}
                      </span>
                      <em>{skill.scope}</em>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="ai-chat-composer-toolbar">
              <input
                ref={attachmentInputRef}
                className="ai-chat-attachment-input"
                type="file"
                accept="image/png,image/jpeg,image/webp,image/gif"
                multiple
                tabIndex={-1}
                onChange={(event) => void handleAttachmentSelection(event)}
              />
              <button
                className="ai-chat-attachment-button"
                type="button"
                aria-label="添加图片附件"
                title="添加图片"
                disabled={attachmentBlocked}
                onClick={() => attachmentInputRef.current?.click()}
              >
                <LinearIcon name="plus" />
              </button>
              <div className="ai-chat-menu-wrap ai-chat-permission-menu-wrap">
                <button
                  className="ai-chat-permission-trigger"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "sandbox"}
                  disabled={!activeCatalog || snapshot?.thread.status === "running" || settingsSaving}
                  onClick={() => setMenu((current) => current === "sandbox" ? null : "sandbox")}
                >
                  <LinearIcon name={SANDBOX_ICONS[draftSandbox]} />
                  {SANDBOX_LABELS[draftSandbox]}
                  <LinearIcon name="chevronDown" />
                </button>
                {menu === "sandbox" && (
                  <div className="ai-chat-option-menu ai-chat-permission-menu" role="menu" aria-label="执行权限">
                    <header>
                      <span>应如何批准 Codex 操作？</span>
                      <a
                        href="https://developers.openai.com/codex/security"
                        target="_blank"
                        rel="noreferrer"
                      >
                        了解更多
                      </a>
                    </header>
                    {availableSandboxes.map((sandbox) => (
                      <button
                        className={sandbox === "danger-full-access" ? "is-danger" : undefined}
                        type="button"
                        role="menuitemradio"
                        aria-checked={sandbox === draftSandbox}
                        key={sandbox}
                        onClick={() => void chooseSandbox(sandbox)}
                      >
                        <LinearIcon name={SANDBOX_ICONS[sandbox]} />
                        <span>
                          <strong>{SANDBOX_LABELS[sandbox]}</strong>
                          <small>{SANDBOX_DESCRIPTIONS[sandbox]}</small>
                        </span>
                        {sandbox === draftSandbox && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <span className="ai-chat-toolbar-spacer" />
              <div className="ai-chat-menu-wrap ai-chat-model-menu-wrap">
                <button
                  className="ai-chat-model-trigger"
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "model" || menu === "model-list" || menu === "effort-list"}
                  disabled={!activeCatalog || snapshot?.thread.status === "running" || settingsSaving}
                  onClick={() => setMenu((current) => (
                    current === "model" || current === "model-list" || current === "effort-list"
                      ? null
                      : "model"
                  ))}
                >
                  <span>{modelDisplayName(selectedModel?.displayName ?? (draftModel || "模型"))}</span>
                  <span className="ai-chat-model-effort">
                    {EFFORT_LABELS[draftEffort] ?? (draftEffort || "推理")}
                  </span>
                  <LinearIcon name="chevronDown" />
                </button>
                {menu === "model" && (
                  <div className="ai-chat-option-menu ai-chat-config-menu" role="menu" aria-label="模型与推理强度">
                    <button type="button" onClick={() => setMenu("model-list")}>
                      <span>模型</span>
                      <strong>{modelDisplayName(selectedModel?.displayName ?? draftModel)}</strong>
                      <LinearIcon name="chevronRight" />
                    </button>
                    <button type="button" onClick={() => setMenu("effort-list")}>
                      <span>推理强度</span>
                      <strong>{EFFORT_LABELS[draftEffort] ?? draftEffort}</strong>
                      <LinearIcon name="chevronRight" />
                    </button>
                  </div>
                )}
                {menu === "model-list" && (
                  <div className="ai-chat-option-menu ai-chat-config-menu ai-chat-config-submenu" role="menu" aria-label="选择模型">
                    <header>
                      <button type="button" aria-label="返回模型与推理强度" onClick={() => setMenu("model")}>
                        <LinearIcon name="chevronLeft" />
                      </button>
                      <strong>模型</strong>
                    </header>
                    {(activeCatalog?.models ?? []).map((model) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={model.slug === draftModel}
                        key={model.slug}
                        onClick={() => void chooseModel(model)}
                      >
                        <span>
                          <strong>{modelDisplayName(model.displayName)}</strong>
                          {model.description && <small>{model.description}</small>}
                        </span>
                        {model.slug === draftModel && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
                {menu === "effort-list" && selectedModel && (
                  <div className="ai-chat-option-menu ai-chat-config-menu ai-chat-config-submenu" role="menu" aria-label="选择推理强度">
                    <header>
                      <button type="button" aria-label="返回模型与推理强度" onClick={() => setMenu("model")}>
                        <LinearIcon name="chevronLeft" />
                      </button>
                      <strong>推理强度</strong>
                    </header>
                    {selectedModel.supportedReasoningEfforts.map((effort) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={effort === draftEffort}
                        key={effort}
                        onClick={() => void chooseEffort(effort)}
                      >
                        <span>{EFFORT_LABELS[effort] ?? effort}</span>
                        {effort === draftEffort && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {primaryAction === "stop" ? (
                <button
                  className="ai-chat-send-button is-stop"
                  type="button"
                  aria-label="停止生成"
                  title="停止"
                  onClick={() => void stopRun(currentRun)}
                >
                  <LinearIcon name="pause" />
                </button>
              ) : (
                <button
                  className="ai-chat-send-button"
                  type="button"
                  aria-label="发送消息"
                  title="发送"
                  disabled={
                    primaryAction === "disabled"
                    || loading
                    || settingsSaving
                    || Boolean(catalogError)
                  }
                  onClick={() => void startMessage(draft, false)}
                >
                  <LinearIcon name="send" />
                </button>
              )}
            </div>
          </div>

          {dangerConfirmOpen && (
            <div className="ai-chat-confirm-backdrop">
              <div className="ai-chat-confirm" role="alertdialog" aria-modal="true" aria-labelledby="ai-chat-confirm-title">
                <strong id="ai-chat-confirm-title">允许完全访问？</strong>
                <p>本次消息允许 Codex 访问工作区之外的文件和命令。确认只对本次发送生效。</p>
                <div>
                  <button type="button" onClick={() => setPendingDangerInput(null)}>取消</button>
                  <button
                    className="is-danger"
                    type="button"
                    onClick={() => {
                      if (!pendingDangerInput) return;
                      void startMessage(
                        pendingDangerInput.message,
                        true,
                        pendingDangerInput.skillIds,
                        pendingDangerInput.clearDraftOnSuccess,
                        pendingDangerInput.attachments,
                      );
                    }}
                  >
                    允许并发送
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      {!panelOpen && (
        <button
          type="button"
          className={`ai-chat-launcher is-${launcherState}`}
          aria-label="打开 AI 对话"
          aria-expanded="false"
          title="AI 对话"
          onClick={() => setPanelOpen(true)}
        >
          <LinearIcon name="conversation" />
          {launcherState !== "idle" && <span className="ai-chat-launcher-state" aria-hidden="true" />}
        </button>
      )}
    </div>
  );
}
