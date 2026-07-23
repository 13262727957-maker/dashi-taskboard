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
  dropActive?: boolean;
  dragShiftY?: number;
  dragActive?: boolean;
  settleActive?: boolean;
}

export type WorkflowCanvasNode = Node<WorkflowNodeData, "workflow">;

export function WorkflowNodeDragPreview({
  compact,
  data,
}: {
  compact: boolean;
  data: WorkflowNodeData;
}) {
  if (compact) {
    return (
      <article className={`workflow-node-compact workflow-node-${data.tone}`}>
        <span className="workflow-node-icon" aria-hidden="true">
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

  if (data.acceptsChildren) {
    return (
      <article className="workflow-plan-container">
        <header className="workflow-plan-container-header">
          <span className="workflow-node-icon" aria-hidden="true">
            <WorkflowMark
              icon={data.icon}
              logo={data.logo}
              logoMonochrome={data.logoMonochrome}
            />
          </span>
          <span className="workflow-node-heading">
            <span>{data.eyebrow}</span>
            <strong>{data.displayTitle ?? data.title}</strong>
          </span>
        </header>
        <div className="workflow-plan-container-summary">
          <p>{data.description}</p>
        </div>
        <div className="workflow-plan-drop-zone">
          <LinearIcon name="plus" />
          <span>拖入能力节点</span>
        </div>
        <footer className="workflow-plan-container-footer">
          <span>从上到下执行</span>
          <span>0 步</span>
        </footer>
      </article>
    );
  }

  return (
    <article className={`workflow-node workflow-node-${data.tone}`}>
      <header className="workflow-node-header">
        <span className="workflow-node-icon" aria-hidden="true">
          <WorkflowMark
            icon={data.icon}
            logo={data.logo}
            logoMonochrome={data.logoMonochrome}
          />
        </span>
        <span className="workflow-node-heading">
          <span>{data.eyebrow}</span>
          <strong>{data.displayTitle ?? data.title}</strong>
        </span>
      </header>
      <div className="workflow-node-body">
        <p>{data.description}</p>
        <span>{data.meta}</span>
      </div>
      <footer className="workflow-node-footer">
        <span className="workflow-node-state"><i aria-hidden="true" />已配置</span>
        {data.outputLabel && <span>{data.outputLabel}</span>}
      </footer>
    </article>
  );
}

export function WorkflowNode({ data, selected, isConnectable, parentId }: NodeProps<WorkflowCanvasNode>) {
  if (data.acceptsChildren) {
    return (
      <article className={`workflow-plan-container${selected ? " selected" : ""}${data.dropActive ? " is-drop-target" : ""}`}>
        {data.inputLabel && (
          <Handle
            className="workflow-node-handle workflow-node-handle-input"
            type="target"
            position={Position.Left}
            isConnectable={isConnectable}
            aria-label={data.inputLabel}
          />
        )}
        <header className="workflow-plan-container-header">
          <span className="workflow-node-icon" aria-hidden="true">
            <WorkflowMark
              icon={data.icon}
              logo={data.logo}
              logoMonochrome={data.logoMonochrome}
            />
          </span>
          <span className="workflow-node-heading">
            <span>{data.eyebrow}</span>
            <strong>{data.displayTitle ?? data.title}</strong>
          </span>
          <span className="workflow-node-menu" aria-hidden="true">
            <LinearIcon name="more" />
          </span>
        </header>
        <div className="workflow-plan-container-summary">
          <p>{data.description}</p>
        </div>
        <div className="workflow-plan-drop-zone" aria-hidden="true">
          {(data.childCount ?? 0) === 0 && (
            <>
              <LinearIcon name="plus" />
              <span>拖入能力节点</span>
            </>
          )}
        </div>
        <footer className="workflow-plan-container-footer">
          <span>从上到下执行</span>
          <span>{data.childCount ?? 0} 步</span>
        </footer>
        {data.outputLabel && (
          <Handle
            className="workflow-node-handle workflow-node-handle-output"
            type="source"
            position={Position.Right}
            isConnectable={isConnectable}
            aria-label={data.outputLabel}
          />
        )}
      </article>
    );
  }

  if (parentId) {
    return (
      <article
        className={`workflow-node-compact workflow-node-${data.tone}${selected ? " selected" : ""}${data.dragShiftY ? " is-drag-shifted" : ""}${data.dragActive ? " is-dragging" : ""}${data.settleActive ? " is-settling" : ""}`}
        style={data.dragShiftY ? { transform: `translate3d(0, ${data.dragShiftY}px, 0)` } : undefined}
      >
        <span className="workflow-node-icon" aria-hidden="true">
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
    <article className={`workflow-node workflow-node-${data.tone}${selected ? " selected" : ""}`}>
      {data.inputLabel && (
        <Handle
          className="workflow-node-handle workflow-node-handle-input"
          type="target"
          position={Position.Left}
          isConnectable={isConnectable}
          aria-label={data.inputLabel}
        />
      )}
      <header className="workflow-node-header">
        <span className="workflow-node-icon" aria-hidden="true">
          <WorkflowMark
            icon={data.icon}
            logo={data.logo}
            logoMonochrome={data.logoMonochrome}
          />
        </span>
        <span className="workflow-node-heading">
          <span>{data.eyebrow}</span>
          <strong>{data.displayTitle ?? data.title}</strong>
        </span>
        <span className="workflow-node-menu" aria-hidden="true">
          <LinearIcon name="more" />
        </span>
      </header>
      <div className="workflow-node-body">
        <p>{data.description}</p>
        <span>{data.meta}</span>
      </div>
      <footer className="workflow-node-footer">
        <span className="workflow-node-state"><i aria-hidden="true" />已配置</span>
        {data.outputLabel && <span>{data.outputLabel}</span>}
      </footer>
      {data.outputLabel && (
        <Handle
          className="workflow-node-handle workflow-node-handle-output"
          type="source"
          position={Position.Right}
          isConnectable={isConnectable}
          aria-label={data.outputLabel}
        />
      )}
    </article>
  );
}
