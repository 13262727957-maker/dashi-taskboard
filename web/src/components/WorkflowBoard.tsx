import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
} from "react";
import {
  addEdge,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type NodeTypes,
  type NodeChange,
  type OnNodeDrag,
  type ReactFlowInstance,
} from "@xyflow/react";
import { createPortal } from "react-dom";
import "@xyflow/react/dist/style.css";
import bytedanceLogo from "@lobehub/icons-static-svg/icons/bytedance-color.svg";
import claudeLogo from "@lobehub/icons-static-svg/icons/claude-color.svg";
import claudeCodeLogo from "@lobehub/icons-static-svg/icons/claudecode-color.svg";
import cloudflareLogo from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import codexLogo from "@lobehub/icons-static-svg/icons/codex-color.svg";
import geminiLogo from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import jimengLogo from "@lobehub/icons-static-svg/icons/jimeng-color.svg";
import klingLogo from "@lobehub/icons-static-svg/icons/kling-color.svg";
import mcpLogo from "@lobehub/icons-static-svg/icons/mcp.svg";
import midjourneyLogo from "@lobehub/icons-static-svg/icons/midjourney.svg";
import vercelLogo from "@lobehub/icons-static-svg/icons/vercel.svg";
import {
  ApiError,
  getWorkflowWorkspace,
  listWorkflowCapabilities,
  saveWorkflowWorkspace,
} from "../api";
import type { WorkflowCapabilities, WorkflowOption } from "../types";
import {
  clearLegacyWorkflowWorkspace,
  INITIAL_WORKFLOW_ID,
  INITIAL_WORKFLOW_NAME,
  readLegacyWorkflowWorkspace,
} from "../workflowStore";
import { LinearIcon } from "./LinearIcon";
import {
  WorkflowNode,
  WorkflowNodeDragPreview,
  type WorkflowCanvasNode,
  type WorkflowNodeData,
  type WorkflowNodeTone,
} from "./WorkflowNode";
import { WorkflowMark } from "./WorkflowMark";

interface WorkflowBoardProps {
  projectId: string;
  projectName: string;
  workspacePath?: string;
  revision: number;
  onWorkflowsChange: (workflows: WorkflowOption[]) => void;
}

type WorkflowGroup = "触发器" | "Skill 和 MCP" | "API" | "第三方集成" | "规划" | "结果";

interface PaletteItem {
  group: WorkflowGroup;
  title: string;
  description: string;
  data: WorkflowNodeData;
}

interface PlanDragPreview {
  nodeId: string;
  sourceParentId: string | null;
  sourceOrderIds: string[];
  targetParentId: string | null;
  targetIndex: number;
}

interface PaletteDragPreview {
  item: PaletteItem;
  clientX: number;
  clientY: number;
  compact: boolean;
  scale: number;
}

interface PaletteDropTarget {
  position: { x: number; y: number };
  parentId: string | null;
  targetIndex: number;
}

interface WorkflowTab {
  id: string;
  name: string;
}

interface WorkflowSnapshot {
  nodes: WorkflowCanvasNode[];
  edges: Edge[];
  selectedNodeId: string | null;
}

interface WorkflowWorkspace {
  version: 1;
  tabs: WorkflowTab[];
  activeWorkflowId: string;
  snapshots: Record<string, WorkflowSnapshot>;
}

const GIT_OPERATIONS = [
  { value: "status", label: "查看状态" },
  { value: "commit", label: "提交更改" },
  { value: "pull", label: "拉取更新" },
  { value: "push", label: "推送分支" },
  { value: "create-branch", label: "创建分支" },
  { value: "switch-branch", label: "切换分支" },
  { value: "merge-branch", label: "合并分支" },
  { value: "create-worktree", label: "创建 Worktree" },
] as const;
const ISSUE_STATUSES = [
  { value: "backlog", label: "积压事项" },
  { value: "todo", label: "待办事项" },
  { value: "in_progress", label: "进行中" },
  { value: "in_review", label: "审核中" },
  { value: "blocked", label: "已阻塞" },
  { value: "done", label: "完成" },
  { value: "canceled", label: "已取消" },
] as const;
const ISSUE_PRIORITIES = [
  { value: "none", label: "无优先级" },
  { value: "urgent", label: "紧急" },
  { value: "high", label: "高" },
  { value: "medium", label: "中" },
  { value: "low", label: "低" },
] as const;
const NESTABLE_TONES = new Set<WorkflowNodeTone>(["capability", "api", "integration"]);
const WORKFLOW_LIBRARY_COLLAPSED_KEY = "taskboard.workflow.library-collapsed";
const WORKFLOW_INSPECTOR_COLLAPSED_KEY = "taskboard.workflow.inspector-collapsed";
const WORKFLOW_PALETTE_MIME = "application/x-codex-taskboard-workflow-node";
const PALETTE_PLAN_PREVIEW_ID = "__palette-plan-preview__";

const NODE_TYPES = { workflow: WorkflowNode } satisfies NodeTypes;
const FEISHU_LOGO = "https://p1-hera.feishucdn.com/tos-cn-i-jbbdkfciu3/84a9f036fe2b44f99b899fff4beeb963~tplv-jbbdkfciu3-image:0:0.image";
const GIT_LOGO = "https://git-scm.com/images/logos/downloads/Git-Icon-1788C.svg";

const PALETTE_ITEMS: PaletteItem[] = [
  {
    group: "触发器",
    title: "Issue",
    description: "当议题变化时启动流程",
    data: {
      kind: "issue-trigger",
      eyebrow: "ISSUE TRIGGER",
      title: "议题触发器",
      description: "当议题满足条件时启动",
      meta: "状态、标签或优先级",
      icon: "myIssues",
      tone: "issue",
      outputLabel: "议题",
      triggerStatus: "todo",
    },
  },
  {
    group: "Skill 和 MCP",
    title: "Skill",
    description: "调用已安装的 Skill",
    data: {
      kind: "skill",
      eyebrow: "SKILL",
      title: "调用 Skill",
      description: "运行工作区中的 Skill",
      meta: "选择一个 Skill",
      icon: "file",
      tone: "capability",
      inputLabel: "上下文",
      outputLabel: "输出",
    },
  },
  {
    group: "Skill 和 MCP",
    title: "MCP",
    description: "调用 MCP 工具或资源",
    data: {
      kind: "mcp",
      eyebrow: "MCP",
      title: "调用 MCP",
      description: "连接已配置的 MCP Server",
      meta: "选择一个 MCP Server",
      icon: "panel",
      logo: mcpLogo,
      logoMonochrome: true,
      tone: "capability",
      inputLabel: "参数",
      outputLabel: "结果",
    },
  },
  {
    group: "API",
    title: "Nano Banana 生图",
    description: "调用 Gemini 图像生成能力",
    data: {
      kind: "nano-banana",
      eyebrow: "IMAGE API",
      title: "Nano Banana 生图",
      description: "根据提示词和参考图生成图像",
      meta: "Google Gemini · Image",
      icon: "send",
      logo: geminiLogo,
      tone: "api",
      inputLabel: "提示词",
      outputLabel: "图像",
    },
  },
  {
    group: "API",
    title: "即梦生图",
    description: "调用即梦 AI 图片生成",
    data: {
      kind: "jimeng-image",
      eyebrow: "IMAGE API",
      title: "即梦生图",
      description: "使用即梦模型生成图片素材",
      meta: "即梦 AI · Image",
      icon: "send",
      logo: jimengLogo,
      tone: "api",
      inputLabel: "提示词",
      outputLabel: "图像",
    },
  },
  {
    group: "API",
    title: "Midjourney 生图",
    description: "提交 Midjourney 生成任务",
    data: {
      kind: "midjourney-image",
      eyebrow: "IMAGE API",
      title: "Midjourney 生图",
      description: "通过 Midjourney 生成图片素材",
      meta: "Midjourney · Image",
      icon: "send",
      logo: midjourneyLogo,
      logoMonochrome: true,
      tone: "api",
      inputLabel: "提示词",
      outputLabel: "图像",
    },
  },
  {
    group: "API",
    title: "Seedance 2.0 生视频",
    description: "调用字节跳动视频生成模型",
    data: {
      kind: "seedance-video",
      eyebrow: "VIDEO API",
      title: "Seedance 2.0 生视频",
      description: "生成多模态音视频内容",
      meta: "ByteDance Seed · Video",
      icon: "send",
      logo: bytedanceLogo,
      tone: "api",
      inputLabel: "素材与提示词",
      outputLabel: "视频",
    },
  },
  {
    group: "API",
    title: "可灵生视频",
    description: "调用可灵 AI 视频生成",
    data: {
      kind: "kling-video",
      eyebrow: "VIDEO API",
      title: "可灵生视频",
      description: "使用可灵模型生成视频素材",
      meta: "Kling AI · Video",
      icon: "send",
      logo: klingLogo,
      tone: "api",
      inputLabel: "素材与提示词",
      outputLabel: "视频",
    },
  },
  {
    group: "API",
    title: "自定义 API 节点",
    description: "配置任意 HTTP API",
    data: {
      kind: "custom-api",
      eyebrow: "HTTP API",
      title: "自定义 API 节点",
      description: "调用自定义 HTTP 接口",
      meta: "GET、POST、PUT",
      icon: "send",
      tone: "api",
      inputLabel: "请求",
      outputLabel: "响应",
    },
  },
  {
    group: "第三方集成",
    title: "Git",
    description: "读取仓库、分支与变更信息",
    data: {
      kind: "git",
      eyebrow: "INTEGRATION",
      title: "Git",
      description: "读取或操作当前项目的 Git 仓库",
      meta: "Git · Repository",
      icon: "branch",
      logo: GIT_LOGO,
      tone: "integration",
      inputLabel: "仓库与操作",
      outputLabel: "Git 结果",
      gitOperation: "commit",
      gitCommitMessage: "",
      gitStageAll: true,
      gitRemote: "origin",
      gitBranchName: "",
      gitBaseBranch: "",
      gitWorktreePath: "",
    },
  },
  {
    group: "第三方集成",
    title: "飞书文档",
    description: "读取或写入飞书云文档",
    data: {
      kind: "feishu-docs",
      eyebrow: "INTEGRATION",
      title: "飞书文档",
      description: "连接飞书文档与知识空间",
      meta: "飞书开放平台 · Docs",
      icon: "file",
      logo: FEISHU_LOGO,
      tone: "integration",
      inputLabel: "文档参数",
      outputLabel: "文档内容",
    },
  },
  {
    group: "第三方集成",
    title: "OpenCLI",
    description: "调用网站适配器和登录态浏览器",
    data: {
      kind: "opencli",
      eyebrow: "INTEGRATION",
      title: "OpenCLI",
      description: "通过 OpenCLI 操作网站与本地工具",
      meta: "OpenCLI · Browser",
      icon: "panel",
      tone: "integration",
      inputLabel: "命令",
      outputLabel: "执行结果",
    },
  },
  {
    group: "第三方集成",
    title: "Claude Design 设计",
    description: "调用 Claude 生成设计方案",
    data: {
      kind: "claude-design",
      eyebrow: "INTEGRATION",
      title: "Claude Design 设计",
      description: "使用 Claude 完成设计与实现",
      meta: "Claude · Design",
      icon: "write",
      logo: claudeLogo,
      tone: "integration",
      inputLabel: "设计需求",
      outputLabel: "设计结果",
    },
  },
  {
    group: "第三方集成",
    title: "Cloudflare 部署",
    description: "部署 Workers、Pages 等服务",
    data: {
      kind: "cloudflare-deploy",
      eyebrow: "DEPLOYMENT",
      title: "Cloudflare 部署",
      description: "构建并部署到 Cloudflare",
      meta: "Workers · Pages",
      icon: "send",
      logo: cloudflareLogo,
      tone: "integration",
      inputLabel: "构建产物",
      outputLabel: "部署地址",
    },
  },
  {
    group: "第三方集成",
    title: "Vercel 部署",
    description: "部署项目并返回预览地址",
    data: {
      kind: "vercel-deploy",
      eyebrow: "DEPLOYMENT",
      title: "Vercel 部署",
      description: "构建并部署到 Vercel",
      meta: "Preview · Production",
      icon: "send",
      logo: vercelLogo,
      logoMonochrome: true,
      tone: "integration",
      inputLabel: "构建产物",
      outputLabel: "部署地址",
    },
  },
  {
    group: "第三方集成",
    title: "自定义集成",
    description: "连接其他第三方服务",
    data: {
      kind: "custom-integration",
      eyebrow: "INTEGRATION",
      title: "自定义集成",
      description: "通过授权或 Webhook 连接服务",
      meta: "OAuth · Webhook",
      icon: "link",
      tone: "integration",
      inputLabel: "集成参数",
      outputLabel: "执行结果",
    },
  },
  {
    group: "规划",
    title: "基础规划",
    description: "拆解步骤、依赖和验收条件",
    data: {
      kind: "basic-planning",
      eyebrow: "PLANNING",
      title: "基础规划",
      description: "根据议题生成结构化执行计划",
      meta: "内置规划器",
      icon: "dashboard",
      tone: "planning",
      inputLabel: "任务上下文",
      outputLabel: "执行计划",
      acceptsChildren: true,
    },
  },
  {
    group: "规划",
    title: "Claude Code 规划",
    description: "使用 Claude Code 生成计划",
    data: {
      kind: "claude-code-planning",
      eyebrow: "PLANNING",
      title: "Claude Code 规划",
      description: "让 Claude Code 分析并规划任务",
      meta: "Claude Code · Plan",
      icon: "dashboard",
      logo: claudeCodeLogo,
      tone: "planning",
      inputLabel: "任务上下文",
      outputLabel: "执行计划",
      claudeModel: "claude-sonnet",
      reasoningEffort: "high",
      planningRequirements: "分析依赖、风险、执行步骤和验收条件，输出可直接执行的计划。",
    },
  },
  {
    group: "规划",
    title: "自定义规划",
    description: "通过自定义提示词生成计划",
    data: {
      kind: "custom-planning",
      eyebrow: "PLANNING",
      title: "自定义规划",
      description: "使用自定义规则拆解任务",
      meta: "Prompt · 自定义",
      icon: "write",
      tone: "planning",
      inputLabel: "任务上下文",
      outputLabel: "执行计划",
    },
  },
  {
    group: "结果",
    title: "更新 Issue",
    description: "回写状态、评论和附件",
    data: {
      kind: "issue-update",
      eyebrow: "ISSUE ACTION",
      title: "更新议题",
      description: "把流程结果写回议题",
      meta: "状态、评论或附件",
      icon: "write",
      tone: "result",
      inputLabel: "流程结果",
      outputLabel: "已更新",
      issueTarget: "trigger",
      specificIssueId: "",
      changeStatus: true,
      targetStatus: "in_review",
      addComment: true,
      commentSource: "workflow-output",
      customComment: "",
      addLabels: false,
      labelsToAdd: "",
      setPriority: false,
      targetPriority: "none",
      attachArtifacts: true,
      recordConversation: true,
    },
  },
  {
    group: "结果",
    title: "Codex 审核",
    description: "由 Codex 审核结果和变更",
    data: {
      kind: "codex-review",
      eyebrow: "REVIEW",
      title: "Codex 审核",
      description: "检查实现结果、测试与验收条件",
      meta: "Codex · Review",
      icon: "check",
      logo: codexLogo,
      tone: "result",
      inputLabel: "执行结果",
      outputLabel: "审核结论",
    },
  },
  {
    group: "结果",
    title: "Claude Code 审核",
    description: "由 Claude Code 审核结果和变更",
    data: {
      kind: "claude-code-review",
      eyebrow: "REVIEW",
      title: "Claude Code 审核",
      description: "使用 Claude Code 复核实现结果",
      meta: "Claude Code · Review",
      icon: "check",
      logo: claudeCodeLogo,
      tone: "result",
      inputLabel: "执行结果",
      outputLabel: "审核结论",
      claudeModel: "claude-sonnet",
      reasoningEffort: "high",
      planningRequirements: "对照执行计划和验收条件复核变更、测试结果与潜在回归。",
    },
  },
];

