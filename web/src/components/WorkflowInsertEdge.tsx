import {
  BaseEdge,
  EdgeLabelRenderer,
  getStraightPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { LinearIcon } from "./LinearIcon";

export interface WorkflowInsertEdgeData extends Record<string, unknown> {
  onInsert?: () => void;
}

export type WorkflowSequenceEdge = Edge<WorkflowInsertEdgeData, "workflowInsert">;

export function WorkflowInsertEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  markerEnd,
  data,
}: EdgeProps<WorkflowSequenceEdge>) {
  const [path, labelX, labelY] = getStraightPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
  });

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        markerEnd={markerEnd}
        className="workflow-sequence-edge-path"
      />
      <EdgeLabelRenderer>
        <button
          className="workflow-sequence-add nodrag nopan"
          type="button"
          aria-label="在此处添加步骤"
          title="添加步骤"
          style={{
            transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
          }}
          onClick={(event) => {
            event.stopPropagation();
            data?.onInsert?.();
          }}
        >
          <LinearIcon name="plus" />
        </button>
      </EdgeLabelRenderer>
    </>
  );
}
