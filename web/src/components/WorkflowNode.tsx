import { useEffect, useRef, useState } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { LinearIcon, type LinearIconName } from "./LinearIcon";
import { WorkflowMark } from "./WorkflowMark";

export type WorkflowNodeTone =
  | "issue"
  | "capability"
  | "api"
  | "integration"
  | "planning"
  | "result";

export interface WorkflowNodeData extends Record<string, unknown> {
  kind: string;
  eyebrow: string;
  title: string;
  displayTitle?: string;
  description: string;
  meta: string;
  icon: LinearIconName;
  logo?: string;
  logoMonochrome?: boolean;
  tone: WorkflowNodeTone;
  inputLabel?: string;
  outputLabel?: string;
  additionalInstructions?: string;
  selectedSkill?: string;
  selectedMcpServer?: string;
  claudeModel?: string;
  reasoningEffort?: string;
  planningRequirements?: string;
  issueTarget?: string;
  specificIssueId?: string;
  changeStatus?: boolean;
  targetStatus?: string;
  addComment?: boolean;
  commentSource?: string;
  customComment?: string;
  addLabels?: boolean;
  labelsToAdd?: string;
  setPriority?: boolean;
  targetPriority?: string;
  attachArtifacts?: boolean;
  recordConversation?: boolean;
  triggerStatus?: string;
  gitOperation?: string;
  gitCommitMessage?: string;
  gitStageAll?: boolean;
  gitRemote?: string;
  gitBranchName?: string;
  gitBaseBranch?: string;
  gitWorktreePath?: string;
  acceptsChildren?: boolean;
  childCount?: number;
  stepNumber?: number;
  configured?: boolean;
  isTrigger?: boolean;
  dragShiftY?: number;
  dragActive?: boolean;
  settleActive?: boolean;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onAddChild?: () => void;
}

export type WorkflowCanvasNode = Node<WorkflowNodeData, "workflow">;

function StepMenu({
  canDelete,
  onDelete,
  onDuplicate,
}: {
  canDelete: boolean;
  onDelete?: () => void;
  onDuplicate?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(event: MouseEvent) {
      if (menuRef.current?.contains(event.target as globalThis.Node)) return;
      setOpen(false);
    }
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="workflow-step-menu" ref={menuRef}>
      <button
        className="workflow-step-menu-trigger"
        type="button"
        aria-label="步骤操作"
        aria-expanded={open}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name="more" />
      </button>
      {open && (
        <div className="workflow-step-menu-popover" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={(event) => {
              event.stopPropagation();
              setOpen(false);
              onDuplicate?.();
            }}
          >
            <LinearIcon name="copy" />
            <span>复制步骤</span>
          </button>
          {canDelete && (
            <button
              className="is-danger"
              type="button"
              role="menuitem"
              onClick={(event) => {
                event.stopPropagation();
                setOpen(false);
                onDelete?.();
              }}
            >
              <LinearIcon name="trash" />
              <span>删除步骤</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function WorkflowNode({ data, selected, isConnectable, parentId }: NodeProps<WorkflowCanvasNode>) {
  if (data.kind === "sequence-end") {
    return (
      <div className="workflow-sequence-end">
        <Handle
          className="workflow-sequence-handle workflow-sequence-handle-input"
          type="target"
          position={Position.Top}
          isConnectable={false}
        />
        <button
          type="button"
          aria-label="在流程末尾添加步骤"
          onClick={(event) => {
            event.stopPropagation();
            data.onAddChild?.();
          }}
        >
          <LinearIcon name="plus" />
          <span>添加步骤</span>
        </button>
      </div>
    );
  }

  if (parentId) {
    return (
      <article
        className={`workflow-plan-item workflow-node-${data.tone}${selected ? " selected" : ""}${data.dragShiftY ? " is-drag-shifted" : ""}${data.dragActive ? " is-dragging" : ""}${data.settleActive ? " is-settling" : ""}`}
        style={data.dragShiftY ? { transform: `translate3d(0, ${data.dragShiftY}px, 0)` } : undefined}
      >
        <span className="workflow-plan-item-grip" aria-hidden="true">
          <LinearIcon name="more" />
        </span>
        <span className="workflow-step-mark" aria-hidden="true">
          <WorkflowMark
            icon={data.icon}
            logo={data.logo}
            logoMonochrome={data.logoMonochrome}
          />
        </span>
        <strong>{data.displayTitle ?? data.title}</strong>
      </article>
    );
  }

  return (
    <article
      className={`workflow-step-card workflow-node-${data.tone}${selected ? " selected" : ""}${data.acceptsChildren ? " is-plan" : ""}${data.dragShiftY ? " is-drag-shifted" : ""}${data.dragActive ? " is-dragging" : ""}${data.settleActive ? " is-settling" : ""}`}
      style={data.dragShiftY ? { transform: `translate3d(0, ${data.dragShiftY}px, 0)` } : undefined}
    >
      <Handle
        className="workflow-sequence-handle workflow-sequence-handle-input"
        type="target"
        position={Position.Top}
        isConnectable={isConnectable}
        aria-label={data.inputLabel ?? "步骤输入"}
      />
      <div className="workflow-step-main">
        <span className={`workflow-step-order${data.isTrigger ? " is-trigger" : ""}`}>
          {data.isTrigger ? "触发" : data.stepNumber}
        </span>
        <span className="workflow-step-mark" aria-hidden="true">
          <WorkflowMark
            icon={data.icon}
            logo={data.logo}
            logoMonochrome={data.logoMonochrome}
          />
        </span>
        <span className="workflow-step-copy">
          <strong>{data.displayTitle ?? data.title}</strong>
          <small>{data.meta}</small>
        </span>
        <span className={`workflow-step-state${data.configured ? " is-configured" : " needs-config"}`}>
          <i aria-hidden="true" />
          {data.configured ? "已配置" : "需要配置"}
        </span>
        <StepMenu
          canDelete={!data.isTrigger}
          onDelete={data.onDelete}
          onDuplicate={data.onDuplicate}
        />
      </div>
      {data.acceptsChildren && (
        <div className="workflow-plan-list">
          {(data.childCount ?? 0) === 0 && (
            <p>执行计划中还没有步骤</p>
          )}
          <button
            className="workflow-plan-add"
            type="button"
            aria-label="向执行计划添加步骤"
            onClick={(event) => {
              event.stopPropagation();
              data.onAddChild?.();
            }}
          >
            <LinearIcon name="plus" />
            <span>添加执行步骤</span>
          </button>
        </div>
      )}
      <Handle
        className="workflow-sequence-handle workflow-sequence-handle-output"
        type="source"
        position={Position.Bottom}
        isConnectable={isConnectable}
        aria-label={data.outputLabel ?? "步骤输出"}
      />
    </article>
  );
}