function paletteData(kind: string): WorkflowNodeData {
  return PALETTE_ITEMS.find((item) => item.data.kind === kind)!.data;
}

const INITIAL_NODES: WorkflowCanvasNode[] = [
  {
    id: "issue-trigger",
    type: "workflow",
    selected: true,
    position: { x: 20, y: 220 },
    data: {
      ...paletteData("issue-trigger"),
      title: "议题触发器",
      description: "状态变为「待办事项」时触发",
      meta: "任意优先级 · 任意标签",
    },
  },
  {
    id: "basic-planning",
    type: "workflow",
    position: { x: 330, y: 153 },
    data: {
      ...paletteData("basic-planning"),
      title: "拆解议题执行计划",
      description: "生成步骤、依赖和验收条件",
      meta: "基础规划 · 当前项目",
    },
  },
  {
    id: "skill",
    type: "workflow",
    parentId: "basic-planning",
    position: { x: 10, y: 86 },
    data: {
      ...paletteData("skill"),
      title: "调用 Skill",
      description: "运行一个已安装的 Skill",
      meta: "尚未选择 Skill",
    },
  },
  {
    id: "mcp",
    type: "workflow",
    parentId: "basic-planning",
    position: { x: 10, y: 124 },
    data: {
      ...paletteData("mcp"),
      title: "调用 MCP",
      description: "连接一个已配置的 MCP Server",
      meta: "尚未选择 MCP Server",
    },
  },
  {
    id: "nano-banana",
    type: "workflow",
    parentId: "basic-planning",
    position: { x: 10, y: 162 },
    data: {
      ...paletteData("nano-banana"),
      title: "生成预览素材",
      description: "根据议题内容生成预览图",
      meta: "Nano Banana · 16:9",
    },
  },
  {
    id: "cloudflare-deploy",
    type: "workflow",
    parentId: "basic-planning",
    position: { x: 10, y: 200 },
    data: {
      ...paletteData("cloudflare-deploy"),
      title: "部署预览版本",
      description: "构建并发布项目预览",
      meta: "Cloudflare Pages · Preview",
    },
  },
  {
    id: "codex-review",
    type: "workflow",
    position: { x: 650, y: 220 },
    data: {
      ...paletteData("codex-review"),
      title: "审核交付结果",
      description: "检查产物、测试与验收条件",
      meta: "Codex · 自动审核",
    },
  },
  {
    id: "issue-update",
    type: "workflow",
    position: { x: 950, y: 220 },
    data: {
      ...paletteData("issue-update"),
      title: "提交审核",
      description: "追加结果评论并更新状态",
      meta: "状态 → 审核中",
    },
  },
];

const INITIAL_EDGES: Edge[] = [
  { id: "issue-plan", source: "issue-trigger", target: "basic-planning" },
  { id: "plan-review", source: "basic-planning", target: "codex-review" },
  { id: "review-update", source: "codex-review", target: "issue-update" },
];

const INITIAL_NODE_PRESETS: PaletteItem[] = INITIAL_NODES.map((node) => {
  const template = PALETTE_ITEMS.find((item) => item.data.kind === node.data.kind)!;
  return {
    group: template.group,
    title: node.data.title,
    description: node.data.description,
    data: { ...node.data },
  };
});

const NODE_LIBRARY_ITEMS = [
  ...PALETTE_ITEMS,
  ...INITIAL_NODE_PRESETS.filter((preset) => (
    preset.data.kind !== "skill"
    && preset.data.kind !== "mcp"
    && !PALETTE_ITEMS.some((item) => item.title === preset.title)
  )),
];

const DEFAULT_EDGE_OPTIONS = {
  type: "smoothstep",
  markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14 },
  style: { stroke: "var(--workflow-edge)", strokeWidth: 1.35 },
};
const DEFAULT_VIEWPORT = { x: 12, y: 100, zoom: 0.48 };
const NODE_ORIGIN: [number, number] = [0.5, 0.5];
const TOP_LEFT_ORIGIN: [number, number] = [0, 0];
const WORKFLOW_NODE_SIZE = { width: 250, height: 138 };
const PLAN_LIST_TOP = 86;
const PLAN_ITEM_GAP = 4;
const PLAN_CONTAINER_BOTTOM = 38;
const COMPACT_NODE_SIZE = { width: 230, height: 34 };
const INITIAL_NODE_CENTER_OFFSET = {
  x: WORKFLOW_NODE_SIZE.width / 2,
  y: WORKFLOW_NODE_SIZE.height / 2,
};
const PAN_MOUSE_BUTTONS = [1, 2];
const DELETE_KEYS = ["Backspace", "Delete"];
const PRO_OPTIONS = { hideAttribution: true };

const MINI_MAP_COLORS: Record<WorkflowNodeTone, string> = {
  issue: "#6e78df",
  capability: "#4777d4",
  api: "#2b8a66",
  integration: "#2f7f9d",
  planning: "#b7791f",
  result: "#a75ac4",
};

function compactNodePosition(index: number) {
  return {
    x: 10,
    y: PLAN_LIST_TOP + index * (COMPACT_NODE_SIZE.height + PLAN_ITEM_GAP),
  };
}

function planContainerSize(childCount: number) {
  const listHeight = childCount === 0
    ? 0
    : childCount * COMPACT_NODE_SIZE.height + (childCount - 1) * PLAN_ITEM_GAP;
  return {
    width: WORKFLOW_NODE_SIZE.width,
    height: Math.max(
      WORKFLOW_NODE_SIZE.height,
      PLAN_LIST_TOP + listHeight + PLAN_CONTAINER_BOTTOM,
    ),
  };
}

