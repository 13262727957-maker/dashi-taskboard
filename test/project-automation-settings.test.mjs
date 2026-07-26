import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const settingsSource = await readFile(
  new URL("../web/src/components/BoardSettingsMenu.tsx", import.meta.url),
  "utf8",
);
const menuSource = await readFile(
  new URL("../web/src/components/ProjectAutomationMenu.tsx", import.meta.url),
  "utf8",
);
const iconSource = await readFile(
  new URL("../web/src/components/LinearIcon.tsx", import.meta.url),
  "utf8",
);
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("project automation state is device-local and scoped by taskboard project", () => {
  assert.match(appSource, /const PROJECT_AUTOMATIONS_KEY = "taskboard\.projectAutomations\.v1"/);
  assert.match(appSource, /type ProjectAutomationStatus = "ACTIVE" \| "PAUSED"/);
  assert.match(appSource, /automationId\?: string/);
  assert.match(appSource, /codexProjectId: string/);
  assert.match(appSource, /type AutomationIntervalMinutes = 5 \| 10 \| 15 \| 30 \| 60/);
  assert.match(appSource, /type AutomationModel = "gpt-5\.5" \| "gpt-5\.4"/);
  assert.match(appSource, /type AutomationReasoningEffort = "medium" \| "high" \| "xhigh"/);
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
  assert.match(appSource, /intervalMinutes: options\.intervalMinutes/);
  assert.match(appSource, /model: options\.model/);
  assert.match(appSource, /reasoningEffort: options\.reasoningEffort/);
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

test("the project navigation automation menu owns the icon, fields, and accessible popover", () => {
  assert.doesNotMatch(settingsSource, /自动认领待办|automationEnabled|automationPending/);
  assert.match(menuSource, /status === "ACTIVE" \? "play" : "pause"/);
  assert.doesNotMatch(menuSource, /statusStarted|statusTodo/);
  assert.match(menuSource, /aria-busy=\{pending/);
  assert.match(menuSource, /运行中/);
  assert.match(menuSource, /已暂停/);
  assert.match(menuSource, /自动认领开关/);
  assert.match(menuSource, /5, 10, 15, 30, 60/);
  assert.match(menuSource, /gpt-5\.5/);
  assert.match(menuSource, /gpt-5\.4/);
  assert.match(menuSource, /medium.*中/);
  assert.match(menuSource, /xhigh.*最高/);
  assert.match(menuSource, /createPortal/);
  assert.match(menuSource, /window\.addEventListener\("resize"/);
  assert.match(menuSource, /window\.addEventListener\("scroll", closeFromViewportChange, true\)/);
  assert.match(menuSource, /no-drag/);
  assert.doesNotMatch(menuSource, /event\.key === "Tab"/);
  assert.match(appSource, /<ProjectAutomationMenu/);
  assert.match(appSource, /<ProjectAutomationMenu[\s\S]*?<button[\s\S]*?header-create-button/);
  assert.doesNotMatch(appSource, /toolbar-connection/);
  assert.match(appSource, /仅本地任务面板可用/);
});

test("automation status uses Codex-native play and pause icon assets", () => {
  assert.match(iconSource, /play:\s*\{\s*viewBox: "0 0 24 24",\s*content: <polygon[^>]*points="6 3 20 12 6 21 6 3"[^>]*\/>/s);
  assert.match(iconSource, /pause:\s*\{\s*viewBox: "0 0 24 24",[\s\S]*?<rect x="14" y="4" width="4" height="16" rx="1" \/>[\s\S]*?<rect x="6" y="4" width="4" height="16" rx="1" \/>/s);
  assert.match(iconSource, /in_progress: "statusStarted"/);
  assert.match(iconSource, /todo: "statusTodo"/);
});

test("automation play and pause retain Codex Lucide stroke presentation locally", () => {
  assert.match(iconSource, /play:[\s\S]*?<polygon[^>]*fill="none"[^>]*stroke="currentColor"[^>]*strokeWidth=\{2\}[^>]*strokeLinecap="round"[^>]*strokeLinejoin="round"/);
  assert.match(iconSource, /pause:[\s\S]*?<g fill="none" stroke="currentColor" strokeWidth=\{2\} strokeLinecap="round" strokeLinejoin="round">/);
});

test("the automation menu reuses the Linear switch and keeps form focus chrome suppressed", () => {
  assert.match(menuSource, /className=\{`board-setting-switch\$\{draft\.status === "ACTIVE" \? " is-on" : ""\}`\}/);
  assert.match(menuSource, /role="switch"/);
  assert.match(menuSource, /aria-checked=\{draft\.status === "ACTIVE"\}/);
  assert.doesNotMatch(menuSource, /type="checkbox"/);
  assert.match(styles, /\.project-automation-field select:focus-visible\s*\{[^}]*outline:\s*0;[^}]*box-shadow:\s*none;/s);
  assert.doesNotMatch(styles, /\.project-automation-switch input:focus-visible/);
});

test("unavailable automation state has one notice, clears stale errors, and cannot save", () => {
  assert.match(menuSource, /error && error !== unavailableReason/);
  assert.match(menuSource, /disabled=\{pending \|\| Boolean\(unavailableReason\)\}/);
  const reconcileSource = appSource.slice(
    appSource.indexOf("const reconcileProjectAutomation"),
    appSource.indexOf("const saveProjectAutomation"),
  );
  assert.match(
    reconcileSource,
    /automationProjectContext\.unavailableReason[\s\S]*?\) \{\s*setAutomationError\(null\);\s*return;/,
  );
  assert.doesNotMatch(reconcileSource, /setAutomationError\(automationProjectContext\.unavailableReason/);
});

test("opening settings and changing projects reconcile with the host list", () => {
  assert.match(appSource, /sendAutomationRequest\("list", options, stored\?\.automationId\)/);
  assert.match(appSource, /items\.find\(\(item\) => item\.id === stored\?\.automationId\)/);
  assert.match(appSource, /items\.length === 1 \? items\[0\] : undefined/);
  assert.match(appSource, /status: item\.status/);
  assert.match(appSource, /automationId: undefined/);
  assert.match(appSource, /options\.status === "PAUSED" && !stored\?\.automationId/);
  assert.match(appSource, /writeProjectAutomation\(selectedProjectId, previousRecord\)/);
});
