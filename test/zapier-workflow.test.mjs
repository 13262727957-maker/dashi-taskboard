import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const board = await readFile(new URL("../web/src/components/WorkflowBoard.tsx", import.meta.url), "utf8");
const node = await readFile(new URL("../web/src/components/WorkflowNode.tsx", import.meta.url), "utf8");
const inspector = await readFile(new URL("../web/src/components/WorkflowInspector.tsx", import.meta.url), "utf8");
const picker = await readFile(new URL("../web/src/components/WorkflowStepPicker.tsx", import.meta.url), "utf8");
const styles = await readFile(new URL("../web/src/components/workflow.css", import.meta.url), "utf8");

test("workflow editing is a constrained vertical execution sequence instead of a free canvas", () => {
  assert.match(board, /orderedWorkflowStepIds/);
  assert.match(board, /layoutWorkflowSteps/);
  assert.match(board, /workflowSequenceEdges/);
  assert.match(board, /edgeTypes=\{EDGE_TYPES\}/);
  assert.match(board, /nodeOrigin=\{TOP_CENTER_ORIGIN\}/);
  assert.match(board, /nodesConnectable=\{false\}/);
  assert.match(board, /aria-label="流程编排区"/);
  assert.match(board, /instance\.setCenter\(0, 220, \{ zoom: 1 \}\)/);
  assert.doesNotMatch(board, /\n\s+fitView\n/);
  assert.doesNotMatch(board, /MiniMap|onConnect=|aria-label="节点库"|workflow-library/);
  assert.doesNotMatch(styles, /workflow-minimap|workflow-library-width|workflow-grid-dot/);
});

test("steps are inserted from the connector or sequence end through a searchable chooser", () => {
  assert.match(board, /const openStepPicker = useCallback/);
  assert.match(board, /aria-label="添加第一个步骤"/);
  assert.match(node, /aria-label="在流程末尾添加步骤"/);
  assert.match(board, /<WorkflowStepPicker/);
  assert.match(picker, /role="dialog"/);
  assert.match(picker, /aria-label="添加流程步骤"/);
  assert.match(picker, /placeholder="搜索应用或动作…"/);
  assert.match(picker, /触发器|Skill 和 MCP|API|第三方集成|规划|结果/);
  assert.match(picker, /onSelect\(item\)/);
  assert.match(styles, /\.workflow-step-picker \{/);
  assert.match(styles, /\.workflow-sequence-add \{[\s\S]*?pointer-events: all/);
});

test("compact Zapier-like step cards expose order, configuration state and real actions", () => {
  assert.match(node, /Position\.Top/);
  assert.match(node, /Position\.Bottom/);
  assert.match(node, /data\.stepNumber/);
  assert.match(node, /data\.configured \? "已配置" : "需要配置"/);
  assert.match(node, /aria-label="步骤操作"/);
  assert.match(node, />复制步骤</);
  assert.match(node, />删除步骤</);
  assert.match(node, /data\.onDuplicate/);
  assert.match(node, /data\.onDelete/);
  assert.match(styles, /\.workflow-step-card \{[\s\S]*?width: 360px[\s\S]*?min-height: 78px/);
  assert.match(styles, /\.workflow-step-card\.selected \{/);
});

test("step configuration is an on-demand right panel rather than a permanent three-column shell", () => {
  assert.match(board, /selectedNode && \([\s\S]*?<WorkflowInspector/);
  assert.match(inspector, /aria-label="关闭步骤配置"/);
  assert.match(inspector, /role="tablist"/);
  assert.match(inspector, />设置</);
  assert.match(inspector, />配置</);
  assert.match(board, /listWorkflowCapabilities/);
  assert.match(inspector, /可用 Skill/);
  assert.match(inspector, /可用 MCP Server/);
  assert.match(inspector, /额外说明/);
  assert.match(styles, /\.workflow-board\.has-inspector \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) 360px/);
  assert.doesNotMatch(styles, /\.workflow-board \{[\s\S]*?grid-template-columns: var\(--workflow-library-width\)/);
});

test("planning remains a compact ordered container inside the lighter sequence", () => {
  assert.match(node, /data\.acceptsChildren/);
  assert.match(node, /data\.onAddChild/);
  assert.match(node, /aria-label="向执行计划添加步骤"/);
  assert.match(node, /workflow-plan-item/);
  assert.match(board, /reorderPlanItem/);
  assert.match(styles, /\.workflow-plan-list \{/);
  assert.match(styles, /\.workflow-plan-item \{/);
});