function layoutContainerChildren(
  nodes: WorkflowCanvasNode[],
  parentId: string,
  orderedChildIds: string[],
): WorkflowCanvasNode[] {
  const positions = new Map(orderedChildIds.map((id, index) => [id, compactNodePosition(index)]));
  return nodes.map((node) => (
    node.parentId === parentId && positions.has(node.id)
      ? {
          ...node,
          position: positions.get(node.id)!,
          style: COMPACT_NODE_SIZE,
          initialWidth: COMPACT_NODE_SIZE.width,
          initialHeight: COMPACT_NODE_SIZE.height,
          zIndex: 2,
        }
      : node
  ));
}

function containerDropOrder(
  instance: ReactFlowInstance<WorkflowCanvasNode, Edge>,
  parentId: string,
  draggedNodeId: string,
  absoluteCenterY: number,
) {
  const targetChildren = instance.getNodes()
    .filter((node) => node.parentId === parentId && node.id !== draggedNodeId)
    .sort((a, b) => {
      const aPosition = instance.getInternalNode(a.id)?.internals.positionAbsolute.y ?? 0;
      const bPosition = instance.getInternalNode(b.id)?.internals.positionAbsolute.y ?? 0;
      return aPosition - bPosition;
    });
  const targetIndex = targetChildren.findIndex((node) => {
    const internal = instance.getInternalNode(node.id);
    if (!internal) return false;
    const height = internal.measured.height ?? COMPACT_NODE_SIZE.height;
    return absoluteCenterY < internal.internals.positionAbsolute.y + height / 2;
  });
  const insertionIndex = targetIndex < 0 ? targetChildren.length : targetIndex;
  const orderedIds = targetChildren.map((node) => node.id);
  orderedIds.splice(insertionIndex, 0, draggedNodeId);
  return { insertionIndex, orderedIds };
}

function planItemDragShift(
  node: WorkflowCanvasNode,
  nodes: WorkflowCanvasNode[],
  preview: PlanDragPreview | null,
): number {
  if (!preview || !node.parentId || node.id === preview.nodeId) return 0;
  const distance = COMPACT_NODE_SIZE.height + PLAN_ITEM_GAP;
  let shift = 0;

  if (node.parentId === preview.sourceParentId) {
    const draggedIndex = preview.sourceOrderIds.indexOf(preview.nodeId);
    const nodeIndex = preview.sourceOrderIds.indexOf(node.id);
    if (draggedIndex >= 0 && nodeIndex > draggedIndex) shift -= distance;
  }

  if (node.parentId === preview.targetParentId) {
    const targetOrderIds = preview.targetParentId === preview.sourceParentId
      ? preview.sourceOrderIds.filter((id) => id !== preview.nodeId)
      : nodes
          .filter((candidate) => (
            candidate.parentId === preview.targetParentId && candidate.id !== preview.nodeId
          ))
          .sort((a, b) => a.position.y - b.position.y)
          .map((candidate) => candidate.id);
    const nodeIndex = targetOrderIds.indexOf(node.id);
    if (nodeIndex >= preview.targetIndex) shift += distance;
  }

  return shift;
}

function cloneInitialNodes(): WorkflowCanvasNode[] {
  const childCounts = new Map<string, number>();
  for (const node of INITIAL_NODES) {
    if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
  }
  return INITIAL_NODES.map((node) => {
    if (node.data.acceptsChildren) {
      const size = planContainerSize(childCounts.get(node.id) ?? 0);
      return {
        ...node,
        origin: TOP_LEFT_ORIGIN,
        style: size,
        initialWidth: size.width,
        initialHeight: size.height,
        data: { ...node.data },
      };
    }
    if (node.parentId) {
      return {
        ...node,
        origin: TOP_LEFT_ORIGIN,
        style: COMPACT_NODE_SIZE,
        initialWidth: COMPACT_NODE_SIZE.width,
        initialHeight: COMPACT_NODE_SIZE.height,
        zIndex: 2,
        data: { ...node.data },
      };
    }
    return {
      ...node,
      position: {
        x: node.position.x + INITIAL_NODE_CENTER_OFFSET.x,
        y: node.position.y + INITIAL_NODE_CENTER_OFFSET.y,
      },
      initialWidth: WORKFLOW_NODE_SIZE.width,
      initialHeight: WORKFLOW_NODE_SIZE.height,
      data: { ...node.data },
    };
  });
}

function cloneInitialEdges(): Edge[] {
  return INITIAL_EDGES.map((edge) => ({ ...edge }));
}

function createInitialWorkflowWorkspace(): {
  tabs: WorkflowTab[];
  activeWorkflowId: string;
  snapshots: Map<string, WorkflowSnapshot>;
} {
  return {
    tabs: [{ id: INITIAL_WORKFLOW_ID, name: INITIAL_WORKFLOW_NAME }],
    activeWorkflowId: INITIAL_WORKFLOW_ID,
    snapshots: new Map([
      [
        INITIAL_WORKFLOW_ID,
        {
          nodes: cloneInitialNodes(),
          edges: cloneInitialEdges(),
          selectedNodeId: "issue-trigger",
        },
      ],
    ]),
  };
}

function parseWorkflowWorkspace(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const stored = value as Partial<WorkflowWorkspace>;
  if (stored.version !== 1 || !Array.isArray(stored.tabs) || !stored.snapshots) return null;
  const tabs = stored.tabs.filter((tab) => (
    typeof tab?.id === "string"
    && typeof tab.name === "string"
    && tab.id.length > 0
    && tab.name.length > 0
  ));
  if (tabs.length === 0) return null;

  const snapshots = new Map<string, WorkflowSnapshot>();
  for (const tab of tabs) {
    const snapshot = stored.snapshots[tab.id];
    if (
      !snapshot
      || !Array.isArray(snapshot.nodes)
      || !Array.isArray(snapshot.edges)
      || (snapshot.selectedNodeId !== null && typeof snapshot.selectedNodeId !== "string")
    ) {
      return null;
    }
    snapshots.set(tab.id, {
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      selectedNodeId: snapshot.selectedNodeId,
    });
  }

  const activeWorkflowId = tabs.some((tab) => tab.id === stored.activeWorkflowId)
    ? stored.activeWorkflowId!
    : tabs[0].id;
  return { tabs, activeWorkflowId, snapshots };
}

function serializeWorkflowWorkspace(
  tabs: WorkflowTab[],
  activeWorkflowId: string,
  snapshots: Map<string, WorkflowSnapshot>,
): WorkflowWorkspace {
  return {
    version: 1,
    tabs,
    activeWorkflowId,
    snapshots: Object.fromEntries(tabs.map((tab) => [tab.id, snapshots.get(tab.id)!])),
  };
}

function workflowSignature(tab: WorkflowTab, snapshot: WorkflowSnapshot): string {
  return JSON.stringify({
    name: tab.name,
    nodes: snapshot.nodes,
    edges: snapshot.edges,
  });
}

function mergeLegacyWorkspace(
  remote: ReturnType<typeof createInitialWorkflowWorkspace>,
  legacy: ReturnType<typeof createInitialWorkflowWorkspace>,
) {
  const tabs = [...remote.tabs];
  const snapshots = new Map(remote.snapshots);
  for (const legacyTab of legacy.tabs) {
    const legacySnapshot = legacy.snapshots.get(legacyTab.id)!;
    const remoteTab = tabs.find((tab) => tab.id === legacyTab.id);
    if (!remoteTab) {
      tabs.push(legacyTab);
      snapshots.set(legacyTab.id, legacySnapshot);
      continue;
    }
    const remoteSnapshot = snapshots.get(remoteTab.id)!;
    if (workflowSignature(remoteTab, remoteSnapshot) === workflowSignature(legacyTab, legacySnapshot)) {
      continue;
    }
    const importedId = `workflow-imported-${crypto.randomUUID()}`;
    tabs.push({ id: importedId, name: `${legacyTab.name}（从另一入口导入）` });
    snapshots.set(importedId, legacySnapshot);
  }
  return {
    tabs,
    activeWorkflowId: remote.activeWorkflowId,
    snapshots,
  };
}

function orderParentsBeforeChildren(nodes: WorkflowCanvasNode[]): WorkflowCanvasNode[] {
  return [
    ...nodes.filter((node) => !node.parentId),
    ...nodes.filter((node) => node.parentId),
  ];
}

function isNestableNode(node: WorkflowCanvasNode): boolean {
  return !node.data.acceptsChildren && NESTABLE_TONES.has(node.data.tone);
}

function miniMapNodeColor(node: WorkflowCanvasNode): string {
  return MINI_MAP_COLORS[node.data.tone];
}

function optionLabel(
  options: readonly { value: string; label: string }[],
  value: string | undefined,
): string {
  return options.find((option) => option.value === value)?.label ?? "";
}

function selectedCapabilityValue(
  options: readonly { id: string }[],
  value: string | undefined,
): string {
  return value && options.some((option) => option.id === value) ? value : "";
}

function capabilityNodeMeta(
  data: WorkflowNodeData,
  capabilities: WorkflowCapabilities | null,
  failed: boolean,
): string {
  if (data.kind === "skill") {
    if (!capabilities) return "正在读取可用 Skill";
    if (failed) return "无法读取可用 Skill";
    const skill = capabilities.skills.find((option) => option.id === data.selectedSkill);
    if (skill) return `${skill.label} · Skill`;
    return data.selectedSkill ? "所选 Skill 当前不可用" : "尚未选择 Skill";
  }
  if (data.kind === "mcp") {
    if (!capabilities) return "正在读取可用 MCP Server";
    if (failed) return "无法读取可用 MCP Server";
    const server = capabilities.mcpServers.find((option) => option.id === data.selectedMcpServer);
    if (server) return `${server.label} · ${server.transport}`;
    return data.selectedMcpServer ? "所选 MCP Server 当前不可用" : "尚未选择 MCP Server";
  }
  return data.meta;
}

function formatActionTitle(title: string, actions: string[]): string {
  if (actions.length === 0) return title;
  const visibleActions = actions.slice(0, 2).join("、");
  const remaining = actions.length > 2 ? ` +${actions.length - 2}` : "";
  return `${title} · ${visibleActions}${remaining}`;
}

