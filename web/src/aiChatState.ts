import type {
  AiChatEvent,
  AiChatModel,
  AiChatSandbox,
  AiChatSkill,
  AiChatThread,
  AiChatThreadSnapshot,
  AiChatThreadStatus,
  TaskboardCapabilities,
} from "./types";

export interface AiChatRouteState {
  selectedThreadId: string | null;
  pendingProjectId: string | null;
  pendingIssueId: string | null;
}

export function isAiChatCapabilityAvailable(capabilities?: TaskboardCapabilities): boolean {
  return capabilities?.localAiChat === true;
}

export function buildThreadCreateInput(projectId: string, issueId: string | null) {
  if (!projectId) return null;
  return {
    projectId,
    ...(issueId ? { issueId } : {}),
  };
}

interface AiChatThreadSettings {
  model: string;
  reasoningEffort: string;
  sandbox: AiChatSandbox;
}

export function settingsForNewAiThread(
  projectId: string,
  settingsProjectId: string | null,
  settings: AiChatThreadSettings,
): Partial<AiChatThreadSettings> {
  return projectId === settingsProjectId ? settings : {};
}

export function routeChatState(
  state: AiChatRouteState,
  projectId: string | null,
  issueId: string | null,
): AiChatRouteState {
  return {
    ...state,
    pendingProjectId: projectId,
    pendingIssueId: issueId,
  };
}

export function normalizeChatSelection(
  models: AiChatModel[],
  model: string | null | undefined,
  reasoningEffort: string | null | undefined,
) {
  const selectedModel = models.find((candidate) => candidate.slug === model) ?? models[0];
  if (!selectedModel) return null;
  return {
    model: selectedModel.slug,
    reasoningEffort: selectedModel.supportedReasoningEfforts.includes(reasoningEffort ?? "")
      ? reasoningEffort as string
      : selectedModel.defaultReasoningEffort,
  };
}

export function readSkillMention(value: string, caret: number) {
  const prefix = value.slice(0, caret);
  const match = /(?:^|\s)@([^\s@]*)$/.exec(prefix);
  if (!match) return null;
  const at = prefix.lastIndexOf("@");
  return { start: at, end: caret, query: match[1].toLocaleLowerCase() };
}

export function insertSkillMention(
  value: string,
  start: number,
  end: number,
  skill: AiChatSkill,
) {
  const mention = `@${skill.label}`;
  return {
    value: `${value.slice(0, start)}${mention}${value.slice(end)}`,
    caret: start + mention.length,
    skillId: skill.id,
  };
}

export function buildTurnInput(
  message: string,
  skillIds: string[],
  dangerFullAccessConfirmed: boolean,
) {
  return {
    message,
    ...(skillIds.length > 0 ? { skillIds } : {}),
    ...(dangerFullAccessConfirmed ? { dangerFullAccessConfirmed: true } : {}),
  };
}

export function chatPrimaryAction(
  status: AiChatThreadStatus,
  message: string,
  blocked = false,
): "send" | "stop" | "disabled" {
  if (blocked) return "disabled";
  if (status === "running") return "stop";
  return message.trim() ? "send" : "disabled";
}

export function needsDangerConfirmation(
  sandbox: AiChatSandbox,
  confirmed: boolean,
): boolean {
  return sandbox === "danger-full-access" && !confirmed;
}

export function shouldRefreshAiSnapshot(type: string): boolean {
  return type === "ai.event" || type === "ai.run";
}

const VISIBLE_EVENT_TYPES = new Set([
  "agent_message",
  "assistant",
  "plan",
  "todo",
  "todo_list",
  "command",
  "command_execution",
  "file",
  "file_change",
  "mcp",
  "mcp_tool_call",
  "skill",
  "web",
  "web_search",
  "error",
  "turn.failed",
  "user_message",
  "user",
]);

function isMessageEvent(event: Pick<AiChatEvent, "role" | "type">): boolean {
  return event.role === "user"
    || event.role === "assistant"
    || event.type === "user"
    || event.type === "user_message"
    || event.type === "assistant"
    || event.type === "agent_message";
}

export function filterVisibleAiEvents<
  T extends Pick<AiChatEvent, "type" | "role" | "data">,
>(events: T[]): T[] {
  const visible = events.filter((event) => VISIBLE_EVENT_TYPES.has(event.type));
  const latestActivityIndex = new Map<string, number>();
  visible.forEach((event, index) => {
    const itemId = event.data?.itemId;
    if (!isMessageEvent(event) && typeof itemId === "string") {
      latestActivityIndex.set(itemId, index);
    }
  });
  return visible.filter((event, index) => {
    const itemId = event.data?.itemId;
    return isMessageEvent(event)
      || typeof itemId !== "string"
      || latestActivityIndex.get(itemId) === index;
  });
}

export function aiChatEventStatus(
  event: Pick<AiChatEvent, "role" | "type" | "data">,
): "running" | "completed" | "failed" {
  if (event.role === "error" || event.type === "error" || event.type === "turn.failed") {
    return "failed";
  }
  const status = event.data?.status;
  if (status === "running" || status === "started" || status === "in_progress") {
    return "running";
  }
  if (status === "failed" || status === "error") return "failed";
  return "completed";
}

export function patchAiChatSnapshot(
  current: AiChatThreadSnapshot | null,
  threadId: string,
  thread: AiChatThread,
): AiChatThreadSnapshot | null {
  if (!current || current.thread.id !== threadId) return current;
  return { ...current, thread };
}

export function createAiSnapshotRefreshQueue(
  refresh: (threadId: string) => Promise<void>,
) {
  const states = new Map<string, {
    queued: boolean;
    promise: Promise<void>;
  }>();
  let active = true;

  return {
    request(threadId: string): Promise<void> {
      const current = states.get(threadId);
      if (current) {
        current.queued = true;
        return current.promise;
      }

      const state = {
        queued: false,
        promise: Promise.resolve(),
      };
      state.promise = (async () => {
        do {
          state.queued = false;
          await refresh(threadId);
        } while (active && state.queued);
      })().finally(() => {
        if (states.get(threadId) === state) states.delete(threadId);
      });
      states.set(threadId, state);
      return state.promise;
    },
    clear() {
      active = false;
      states.clear();
    },
  };
}
