import type {
  AiChatEvent,
  AiChatModel,
  AiChatSandbox,
  AiChatSkill,
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
): "send" | "stop" | "disabled" {
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
  "user_message",
  "user",
]);

export function filterVisibleAiEvents<T extends Pick<AiChatEvent, "type">>(events: T[]): T[] {
  return events.filter((event) => VISIBLE_EVENT_TYPES.has(event.type));
}