function workflowNodeDisplayTitle(data: WorkflowNodeData): string {
  if (data.kind === "git") {
    return formatActionTitle(data.title, [
      optionLabel(GIT_OPERATIONS, data.gitOperation ?? "commit"),
    ]);
  }
  if (data.kind === "issue-trigger") {
    const status = optionLabel(ISSUE_STATUSES, data.triggerStatus ?? "todo");
    return formatActionTitle(data.title, [`进入${status}`]);
  }
  if (data.kind === "issue-update") {
    const actions = [
      data.changeStatus
        ? `状态 → ${optionLabel(ISSUE_STATUSES, data.targetStatus ?? "in_review")}`
        : "",
      data.addComment ? "添加评论" : "",
      data.addLabels ? "添加标签" : "",
      data.setPriority
        ? `优先级 → ${optionLabel(ISSUE_PRIORITIES, data.targetPriority ?? "none")}`
        : "",
      data.attachArtifacts ? "附加产物" : "",
      data.recordConversation ? "记录对话" : "",
    ].filter(Boolean);
    return formatActionTitle(data.title, actions);
  }
  return data.title;
}

export function WorkflowBoard({
  projectId,
  projectName,
  workspacePath,
  revision,
  onWorkflowsChange,
}: WorkflowBoardProps) {
  const [initialWorkspace] = useState(
    () => parseWorkflowWorkspace(readLegacyWorkflowWorkspace(projectId)) ?? createInitialWorkflowWorkspace(),
  );
  const initialSnapshot = initialWorkspace.snapshots.get(initialWorkspace.activeWorkflowId)!;
  const [nodes, setNodes] = useNodesState<WorkflowCanvasNode>(initialSnapshot.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(initialSnapshot.edges);
  const [workflowTabs, setWorkflowTabs] = useState<WorkflowTab[]>(initialWorkspace.tabs);
  const [activeWorkflowId, setActiveWorkflowId] = useState(initialWorkspace.activeWorkflowId);
  const [hydrated, setHydrated] = useState(false);
  const [persistenceError, setPersistenceError] = useState("");
  const [renamingWorkflowId, setRenamingWorkflowId] = useState<string | null>(null);
  const [workflowNameDraft, setWorkflowNameDraft] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(initialSnapshot.selectedNodeId);
  const [nodeSearch, setNodeSearch] = useState("");
  const [dropTargetContainerId, setDropTargetContainerId] = useState<string | null>(null);
  const [planDragPreview, setPlanDragPreview] = useState<PlanDragPreview | null>(null);
  const [settlingNodeId, setSettlingNodeId] = useState<string | null>(null);
  const [paletteDragPreview, setPaletteDragPreview] = useState<PaletteDragPreview | null>(null);
  const [workflowCapabilities, setWorkflowCapabilities] = useState<WorkflowCapabilities | null>(null);
  const [workflowCapabilitiesFailed, setWorkflowCapabilitiesFailed] = useState(false);
  const [libraryCollapsed, setLibraryCollapsed] = useState(
    () => window.localStorage.getItem(WORKFLOW_LIBRARY_COLLAPSED_KEY) === "true",
  );
  const [inspectorCollapsed, setInspectorCollapsed] = useState(
    () => window.localStorage.getItem(WORKFLOW_INSPECTOR_COLLAPSED_KEY) === "true",
  );
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const flowRef = useRef<ReactFlowInstance<WorkflowCanvasNode, Edge> | null>(null);
  const draggedPaletteItemRef = useRef<PaletteItem | null>(null);
  const nativeDragImageRef = useRef<HTMLSpanElement | null>(null);
  const workflowNameInputRef = useRef<HTMLInputElement | null>(null);
  const cancelWorkflowRenameRef = useRef(false);
  const workflowSnapshotsRef = useRef(initialWorkspace.snapshots);
  const remoteVersionRef = useRef(0);
  const lastRemoteWorkspaceRef = useRef("");
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const planDragSessionRef = useRef<Pick<PlanDragPreview, "nodeId" | "sourceParentId" | "sourceOrderIds"> | null>(null);
  const settleTimerRef = useRef<number | null>(null);
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;
  const applyWorkspace = useCallback((workspace: ReturnType<typeof createInitialWorkflowWorkspace>) => {
    const snapshot = workspace.snapshots.get(workspace.activeWorkflowId)!;
    workflowSnapshotsRef.current = new Map(workspace.snapshots);
    setWorkflowTabs(workspace.tabs);
    setActiveWorkflowId(workspace.activeWorkflowId);
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedNodeId(snapshot.selectedNodeId);
    setRenamingWorkflowId(null);
    onWorkflowsChange(workspace.tabs);
  }, [onWorkflowsChange, setEdges, setNodes]);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    };
  }, []);
  useEffect(() => {
    let cancelled = false;
    const legacy = parseWorkflowWorkspace(readLegacyWorkflowWorkspace(projectId));

    async function hydrateWorkspace() {
      try {
        let record = await getWorkflowWorkspace<WorkflowWorkspace>(projectId);
        let workspace = parseWorkflowWorkspace(record.workspace);
        if (!workspace) {
          workspace = legacy ?? initialWorkspace;
          try {
            record = await saveWorkflowWorkspace(
              projectId,
              serializeWorkflowWorkspace(workspace.tabs, workspace.activeWorkflowId, workspace.snapshots),
              record.version,
            );
          } catch (error) {
            if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT") throw error;
            record = await getWorkflowWorkspace<WorkflowWorkspace>(projectId);
            const latest = parseWorkflowWorkspace(record.workspace);
            if (!latest) throw error;
            workspace = legacy ? mergeLegacyWorkspace(latest, legacy) : latest;
            if (
              JSON.stringify(serializeWorkflowWorkspace(
                workspace.tabs,
                workspace.activeWorkflowId,
                workspace.snapshots,
              )) !== JSON.stringify(record.workspace)
            ) {
              record = await saveWorkflowWorkspace(
                projectId,
                serializeWorkflowWorkspace(workspace.tabs, workspace.activeWorkflowId, workspace.snapshots),
                record.version,
              );
            }
          }
        } else if (legacy) {
          const merged = mergeLegacyWorkspace(workspace, legacy);
          const serializedMerged = serializeWorkflowWorkspace(
            merged.tabs,
            merged.activeWorkflowId,
            merged.snapshots,
          );
          if (JSON.stringify(serializedMerged) !== JSON.stringify(record.workspace)) {
            record = await saveWorkflowWorkspace(projectId, serializedMerged, record.version);
            workspace = merged;
          }
        }
        if (cancelled) return;
        const serialized = serializeWorkflowWorkspace(
          workspace.tabs,
          workspace.activeWorkflowId,
          workspace.snapshots,
        );
        remoteVersionRef.current = record.version;
        lastRemoteWorkspaceRef.current = JSON.stringify(serialized);
        clearLegacyWorkflowWorkspace(projectId);
        applyWorkspace(workspace);
        setPersistenceError("");
      } catch {
        if (cancelled) return;
        setPersistenceError("流程暂时无法同步到任务面板服务");
        onWorkflowsChange(initialWorkspace.tabs);
      } finally {
        if (!cancelled) setHydrated(true);
      }
    }

    void hydrateWorkspace();
    return () => {
      cancelled = true;
    };
  }, [applyWorkspace, initialWorkspace, onWorkflowsChange, projectId]);
  useEffect(() => {
    const controller = new AbortController();
    setWorkflowCapabilities(null);
    setWorkflowCapabilitiesFailed(false);
    void listWorkflowCapabilities(workspacePath, controller.signal)
      .then(setWorkflowCapabilities)
      .catch(() => {
        if (controller.signal.aborted) return;
        setWorkflowCapabilities({ skills: [], mcpServers: [] });
        setWorkflowCapabilitiesFailed(true);
      });
    return () => controller.abort();
  }, [workspacePath]);
  useEffect(() => {
    window.localStorage.setItem(WORKFLOW_LIBRARY_COLLAPSED_KEY, String(libraryCollapsed));
  }, [libraryCollapsed]);
  useEffect(() => {
    window.localStorage.setItem(WORKFLOW_INSPECTOR_COLLAPSED_KEY, String(inspectorCollapsed));
  }, [inspectorCollapsed]);
  useEffect(() => {
    workflowSnapshotsRef.current.set(activeWorkflowId, {
      nodes,
      edges,
      selectedNodeId,
    });
    const workspace = serializeWorkflowWorkspace(
      workflowTabs,
      activeWorkflowId,
      workflowSnapshotsRef.current,
    );
    onWorkflowsChange(workflowTabs);
    if (!hydrated) return;
    const serialized = JSON.stringify(workspace);
    if (serialized === lastRemoteWorkspaceRef.current) return;
    const timer = window.setTimeout(() => {
      saveQueueRef.current = saveQueueRef.current.then(async () => {
        if (!mountedRef.current || serialized === lastRemoteWorkspaceRef.current) return;
        try {
          const saved = await saveWorkflowWorkspace(
            projectId,
            workspace,
            remoteVersionRef.current,
          );
          if (!mountedRef.current) return;
          remoteVersionRef.current = saved.version;
          lastRemoteWorkspaceRef.current = serialized;
          clearLegacyWorkflowWorkspace(projectId);
          setPersistenceError("");
        } catch (error) {
          if (!mountedRef.current) return;
          if (error instanceof ApiError && error.code === "VERSION_CONFLICT") {
            try {
              const latest = await getWorkflowWorkspace<WorkflowWorkspace>(projectId);
              const latestWorkspace = parseWorkflowWorkspace(latest.workspace);
              if (latestWorkspace && mountedRef.current) {
                remoteVersionRef.current = latest.version;
                lastRemoteWorkspaceRef.current = JSON.stringify(latest.workspace);
                applyWorkspace(latestWorkspace);
                setPersistenceError("");
                return;
              }
            } catch {
              // The next local edit will retry once the service is reachable.
            }
          }
          setPersistenceError("流程保存失败，请稍后重试");
        }
      });
    }, 180);
    return () => window.clearTimeout(timer);
  }, [
    activeWorkflowId,
    applyWorkspace,
    edges,
    hydrated,
    nodes,
    onWorkflowsChange,
    projectId,
    selectedNodeId,
    workflowTabs,
  ]);
  useEffect(() => {
    if (!hydrated || revision === 0) return;
    const controller = new AbortController();
    void getWorkflowWorkspace<WorkflowWorkspace>(projectId, controller.signal)
      .then((record) => {
        if (record.version <= remoteVersionRef.current) return;
        const workspace = parseWorkflowWorkspace(record.workspace);
        if (!workspace) return;
        remoteVersionRef.current = record.version;
        lastRemoteWorkspaceRef.current = JSON.stringify(record.workspace);
        applyWorkspace(workspace);
        setPersistenceError("");
      })
      .catch((error) => {
        if ((error as Error).name !== "AbortError") {
          setPersistenceError("流程同步失败，请稍后重试");
        }
      });
    return () => controller.abort();
  }, [applyWorkspace, hydrated, projectId, revision]);
  useEffect(() => {
    if (!renamingWorkflowId) return;
    workflowNameInputRef.current?.focus();
    workflowNameInputRef.current?.select();
  }, [renamingWorkflowId]);
  const onNodesChange = useCallback((changes: NodeChange<WorkflowCanvasNode>[]) => {
    setNodes((current) => {
      const affectedParentIds = new Set(
        changes
          .filter((change) => change.type === "remove")
          .map((change) => current.find((node) => node.id === change.id)?.parentId)
          .filter((parentId): parentId is string => Boolean(parentId)),
      );
      let next = applyNodeChanges(changes, current);
      for (const parentId of affectedParentIds) {
        const orderedChildIds = next
          .filter((node) => node.parentId === parentId)
          .sort((a, b) => a.position.y - b.position.y)
          .map((node) => node.id);
        next = layoutContainerChildren(next, parentId, orderedChildIds);
      }
      return next;
    });
  }, [setNodes]);
  const renderedNodes = useMemo(() => {
    const childCounts = new Map<string, number>();
    for (const node of nodes) {
      if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
    }
    return nodes.map((node) => {
      const childCount = childCounts.get(node.id) ?? 0;
      const previewChildCount = childCount + (
        planDragPreview?.targetParentId === node.id
        && planDragPreview.sourceParentId !== node.id
          ? 1
          : 0
      );
      const size = node.data.acceptsChildren ? planContainerSize(previewChildCount) : null;
      const dragShiftY = planItemDragShift(node, nodes, planDragPreview);
      return {
        ...node,
        ...(size
          ? {
              style: size,
              initialWidth: size.width,
              initialHeight: size.height,
            }
          : {}),
        data: {
          ...node.data,
          displayTitle: workflowNodeDisplayTitle(node.data),
          meta: capabilityNodeMeta(
            node.data,
            workflowCapabilities,
            workflowCapabilitiesFailed,
          ),
          dragShiftY,
          dragActive: planDragPreview?.nodeId === node.id,
          settleActive: settlingNodeId === node.id,
          ...(node.data.acceptsChildren
            ? {
                childCount,
                dropActive: node.id === dropTargetContainerId,
              }
            : {}),
        },
      };
    });
  }, [
    dropTargetContainerId,
    nodes,
    planDragPreview,
    settlingNodeId,
    workflowCapabilities,
    workflowCapabilitiesFailed,
  ]);

  const filteredPaletteItems = useMemo(() => {
    const term = nodeSearch.trim().toLocaleLowerCase();
    if (!term) return NODE_LIBRARY_ITEMS;
    return NODE_LIBRARY_ITEMS.filter((item) => (
      `${item.title} ${item.description} ${item.group}`.toLocaleLowerCase().includes(term)
    ));
  }, [nodeSearch]);

  const onConnect = useCallback((connection: Connection) => {
    setEdges((current) => addEdge({ ...connection, ...DEFAULT_EDGE_OPTIONS }, current));
  }, [setEdges]);

  const findDropContainer = useCallback((draggedNode: WorkflowCanvasNode) => {
    const instance = flowRef.current;
    const draggedInternal = instance?.getInternalNode(draggedNode.id);
    if (!instance || !draggedInternal || !isNestableNode(draggedNode)) return null;
    const draggedWidth = draggedInternal.measured.width ?? WORKFLOW_NODE_SIZE.width;
    const draggedHeight = draggedInternal.measured.height ?? WORKFLOW_NODE_SIZE.height;
    const draggedCenter = {
      x: draggedInternal.internals.positionAbsolute.x + draggedWidth / 2,
      y: draggedInternal.internals.positionAbsolute.y + draggedHeight / 2,
    };
    return instance.getNodes().find((candidate) => {
      if (!candidate.data.acceptsChildren || candidate.id === draggedNode.id) return false;
      const internal = instance.getInternalNode(candidate.id);
      if (!internal) return false;
      const fallbackSize = planContainerSize(candidate.data.childCount ?? 0);
      const width = internal.measured.width ?? fallbackSize.width;
      const height = internal.measured.height ?? fallbackSize.height;
      return draggedCenter.x >= internal.internals.positionAbsolute.x + 12
        && draggedCenter.x <= internal.internals.positionAbsolute.x + width - 12
        && draggedCenter.y >= internal.internals.positionAbsolute.y + 12
        && draggedCenter.y <= internal.internals.positionAbsolute.y + height - 12;
    }) ?? null;
  }, []);

  const resolvePaletteDrop = useCallback((
    item: PaletteItem,
    clientX: number,
    clientY: number,
  ): PaletteDropTarget => {
    const instance = flowRef.current!;
    const position = instance.screenToFlowPosition({ x: clientX, y: clientY });
    if (item.data.acceptsChildren || !NESTABLE_TONES.has(item.data.tone)) {
      return { position, parentId: null, targetIndex: 0 };
    }
    const target = instance.getNodes().find((candidate) => {
      if (!candidate.data.acceptsChildren) return false;
      const internal = instance.getInternalNode(candidate.id);
      if (!internal) return false;
      const fallbackSize = planContainerSize(candidate.data.childCount ?? 0);
      const width = internal.measured.width ?? fallbackSize.width;
      const height = internal.measured.height ?? fallbackSize.height;
      return position.x >= internal.internals.positionAbsolute.x + 8
        && position.x <= internal.internals.positionAbsolute.x + width - 8
        && position.y >= internal.internals.positionAbsolute.y + 8
        && position.y <= internal.internals.positionAbsolute.y + height - 8;
    });
    if (!target) return { position, parentId: null, targetIndex: 0 };
    return {
      position,
      parentId: target.id,
      targetIndex: containerDropOrder(
        instance,
        target.id,
        PALETTE_PLAN_PREVIEW_ID,
        position.y,
      ).insertionIndex,
    };
  }, []);

  const onNodeDragStart = useCallback<OnNodeDrag<WorkflowCanvasNode>>((_, node) => {
    if (!isNestableNode(node)) return;
    const sourceParentId = node.parentId ?? null;
    const sourceOrderIds = sourceParentId
      ? nodes
          .filter((candidate) => candidate.parentId === sourceParentId)
          .sort((a, b) => a.position.y - b.position.y)
          .map((candidate) => candidate.id)
      : [];
    const session = { nodeId: node.id, sourceParentId, sourceOrderIds };
    planDragSessionRef.current = session;
    setPlanDragPreview({
      ...session,
      targetParentId: sourceParentId,
      targetIndex: Math.max(0, sourceOrderIds.indexOf(node.id)),
    });
    setSettlingNodeId(null);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
  }, [nodes]);

  const onNodeDrag = useCallback<OnNodeDrag<WorkflowCanvasNode>>((_, node) => {
    const session = planDragSessionRef.current;
    if (!session || session.nodeId !== node.id) return;
    const instance = flowRef.current;
    const internal = instance?.getInternalNode(node.id);
    const target = findDropContainer(node);
    if (!instance || !internal) return;
    const height = internal.measured.height ?? (
      node.parentId ? COMPACT_NODE_SIZE.height : WORKFLOW_NODE_SIZE.height
    );
    const absoluteCenterY = internal.internals.positionAbsolute.y + height / 2;
    const targetIndex = target
      ? containerDropOrder(instance, target.id, node.id, absoluteCenterY).insertionIndex
      : 0;
    setDropTargetContainerId((current) => current === target?.id ? current : target?.id ?? null);
    setPlanDragPreview((current) => (
      current
      && current.targetParentId === (target?.id ?? null)
      && current.targetIndex === targetIndex
        ? current
        : {
            ...session,
            targetParentId: target?.id ?? null,
            targetIndex,
          }
    ));
  }, [findDropContainer]);

  const onNodeDragStop = useCallback<OnNodeDrag<WorkflowCanvasNode>>((_, node) => {
    setDropTargetContainerId(null);
    setPlanDragPreview(null);
    planDragSessionRef.current = null;
    if (!isNestableNode(node)) return;
    const instance = flowRef.current;
    const internal = instance?.getInternalNode(node.id);
    if (!instance || !internal) return;
    const width = internal.measured.width ?? (node.parentId ? COMPACT_NODE_SIZE.width : WORKFLOW_NODE_SIZE.width);
    const height = internal.measured.height ?? (node.parentId ? COMPACT_NODE_SIZE.height : WORKFLOW_NODE_SIZE.height);
    const absoluteCenter = {
      x: internal.internals.positionAbsolute.x + width / 2,
      y: internal.internals.positionAbsolute.y + height / 2,
    };
    const target = findDropContainer(node);
    const targetInternal = target ? instance.getInternalNode(target.id) : null;
    const targetOrderIds = target
      ? containerDropOrder(instance, target.id, node.id, absoluteCenter.y).orderedIds
      : [];

    setNodes((current) => {
      const dragged = current.find((candidate) => candidate.id === node.id);
      if (!dragged) return current;
      let next = current;
      if (target && targetInternal) {
        next = current.map((candidate) => (
          candidate.id === node.id
            ? {
                ...candidate,
                parentId: target.id,
                origin: TOP_LEFT_ORIGIN,
                position: compactNodePosition(0),
                style: COMPACT_NODE_SIZE,
                initialWidth: COMPACT_NODE_SIZE.width,
                initialHeight: COMPACT_NODE_SIZE.height,
                zIndex: 2,
              }
            : candidate
        ));
      } else if (dragged.parentId) {
        next = current.map((candidate) => (
          candidate.id === node.id
            ? {
                ...candidate,
                parentId: undefined,
                origin: undefined,
                position: absoluteCenter,
                style: undefined,
                initialWidth: WORKFLOW_NODE_SIZE.width,
                initialHeight: WORKFLOW_NODE_SIZE.height,
                zIndex: undefined,
              }
            : candidate
        ));
      } else {
        return current;
      }

      if (dragged.parentId && dragged.parentId !== target?.id) {
        const oldOrderIds = next
          .filter((candidate) => candidate.parentId === dragged.parentId)
          .sort((a, b) => a.position.y - b.position.y)
          .map((candidate) => candidate.id);
        next = layoutContainerChildren(next, dragged.parentId, oldOrderIds);
      }
      if (target) {
        next = layoutContainerChildren(next, target.id, targetOrderIds);
      }
      return orderParentsBeforeChildren(next);
    });
    if (target || node.parentId) {
      setSettlingNodeId(node.id);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        setSettlingNodeId((current) => current === node.id ? null : current);
        settleTimerRef.current = null;
      }, 220);
    }
  }, [findDropContainer, setNodes]);

  function addNodeAtPosition(
    item: PaletteItem,
    position: { x: number; y: number },
    planTarget?: { parentId: string; targetIndex: number },
  ) {
    const id = `${item.data.kind}-${crypto.randomUUID()}`;
    const emptyPlanSize = planContainerSize(0);
    const node: WorkflowCanvasNode = planTarget
      ? {
          id,
          type: "workflow",
          parentId: planTarget.parentId,
          origin: TOP_LEFT_ORIGIN,
          position: compactNodePosition(planTarget.targetIndex),
          style: COMPACT_NODE_SIZE,
          initialWidth: COMPACT_NODE_SIZE.width,
          initialHeight: COMPACT_NODE_SIZE.height,
          zIndex: 2,
          data: { ...item.data },
        }
      : item.data.acceptsChildren
      ? {
          id,
          type: "workflow",
          origin: TOP_LEFT_ORIGIN,
          position: {
            x: position.x - emptyPlanSize.width / 2,
            y: position.y - emptyPlanSize.height / 2,
          },
          style: emptyPlanSize,
          initialWidth: emptyPlanSize.width,
          initialHeight: emptyPlanSize.height,
          data: { ...item.data },
        }
      : {
          id,
          type: "workflow",
          position,
          initialWidth: WORKFLOW_NODE_SIZE.width,
          initialHeight: WORKFLOW_NODE_SIZE.height,
          data: { ...item.data },
        };
    setNodes((current) => {
      const next = [
        ...current.map((currentNode) => ({ ...currentNode, selected: false })),
        { ...node, selected: true },
      ];
      if (!planTarget) return next;
      const orderedChildIds = current
        .filter((currentNode) => currentNode.parentId === planTarget.parentId)
        .sort((a, b) => a.position.y - b.position.y)
        .map((currentNode) => currentNode.id);
      orderedChildIds.splice(
        Math.min(planTarget.targetIndex, orderedChildIds.length),
        0,
        id,
      );
      return orderParentsBeforeChildren(
        layoutContainerChildren(next, planTarget.parentId, orderedChildIds),
      );
    });
    setSelectedNodeId(id);
    if (planTarget) {
      setSettlingNodeId(id);
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = window.setTimeout(() => {
        setSettlingNodeId((current) => current === id ? null : current);
        settleTimerRef.current = null;
      }, 220);
    }
  }

  function addNode(item: PaletteItem) {
    const canvasBounds = canvasRef.current!.getBoundingClientRect();
    const position = flowRef.current!.screenToFlowPosition({
      x: canvasBounds.left + canvasBounds.width / 2,
      y: canvasBounds.top + canvasBounds.height / 2,
    });
    addNodeAtPosition(item, position);
  }

  function startPaletteDrag(event: DragEvent<HTMLButtonElement>, item: PaletteItem) {
    draggedPaletteItemRef.current = item;
    setPaletteDragPreview({
      item,
      clientX: event.clientX,
      clientY: event.clientY,
      compact: false,
      scale: flowRef.current?.getViewport().zoom ?? DEFAULT_VIEWPORT.zoom,
    });
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData(WORKFLOW_PALETTE_MIME, item.data.kind);
    event.dataTransfer.setData("text/plain", item.title);
    if (nativeDragImageRef.current) {
      event.dataTransfer.setDragImage(nativeDragImageRef.current, 0, 0);
    }
  }

  function handlePaletteDrag(event: DragEvent<HTMLButtonElement>) {
    if (event.clientX === 0 && event.clientY === 0) return;
    setPaletteDragPreview((current) => current
      ? { ...current, clientX: event.clientX, clientY: event.clientY }
      : current);
  }

  function stopPaletteDrag() {
    draggedPaletteItemRef.current = null;
    setPaletteDragPreview(null);
    setDropTargetContainerId(null);
    setPlanDragPreview(null);
  }

  function handleWorkflowDragOver(event: DragEvent<HTMLElement>) {
    if (!draggedPaletteItemRef.current || event.clientX === 0 || event.clientY === 0) return;
    const insideCanvas = event.target instanceof Node
      && Boolean(canvasRef.current?.contains(event.target));
    setPaletteDragPreview((current) => current
      ? {
          ...current,
          clientX: event.clientX,
          clientY: event.clientY,
          ...(!insideCanvas ? { compact: false } : {}),
        }
      : current);
    if (!insideCanvas) {
      setDropTargetContainerId(null);
      setPlanDragPreview(null);
    }
  }

  function handleCanvasDragOver(event: DragEvent<HTMLDivElement>) {
    const item = draggedPaletteItemRef.current;
    if (!item || !flowRef.current) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    const target = resolvePaletteDrop(item, event.clientX, event.clientY);
    const compact = Boolean(target.parentId);
    setPaletteDragPreview((current) => current
      ? {
          ...current,
          clientX: event.clientX,
          clientY: event.clientY,
          compact,
          scale: flowRef.current!.getViewport().zoom,
        }
      : current);
    setDropTargetContainerId(target.parentId);
    setPlanDragPreview(target.parentId
      ? {
          nodeId: PALETTE_PLAN_PREVIEW_ID,
          sourceParentId: null,
          sourceOrderIds: [],
          targetParentId: target.parentId,
          targetIndex: target.targetIndex,
        }
      : null);
  }

  function handleCanvasDrop(event: DragEvent<HTMLDivElement>) {
    const item = draggedPaletteItemRef.current;
    const instance = flowRef.current;
    if (!item || !instance) return;
    event.preventDefault();
    const target = resolvePaletteDrop(item, event.clientX, event.clientY);
    addNodeAtPosition(
      item,
      target.position,
      target.parentId
        ? { parentId: target.parentId, targetIndex: target.targetIndex }
        : undefined,
    );
    stopPaletteDrag();
  }

  function stopWorkflowInteraction() {
    setPlanDragPreview(null);
    setDropTargetContainerId(null);
    setSettlingNodeId(null);
    planDragSessionRef.current = null;
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }

  function activateWorkflow(workflowId: string) {
    if (workflowId === activeWorkflowId) return;
    const snapshot = workflowSnapshotsRef.current.get(workflowId);
    if (!snapshot) return;
    stopWorkflowInteraction();
    setActiveWorkflowId(workflowId);
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedNodeId(snapshot.selectedNodeId);
    requestAnimationFrame(() => {
      if (snapshot.nodes.length > 0) {
        void flowRef.current?.fitView({ padding: 0.16, duration: 240 });
      } else {
        void flowRef.current?.setViewport(DEFAULT_VIEWPORT, { duration: 240 });
      }
    });
  }

  function createWorkflow() {
    const workflowId = `workflow-${crypto.randomUUID()}`;
    const workflowName = `未命名流程 ${workflowTabs.length + 1}`;
    workflowSnapshotsRef.current.set(workflowId, {
      nodes: [],
      edges: [],
      selectedNodeId: null,
    });
    stopWorkflowInteraction();
    setWorkflowTabs((current) => [...current, { id: workflowId, name: workflowName }]);
    setActiveWorkflowId(workflowId);
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    requestAnimationFrame(() => {
      void flowRef.current?.setViewport(DEFAULT_VIEWPORT, { duration: 240 });
    });
  }

  function handleWorkflowTabKeyDown(
    event: KeyboardEvent<HTMLButtonElement>,
    workflowId: string,
  ) {
    const currentIndex = workflowTabs.findIndex((workflow) => workflow.id === workflowId);
    let targetIndex = currentIndex;
    if (event.key === "ArrowLeft") targetIndex = (currentIndex - 1 + workflowTabs.length) % workflowTabs.length;
    else if (event.key === "ArrowRight") targetIndex = (currentIndex + 1) % workflowTabs.length;
    else if (event.key === "Home") targetIndex = 0;
    else if (event.key === "End") targetIndex = workflowTabs.length - 1;
    else return;
    event.preventDefault();
    const target = workflowTabs[targetIndex];
    activateWorkflow(target.id);
    requestAnimationFrame(() => {
      document.getElementById(`workflow-tab-${target.id}`)?.focus();
    });
  }

  function startWorkflowRename(workflow: WorkflowTab) {
    if (workflow.id !== activeWorkflowId) activateWorkflow(workflow.id);
    cancelWorkflowRenameRef.current = false;
    setWorkflowNameDraft(workflow.name);
    setRenamingWorkflowId(workflow.id);
  }

  function commitWorkflowRename(workflowId: string) {
    if (cancelWorkflowRenameRef.current) {
      cancelWorkflowRenameRef.current = false;
      return;
    }
    const name = workflowNameDraft.trim();
    if (name) {
      setWorkflowTabs((current) => current.map((workflow) => (
        workflow.id === workflowId ? { ...workflow, name } : workflow
      )));
    }
    setRenamingWorkflowId(null);
    setWorkflowNameDraft("");
  }

  function cancelWorkflowRename(workflowId: string) {
    cancelWorkflowRenameRef.current = true;
    setRenamingWorkflowId(null);
    setWorkflowNameDraft("");
    requestAnimationFrame(() => {
      document.getElementById(`workflow-tab-${workflowId}`)?.focus();
    });
  }

  function updateSelectedNode(changes: Partial<WorkflowNodeData>) {
    if (!selectedNodeId) return;
    setNodes((current) => current.map((node) => (
      node.id === selectedNodeId
        ? { ...node, data: { ...node.data, ...changes } }
        : node
    )));
  }

  const paletteGroups = [...new Set(filteredPaletteItems.map((item) => item.group))];

  return (
    <section
      className={`workflow-board${libraryCollapsed ? " workflow-library-collapsed" : ""}${inspectorCollapsed ? " workflow-inspector-collapsed" : ""}`}
      aria-label="流程看板"
      onDragOver={handleWorkflowDragOver}
    >
      <span ref={nativeDragImageRef} className="workflow-native-drag-image" aria-hidden="true" />
      {paletteDragPreview && createPortal(
        <div
          className={`workflow-palette-drag-preview${paletteDragPreview.compact ? " is-compact" : ""}${paletteDragPreview.item.data.acceptsChildren ? " is-plan" : ""}`}
          style={{
            left: paletteDragPreview.clientX,
            top: paletteDragPreview.clientY,
            transform: `translate(-50%, -50%) scale(${paletteDragPreview.scale})`,
          }}
          aria-hidden="true"
        >
          <WorkflowNodeDragPreview
            compact={paletteDragPreview.compact}
            data={{
              ...paletteDragPreview.item.data,
              displayTitle: workflowNodeDisplayTitle(paletteDragPreview.item.data),
            }}
          />
        </div>,
        document.body,
      )}
      <aside
        className={`workflow-library${libraryCollapsed ? " is-collapsed" : ""}`}
        aria-label="节点库"
      >
        <div className="workflow-panel-heading">
          <span className="workflow-panel-heading-label">节点</span>
          {!libraryCollapsed && (
            <button
              className="workflow-panel-toggle"
              type="button"
              aria-label="收起节点库"
              aria-expanded="true"
              title="收起节点库"
              onClick={() => setLibraryCollapsed(true)}
            >
              <LinearIcon name="chevronLeft" />
            </button>
          )}
        </div>
        <label className="workflow-node-search">
          <LinearIcon name="search" />
          <span className="sr-only">搜索节点</span>
          <input
            type="search"
            value={nodeSearch}
            placeholder="搜索节点…"
            onChange={(event) => setNodeSearch(event.target.value)}
          />
        </label>
        <div className="workflow-node-groups">
          {paletteGroups.map((group) => (
            <section className="workflow-node-group" key={group}>
              <h2>{group}</h2>
              {filteredPaletteItems.filter((item) => item.group === group).map((item) => (
                <button
                  className={`workflow-palette-item workflow-palette-${item.data.tone}`}
                  type="button"
                  draggable
                  aria-label={`添加 ${item.title}，可拖拽到画布`}
                  key={`${item.data.kind}:${item.title}`}
                  onClick={() => addNode(item)}
                  onDragStart={(event) => startPaletteDrag(event, item)}
                  onDrag={handlePaletteDrag}
                  onDragEnd={stopPaletteDrag}
                >
                  <span className="workflow-palette-icon" aria-hidden="true">
                    <WorkflowMark
                      icon={item.data.icon}
                      logo={item.data.logo}
                      logoMonochrome={item.data.logoMonochrome}
                    />
                  </span>
                  <span>
                    <strong>{item.title}</strong>
                    <small>{item.description}</small>
                  </span>
                  <LinearIcon className="workflow-palette-add" name="plus" />
                </button>
              ))}
            </section>
          ))}
          {filteredPaletteItems.length === 0 && <p className="workflow-library-empty">没有匹配的节点</p>}
        </div>
      </aside>

      <div className="workflow-canvas-shell">
        <div className="workflow-canvas-toolbar">
          {libraryCollapsed && (
            <button
              className="workflow-toolbar-panel-toggle is-library"
              type="button"
              aria-label="展开节点库"
              aria-expanded="false"
              title="展开节点库"
              onClick={() => setLibraryCollapsed(false)}
            >
              <LinearIcon name="chevronRight" />
            </button>
          )}
          <div className="workflow-tabs" role="tablist" aria-label={`${projectName} 的流程`}>
            {workflowTabs.map((workflow) => {
              const active = workflow.id === activeWorkflowId;
              if (workflow.id === renamingWorkflowId) {
                return (
                  <div
                    id={`workflow-tab-${workflow.id}`}
                    className={`workflow-tab is-renaming${active ? " is-active" : ""}`}
                    role="tab"
                    aria-controls="workflow-canvas-panel"
                    aria-selected={active}
                    key={workflow.id}
                  >
                    <LinearIcon name="dashboard" />
                    <input
                      ref={workflowNameInputRef}
                      type="text"
                      aria-label="流程名称"
                      value={workflowNameDraft}
                      onChange={(event) => setWorkflowNameDraft(event.target.value)}
                      onBlur={() => commitWorkflowRename(workflow.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        } else if (event.key === "Escape") {
                          event.preventDefault();
                          cancelWorkflowRename(workflow.id);
                        }
                      }}
                    />
                  </div>
                );
              }
              return (
                <button
                  id={`workflow-tab-${workflow.id}`}
                  className={`workflow-tab${active ? " is-active" : ""}`}
                  type="button"
                  role="tab"
                  aria-controls="workflow-canvas-panel"
                  aria-selected={active}
                  tabIndex={active ? 0 : -1}
                  key={workflow.id}
                  onClick={() => activateWorkflow(workflow.id)}
                  onDoubleClick={() => startWorkflowRename(workflow)}
                  onKeyDown={(event) => handleWorkflowTabKeyDown(event, workflow.id)}
                  title="双击重命名"
                >
                  <LinearIcon name="dashboard" />
                  <span>{workflow.name}</span>
                </button>
              );
            })}
            <button
              className="workflow-tab-add"
              type="button"
              aria-label="新建流程"
              title="新建流程"
              onClick={createWorkflow}
            >
              <LinearIcon name="plus" />
            </button>
          </div>
          {persistenceError && (
            <span className="workflow-persistence-error" role="alert">{persistenceError}</span>
          )}
          {inspectorCollapsed && (
            <button
              className="workflow-toolbar-panel-toggle is-inspector"
              type="button"
              aria-label="展开节点配置"
              aria-expanded="false"
              title="展开节点配置"
              onClick={() => setInspectorCollapsed(false)}
            >
              <LinearIcon name="chevronLeft" />
            </button>
          )}
        </div>
        <div
          className={`workflow-canvas${paletteDragPreview ? " is-palette-dragging" : ""}`}
          id="workflow-canvas-panel"
          ref={canvasRef}
          role="tabpanel"
          aria-labelledby={`workflow-tab-${activeWorkflowId}`}
          onDragOver={handleCanvasDragOver}
          onDrop={handleCanvasDrop}
        >
          <ReactFlow<WorkflowCanvasNode, Edge>
            nodes={renderedNodes}
            edges={edges}
            nodeTypes={NODE_TYPES}
            nodeOrigin={NODE_ORIGIN}
            defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onInit={(instance) => {
              flowRef.current = instance;
            }}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId(null)}
            defaultViewport={DEFAULT_VIEWPORT}
            proOptions={PRO_OPTIONS}
            minZoom={0.35}
            maxZoom={1.6}
            selectionOnDrag
            panOnScroll
            panOnDrag={PAN_MOUSE_BUTTONS}
            zoomOnDoubleClick={false}
            deleteKeyCode={DELETE_KEYS}
          >
            <Background
              color="var(--workflow-grid-dot)"
              gap={22}
              size={1.2}
              variant={BackgroundVariant.Dots}
            />
            <Controls className="workflow-flow-controls" showInteractive={false} />
            <MiniMap
              className="workflow-minimap"
              pannable
              zoomable
              nodeColor={miniMapNodeColor}
              maskColor="var(--workflow-minimap-mask)"
            />
          </ReactFlow>
        </div>
      </div>

      <aside
        className={`workflow-inspector${inspectorCollapsed ? " is-collapsed" : ""}`}
        aria-label="节点配置"
      >
        <div className="workflow-panel-heading">
          <span className="workflow-panel-heading-label">配置</span>
          {!inspectorCollapsed && (
            <button
              className="workflow-panel-toggle"
              type="button"
              aria-label="收起节点配置"
              aria-expanded="true"
              title="收起节点配置"
              onClick={() => setInspectorCollapsed(true)}
            >
              <LinearIcon name="chevronRight" />
            </button>
          )}
        </div>
        {selectedNode ? (
          <div className="workflow-inspector-content">
            <div className={`workflow-inspector-title workflow-inspector-${selectedNode.data.tone}`}>
              <span aria-hidden="true">
                <WorkflowMark
                  icon={selectedNode.data.icon}
                  logo={selectedNode.data.logo}
                  logoMonochrome={selectedNode.data.logoMonochrome}
                />
              </span>
              <div>
                <small>{selectedNode.data.eyebrow}</small>
                <strong>{workflowNodeDisplayTitle(selectedNode.data)}</strong>
              </div>
            </div>
            <div className="workflow-config-section">
              <h2>常规</h2>
              <label>
                <span>节点名称</span>
                <input
                  type="text"
                  value={selectedNode.data.title}
                  onChange={(event) => updateSelectedNode({ title: event.target.value })}
                />
              </label>
              <label>
                <span>说明</span>
                <textarea
                  rows={3}
                  value={selectedNode.data.description}
                  onChange={(event) => updateSelectedNode({ description: event.target.value })}
                />
              </label>
            </div>
            {selectedNode.data.kind === "skill" && (
              <div className="workflow-config-section">
                <h2>Skill</h2>
                <label>
                  <span>可用 Skill</span>
                  <select
                    aria-label="可用 Skill"
                    value={selectedCapabilityValue(
                      workflowCapabilities?.skills ?? [],
                      selectedNode.data.selectedSkill,
                    )}
                    disabled={
                      !workflowCapabilities
                      || workflowCapabilitiesFailed
                      || workflowCapabilities.skills.length === 0
                    }
                    onChange={(event) => updateSelectedNode({
                      selectedSkill: event.target.value,
                      meta: `${event.target.selectedOptions[0].text} · Skill`,
                    })}
                  >
                    <option value="" disabled>
                      {!workflowCapabilities
                        ? "正在读取可用 Skill…"
                        : workflowCapabilitiesFailed
                          ? "读取可用 Skill 失败"
                          : workflowCapabilities.skills.length === 0
                            ? "未发现可用 Skill"
                            : "请选择 Skill"}
                    </option>
                    {(workflowCapabilities?.skills ?? []).map((skill) => (
                      <option key={skill.id} value={skill.id}>{skill.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {selectedNode.data.kind === "mcp" && (
              <div className="workflow-config-section">
                <h2>MCP</h2>
                <label>
                  <span>可用 MCP Server</span>
                  <select
                    aria-label="可用 MCP Server"
                    value={selectedCapabilityValue(
                      workflowCapabilities?.mcpServers ?? [],
                      selectedNode.data.selectedMcpServer,
                    )}
                    disabled={
                      !workflowCapabilities
                      || workflowCapabilitiesFailed
                      || workflowCapabilities.mcpServers.length === 0
                    }
                    onChange={(event) => {
                      const server = workflowCapabilities?.mcpServers.find(
                        (option) => option.id === event.target.value,
                      );
                      updateSelectedNode({
                        selectedMcpServer: event.target.value,
                        meta: server ? `${server.label} · ${server.transport}` : "尚未选择 MCP Server",
                      });
                    }}
                  >
                    <option value="" disabled>
                      {!workflowCapabilities
                        ? "正在读取可用 MCP Server…"
                        : workflowCapabilitiesFailed
                          ? "读取可用 MCP Server 失败"
                          : workflowCapabilities.mcpServers.length === 0
                            ? "未发现可用 MCP Server"
                            : "请选择 MCP Server"}
                    </option>
                    {(workflowCapabilities?.mcpServers ?? []).map((server) => (
                      <option key={server.id} value={server.id}>
                        {server.label} · {server.transport}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {selectedNode.data.kind === "git" && (
              <div className="workflow-config-section">
                <h2>Git 操作</h2>
                <label>
                  <span>操作</span>
                  <select
                    aria-label="Git 操作"
                    value={selectedNode.data.gitOperation ?? "commit"}
                    onChange={(event) => updateSelectedNode({ gitOperation: event.target.value })}
                  >
                    {GIT_OPERATIONS.map((operation) => (
                      <option key={operation.value} value={operation.value}>{operation.label}</option>
                    ))}
                  </select>
                </label>
                {selectedNode.data.gitOperation === "commit" && (
                  <>
                    <label>
                      <span>提交说明</span>
                      <input
                        aria-label="Git 提交说明"
                        type="text"
                        value={selectedNode.data.gitCommitMessage ?? ""}
                        placeholder="描述本次变更"
                        onChange={(event) => updateSelectedNode({ gitCommitMessage: event.target.value })}
                      />
                    </label>
                    <label className="workflow-action-toggle workflow-action-toggle-full">
                      <input
                        type="checkbox"
                        checked={selectedNode.data.gitStageAll ?? true}
                        onChange={(event) => updateSelectedNode({ gitStageAll: event.target.checked })}
                      />
                      <span>提交前暂存全部变更</span>
                    </label>
                  </>
                )}
                {(selectedNode.data.gitOperation === "pull"
                  || selectedNode.data.gitOperation === "push") && (
                  <>
                    <label>
                      <span>远程仓库</span>
                      <input
                        aria-label="Git 远程仓库"
                        type="text"
                        value={selectedNode.data.gitRemote ?? "origin"}
                        placeholder="origin"
                        onChange={(event) => updateSelectedNode({ gitRemote: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>分支</span>
                      <input
                        aria-label="Git 分支"
                        type="text"
                        value={selectedNode.data.gitBranchName ?? ""}
                        placeholder="留空使用当前分支"
                        onChange={(event) => updateSelectedNode({ gitBranchName: event.target.value })}
                      />
                    </label>
                  </>
                )}
                {(selectedNode.data.gitOperation === "create-branch"
                  || selectedNode.data.gitOperation === "switch-branch"
                  || selectedNode.data.gitOperation === "merge-branch") && (
                  <label>
                    <span>分支名称</span>
                    <input
                      aria-label="Git 分支名称"
                      type="text"
                      value={selectedNode.data.gitBranchName ?? ""}
                      placeholder="feature/workflow"
                      onChange={(event) => updateSelectedNode({ gitBranchName: event.target.value })}
                    />
                  </label>
                )}
                {(selectedNode.data.gitOperation === "create-branch"
                  || selectedNode.data.gitOperation === "create-worktree") && (
                  <label>
                    <span>基于分支</span>
                    <input
                      aria-label="Git 基于分支"
                      type="text"
                      value={selectedNode.data.gitBaseBranch ?? ""}
                      placeholder="留空使用当前分支"
                      onChange={(event) => updateSelectedNode({ gitBaseBranch: event.target.value })}
                    />
                  </label>
                )}
                {selectedNode.data.gitOperation === "create-worktree" && (
                  <>
                    <label>
                      <span>Worktree 分支</span>
                      <input
                        aria-label="Git Worktree 分支"
                        type="text"
                        value={selectedNode.data.gitBranchName ?? ""}
                        placeholder="feature/workflow"
                        onChange={(event) => updateSelectedNode({ gitBranchName: event.target.value })}
                      />
                    </label>
                    <label>
                      <span>Worktree 目录</span>
                      <input
                        aria-label="Git Worktree 目录"
                        type="text"
                        value={selectedNode.data.gitWorktreePath ?? ""}
                        placeholder="../project-worktree"
                        onChange={(event) => updateSelectedNode({ gitWorktreePath: event.target.value })}
                      />
                    </label>
                  </>
                )}
              </div>
            )}
            {(selectedNode.data.kind === "claude-code-planning"
              || selectedNode.data.kind === "claude-code-review") && (
              <div className="workflow-config-section">
                <h2>Claude Code</h2>
                <label>
                  <span>模型</span>
                  <select
                    aria-label="Claude Code 模型"
                    value={selectedNode.data.claudeModel ?? "claude-sonnet"}
                    onChange={(event) => updateSelectedNode({ claudeModel: event.target.value })}
                  >
                    <option value="claude-sonnet">Claude Sonnet</option>
                    <option value="claude-opus">Claude Opus</option>
                    <option value="claude-haiku">Claude Haiku</option>
                  </select>
                </label>
                <label>
                  <span>推理强度</span>
                  <select
                    aria-label="推理强度"
                    value={selectedNode.data.reasoningEffort ?? "high"}
                    onChange={(event) => updateSelectedNode({ reasoningEffort: event.target.value })}
                  >
                    <option value="low">低</option>
                    <option value="medium">中</option>
                    <option value="high">高</option>
                    <option value="max">最高</option>
                  </select>
                </label>
                <label>
                  <span>规划要求</span>
                  <textarea
                    rows={4}
                    value={selectedNode.data.planningRequirements ?? ""}
                    placeholder="说明分析步骤、约束、风险和验收要求…"
                    onChange={(event) => updateSelectedNode({ planningRequirements: event.target.value })}
                  />
                </label>
              </div>
            )}
            {selectedNode.data.kind === "issue-trigger" && (
              <div className="workflow-config-section">
                <h2>触发条件</h2>
                <label>
                  <span>议题状态变为</span>
                  <select
                    aria-label="议题触发状态"
                    value={selectedNode.data.triggerStatus ?? "todo"}
                    onChange={(event) => updateSelectedNode({
                      triggerStatus: event.target.value,
                      description: `状态变为「${event.target.selectedOptions[0].text}」时触发`,
                    })}
                  >
                    {ISSUE_STATUSES.map((status) => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </label>
              </div>
            )}
            {selectedNode.data.kind === "issue-update" && (
              <div className="workflow-config-section">
                <h2>议题操作</h2>
                <label>
                  <span>议题选择</span>
                  <select
                    aria-label="议题选择"
                    value={selectedNode.data.issueTarget ?? "trigger"}
                    onChange={(event) => updateSelectedNode({ issueTarget: event.target.value })}
                  >
                    <option value="trigger">触发流程的议题</option>
                    <option value="upstream">上游节点输出的议题</option>
                    <option value="specific">指定议题</option>
                  </select>
                </label>
                {selectedNode.data.issueTarget === "specific" && (
                  <label>
                    <span>议题 ID</span>
                    <input
                      aria-label="指定议题 ID"
                      type="text"
                      value={selectedNode.data.specificIssueId ?? ""}
                      placeholder="例如 LOCAL-48"
                      onChange={(event) => updateSelectedNode({ specificIssueId: event.target.value })}
                    />
                  </label>
                )}
                <div className="workflow-action-row">
                  <label className="workflow-action-toggle">
                    <input
                      type="checkbox"
                      checked={selectedNode.data.changeStatus ?? false}
                      onChange={(event) => updateSelectedNode({ changeStatus: event.target.checked })}
                    />
                    <span>改变状态</span>
                  </label>
                  <select
                    aria-label="目标状态"
                    disabled={!selectedNode.data.changeStatus}
                    value={selectedNode.data.targetStatus ?? "in_review"}
                    onChange={(event) => updateSelectedNode({ targetStatus: event.target.value })}
                  >
                    {ISSUE_STATUSES.map((status) => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </div>
                <div className="workflow-action-row">
                  <label className="workflow-action-toggle">
                    <input
                      type="checkbox"
                      checked={selectedNode.data.addComment ?? false}
                      onChange={(event) => updateSelectedNode({ addComment: event.target.checked })}
                    />
                    <span>添加评论</span>
                  </label>
                  <select
                    aria-label="评论内容"
                    disabled={!selectedNode.data.addComment}
                    value={selectedNode.data.commentSource ?? "workflow-output"}
                    onChange={(event) => updateSelectedNode({ commentSource: event.target.value })}
                  >
                    <option value="workflow-output">上游节点输出</option>
                    <option value="run-summary">流程运行摘要</option>
                    <option value="custom">自定义内容</option>
                  </select>
                </div>
                {selectedNode.data.addComment && selectedNode.data.commentSource === "custom" && (
                  <label>
                    <span>评论内容</span>
                    <textarea
                      rows={3}
                      value={selectedNode.data.customComment ?? ""}
                      placeholder="输入要追加到议题的评论…"
                      onChange={(event) => updateSelectedNode({ customComment: event.target.value })}
                    />
                  </label>
                )}
                <div className="workflow-action-row">
                  <label className="workflow-action-toggle">
                    <input
                      type="checkbox"
                      checked={selectedNode.data.addLabels ?? false}
                      onChange={(event) => updateSelectedNode({ addLabels: event.target.checked })}
                    />
                    <span>添加标签</span>
                  </label>
                  <input
                    aria-label="要添加的标签"
                    type="text"
                    disabled={!selectedNode.data.addLabels}
                    value={selectedNode.data.labelsToAdd ?? ""}
                    placeholder="自动化, 已处理"
                    onChange={(event) => updateSelectedNode({ labelsToAdd: event.target.value })}
                  />
                </div>
                <div className="workflow-action-row">
                  <label className="workflow-action-toggle">
                    <input
                      type="checkbox"
                      checked={selectedNode.data.setPriority ?? false}
                      onChange={(event) => updateSelectedNode({ setPriority: event.target.checked })}
                    />
                    <span>设置优先级</span>
                  </label>
                  <select
                    aria-label="目标优先级"
                    disabled={!selectedNode.data.setPriority}
                    value={selectedNode.data.targetPriority ?? "none"}
                    onChange={(event) => updateSelectedNode({ targetPriority: event.target.value })}
                  >
                    {ISSUE_PRIORITIES.map((priority) => (
                      <option key={priority.value} value={priority.value}>{priority.label}</option>
                    ))}
                  </select>
                </div>
                <label className="workflow-action-toggle workflow-action-toggle-full">
                  <input
                    type="checkbox"
                    checked={selectedNode.data.attachArtifacts ?? false}
                    onChange={(event) => updateSelectedNode({ attachArtifacts: event.target.checked })}
                  />
                  <span>附加流程运行产物</span>
                </label>
                <label className="workflow-action-toggle workflow-action-toggle-full">
                  <input
                    type="checkbox"
                    checked={selectedNode.data.recordConversation ?? false}
                    onChange={(event) => updateSelectedNode({ recordConversation: event.target.checked })}
                  />
                  <span>记录执行该议题的 Codex 对话</span>
                </label>
              </div>
            )}
            <div className="workflow-config-section">
              <h2>额外说明</h2>
              <textarea
                aria-label="额外说明"
                rows={4}
                value={selectedNode.data.additionalInstructions ?? ""}
                placeholder="补充执行约束、上下文或验收要求…"
                onChange={(event) => updateSelectedNode({ additionalInstructions: event.target.value })}
              />
            </div>
            <div className="workflow-config-section">
              <h2>连接</h2>
              <div className="workflow-port-row">
                <span><i className="input" aria-hidden="true" />输入</span>
                <strong>{selectedNode.data.inputLabel ?? "无"}</strong>
              </div>
              <div className="workflow-port-row">
                <span><i className="output" aria-hidden="true" />输出</span>
                <strong>{selectedNode.data.outputLabel ?? "无"}</strong>
              </div>
            </div>
            <div className="workflow-config-section">
              <h2>上下文</h2>
              <div className="workflow-context-field">
                <span>
                  <LinearIcon name="project" />
                  当前项目
                </span>
                <strong>{projectName}</strong>
                <LinearIcon name="chevronDown" />
              </div>
            </div>
          </div>
        ) : (
          <div className="workflow-inspector-empty">
            <span aria-hidden="true"><LinearIcon name="panel" /></span>
            <strong>选择一个节点</strong>
            <p>查看并编辑它的配置、输入和输出。</p>
          </div>
        )}
      </aside>
    </section>
  );
}
