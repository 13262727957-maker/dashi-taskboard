import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  createAiChatThread,
  getAiChatCatalog,
  getAiChatThread,
  interruptAiChatRun,
  listAiChatThreads,
  startAiChatTurn,
  subscribeAiChatThread,
  updateAiChatThread,
} from "../api";
import {
  buildThreadCreateInput,
  buildTurnInput,
  chatPrimaryAction,
  filterVisibleAiEvents,
  insertSkillMention,
  needsDangerConfirmation,
  normalizeChatSelection,
  readSkillMention,
} from "../aiChatState";
import type {
  AiChatCatalog,
  AiChatEvent,
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

type MenuName = "model" | "effort" | "sandbox" | null;

const LAST_THREAD_KEY = "taskboard.aiChat.lastThreadId";

const SANDBOX_LABELS: Record<AiChatSandbox, string> = {
  "read-only": "只读",
  "workspace-write": "工作区",
  "danger-full-access": "完全访问",
};

const EFFORT_LABELS: Record<string, string> = {
  low: "轻度",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
  ultra: "极高",
};

const ACTIVITY_LABELS: Record<string, string> = {
  plan: "执行计划",
  todo: "任务进度",
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

function eventStatus(event: AiChatEvent): "running" | "completed" | "failed" {
  if (event.role === "error" || event.type === "error") return "failed";
  const status = event.data?.status;
  if (status === "running" || status === "started") return "running";
  if (status === "failed" || status === "error") return "failed";
  return "completed";
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

function ActivityCard({ event }: { event: AiChatEvent }) {
  const status = eventStatus(event);
  const detail = activityDetail(event);
  const label = ACTIVITY_LABELS[event.type] ?? "执行活动";
  return (
    <details className={`ai-chat-activity is-${status}`} open={status !== "completed"}>
      <summary>
        <span className="ai-chat-activity-status" aria-hidden="true">
          {status === "running"
            ? <span className="ai-chat-spinner" />
            : <LinearIcon name={status === "failed" ? "alert" : "check"} />}
        </span>
        <span className="ai-chat-activity-label">{label}</span>
        <span className="ai-chat-activity-summary">{event.content}</span>
        <LinearIcon className="ai-chat-activity-chevron" name="chevronDown" />
      </summary>
      {detail && <pre><code>{detail}</code></pre>}
    </details>
  );
}

function MessageTimeline({ events }: { events: AiChatEvent[] }) {
  return (
    <>
      {filterVisibleAiEvents(events).map((event) => {
        if (event.role === "user" || event.type === "user" || event.type === "user_message") {
          return (
            <article className="ai-chat-user-message" key={event.id}>
              <MarkdownMessage>{event.content}</MarkdownMessage>
            </article>
          );
        }
        if (event.role === "assistant" || event.type === "assistant" || event.type === "agent_message") {
          return (
            <article className="ai-chat-assistant-message" key={event.id}>
              <img src="/codex-agent-logo.png" alt="" aria-hidden="true" />
              <MarkdownMessage>{event.content}</MarkdownMessage>
            </article>
          );
        }
        return <ActivityCard event={event} key={event.id} />;
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
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [skillIds, setSkillIds] = useState<string[]>([]);
  const [skillMention, setSkillMention] = useState<ReturnType<typeof readSkillMention>>(null);
  const [dangerConfirmOpen, setDangerConfirmOpen] = useState(false);
  const [unread, setUnread] = useState(false);
  const [draftModel, setDraftModel] = useState("");
  const [draftEffort, setDraftEffort] = useState("");
  const [draftSandbox, setDraftSandbox] = useState<AiChatSandbox>("read-only");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const selectedThreadRef = useRef(selectedThreadId);
  const panelOpenRef = useRef(panelOpen);
  const snapshotRequestRef = useRef(0);
  const observedRunStatusesRef = useRef(new Map<string, AiChatRun["status"]>());

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
    if (!quiet) setLoading(true);
    try {
      const next = await getAiChatThread(threadId);
      if (requestId !== snapshotRequestRef.current || selectedThreadRef.current !== threadId) return;
      setSnapshot(next);
      replaceThread(next.thread);
      observeRunTransitions(next.runs);
      setError(null);
    } catch (nextError) {
      if (requestId === snapshotRequestRef.current) setError(messageFor(nextError));
    } finally {
      if (!quiet && requestId === snapshotRequestRef.current) setLoading(false);
    }
  }, [observeRunTransitions, replaceThread]);

  const loadThreads = useCallback(async () => {
    try {
      const next = await listAiChatThreads();
      setThreads(next);
      setSelectedThreadId((current) => {
        if (current && next.some((thread) => thread.id === current)) return current;
        return next[0]?.id ?? null;
      });
      setError(null);
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
    void loadSnapshot(selectedThreadId);
    return subscribeAiChatThread(
      selectedThreadId,
      () => void loadSnapshot(selectedThreadId, true),
    );
  }, [loadSnapshot, selectedThreadId]);

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
    const unsubscribers = backgroundRunningThreadIds.map((threadId) => (
      subscribeAiChatThread(threadId, () => void refresh(threadId))
    ));
    return () => {
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
  useEffect(() => {
    if (!available || !catalogProjectId) {
      setCatalog(null);
      setCatalogError(null);
      return;
    }
    const controller = new AbortController();
    void getAiChatCatalog(catalogProjectId, controller.signal).then(
      (next) => {
        setCatalog(next);
        setCatalogError(null);
      },
      (nextError) => {
        if ((nextError as Error).name !== "AbortError") {
          setCatalog(null);
          setCatalogError(messageFor(nextError));
        }
      },
    );
    return () => controller.abort();
  }, [available, catalogProjectId]);

  useEffect(() => {
    const thread = snapshot?.thread;
    if (thread) {
      setDraftModel(thread.model);
      setDraftEffort(thread.reasoningEffort);
      setDraftSandbox(thread.sandbox);
      return;
    }
    const normalized = normalizeChatSelection(catalog?.models ?? [], draftModel, draftEffort);
    if (normalized) {
      setDraftModel(normalized.model);
      setDraftEffort(normalized.reasoningEffort);
    }
    const firstSandbox = catalog?.sandboxes.find(isAiChatSandbox);
    if (firstSandbox) setDraftSandbox(firstSandbox);
  }, [catalog, snapshot?.thread.id]);

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
      if (dangerConfirmOpen) setDangerConfirmOpen(false);
      else if (skillMention) setSkillMention(null);
      else if (menu) setMenu(null);
      else if (historyOpen) setHistoryOpen(false);
      else setPanelOpen(false);
    }
    document.addEventListener("keydown", closeWithEscape, true);
    return () => document.removeEventListener("keydown", closeWithEscape, true);
  }, [dangerConfirmOpen, historyOpen, menu, panelOpen, skillMention]);

  const visibleSkills = useMemo(
    () => (catalog?.skills ?? []).filter((skill) => (
      skill.id !== "manage-taskboard"
      && !skill.id.endsWith(":manage-taskboard")
      && (
        !skillMention?.query
        || skill.label.toLocaleLowerCase().includes(skillMention.query)
        || skill.id.toLocaleLowerCase().includes(skillMention.query)
      )
    )),
    [catalog?.skills, skillMention?.query],
  );

  const selectedModel = catalog?.models.find((model) => model.slug === draftModel) ?? null;
  const availableSandboxes = (catalog?.sandboxes ?? []).filter(isAiChatSandbox);
  const currentRun = snapshot?.thread.currentRun
    ?? snapshot?.runs.find((run) => run.status === "running")
    ?? null;
  const primaryAction = chatPrimaryAction(snapshot?.thread.status ?? "idle", draft);
  const anyRunning = threads.some((thread) => thread.status === "running");
  const anyFailed = threads.some((thread) => thread.status === "failed");
  const launcherState = anyRunning ? "running" : anyFailed ? "failed" : unread ? "unread" : "idle";

  async function createThreadForCurrentOrigin(): Promise<AiChatThread | null> {
    const input = buildThreadCreateInput(projectId ?? "", issueId);
    if (!input) {
      setError("请先进入一个已映射的项目，再新建对话");
      return null;
    }
    setLoading(true);
    try {
      const thread = await createAiChatThread({
        ...input,
        ...(draftModel ? { model: draftModel } : {}),
        ...(draftEffort ? { reasoningEffort: draftEffort } : {}),
        sandbox: draftSandbox,
      });
      replaceThread(thread);
      setSelectedThreadId(thread.id);
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

  async function saveThreadSettings(changes: {
    model?: string;
    reasoningEffort?: string;
    sandbox?: AiChatSandbox;
  }) {
    const threadId = snapshot?.thread.id;
    if (!threadId) return;
    setSettingsSaving(true);
    try {
      const thread = await updateAiChatThread(threadId, changes);
      setSnapshot((current) => current ? { ...current, thread } : current);
      replaceThread(thread);
      setError(null);
    } catch (nextError) {
      setError(messageFor(nextError));
      void loadSnapshot(threadId, true);
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
    const visible = (catalog?.skills ?? []).filter((skill) => (
      skill.id !== "manage-taskboard"
      && !skill.id.endsWith(":manage-taskboard")
      && message.includes(`@${skill.label}`)
    )).map((skill) => skill.id);
    return [...new Set([...skillIds, ...visible])].filter((id) => (
      (catalog?.skills ?? []).some((skill) => skill.id === id && message.includes(`@${skill.label}`))
    ));
  }

  async function startMessage(message: string, dangerConfirmed: boolean) {
    const trimmed = message.trim();
    if (!trimmed) return;
    let thread = snapshot?.thread ?? null;
    if (!thread) thread = await createThreadForCurrentOrigin();
    if (!thread) return;
    if (needsDangerConfirmation(thread.sandbox, dangerConfirmed)) {
      setDangerConfirmOpen(true);
      return;
    }
    setDangerConfirmOpen(false);
    setError(null);
    try {
      const run = await startAiChatTurn(
        thread.id,
        buildTurnInput(trimmed, realSkillIdsForMessage(trimmed), dangerConfirmed),
      );
      setDraft("");
      setSkillIds([]);
      setSkillMention(null);
      observedRunStatusesRef.current.set(run.id, run.status);
      setSnapshot((current) => current ? {
        ...current,
        thread: { ...current.thread, status: "running", currentRun: run },
        runs: [run, ...current.runs.filter((candidate) => candidate.id !== run.id)],
      } : current);
      replaceThread({ ...thread, status: "running", currentRun: run });
      void loadSnapshot(thread.id, true);
    } catch (nextError) {
      setError(messageFor(nextError));
      void loadSnapshot(thread.id, true);
    }
  }

  async function stopRun(run: AiChatRun | null) {
    if (!run) return;
    try {
      await interruptAiChatRun(run.id);
      if (selectedThreadId) void loadSnapshot(selectedThreadId, true);
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
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
            <img src="/codex-agent-logo.png" alt="" aria-hidden="true" />
            <div className="ai-chat-panel-title">
              <strong>{snapshot?.thread.title ?? "Codex"}</strong>
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
                <button
                  type="button"
                  className={thread.id === selectedThreadId ? "is-active" : ""}
                  key={thread.id}
                  onClick={() => {
                    setSelectedThreadId(thread.id);
                    setHistoryOpen(false);
                  }}
                >
                  <span className={`ai-chat-thread-status is-${thread.status}`} aria-hidden="true" />
                  <span>
                    <strong>{thread.title}</strong>
                    <small>{thread.origin.projectName} · {dateLabel(thread.updatedAt)}</small>
                  </span>
                </button>
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
                      const lastUserEvent = [...snapshot.events].reverse().find((event) => event.role === "user");
                      if (lastUserEvent) void startMessage(lastUserEvent.content, false);
                    }}
                  >
                    <LinearIcon name="recurrence" />
                    重试上一条消息
                  </button>
                )}
              </>
            ) : (
              <div className="ai-chat-empty">
                <img src="/codex-agent-logo.png" alt="" aria-hidden="true" />
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

          <div className="ai-chat-composer">
            <div className="ai-chat-input-wrap">
              <textarea
                ref={textareaRef}
                value={draft}
                rows={1}
                placeholder="询问 Codex"
                aria-label="发送给 Codex 的消息"
                disabled={snapshot?.thread.status === "running" || settingsSaving}
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
              />
              {skillMention && visibleSkills.length > 0 && (
                <div className="ai-chat-skill-menu" role="listbox" aria-label="可用 Skill">
                  {visibleSkills.map((skill) => (
                    <button
                      type="button"
                      role="option"
                      key={skill.id}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={() => selectSkill(skill)}
                    >
                      <LinearIcon name="file" />
                      <span><strong>{skill.label}</strong><small>{skill.scope}</small></span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="ai-chat-composer-toolbar">
              <div className="ai-chat-menu-wrap">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "sandbox"}
                  disabled={!catalog || snapshot?.thread.status === "running" || settingsSaving}
                  onClick={() => setMenu((current) => current === "sandbox" ? null : "sandbox")}
                >
                  {SANDBOX_LABELS[draftSandbox]}
                  <LinearIcon name="chevronDown" />
                </button>
                {menu === "sandbox" && (
                  <OptionMenu label="执行权限">
                    {availableSandboxes.map((sandbox) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={sandbox === draftSandbox}
                        key={sandbox}
                        onClick={() => void chooseSandbox(sandbox)}
                      >
                        <span>{SANDBOX_LABELS[sandbox]}</span>
                        {sandbox === draftSandbox && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </OptionMenu>
                )}
              </div>

              <div className="ai-chat-menu-wrap ai-chat-model-menu-wrap">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "model"}
                  disabled={!catalog || snapshot?.thread.status === "running" || settingsSaving}
                  onClick={() => setMenu((current) => current === "model" ? null : "model")}
                >
                  <span>{selectedModel?.displayName ?? (draftModel || "模型")}</span>
                  <LinearIcon name="chevronDown" />
                </button>
                {menu === "model" && (
                  <OptionMenu label="模型">
                    {(catalog?.models ?? []).map((model) => (
                      <button
                        type="button"
                        role="menuitemradio"
                        aria-checked={model.slug === draftModel}
                        key={model.slug}
                        onClick={() => void chooseModel(model)}
                      >
                        <span><strong>{model.displayName}</strong><small>{model.description}</small></span>
                        {model.slug === draftModel && <LinearIcon name="check" />}
                      </button>
                    ))}
                  </OptionMenu>
                )}
              </div>

              <div className="ai-chat-menu-wrap">
                <button
                  type="button"
                  aria-haspopup="menu"
                  aria-expanded={menu === "effort"}
                  disabled={!selectedModel || snapshot?.thread.status === "running" || settingsSaving}
                  onClick={() => setMenu((current) => current === "effort" ? null : "effort")}
                >
                  {EFFORT_LABELS[draftEffort] ?? (draftEffort || "推理")}
                  <LinearIcon name="chevronDown" />
                </button>
                {menu === "effort" && selectedModel && (
                  <OptionMenu label="推理强度">
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
                  </OptionMenu>
                )}
              </div>

              <span className="ai-chat-toolbar-spacer" />
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
                  <button type="button" onClick={() => setDangerConfirmOpen(false)}>取消</button>
                  <button
                    className="is-danger"
                    type="button"
                    onClick={() => void startMessage(draft, true)}
                  >
                    允许并发送
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>
      )}

      <button
        type="button"
        className={`ai-chat-launcher is-${launcherState}`}
        aria-label={panelOpen ? "关闭 Codex AI 对话" : "打开 Codex AI 对话"}
        aria-expanded={panelOpen}
        title="Codex AI 对话"
        onClick={() => setPanelOpen((current) => !current)}
      >
        <img src="/codex-agent-logo.png" alt="" />
        {launcherState !== "idle" && <span className="ai-chat-launcher-state" aria-hidden="true" />}
      </button>
    </div>
  );
}
