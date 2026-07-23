import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  applyNodeChanges,
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  type Edge,
  type EdgeTypes,
  type NodeChange,
  type NodeTypes,
  type OnNodeDrag,
  type ReactFlowInstance,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./workflow.css";
import {
  insertWorkflowStep,
  layoutWorkflowSteps,
  orderedWorkflowStepIds,
  reorderWorkflowStep,
  workflowSequenceEdges,
} from "../../../shared/workflow-sequence.mjs";
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
import { WorkflowInsertEdge } from "./WorkflowInsertEdge";
import { WorkflowInspector } from "./WorkflowInspector";
import {
  WorkflowNode,
  type WorkflowCanvasNode,
  type WorkflowNodeData,
} from "./WorkflowNode";
import { WorkflowStepPicker } from "./WorkflowStepPicker";
import {
  PALETTE_ITEMS,
  capabilityNodeMeta,
  paletteData,
  type PaletteItem,
  workflowNodeConfigured,
  workflowNodeDisplayTitle,
} from "./workflowCatalog";

interface WorkflowBoardProps {
  projectId: string;
  projectName: string;
  workspacePath?: string;
  revision: number;
  onWorkflowsChange: (workflows: WorkflowOption[]) => void;
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

interface StepPickerTarget {
  afterStepId: string | null;
  parentId: string | null;
}

interface SequenceDragPreview {
  nodeId: string;
  sourceOrderIds: string[];
  sourceIndex: number;
  targetIndex: number;
}

interface PlanDragPreview {
  nodeId: string;
  parentId: string;
  sourceOrderIds: string[];
  sourceIndex: number;
  targetIndex: number;
}

const WORKFLOW_STEP_WIDTH = 360;
const WORKFLOW_STEP_HEIGHT = 78;
const WORKFLOW_STEP_GAP = 58;
const PLAN_ITEM_WIDTH = 300;
const PLAN_ITEM_HEIGHT = 38;
const PLAN_ITEM_GAP = 6;
const PLAN_LIST_TOP = 86;
const PLAN_CONTAINER_BOTTOM = 50;
const END_STEP_HEIGHT = 42;
const END_STEP_ID = "__workflow-sequence-end__";
const TOP_CENTER_ORIGIN: [number, number] = [0.5, 0];
const TOP_LEFT_ORIGIN: [number, number] = [0, 0];
const PAN_MOUSE_BUTTONS = [1, 2];
const PRO_OPTIONS = { hideAttribution: true };
const NODE_TYPES = { workflow: WorkflowNode } satisfies NodeTypes;
const EDGE_TYPES = { workflowInsert: WorkflowInsertEdge } satisfies EdgeTypes;
const NESTABLE_TONES = new Set(["capability", "api", "integration"]);

function planItemPosition(index: number) {
  return {
    x: (WORKFLOW_STEP_WIDTH - PLAN_ITEM_WIDTH) / 2,
    y: PLAN_LIST_TOP + index * (PLAN_ITEM_HEIGHT + PLAN_ITEM_GAP),
  };
}

function planContainerHeight(childCount: number) {
  const listHeight = childCount === 0
    ? 28
    : childCount * PLAN_ITEM_HEIGHT + (childCount - 1) * PLAN_ITEM_GAP;
  return PLAN_LIST_TOP + listHeight + PLAN_CONTAINER_BOTTOM;
}

function layoutPlanChildren(
  nodes: WorkflowCanvasNode[],
  parentId: string,
  orderedChildIds: string[],
): WorkflowCanvasNode[] {
  const positions = new Map(orderedChildIds.map((id, index) => [id, planItemPosition(index)]));
  return nodes.map((node) => (
    node.parentId === parentId && positions.has(node.id)
      ? {
          ...node,
          origin: TOP_LEFT_ORIGIN,
          position: positions.get(node.id)!,
          style: { width: PLAN_ITEM_WIDTH, height: PLAN_ITEM_HEIGHT },
          initialWidth: PLAN_ITEM_WIDTH,
          initialHeight: PLAN_ITEM_HEIGHT,
          zIndex: 2,
        }
      : node
  ));
}

function layoutWorkflowSequence(
  nodes: WorkflowCanvasNode[],
  stepIds: string[],
): WorkflowCanvasNode[] {
  let next = nodes;
  const heights: Record<string, number> = {};
  for (const id of stepIds) {
    const node = next.find((candidate) => candidate.id === id);
    if (!node) continue;
    if (node.data.acceptsChildren) {
      const childIds = next
        .filter((candidate) => candidate.parentId === id)
        .sort((left, right) => left.position.y - right.position.y)
        .map((candidate) => candidate.id);
      next = layoutPlanChildren(next, id, childIds);
      heights[id] = planContainerHeight(childIds.length);
    } else {
      heights[id] = WORKFLOW_STEP_HEIGHT;
    }
  }
  const laidOut = layoutWorkflowSteps(
    next,
    stepIds,
    heights,
    { top: 48, gap: WORKFLOW_STEP_GAP },
  ) as WorkflowCanvasNode[];
  return laidOut.map((node) => {
    if (node.parentId) return node;
    const height = heights[node.id] ?? WORKFLOW_STEP_HEIGHT;
    return {
      ...node,
      origin: TOP_CENTER_ORIGIN,
      style: { width: WORKFLOW_STEP_WIDTH, height },
      initialWidth: WORKFLOW_STEP_WIDTH,
      initialHeight: height,
    };
  });
}

function sequenceEdges(stepIds: string[]): Edge[] {
  return workflowSequenceEdges(stepIds).map((edge) => ({
    ...edge,
    type: "workflowInsert",
  }));
}

function normalizeSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const stepIds = orderedWorkflowStepIds(snapshot.nodes, snapshot.edges);
  return {
    nodes: layoutWorkflowSequence(snapshot.nodes, stepIds),
    edges: sequenceEdges(stepIds),
    selectedNodeId: null,
  };
}

