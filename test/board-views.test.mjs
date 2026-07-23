import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const appSource = await readFile(new URL("../web/src/App.tsx", import.meta.url), "utf8");
const apiSource = await readFile(new URL("../web/src/api.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../web/src/types.ts", import.meta.url), "utf8");
const workflowSource = await readFile(new URL("../web/src/components/WorkflowBoard.tsx", import.meta.url), "utf8");
const workflowNodeSource = await readFile(new URL("../web/src/components/WorkflowNode.tsx", import.meta.url), "utf8");
const workflowStoreSource = await readFile(new URL("../web/src/workflowStore.ts", import.meta.url), "utf8");
const databaseSource = await readFile(new URL("../server/database.mjs", import.meta.url), "utf8");
const serverSource = await readFile(new URL("../server/app.mjs", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/styles.css", import.meta.url), "utf8");

test("the board selector exposes issue and workflow views without the old placeholders", () => {
  assert.match(appSource, /type BoardView = "issues" \| "workflow"/);
  assert.match(appSource, /useState<BoardView>\("issues"\)/);
  assert.match(appSource, />\s*议题看板\s*<\/button>/);
  assert.match(appSource, />\s*流程看板\s*<\/button>/);
  assert.match(appSource, /aria-pressed=\{boardView === "issues"\}/);
  assert.match(appSource, /aria-pressed=\{boardView === "workflow"\}/);
  assert.doesNotMatch(appSource, /<span>活跃<\/span>|<span>积压事项<\/span>|所有议题|add-view/);
});

test("workflow view lazy-loads an independent React Flow canvas while issue tools stay on the issue board", () => {
  assert.match(appSource, /boardView === "issues" && <div className="toolbar-tools">/);
  assert.match(appSource, /lazy\(\(\) => import\("\.\/components\/WorkflowBoard"\)/);
  assert.match(appSource, /boardView === "workflow" \? \([\s\S]*?<WorkflowBoard/);
  assert.match(workflowSource, /from "@xyflow\/react"/);
  assert.match(workflowSource, /aria-label="节点库"/);
  assert.match(workflowSource, /aria-label="节点配置"/);
  assert.match(workflowSource, /Issue[\s\S]*Skill[\s\S]*MCP[\s\S]*Nano Banana 生图[\s\S]*Seedance 2\.0 生视频/);
  assert.match(workflowSource, /第三方集成[\s\S]*飞书文档[\s\S]*OpenCLI[\s\S]*Cloudflare 部署[\s\S]*Vercel 部署/);
  assert.match(workflowSource, /规划[\s\S]*基础规划[\s\S]*Claude Code 规划[\s\S]*自定义规划/);
  assert.match(workflowSource, /结果[\s\S]*Codex 审核[\s\S]*Claude Code 审核/);
  assert.match(workflowSource, /const GIT_LOGO = "https:\/\/git-scm\.com\/images\/logos\/downloads\/Git-Icon-1788C\.svg"/);
  assert.match(workflowSource, /group: "第三方集成",\s*title: "Git"/);
  assert.match(workflowSource, /const INITIAL_NODE_PRESETS: PaletteItem\[\] = INITIAL_NODES\.map/);
  assert.match(workflowSource, /const NODE_LIBRARY_ITEMS = \[[\s\S]*INITIAL_NODE_PRESETS/);
  assert.match(workflowSource, /preset\.data\.kind !== "skill"[\s\S]*?preset\.data\.kind !== "mcp"/);
  assert.doesNotMatch(workflowSource, /读取任务上下文|获取项目上下文/);
  assert.doesNotMatch(workflowSource, /Codex 任务/);
  assert.match(workflowSource, /hideAttribution: true/);
  assert.doesNotMatch(workflowSource, /这是工作流 UI 示意|仅保存在当前页面|后续实现|将在后续接入/);
  assert.doesNotMatch(appSource, /workflow-board-placeholder|具体功能将在后续开发/);
  assert.match(styles, /\.workflow-board/);
  assert.match(styles, /\.view-tab\.active/);
});

test("new workflow nodes are centered in the current React Flow viewport", () => {
  assert.match(workflowSource, /canvasRef\.current!\.getBoundingClientRect\(\)/);
  assert.match(workflowSource, /flowRef\.current!\.screenToFlowPosition\(\{/);
  assert.match(workflowSource, /x: canvasBounds\.left \+ canvasBounds\.width \/ 2/);
  assert.match(workflowSource, /y: canvasBounds\.top \+ canvasBounds\.height \/ 2/);
  assert.match(workflowSource, /const NODE_ORIGIN: \[number, number\] = \[0\.5, 0\.5\]/);
  assert.match(workflowSource, /nodeOrigin=\{NODE_ORIGIN\}/);
  assert.match(workflowSource, /initialWidth: WORKFLOW_NODE_SIZE\.width/);
  assert.match(workflowSource, /initialHeight: WORKFLOW_NODE_SIZE\.height/);
  assert.doesNotMatch(workflowSource, /390 \+ \(index % 3\)|120 \+ \(index % 4\)/);
});

test("node library drags use real node previews and become plan items over planning containers", () => {
  assert.match(workflowSource, /WORKFLOW_PALETTE_MIME = "application\/x-codex-taskboard-workflow-node"/);
  assert.match(workflowSource, /PALETTE_PLAN_PREVIEW_ID = "__palette-plan-preview__"/);
  assert.match(workflowSource, /function addNodeAtPosition\([\s\S]*?planTarget\?: \{ parentId: string; targetIndex: number \}/);
  assert.match(workflowSource, /const resolvePaletteDrop[\s\S]*?screenToFlowPosition\(\{ x: clientX, y: clientY \}\)[\s\S]*?candidate\.data\.acceptsChildren[\s\S]*?containerDropOrder/);
  assert.match(workflowSource, /function startPaletteDrag[\s\S]*?setPaletteDragPreview[\s\S]*?dataTransfer\.setDragImage\(nativeDragImageRef\.current/);
  assert.match(workflowSource, /function handleCanvasDragOver[\s\S]*?resolvePaletteDrop[\s\S]*?compact[\s\S]*?PALETTE_PLAN_PREVIEW_ID/);
  assert.match(workflowSource, /function handleCanvasDrop[\s\S]*?resolvePaletteDrop[\s\S]*?addNodeAtPosition[\s\S]*?parentId: target\.parentId/);
  assert.match(workflowSource, /layoutContainerChildren\(next, planTarget\.parentId, orderedChildIds\)/);
  assert.match(workflowSource, /createPortal\([\s\S]*?workflow-palette-drag-preview[\s\S]*?<WorkflowNodeDragPreview/);
  assert.match(workflowNodeSource, /export function WorkflowNodeDragPreview[\s\S]*?if \(compact\)[\s\S]*?workflow-node-compact[\s\S]*?workflow-node-header/);
  assert.match(workflowSource, /draggable[\s\S]*?onDragStart=\{\(event\) => startPaletteDrag\(event, item\)\}[\s\S]*?onDrag=\{handlePaletteDrag\}[\s\S]*?onDragEnd=\{stopPaletteDrag\}/);
  assert.match(workflowSource, /onDragOver=\{handleCanvasDragOver\}[\s\S]*?onDrop=\{handleCanvasDrop\}/);
  assert.match(styles, /\.workflow-palette-item \{[\s\S]*?cursor: grab/);
  assert.match(styles, /\.workflow-palette-drag-preview \{[\s\S]*?position: fixed[\s\S]*?pointer-events: none/);
  assert.match(styles, /\.workflow-palette-drag-preview\.is-compact \{[\s\S]*?width: 230px[\s\S]*?height: 34px/);
  assert.match(styles, /\.workflow-canvas\.is-palette-dragging::after/);
});

test("workflow side panels independently collapse, expand and remember their state", () => {
  assert.match(workflowSource, /WORKFLOW_LIBRARY_COLLAPSED_KEY = "taskboard\.workflow\.library-collapsed"/);
  assert.match(workflowSource, /WORKFLOW_INSPECTOR_COLLAPSED_KEY = "taskboard\.workflow\.inspector-collapsed"/);
  assert.match(workflowSource, /const \[libraryCollapsed, setLibraryCollapsed\] = useState/);
  assert.match(workflowSource, /const \[inspectorCollapsed, setInspectorCollapsed\] = useState/);
  assert.match(workflowSource, /!libraryCollapsed && \([\s\S]*?className="workflow-panel-toggle"[\s\S]*?aria-label="收起节点库"/);
  assert.match(workflowSource, /libraryCollapsed && \([\s\S]*?className="workflow-toolbar-panel-toggle is-library"[\s\S]*?aria-label="展开节点库"/);
  assert.match(workflowSource, /!inspectorCollapsed && \([\s\S]*?className="workflow-panel-toggle"[\s\S]*?aria-label="收起节点配置"/);
  assert.match(workflowSource, /inspectorCollapsed && \([\s\S]*?className="workflow-toolbar-panel-toggle is-inspector"[\s\S]*?aria-label="展开节点配置"/);
  assert.match(styles, /\.workflow-board\.workflow-library-collapsed[\s\S]*?--workflow-library-width: 0px/);
  assert.match(styles, /\.workflow-board\.workflow-inspector-collapsed[\s\S]*?--workflow-inspector-width: 0px/);
  assert.match(styles, /\.workflow-library\.is-collapsed,[\s\S]*?visibility: hidden/);
  assert.doesNotMatch(styles, /--workflow-(?:library|inspector)-width: 42px/);
});

test("workflow tabs switch independent canvases and create new blank workflows", () => {
  assert.match(workflowSource, /interface WorkflowSnapshot[\s\S]*?nodes: WorkflowCanvasNode\[\][\s\S]*?edges: Edge\[\][\s\S]*?selectedNodeId/);
  assert.match(workflowSource, /const \[workflowTabs, setWorkflowTabs\] = useState<WorkflowTab\[\]>/);
  assert.match(workflowSource, /const \[activeWorkflowId, setActiveWorkflowId\] = useState/);
  assert.match(workflowSource, /workflowSnapshotsRef\.current\.set\(activeWorkflowId/);
  assert.match(workflowSource, /function activateWorkflow[\s\S]*?setNodes\(snapshot\.nodes\)[\s\S]*?setEdges\(snapshot\.edges\)/);
  assert.match(workflowSource, /function createWorkflow[\s\S]*?nodes: \[\][\s\S]*?edges: \[\][\s\S]*?setWorkflowTabs/);
  assert.match(workflowSource, /className="workflow-tabs" role="tablist"/);
  assert.match(workflowSource, /role="tab"[\s\S]*?aria-selected=\{active\}/);
  assert.match(workflowSource, /function handleWorkflowTabKeyDown[\s\S]*?ArrowLeft[\s\S]*?ArrowRight[\s\S]*?Home[\s\S]*?End/);
  assert.match(workflowSource, /aria-label="新建流程"/);
  assert.doesNotMatch(workflowSource, /<span>\{projectName\}<\/span>[\s\S]*?<strong>议题处理与交付<\/strong>/);
  assert.match(styles, /\.workflow-tab\.is-active \{/);
});

test("workflow tabs rename in place and visually merge into the canvas", () => {
  assert.match(workflowSource, /const \[renamingWorkflowId, setRenamingWorkflowId\] = useState/);
  assert.match(workflowSource, /function startWorkflowRename[\s\S]*?setWorkflowNameDraft\(workflow\.name\)[\s\S]*?setRenamingWorkflowId\(workflow\.id\)/);
  assert.match(workflowSource, /function commitWorkflowRename[\s\S]*?workflowNameDraft\.trim\(\)[\s\S]*?setWorkflowTabs/);
  assert.match(workflowSource, /onDoubleClick=\{\(\) => startWorkflowRename\(workflow\)\}/);
  assert.match(workflowSource, /aria-label="流程名称"[\s\S]*?event\.key === "Enter"[\s\S]*?event\.key === "Escape"/);
  const toolbarStyles = styles.slice(
    styles.indexOf(".workflow-canvas-toolbar {"),
    styles.indexOf(".workflow-tabs {"),
  );
  assert.doesNotMatch(toolbarStyles, /border-bottom/);
  assert.match(toolbarStyles, /box-shadow: inset 0 calc\(-1 \* var\(--border-hairline\)\) 0 var\(--border\)/);
  assert.doesNotMatch(styles, /\.workflow-tabs \{[\s\S]*?box-shadow: inset 0 calc\(-1 \* var\(--border-hairline\)\) 0 var\(--border\)/);
  assert.match(styles, /\.workflow-tab\.is-active \{[\s\S]*?margin-bottom: 0[\s\S]*?border-bottom: 0[\s\S]*?background: var\(--bg\)/);
  assert.doesNotMatch(styles, /\.workflow-tab\.is-active::after/);
  assert.match(styles, /\.workflow-tab\.is-renaming input \{/);
});

test("workflow library, tabs and inspector share one titlebar height", () => {
  assert.match(styles, /\.workflow-board \{[\s\S]*?--workflow-titlebar-height: 48px/);
  assert.match(styles, /\.workflow-panel-heading \{[\s\S]*?flex: 0 0 var\(--workflow-titlebar-height\)[\s\S]*?height: var\(--workflow-titlebar-height\)/);
  assert.match(styles, /\.workflow-canvas-toolbar \{[\s\S]*?flex: 0 0 var\(--workflow-titlebar-height\)[\s\S]*?height: var\(--workflow-titlebar-height\)/);
});

test("workflow edits persist per project and the reset layout action is removed", () => {
  assert.match(appSource, /<WorkflowBoard[\s\S]*?projectId=\{selectedProject\?\.id \?\? "local"\}/);
  assert.match(databaseSource, /CREATE TABLE IF NOT EXISTS workflow_workspaces/);
  assert.match(databaseSource, /saveWorkflowWorkspace\(projectId, expectedVersion, workspace\)/);
  assert.match(serverSource, /\/workflow-workspace/);
  assert.match(serverSource, /events\.emit\("workflow\.updated"/);
  assert.match(apiSource, /export async function getWorkflowWorkspace/);
  assert.match(apiSource, /export async function saveWorkflowWorkspace/);
  assert.match(workflowStoreSource, /WORKFLOW_STATE_KEY_PREFIX = "taskboard\.workflow\.workspace\."/);
  assert.match(workflowStoreSource, /readLegacyWorkflowWorkspace/);
  assert.match(workflowStoreSource, /clearLegacyWorkflowWorkspace/);
  assert.match(workflowSource, /getWorkflowWorkspace<WorkflowWorkspace>\(projectId/);
  assert.match(workflowSource, /saveWorkflowWorkspace\([\s\S]*?remoteVersionRef\.current/);
  assert.match(workflowSource, /saveQueueRef\.current = saveQueueRef\.current\.then/);
  assert.match(workflowSource, /mergeLegacyWorkspace/);
  assert.doesNotMatch(workflowSource, /localStorage\.setItem\(workflowStorageKey/);
  assert.doesNotMatch(workflowSource, /resetLayout|重置布局/);
  assert.doesNotMatch(styles, /workflow-reset-label|workflow-canvas-actions/);
});

test("issue workflow choices read the shared service workspace without loading React Flow", () => {
  assert.match(workflowStoreSource, /INITIAL_WORKFLOW_ID = "issue-delivery"/);
  assert.match(workflowStoreSource, /INITIAL_WORKFLOW_NAME = "议题处理与交付"/);
  assert.match(workflowStoreSource, /export function workflowOptionsFromWorkspace\(workspace: unknown\)/);
  assert.match(appSource, /getWorkflowWorkspace<unknown>\(projectId, signal\)/);
  assert.match(appSource, /event\.type === "workflow\.updated"/);
  assert.match(appSource, /setWorkflowRevision/);
  assert.doesNotMatch(appSource, /from "\.\/components\/WorkflowBoard".*workflowStorageKey/);
});

test("workflow node configuration exposes issue actions, Claude Code controls, skills and extra instructions", () => {
  assert.doesNotMatch(workflowSource, /const AVAILABLE_SKILLS/);
  assert.match(apiSource, /export async function listWorkflowCapabilities[\s\S]*?\/api\/workflow-capabilities/);
  assert.match(typesSource, /export interface WorkflowCapabilities[\s\S]*?skills: WorkflowCapabilityOption\[\][\s\S]*?mcpServers: WorkflowMcpServerOption\[\]/);
  assert.match(workflowSource, /listWorkflowCapabilities\(workspacePath, controller\.signal\)/);
  assert.match(workflowSource, /selectedNode\.data\.kind === "skill"[\s\S]*?<span>可用 Skill<\/span>[\s\S]*?workflowCapabilities\?\.skills/);
  assert.match(workflowSource, /selectedNode\.data\.kind === "mcp"[\s\S]*?<span>可用 MCP Server<\/span>[\s\S]*?selectedMcpServer/);
  assert.match(workflowSource, /未发现可用 Skill/);
  assert.match(workflowSource, /未发现可用 MCP Server/);
  assert.match(workflowSource, /selectedNode\.data\.kind === "claude-code-planning"[\s\S]*?selectedNode\.data\.kind === "claude-code-review"/);
  assert.match(workflowSource, /aria-label="Claude Code 模型"[\s\S]*?Claude Sonnet[\s\S]*?Claude Opus[\s\S]*?Claude Haiku/);
  assert.match(workflowSource, /<span>推理强度<\/span>[\s\S]*?<span>规划要求<\/span>/);
  assert.match(workflowSource, /selectedNode\.data\.kind === "issue-update"[\s\S]*?<span>议题选择<\/span>/);
  for (const action of ["改变状态", "添加评论", "添加标签", "设置优先级", "附加流程运行产物", "记录执行该议题的 Codex 对话"]) {
    assert.match(workflowSource, new RegExp(action));
  }
  assert.match(workflowSource, /<h2>额外说明<\/h2>[\s\S]*?aria-label="额外说明"/);
  assert.match(styles, /\.workflow-action-row \{/);
  assert.match(styles, /\.workflow-action-toggle input\[type="checkbox"\]/);
});

test("Git and issue nodes expose actions and render the selected action in their title", () => {
  for (const action of ["查看状态", "提交更改", "拉取更新", "推送分支", "创建分支", "切换分支", "合并分支", "创建 Worktree"]) {
    assert.match(workflowSource, new RegExp(action));
  }
  assert.match(workflowSource, /selectedNode\.data\.kind === "git"[\s\S]*?aria-label="Git 操作"/);
  assert.match(workflowSource, /aria-label="Git 提交说明"/);
  assert.match(workflowSource, /aria-label="Git 远程仓库"/);
  assert.match(workflowSource, /aria-label="Git Worktree 分支"/);
  assert.match(workflowSource, /aria-label="Git Worktree 目录"/);
  assert.match(workflowSource, /selectedNode\.data\.kind === "issue-trigger"[\s\S]*?aria-label="议题触发状态"/);
  assert.match(workflowSource, /function workflowNodeDisplayTitle[\s\S]*?data\.kind === "git"[\s\S]*?data\.kind === "issue-trigger"[\s\S]*?data\.kind === "issue-update"/);
  assert.match(workflowSource, /displayTitle: workflowNodeDisplayTitle\(node\.data\)/);
  assert.match(workflowNodeSource, /data\.displayTitle \?\? data\.title/);
});

test("the execution planning node accepts draggable compact capability modules", () => {
  assert.match(workflowSource, /kind: "basic-planning"[\s\S]*?acceptsChildren: true/);
  assert.match(workflowSource, /id: "skill"[\s\S]*?parentId: "basic-planning"/);
  assert.match(workflowSource, /id: "mcp"[\s\S]*?parentId: "basic-planning"/);
  assert.match(workflowSource, /id: "nano-banana"[\s\S]*?parentId: "basic-planning"/);
  assert.match(workflowSource, /id: "cloudflare-deploy"[\s\S]*?parentId: "basic-planning"/);
  assert.match(workflowSource, /const COMPACT_NODE_SIZE = \{ width: 230, height: 34 \}/);
  assert.match(workflowSource, /function planContainerSize\(childCount: number\)[\s\S]*?width: WORKFLOW_NODE_SIZE\.width[\s\S]*?Math\.max\([\s\S]*?WORKFLOW_NODE_SIZE\.height/);
  assert.match(workflowSource, /function compactNodePosition\(index: number\)[\s\S]*?PLAN_LIST_TOP \+ index \* \(COMPACT_NODE_SIZE\.height \+ PLAN_ITEM_GAP\)/);
  assert.match(workflowSource, /function layoutContainerChildren[\s\S]*?orderedChildIds[\s\S]*?compactNodePosition\(index\)/);
  assert.match(workflowSource, /getInternalNode\(draggedNode\.id\)[\s\S]*?internals\.positionAbsolute/);
  assert.match(workflowSource, /onNodeDrag=\{onNodeDrag\}[\s\S]*?onNodeDragStop=\{onNodeDragStop\}/);
  assert.match(workflowSource, /parentId: target\.id[\s\S]*?parentId: undefined/);
  assert.match(workflowSource, /orderedIds\.splice[\s\S]*?layoutContainerChildren\(next, target\.id, targetOrderIds\)/);
  assert.match(workflowSource, /\{ id: "plan-review", source: "basic-planning", target: "codex-review" \}/);
  assert.doesNotMatch(workflowSource, /id: "skill-image"|id: "mcp-deploy"|id: "image-review"|id: "deploy-review"/);
  assert.match(workflowSource, /orderParentsBeforeChildren/);
  assert.doesNotMatch(workflowSource, /extent: "parent"|expandParent: true/);
  assert.match(workflowNodeSource, /if \(data\.acceptsChildren\)[\s\S]*?workflow-plan-container/);
  assert.match(workflowNodeSource, /if \(parentId\)[\s\S]*?workflow-node-compact/);
  const workflowNodeComponentSource = workflowNodeSource.slice(
    workflowNodeSource.indexOf("export function WorkflowNode("),
  );
  const compactNodeBranch = workflowNodeComponentSource.slice(
    workflowNodeComponentSource.indexOf("if (parentId)"),
    workflowNodeComponentSource.indexOf("\n  return (\n    <article className={`workflow-node workflow-node-"),
  );
  assert.doesNotMatch(compactNodeBranch, /<Handle|workflow-node-menu|data\.meta/);
  assert.match(compactNodeBranch, /<WorkflowMark[\s\S]*?<strong>\{data\.displayTitle \?\? data\.title\}<\/strong>/);
  assert.match(styles, /\.workflow-plan-container \{/);
  assert.match(styles, /\.workflow-plan-container\.is-drop-target \{/);
  assert.match(styles, /\.workflow-node-compact \{/);
  assert.match(styles, /\.workflow-node-compact > strong \{/);
});

test("planning items preview their insertion rank and settle like issue cards", () => {
  assert.match(workflowSource, /interface PlanDragPreview[\s\S]*?sourceOrderIds: string\[\][\s\S]*?targetIndex: number/);
  assert.match(workflowSource, /function planItemDragShift[\s\S]*?shift -= distance[\s\S]*?shift \+= distance/);
  assert.match(workflowSource, /const onNodeDragStart[\s\S]*?planDragSessionRef\.current = session/);
  assert.match(workflowSource, /const onNodeDrag[\s\S]*?containerDropOrder[\s\S]*?setPlanDragPreview/);
  assert.match(workflowSource, /dragShiftY: planItemDragShift|const dragShiftY = planItemDragShift/);
  assert.match(workflowSource, /setSettlingNodeId\(node\.id\)[\s\S]*?setTimeout\([\s\S]*?220/);
  assert.match(workflowSource, /onNodeDragStart=\{onNodeDragStart\}[\s\S]*?onNodeDrag=\{onNodeDrag\}[\s\S]*?onNodeDragStop=\{onNodeDragStop\}/);
  assert.match(workflowNodeSource, /is-drag-shifted[\s\S]*?is-settling[\s\S]*?translate3d\(0, \$\{data\.dragShiftY\}px, 0\)/);
  assert.match(styles, /\.workflow-node-compact \{[\s\S]*?transform 160ms cubic-bezier\(0\.2, 0\.8, 0\.2, 1\)/);
  assert.match(styles, /\.workflow-node-compact\.is-drag-shifted \{[\s\S]*?will-change: transform/);
  assert.match(styles, /\.workflow-node-compact\.is-settling \{[\s\S]*?workflow-plan-item-settle 200ms/);
});
