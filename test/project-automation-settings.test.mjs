import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const settingsSource = await readFile(
  new URL("../web/src/components/BoardSettingsMenu.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("project automation state is device-local and scoped by taskboard project", () => {
  assert.match(appSource, /const PROJECT_AUTOMATIONS_KEY = "taskboard\.projectAutomations\.v1"/);
  assert.match(appSource, /type ProjectAutomationStatus = "ACTIVE" \| "PAUSED"/);
  assert.match(appSource, /automationId: string/);
  assert.match(appSource, /codexProjectId: string/);
  assert.match(appSource, /intervalMinutes: 5/);
  assert.match(appSource, /localStorage\.getItem\(PROJECT_AUTOMATIONS_KEY\)/);
  assert.match(appSource, /localStorage\.setItem\(PROJECT_AUTOMATIONS_KEY, JSON\.stringify\(next\)\)/);
  assert.match(appSource, /projectAutomations\[selectedProjectId\]/);
});

test("automation requests use the exact Codex host message contract", () => {
  assert.match(appSource, /type: "taskboard:automation-request"/);
  assert.match(appSource, /operation: "ensure-active" \| "pause" \| "list"/);
  assert.match(appSource, /taskboardProjectId: selectedProjectId/);
  assert.match(appSource, /codexProjectId/);
  assert.match(appSource, /projectName: selectedProject\.name/);
  assert.match(appSource, /workspacePath/);
  assert.match(appSource, /skillPath: manageTaskboardSkillPath/);
  assert.match(appSource, /intervalMinutes: 5/);
  assert.match(appSource, /message\.type === "taskboard:automation-response"/);
  assert.match(appSource, /pendingAutomationRequestsRef/);
  assert.match(appSource, /requestId/);
  assert.match(appSource, /window\.setTimeout/);
});

test("project mapping is based on exact ids and workspace paths, never project names", () => {
  assert.match(appSource, /hostContext\?\.projects\?\.some\([\s\S]*?project\.id === selectedProject\.id/);
  assert.match(appSource, /deviceWorkspacePaths\[project\.id\] === workspacePath/);
  assert.match(appSource, /请先在 Codex 中添加并映射该项目目录/);
  assert.doesNotMatch(appSource, /project\.name === selectedProject\.name/);
});

test("the board settings menu exposes a quiet embedded-only automation switch", () => {
  assert.match(settingsSource, />自动认领待办</);
  assert.match(settingsSource, />每 5 分钟检查一次</);
  assert.match(settingsSource, /automationEnabled/);
  assert.match(settingsSource, /automationPending/);
  assert.match(settingsSource, /automationUnavailableReason/);
  assert.match(settingsSource, /disabled=\{automationPending \|\| Boolean\(automationUnavailableReason\)\}/);
  assert.match(settingsSource, /role="alert"/);
  assert.doesNotMatch(settingsSource, /toast/i);
  assert.match(styles, /\.board-setting-copy/);
  assert.match(styles, /\.board-setting-error/);
  assert.match(appSource, /仅本地任务面板可用/);
});

test("opening settings and changing projects reconcile with the host list", () => {
  assert.match(settingsSource, /onOpen/);
  assert.match(appSource, /sendAutomationRequest\("list", stored\?\.automationId\)/);
  assert.match(appSource, /items\.find\(\(item\) => item\.id === stored\?\.automationId\)/);
  assert.match(appSource, /items\.length === 1 \? items\[0\] : undefined/);
  assert.match(appSource, /status: item\.status/);
});