function initialNodes(): WorkflowCanvasNode[] {
  const nodes: WorkflowCanvasNode[] = [
    {
      id: "issue-trigger",
      type: "workflow",
      position: { x: 0, y: 48 },
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
      position: { x: 0, y: 184 },
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
      position: planItemPosition(0),
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
      position: planItemPosition(1),
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
      position: planItemPosition(2),
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
      position: planItemPosition(3),
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
      position: { x: 0, y: 520 },
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
      position: { x: 0, y: 656 },
      data: {
        ...paletteData("issue-update"),
        title: "提交审核",
        description: "追加结果评论并更新状态",
        meta: "状态 → 审核中",
      },
    },
  ];
  return layoutWorkflowSequence(
    nodes,
    ["issue-trigger", "basic-planning", "codex-review", "issue-update"],
  );
}

function createInitialWorkflowWorkspace() {
  const stepIds = ["issue-trigger", "basic-planning", "codex-review", "issue-update"];
  return {
    tabs: [{ id: INITIAL_WORKFLOW_ID, name: INITIAL_WORKFLOW_NAME }],
    activeWorkflowId: INITIAL_WORKFLOW_ID,
    snapshots: new Map<string, WorkflowSnapshot>([
      [
        INITIAL_WORKFLOW_ID,
        {
          nodes: initialNodes(),
          edges: sequenceEdges(stepIds),
          selectedNodeId: null,
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
    snapshots.set(tab.id, normalizeSnapshot(snapshot));
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
    snapshots: Object.fromEntries(tabs.map((tab) => {
      const snapshot = snapshots.get(tab.id)!;
      return [
        tab.id,
        {
          nodes: snapshot.nodes,
          edges: snapshot.edges,
          selectedNodeId: null,
        },
      ];
    })),
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
      snapshots.set(legacyTab.id, normalizeSnapshot(legacySnapshot));
      continue;
    }
    const remoteSnapshot = snapshots.get(remoteTab.id)!;
    if (workflowSignature(remoteTab, remoteSnapshot) === workflowSignature(legacyTab, legacySnapshot)) {
      continue;
    }
    const importedId = `workflow-imported-${crypto.randomUUID()}`;
    tabs.push({ id: importedId, name: `${legacyTab.name}（从另一入口导入）` });
    snapshots.set(importedId, normalizeSnapshot(legacySnapshot));
  }
  return {
    tabs,
    activeWorkflowId: remote.activeWorkflowId,
    snapshots,
  };
}

function rootDragShift(
  nodeId: string,
  preview: SequenceDragPreview | null,
): number {
  if (!preview || nodeId === preview.nodeId) return 0;
  const nodeIndex = preview.sourceOrderIds.indexOf(nodeId);
  const distance = WORKFLOW_STEP_HEIGHT + WORKFLOW_STEP_GAP;
  if (preview.targetIndex > preview.sourceIndex) {
    return nodeIndex > preview.sourceIndex && nodeIndex <= preview.targetIndex ? -distance : 0;
  }
  if (preview.targetIndex < preview.sourceIndex) {
    return nodeIndex >= preview.targetIndex && nodeIndex < preview.sourceIndex ? distance : 0;
  }
  return 0;
}

function planDragShift(
  nodeId: string,
  preview: PlanDragPreview | null,
): number {
  if (!preview || nodeId === preview.nodeId) return 0;
  const nodeIndex = preview.sourceOrderIds.indexOf(nodeId);
  const distance = PLAN_ITEM_HEIGHT + PLAN_ITEM_GAP;
  if (preview.targetIndex > preview.sourceIndex) {
    return nodeIndex > preview.sourceIndex && nodeIndex <= preview.targetIndex ? -distance : 0;
  }
  if (preview.targetIndex < preview.sourceIndex) {
    return nodeIndex >= preview.targetIndex && nodeIndex < preview.sourceIndex ? distance : 0;
  }
  return 0;
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
  const [nodes, setNodes] = useState<WorkflowCanvasNode[]>(initialSnapshot.nodes);
  const [edges, setEdges] = useState<Edge[]>(initialSnapshot.edges);
  const [workflowTabs, setWorkflowTabs] = useState<WorkflowTab[]>(initialWorkspace.tabs);
  const [activeWorkflowId, setActiveWorkflowId] = useState(initialWorkspace.activeWorkflowId);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [renamingWorkflowId, setRenamingWorkflowId] = useState<string | null>(null);
  const [workflowNameDraft, setWorkflowNameDraft] = useState("");
  const [pickerTarget, setPickerTarget] = useState<StepPickerTarget | null>(null);
  const [rootDragPreview, setRootDragPreview] = useState<SequenceDragPreview | null>(null);
  const [planDragPreview, setPlanDragPreview] = useState<PlanDragPreview | null>(null);
  const [settlingNodeId, setSettlingNodeId] = useState<string | null>(null);
  const [workflowCapabilities, setWorkflowCapabilities] = useState<WorkflowCapabilities | null>(null);
  const [workflowCapabilitiesFailed, setWorkflowCapabilitiesFailed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const [persistenceError, setPersistenceError] = useState("");
  const flowRef = useRef<ReactFlowInstance<WorkflowCanvasNode, Edge> | null>(null);
  const workflowNameInputRef = useRef<HTMLInputElement | null>(null);
  const cancelWorkflowRenameRef = useRef(false);
  const workflowSnapshotsRef = useRef(initialWorkspace.snapshots);
  const remoteVersionRef = useRef(0);
  const lastRemoteWorkspaceRef = useRef("");
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const settleTimerRef = useRef<number | null>(null);
  const rootDragSessionRef = useRef<SequenceDragPreview | null>(null);
  const planDragSessionRef = useRef<PlanDragPreview | null>(null);

  const rootStepIds = useMemo(
    () => orderedWorkflowStepIds(nodes, edges),
    [edges, nodes],
  );
  const selectedNode = nodes.find((node) => node.id === selectedNodeId) ?? null;

  const applyWorkspace = useCallback((workspace: ReturnType<typeof createInitialWorkflowWorkspace>) => {
    const snapshot = normalizeSnapshot(workspace.snapshots.get(workspace.activeWorkflowId)!);
    workflowSnapshotsRef.current = new Map(workspace.snapshots);
    workflowSnapshotsRef.current.set(workspace.activeWorkflowId, snapshot);
    setWorkflowTabs(workspace.tabs);
    setActiveWorkflowId(workspace.activeWorkflowId);
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedNodeId(null);
    setRenamingWorkflowId(null);
    onWorkflowsChange(workspace.tabs);
  }, [onWorkflowsChange]);

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
    workflowSnapshotsRef.current.set(activeWorkflowId, {
      nodes,
      edges,
      selectedNodeId: null,
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
              // The next edit retries after the service is reachable.
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

  const commitSequence = useCallback((
    nextNodes: WorkflowCanvasNode[],
    nextOrder: string[],
  ) => {
    setNodes(layoutWorkflowSequence(nextNodes, nextOrder));
    setEdges(sequenceEdges(nextOrder));
  }, []);

  const openStepPicker = useCallback((
    afterStepId: string | null,
    parentId: string | null = null,
  ) => {
    setPickerTarget({ afterStepId, parentId });
  }, []);

  const updateSelectedNode = useCallback((changes: Partial<WorkflowNodeData>) => {
    if (!selectedNodeId) return;
    setNodes((current) => current.map((node) => (
      node.id === selectedNodeId
        ? { ...node, data: { ...node.data, ...changes } }
        : node
    )));
  }, [selectedNodeId]);

  const deleteNode = useCallback((nodeId: string) => {
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node || node.data.kind === "issue-trigger") return;
    const nextNodes = nodes.filter((candidate) => candidate.id !== nodeId && candidate.parentId !== nodeId);
    const nextOrder = rootStepIds.filter((id) => id !== nodeId);
    commitSequence(nextNodes, nextOrder);
    setSelectedNodeId((current) => current === nodeId ? null : current);
  }, [commitSequence, nodes, rootStepIds]);

  const duplicateNode = useCallback((nodeId: string) => {
    const source = nodes.find((candidate) => candidate.id === nodeId);
    if (!source) return;
    const duplicateId = `node-${crypto.randomUUID()}`;
    if (source.parentId) {
      const siblingIds = nodes
        .filter((candidate) => candidate.parentId === source.parentId)
        .sort((left, right) => left.position.y - right.position.y)
        .map((candidate) => candidate.id);
      const sourceIndex = siblingIds.indexOf(source.id);
      siblingIds.splice(sourceIndex + 1, 0, duplicateId);
      const nextNodes = [
        ...nodes,
        {
          ...source,
          id: duplicateId,
          selected: false,
          data: { ...source.data, title: `${source.data.title} 副本` },
        },
      ];
      commitSequence(layoutPlanChildren(nextNodes, source.parentId, siblingIds), rootStepIds);
    } else {
      const nextNodes = [
        ...nodes,
        {
          ...source,
          id: duplicateId,
          selected: false,
          parentId: undefined,
          data: { ...source.data, title: `${source.data.title} 副本` },
        },
      ];
      const nextOrder = insertWorkflowStep(rootStepIds, duplicateId, source.id);
      commitSequence(nextNodes, nextOrder);
    }
    setSelectedNodeId(duplicateId);
  }, [commitSequence, nodes, rootStepIds]);

  const renderedNodes = useMemo(() => {
    const childCounts = new Map<string, number>();
    for (const node of nodes) {
      if (node.parentId) childCounts.set(node.parentId, (childCounts.get(node.parentId) ?? 0) + 1);
    }
    const pinnedTriggerId = rootStepIds.find((id) => (
      nodes.find((node) => node.id === id)?.data.kind === "issue-trigger"
    ));
    const enriched = nodes.map((node) => {
      const stepIndex = rootStepIds.indexOf(node.id);
      const dragShiftY = node.parentId
        ? planDragShift(node.id, planDragPreview)
        : rootDragShift(node.id, rootDragPreview);
      return {
        ...node,
        draggable: node.id !== pinnedTriggerId,
        data: {
          ...node.data,
          displayTitle: workflowNodeDisplayTitle(node.data),
          meta: capabilityNodeMeta(
            node.data,
            workflowCapabilities,
            workflowCapabilitiesFailed,
          ),
          configured: workflowNodeConfigured(
            node.data,
            workflowCapabilities,
            workflowCapabilitiesFailed,
          ),
          stepNumber: stepIndex >= 0 ? stepIndex + 1 : undefined,
          isTrigger: node.id === pinnedTriggerId,
          childCount: childCounts.get(node.id) ?? 0,
          dragShiftY,
          dragActive: rootDragPreview?.nodeId === node.id || planDragPreview?.nodeId === node.id,
          settleActive: settlingNodeId === node.id,
          onDuplicate: () => duplicateNode(node.id),
          onDelete: () => deleteNode(node.id),
          onAddChild: node.data.acceptsChildren
            ? () => openStepPicker(null, node.id)
            : undefined,
        },
      };
    });
    const lastId = rootStepIds.at(-1);
    const lastNode = lastId ? enriched.find((node) => node.id === lastId) : null;
    const endY = lastNode
      ? lastNode.position.y + Number(lastNode.style?.height ?? WORKFLOW_STEP_HEIGHT) + WORKFLOW_STEP_GAP
      : 72;
    const endNode: WorkflowCanvasNode = {
      id: END_STEP_ID,
      type: "workflow",
      position: { x: 0, y: endY },
      origin: TOP_CENTER_ORIGIN,
      draggable: false,
      selectable: false,
      deletable: false,
      connectable: false,
      style: { width: WORKFLOW_STEP_WIDTH, height: END_STEP_HEIGHT },
      data: {
        kind: "sequence-end",
        eyebrow: "",
        title: "添加步骤",
        description: "",
        meta: "",
        icon: "plus",
        tone: "capability",
        stepNumber: rootStepIds.length === 0 ? 0 : undefined,
        onAddChild: () => openStepPicker(lastId ?? null),
      },
    };
    return [
      ...enriched.filter((node) => !node.parentId),
      ...(rootStepIds.length > 0 ? [endNode] : []),
      ...enriched.filter((node) => node.parentId),
    ];
  }, [
    deleteNode,
    duplicateNode,
    nodes,
    openStepPicker,
    planDragPreview,
    rootDragPreview,
    rootStepIds,
    settlingNodeId,
    workflowCapabilities,
    workflowCapabilitiesFailed,
  ]);

  const renderedEdges = useMemo(() => {
    const insertEdges = workflowSequenceEdges(rootStepIds).map((edge) => ({
      ...edge,
      type: "workflowInsert",
      data: {
        onInsert: () => openStepPicker(edge.source),
      },
    }));
    const lastId = rootStepIds.at(-1);
    return [
      ...insertEdges,
      ...(lastId
        ? [{
            id: `sequence-${lastId}-end`,
            source: lastId,
            target: END_STEP_ID,
            type: "straight",
            className: "workflow-sequence-tail-edge",
          }]
        : []),
    ];
  }, [openStepPicker, rootStepIds]);

  const pickerItems = useMemo(() => {
    if (!pickerTarget) return [];
    if (pickerTarget.parentId) {
      return PALETTE_ITEMS.filter((item) => NESTABLE_TONES.has(item.data.tone));
    }
    if (rootStepIds.length === 0) {
      return PALETTE_ITEMS.filter((item) => item.group === "触发器");
    }
    return PALETTE_ITEMS.filter((item) => item.group !== "触发器");
  }, [pickerTarget, rootStepIds.length]);

  function selectStep(item: PaletteItem) {
    if (!pickerTarget) return;
    const nodeId = `node-${crypto.randomUUID()}`;
    const newNode: WorkflowCanvasNode = {
      id: nodeId,
      type: "workflow",
      position: { x: 0, y: 0 },
      data: { ...item.data },
    };
    if (pickerTarget.parentId) {
      newNode.parentId = pickerTarget.parentId;
      newNode.origin = TOP_LEFT_ORIGIN;
      const childIds = nodes
        .filter((node) => node.parentId === pickerTarget.parentId)
        .sort((left, right) => left.position.y - right.position.y)
        .map((node) => node.id);
      childIds.push(nodeId);
      const nextNodes = layoutPlanChildren([...nodes, newNode], pickerTarget.parentId, childIds);
      commitSequence(nextNodes, rootStepIds);
    } else {
      const nextOrder = insertWorkflowStep(rootStepIds, nodeId, pickerTarget.afterStepId);
      commitSequence([...nodes, newNode], nextOrder);
    }
    setPickerTarget(null);
    setSelectedNodeId(nodeId);
  }

  function reorderPlanItem(parentId: string, nodeId: string, targetIndex: number) {
    const childIds = nodes
      .filter((node) => node.parentId === parentId)
      .sort((left, right) => left.position.y - right.position.y)
      .map((node) => node.id);
    const nextIds = childIds.filter((id) => id !== nodeId);
    nextIds.splice(Math.max(0, Math.min(targetIndex, nextIds.length)), 0, nodeId);
    commitSequence(layoutPlanChildren(nodes, parentId, nextIds), rootStepIds);
  }

  const onNodesChange = useCallback((changes: NodeChange<WorkflowCanvasNode>[]) => {
    setNodes((current) => applyNodeChanges(
      changes.filter((change) => change.type !== "remove" || change.id !== END_STEP_ID),
      current,
    ));
  }, []);

  const onNodeDragStart = useCallback<OnNodeDrag<WorkflowCanvasNode>>((_, node) => {
    if (node.id === END_STEP_ID) return;
    if (node.parentId) {
      const sourceOrderIds = nodes
        .filter((candidate) => candidate.parentId === node.parentId)
        .sort((left, right) => left.position.y - right.position.y)
        .map((candidate) => candidate.id);
      const preview = {
        nodeId: node.id,
        parentId: node.parentId,
        sourceOrderIds,
        sourceIndex: sourceOrderIds.indexOf(node.id),
        targetIndex: sourceOrderIds.indexOf(node.id),
      };
      planDragSessionRef.current = preview;
      setPlanDragPreview(preview);
    } else {
      const sourceIndex = rootStepIds.indexOf(node.id);
      if (sourceIndex < 0) return;
      const preview = {
        nodeId: node.id,
        sourceOrderIds: rootStepIds,
        sourceIndex,
        targetIndex: sourceIndex,
      };
      rootDragSessionRef.current = preview;
      setRootDragPreview(preview);
    }
    setSettlingNodeId(null);
  }, [nodes, rootStepIds]);

  const onNodeDrag = useCallback<OnNodeDrag<WorkflowCanvasNode>>((_, node) => {
    const instance = flowRef.current;
    const internal = instance?.getInternalNode(node.id);
    if (!instance || !internal) return;
    const height = internal.measured.height ?? (node.parentId ? PLAN_ITEM_HEIGHT : WORKFLOW_STEP_HEIGHT);
    const centerY = internal.internals.positionAbsolute.y + height / 2;
    if (node.parentId && planDragSessionRef.current?.nodeId === node.id) {
      const session = planDragSessionRef.current;
      const siblings = session.sourceOrderIds
        .filter((id) => id !== node.id)
        .map((id) => instance.getInternalNode(id))
        .filter((candidate) => candidate !== undefined);
      const index = siblings.findIndex((candidate) => (
        centerY < candidate.internals.positionAbsolute.y
          + (candidate.measured.height ?? PLAN_ITEM_HEIGHT) / 2
      ));
      const targetIndex = index < 0 ? siblings.length : index;
      setPlanDragPreview({ ...session, targetIndex });
      return;
    }
    const session = rootDragSessionRef.current;
    if (!session || session.nodeId !== node.id) return;
    const siblings = session.sourceOrderIds
      .filter((id) => id !== node.id)
      .map((id) => instance.getInternalNode(id))
      .filter((candidate) => candidate !== undefined);
    const index = siblings.findIndex((candidate) => (
      centerY < candidate.internals.positionAbsolute.y
        + (candidate.measured.height ?? WORKFLOW_STEP_HEIGHT) / 2
    ));
    const targetIndex = index < 0 ? siblings.length : index;
    setRootDragPreview({ ...session, targetIndex });
  }, []);

  const onNodeDragStop = useCallback<OnNodeDrag<WorkflowCanvasNode>>((_, node) => {
    if (node.parentId && planDragSessionRef.current?.nodeId === node.id) {
      const session = planDragSessionRef.current;
      reorderPlanItem(session.parentId, node.id, planDragPreview?.targetIndex ?? session.sourceIndex);
      planDragSessionRef.current = null;
      setPlanDragPreview(null);
    } else if (rootDragSessionRef.current?.nodeId === node.id) {
      const session = rootDragSessionRef.current;
      const pinnedId = session.sourceOrderIds.find((id) => (
        nodes.find((candidate) => candidate.id === id)?.data.kind === "issue-trigger"
      ));
      const nextOrder = reorderWorkflowStep(
        session.sourceOrderIds,
        node.id,
        rootDragPreview?.targetIndex ?? session.sourceIndex,
        pinnedId,
      );
      commitSequence(nodes, nextOrder);
      rootDragSessionRef.current = null;
      setRootDragPreview(null);
    }
    setSettlingNodeId(node.id);
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => setSettlingNodeId(null), 220);
  }, [commitSequence, nodes, planDragPreview, rootDragPreview]);

  function activateWorkflow(workflowId: string) {
    if (workflowId === activeWorkflowId) return;
    workflowSnapshotsRef.current.set(activeWorkflowId, {
      nodes,
      edges,
      selectedNodeId: null,
    });
    const snapshot = normalizeSnapshot(workflowSnapshotsRef.current.get(workflowId)!);
    setActiveWorkflowId(workflowId);
    setNodes(snapshot.nodes);
    setEdges(snapshot.edges);
    setSelectedNodeId(null);
    setPickerTarget(null);
    requestAnimationFrame(() => {
      void flowRef.current?.fitView({ padding: 0.2, duration: 240, maxZoom: 1 });
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
    setWorkflowTabs((current) => [...current, { id: workflowId, name: workflowName }]);
    setActiveWorkflowId(workflowId);
    setNodes([]);
    setEdges([]);
    setSelectedNodeId(null);
    setPickerTarget(null);
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

  return (
    <section
      className={`workflow-board${selectedNode ? " has-inspector" : ""}`}
      aria-label="流程看板"
    >
      <div className="workflow-canvas-shell">
        <div className="workflow-canvas-toolbar">
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
          <div className="workflow-toolbar-status">
            <span className={persistenceError ? "has-error" : ""}>
              <i aria-hidden="true" />
              {persistenceError || "已自动保存"}
            </span>
            <button
              type="button"
              aria-label="适应流程视图"
              title="适应流程视图"
              onClick={() => {
                void flowRef.current?.fitView({ padding: 0.2, duration: 240, maxZoom: 1 });
              }}
            >
              <LinearIcon name="expand" />
            </button>
          </div>
        </div>
        <div
          className="workflow-canvas"
          id="workflow-canvas-panel"
          role="tabpanel"
          aria-label="流程编排区"
          aria-labelledby={`workflow-tab-${activeWorkflowId}`}
        >
          <ReactFlow<WorkflowCanvasNode, Edge>
            nodes={renderedNodes}
            edges={renderedEdges}
            nodeTypes={NODE_TYPES}
            edgeTypes={EDGE_TYPES}
            nodeOrigin={TOP_CENTER_ORIGIN}
            onNodesChange={onNodesChange}
            onNodeDragStart={onNodeDragStart}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(_, node) => {
              if (node.id !== END_STEP_ID) setSelectedNodeId(node.id);
            }}
            onPaneClick={() => setSelectedNodeId(null)}
            nodesConnectable={false}
            connectOnClick={false}
            deleteKeyCode={null}
            selectionOnDrag
            panOnScroll
            panOnDrag={PAN_MOUSE_BUTTONS}
            zoomOnDoubleClick={false}
            minZoom={0.45}
            maxZoom={1.35}
            proOptions={PRO_OPTIONS}
            onInit={(instance) => {
              flowRef.current = instance;
              void instance.setCenter(0, 220, { zoom: 1 });
            }}
          >
            <Background
              color="var(--border-strong)"
              gap={24}
              size={0.75}
              variant={BackgroundVariant.Dots}
            />
            <Controls
              className="workflow-flow-controls"
              position="bottom-left"
              showInteractive={false}
            />
          </ReactFlow>
          {rootStepIds.length === 0 && (
            <button
              className="workflow-empty-add"
              type="button"
              aria-label="添加第一个步骤"
              onClick={() => openStepPicker(null)}
            >
              <LinearIcon name="plus" />
              <span>添加触发器</span>
            </button>
          )}
          {pickerTarget && (
            <WorkflowStepPicker
              items={pickerItems}
              onSelect={selectStep}
              onClose={() => setPickerTarget(null)}
            />
          )}
        </div>
      </div>

      {selectedNode && (
        <aside className="workflow-inspector workflow-step-inspector" aria-label="步骤配置">
          <WorkflowInspector
            node={selectedNode}
            projectName={projectName}
            capabilities={workflowCapabilities}
            capabilitiesFailed={workflowCapabilitiesFailed}
            onChange={updateSelectedNode}
            onClose={() => setSelectedNodeId(null)}
          />
        </aside>
      )}
    </section>
  );
}
