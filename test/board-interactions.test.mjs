import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const boardColumnSource = await readFile(new URL("../web/src/components/BoardColumn.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const contextMenuSource = await readFile(new URL("../web/src/components/TaskContextMenu.tsx", import.meta.url), "utf8");
const cardSource = await readFile(new URL("../web/src/components/TaskCard.tsx", import.meta.url), "utf8");
const filterSource = await readFile(new URL("../web/src/taskFilters.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");

function workflowStatuses() {
  const match = typesSource.match(/export const TASK_STATUSES = (\[[\s\S]*?\]) as const/);
  assert.ok(match);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((entry) => entry[1]);
}

test("dragging previews the insertion rank before committing it", () => {
  assert.match(boardColumnSource, /function findDropBefore/);
  assert.match(boardColumnSource, /clientY < card\.getBoundingClientRect\(\)\.top \+ card\.offsetHeight \/ 2/);
  assert.match(boardColumnSource, /onDrop\(status, taskId, findDropBefore/);
  assert.match(boardColumnSource, /function getTaskDragShift/);
  assert.match(boardColumnSource, /shift -= dragDistance/);
  assert.match(boardColumnSource, /shift \+= dragDistance/);
  assert.match(boardColumnSource, /dragShift=\{dragShift\}/);
  assert.match(styles, /\.task-card\.is-dragging \{[\s\S]*?opacity: 0/);
  assert.doesNotMatch(styles, /\.task-card\.is-dragging \{[^}]*pointer-events: none/);
  assert.match(styles, /transform 160ms cubic-bezier/);
  assert.match(appSource, /beforeTaskId: string \| null = null/);
  assert.match(appSource, /\(previousTask\.sortOrder \+ nextTask\.sortOrder\) \/ 2/);
  assert.match(appSource, /currentOrder\.every\(\(candidate, index\) => candidate\.id === desiredOrder\[index\]\.id\)/);
  assert.match(appSource, /setTasks\(\(current\) => sortTasks\(current\.map/);
  assert.match(appSource, /setSettlingTaskId\(task\.id\)/);
  assert.match(styles, /\.task-card\.is-settling \{[\s\S]*?task-card-settle 200ms/);
});

test("text selection is reserved for editable fields", () => {
  assert.match(styles, /body \{[^}]*user-select: none/);
  assert.match(styles, /input,[\s\S]*?textarea,[\s\S]*?\[contenteditable="true"\][\s\S]*?user-select: text/);
});

test("each status column remains a drop target for the full board height", () => {
  assert.match(styles, /\.board \{[\s\S]*?align-items: stretch/);
  assert.match(styles, /\.board-column \{[\s\S]*?display: flex;[\s\S]*?flex-direction: column/);
  assert.match(styles, /\.column-list \{[\s\S]*?flex: 1/);
});

test("the complete Linear-style workflow shares one ordered status source", () => {
  assert.deepEqual(workflowStatuses(), [
    "backlog",
    "todo",
    "in_progress",
    "in_review",
    "blocked",
    "done",
    "canceled",
  ]);
  assert.match(boardColumnSource, /in_review: \{ label: "审核中", tone: "review" \}/);
  assert.match(boardColumnSource, /blocked: \{ label: "已阻塞", tone: "blocked" \}/);
  assert.match(boardColumnSource, /canceled: \{ label: "已取消", tone: "canceled" \}/);
  assert.match(cardSource, /import \{ TASK_STATUSES,/);
  assert.doesNotMatch(cardSource, /STATUS_ORDER/);
  assert.match(detailSource, /TASK_STATUSES\.map\(\(status\) =>/);
  assert.match(editorSource, /TASK_STATUSES\.map\(\(value\) =>/);
  assert.match(contextMenuSource, /TASK_STATUSES\.map\(\(status, index\) =>/);
});

test("review, blocked and canceled statuses round-trip through filter URLs", () => {
  const statuses = workflowStatuses();
  const selected = ["in_review", "blocked", "canceled"];
  const url = new URL("http://taskboard.local/");
  url.searchParams.set("status", selected.join(","));
  const restored = url.searchParams.get("status").split(",").filter((status) => statuses.includes(status));

  assert.deepEqual(restored, selected);
  assert.match(filterSource, /filters\.statuses\.join\(","\)/);
  assert.match(filterSource, /\.split\(","\)\.filter\(isTaskStatus\)/);
  assert.match(filterSource, /TASK_STATUSES\.includes\(value as TaskStatus\)/);
});

test("the column surface wraps its heading and issue list", () => {
  assert.match(styles, /\.board-column \{[\s\S]*?background: var\(--column-header\)/);
  assert.match(styles, /\.column-header \{[\s\S]*?background: transparent/);
  assert.match(styles, /\.column-list \{[\s\S]*?padding: 0 8px 8px/);
});

test("common issue mutations enter a Linear-style undo queue", () => {
  assert.match(appSource, /const undoStackRef = useRef<UndoOperation\[]>/);
  assert.match(appSource, /event\.key\.toLowerCase\(\) === "z"/);
  assert.match(appSource, /event\.metaKey \|\| event\.ctrlKey/);
  assert.match(appSource, /function pushUndo/);
  assert.match(appSource, /setUndoNotice\(showNotice \? \{ id: operation\.id, message \} : null\)/);
  assert.match(appSource, /moveTask\(task, destination, beforeTaskId, true\)/);
  assert.doesNotMatch(appSource, /setAnnouncement\(`已撤回：/);
  assert.match(appSource, /className="toast undo-toast"/);
  assert.match(appSource, /restoreTaskRequest\(archived\)/);
  assert.match(apiSource, /export async function restoreTask/);
});

test("issues expose processing conversations without manual binding", () => {
  assert.match(detailSource, /在对话中打开/);
  assert.match(detailSource, /onOpenInThread\(currentTask\)/);
  assert.doesNotMatch(appSource, /detail-thread-button/);
  assert.doesNotMatch(detailSource, /输入对话 ID|解除 Codex 对话绑定|>绑定</);
  assert.doesNotMatch(editorSource, /对话 ID|linkedThreadId/);
  assert.match(detailSource, /currentTask\.threadId/);
  assert.doesNotMatch(detailSource, /currentTask\.threadIds/);
  assert.match(detailSource, /<strong>查看对话<\/strong>/);
  assert.match(detailSource, /className="conversation-thread-id">\{threadId\}/);
  assert.doesNotMatch(detailSource, /shortThreadId/);
  assert.doesNotMatch(detailSource, /detail-property-label">Codex/);
  assert.match(detailSource, /comment\.threadId/);
  assert.match(detailSource, /threadId=\{comment\.threadId\}/);
  assert.doesNotMatch(detailSource, /compact/);
  assert.doesNotMatch(styles, /issue-conversation-link\.compact/);
  assert.match(detailSource, /代码分支/);
  assert.match(detailSource, /Worktree/);
  assert.match(detailSource, /developmentContext/);
  assert.doesNotMatch(detailSource, /placeholder="绑定分支/);
  assert.doesNotMatch(contextMenuSource, /打开关联 Codex 对话/);
  assert.match(contextMenuSource, /onOpenInThread/);
});

test("comments stage, upload, render and delete their own attachments", () => {
  assert.match(apiSource, /export async function uploadCommentAttachment/);
  assert.match(apiSource, /\/api\/comments\/\$\{encodeURIComponent\(commentId\)\}\/attachments/);
  assert.match(detailSource, /pendingCommentFiles/);
  assert.match(detailSource, /uploadCommentAttachment\(comment\.id, file\)/);
  assert.match(detailSource, /comment\.attachments\.map/);
  assert.match(detailSource, /setPendingAttachmentDelete\(attachment\)/);
});
