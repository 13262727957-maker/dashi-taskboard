import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildThreadCreateInput,
  buildTurnInput,
  chatPrimaryAction,
  filterVisibleAiEvents,
  insertSkillMention,
  isAiChatCapabilityAvailable,
  needsDangerConfirmation,
  normalizeChatSelection,
  readSkillMention,
  routeChatState,
  shouldRefreshAiSnapshot,
} from "../web/src/aiChatState.ts";

const models = [
  {
    slug: "codex-real-model",
    displayName: "Codex Real Model",
    description: "Host model",
    defaultReasoningEffort: "high",
    supportedReasoningEfforts: ["medium", "high"],
    serviceTiers: [{ id: "priority", name: "Priority" }],
  },
  {
    slug: "codex-fast-model",
    displayName: "Codex Fast Model",
    description: "Fast host model",
    defaultReasoningEffort: "low",
    supportedReasoningEfforts: ["low"],
    serviceTiers: [],
  },
];

test("AI chat is exposed only when the local capability is explicit", () => {
  assert.equal(isAiChatCapabilityAvailable({ localAiChat: true }), true);
  assert.equal(isAiChatCapabilityAvailable({ localAiChat: false }), false);
  assert.equal(isAiChatCapabilityAvailable(undefined), false);
});

test("new threads freeze the current project and optional issue as server identifiers", () => {
  assert.deepEqual(buildThreadCreateInput("project-1", "issue-1"), {
    projectId: "project-1",
    issueId: "issue-1",
  });
  assert.deepEqual(buildThreadCreateInput("project-1", null), {
    projectId: "project-1",
  });
  assert.equal(buildThreadCreateInput("", null), null);
});

test("route changes update only the next origin and preserve the selected global thread", () => {
  assert.deepEqual(
    routeChatState(
      { selectedThreadId: "thread-a", pendingProjectId: "project-a", pendingIssueId: "issue-a" },
      "project-b",
      "issue-b",
    ),
    {
      selectedThreadId: "thread-a",
      pendingProjectId: "project-b",
      pendingIssueId: "issue-b",
    },
  );
});

test("model and effort selections are restricted to the real catalog", () => {
  assert.deepEqual(normalizeChatSelection(models, "codex-real-model", "medium"), {
    model: "codex-real-model",
    reasoningEffort: "medium",
  });
  assert.deepEqual(normalizeChatSelection(models, "codex-real-model", "fake-effort"), {
    model: "codex-real-model",
    reasoningEffort: "high",
  });
  assert.deepEqual(normalizeChatSelection(models, "missing-model", "high"), {
    model: "codex-real-model",
    reasoningEffort: "high",
  });
  assert.equal(normalizeChatSelection([], "missing-model", "high"), null);
});

test("@ skill mentions keep a visible label while sending only the selected real id", () => {
  assert.deepEqual(readSkillMention("请用 @cl", 6), {
    start: 3,
    end: 6,
    query: "cl",
  });
  assert.deepEqual(insertSkillMention("请用 @cl 检查", 3, 6, {
    id: "cloudflare",
    label: "Cloudflare",
    scope: "user",
  }), {
    value: "请用 @Cloudflare 检查",
    caret: 14,
    skillId: "cloudflare",
  });
});

test("turn input cannot contain cwd, hidden context, model overrides or arbitrary args", () => {
  const input = buildTurnInput("检查 LOCAL-103", ["cloudflare"], false);
  assert.deepEqual(input, {
    message: "检查 LOCAL-103",
    skillIds: ["cloudflare"],
  });
  assert.equal(JSON.stringify(input).includes("workspacePath"), false);
  assert.equal(JSON.stringify(input).includes("manage-taskboard"), false);
  assert.equal(JSON.stringify(input).includes("model"), false);
  assert.deepEqual(buildTurnInput("执行", [], true), {
    message: "执行",
    dangerFullAccessConfirmed: true,
  });
});

test("runtime controls distinguish send, stop, danger confirmation and SSE refresh hints", () => {
  assert.equal(chatPrimaryAction("running", "hello"), "stop");
  assert.equal(chatPrimaryAction("idle", "hello"), "send");
  assert.equal(chatPrimaryAction("idle", "  "), "disabled");
  assert.equal(needsDangerConfirmation("danger-full-access", false), true);
  assert.equal(needsDangerConfirmation("danger-full-access", true), false);
  assert.equal(needsDangerConfirmation("workspace-write", false), false);
  assert.equal(shouldRefreshAiSnapshot("ai.event"), true);
  assert.equal(shouldRefreshAiSnapshot("ai.run"), true);
  assert.equal(shouldRefreshAiSnapshot("unrelated"), false);
});

test("reasoning and raw JSONL events are excluded from the visible timeline", () => {
  const events = filterVisibleAiEvents([
    { id: "1", type: "agent_message", role: "assistant", content: "公开回复" },
    { id: "2", type: "reasoning", role: "activity", content: "private chain of thought" },
    { id: "3", type: "raw_jsonl", role: "activity", content: "{\"secret\":true}" },
    { id: "4", type: "command", role: "activity", content: "npm test" },
  ]);
  assert.deepEqual(events.map((event) => event.id), ["1", "4"]);
});
