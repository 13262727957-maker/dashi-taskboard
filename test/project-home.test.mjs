import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");
const editorSource = await readFile(new URL("../web/src/components/TaskEditor.tsx", import.meta.url), "utf8");
const detailSource = await readFile(new URL("../web/src/components/TaskDetail.tsx", import.meta.url), "utf8");
const labelPickerSource = await readFile(new URL("../web/src/components/LabelPicker.tsx", import.meta.url), "utf8");
const labelsSource = await readFile(new URL("../web/src/labels.ts", import.meta.url), "utf8");

test("the project home merges live Codex projects with persisted Taskboard projects", () => {
  assert.match(appSource, /\.\.\.\(hostContext\?\.projects \?\? \[\]\), \.\.\.deviceProjects/);
  assert.match(appSource, /persistedById/);
  assert.match(appSource, /project\.inCodex \? "Codex 项目" : "已保存的项目"/);
  assert.match(appSource, /createProjectRequest/);
  assert.match(apiSource, /export async function createProject/);
});

test("each device stores an independent workspace path for every project", () => {
  assert.match(appSource, /const DEVICE_WORKSPACE_PATHS_KEY = "taskboard\.deviceWorkspacePaths\.v1"/);
  assert.match(appSource, /function readDeviceWorkspacePaths\(\)/);
  assert.match(appSource, /rememberDeviceWorkspacePath/);
  assert.match(appSource, /const \[nextProjects, metadata, deviceWorkspaceInfo\] = await Promise\.all\(\[/);
  assert.match(appSource, /listDeviceWorkspaces\(signal\)/);
  assert.match(appSource, /setDeviceProjects\(deviceWorkspaceInfo\.projects\)/);
  assert.match(appSource, /placeholder="设置此设备的项目目录"/);
  assert.match(appSource, /deviceWorkspacePaths\[selectedProjectId\]/);
  assert.match(apiSource, /query\.set\("workspacePath", workspacePath\)/);
  assert.match(apiSource, /\/api\/device-workspaces/);
  assert.match(styles, /\.project-card-directory \{/);
});

test("project selection is remembered until the user explicitly returns home", () => {
  assert.match(appSource, /const LAST_PROJECT_KEY = "taskboard\.lastProjectId"/);
  assert.match(appSource, /window\.localStorage\.setItem\(LAST_PROJECT_KEY, projectId\)/);
  assert.match(appSource, /function returnToProjectHome\(\)/);
  assert.match(appSource, /window\.localStorage\.removeItem\(LAST_PROJECT_KEY\)/);
  assert.match(appSource, /aria-label=\{detailTask \? "返回上一级：议题看板" : "返回上一级：项目首页"\}/);
  assert.match(appSource, /className="detail-back-button project-up-button"[\s\S]*?<span>上一级<\/span>/);
  assert.match(styles, /\.project-up-button \{[\s\S]*?width: auto/);
});

test("the home uses the same restrained surface language as the issue board", () => {
  assert.match(appSource, /<section className="project-home project-overview-demo">/);
  assert.match(appSource, /<h1>\{viewTitles\[overviewView\]\}<\/h1>/);
  assert.match(appSource, /候选任务收件箱/);
  assert.match(appSource, /关注事项/);
  assert.match(appSource, /Codex 执行中心/);
  assert.match(appSource, /活动日志/);
  assert.match(appSource, /返回总览/);
  assert.match(appSource, /const openOverviewView = \(view: ProjectOverviewView, label: string\)/);
  assert.match(appSource, /项目进度/);
  assert.match(appSource, /任务卡片进度/);
  assert.match(appSource, /成员负载/);
  assert.match(appSource, /需要我处理/);
  assert.match(appSource, /overview-project-table/);
  assert.match(appSource, /overview-task-row/);
  assert.match(styles, /\.overview-detail-page \{/);
  assert.match(styles, /\.overview-project-table \{/);
  assert.match(styles, /\.overview-member-row \{/);
  assert.match(appSource, /健康项目/);
  assert.match(appSource, /风险项目/);
  assert.match(appSource, /待验收/);
  assert.match(appSource, /任务卡分布/);
  assert.match(appSource, /下一步/);
  assert.match(styles, /\.overview-health-pill \{/);
  assert.match(styles, /\.overview-task-stack \{/);
  assert.match(styles, /\.project-grid \{[\s\S]*?grid-template-columns:/);
  assert.match(styles, /\.project-card \{[\s\S]*?border: var\(--border-hairline\)/);
});

test("new issues stage attachments in the composer and upload them after creation", () => {
  assert.match(editorSource, /type="file"[\s\S]*?multiple/);
  assert.match(editorSource, /<PendingAttachments[\s\S]*?uploadLabel="保存后上传"/);
  assert.match(editorSource, /保存后上传/);
  assert.match(appSource, /Promise\.allSettled/);
  assert.match(appSource, /uploadAttachment\(saved\.id, file\)/);
  assert.match(appSource, /附件上传失败，可在详情页重试/);
});

test("the issue composer includes Linear-style labels and scheduling", () => {
  for (const label of ["缺陷", "特性", "for-claude", "hold", "改进", "phase-1", "phase-6"]) {
    assert.match(labelsSource, new RegExp(label));
  }
  assert.match(editorSource, /<LabelPicker/);
  assert.match(labelPickerSource, /创建 “\{normalizedSearch\}”/);
  assert.match(editorSource, /设置截止日期/);
  assert.match(editorSource, /设置重复/);
  assert.match(editorSource, /最早截止日期/);
  assert.match(editorSource, /developmentScan\.contexts/);
});

test("the current project is shown only in navigation, not in issue creation or detail properties", () => {
  assert.doesNotMatch(editorSource, /property-project|dialog-project-icon|project\?\.name/);
  assert.doesNotMatch(detailSource, /detail-property-label">项目|project-property-icon|project\.name/);
  assert.doesNotMatch(styles, /\.property-project|\.dialog-project-icon|\.project-property-icon/);
  assert.match(appSource, /createTaskRequest\(selectedProjectId, draft\)/);
  assert.match(appSource, /className="header-project-switcher"/);
});

test("the project header exposes real controls instead of decorative actions", () => {
  assert.match(appSource, /className="header-project-button"[\s\S]*?aria-haspopup="menu"/);
  assert.match(appSource, /className=\{`favorite-button[\s\S]*?aria-pressed=/);
  assert.match(appSource, /FAVORITE_PROJECTS_KEY/);
  assert.match(styles, /\.header-project-menu \{[\s\S]*?-webkit-app-region: no-drag/);
});

test("the project breadcrumb stops at the project name", () => {
  assert.match(
    appSource,
    /className="detail-back-button project-up-button"[\s\S]*?<span>上一级<\/span>[\s\S]*?selectedProjectId && <span className="breadcrumb-chevron"[\s\S]*?className="header-project-switcher"/,
  );
  assert.doesNotMatch(appSource, /className="issue-root-button"/);
  assert.doesNotMatch(appSource, /detailTask\?\.identifier \?\? "议题"/);
});

test("the collapsed Codex sidebar can be expanded immediately after the back button", () => {
  assert.match(
    appSource,
    /className="detail-back-button project-up-button"[\s\S]*?hostContext\?\.sidebarCollapsed[\s\S]*?className="detail-back-button codex-sidebar-expand-button"/,
  );
  assert.match(styles, /\.project-up-button \+ \.codex-sidebar-expand-button \{[\s\S]*?margin-left: 0;/);
});

test("the project home omits the navigation bar but keeps an invisible drag region", () => {
  assert.match(appSource, /selectedProjectId \? \([\s\S]*?<header className="workspace-header"/);
  assert.match(appSource, /className="home-window-drag-region"/);
  assert.match(styles, /\.home-window-drag-region \{[\s\S]*?position: absolute;[\s\S]*?pointer-events: none/);
});

test("realtime updates remain active on the project home and reconcile after reconnecting", () => {
  assert.match(appSource, /useEffect\(\(\) => \{\s*const source = new EventSource\("\/api\/events"\)/);
  assert.match(appSource, /event\.type\.startsWith\("task\."\)[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: affectsSelectedProject \}\)/);
  assert.match(appSource, /source\.onopen = \(\) => \{[\s\S]*?scheduleRefresh\(\{ projects: true, tasks: Boolean\(selectedProjectId\) \}\)/);
});
