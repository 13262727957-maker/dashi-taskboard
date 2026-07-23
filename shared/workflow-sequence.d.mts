export interface WorkflowSequenceNode {
  id: string;
  parentId?: string;
  position: { x: number; y: number };
}

export interface WorkflowSequenceEdge {
  id: string;
  source: string;
  target: string;
}

export function orderedWorkflowStepIds(
  nodes: WorkflowSequenceNode[],
  edges: WorkflowSequenceEdge[],
): string[];

export function insertWorkflowStep(
  stepIds: string[],
  stepId: string,
  afterStepId: string | null,
): string[];

export function reorderWorkflowStep(
  stepIds: string[],
  stepId: string,
  targetIndex: number,
  pinnedStepId?: string,
): string[];

export function workflowSequenceEdges(stepIds: string[]): WorkflowSequenceEdge[];

export function layoutWorkflowSteps<T extends WorkflowSequenceNode>(
  nodes: T[],
  stepIds: string[],
  heights?: Record<string, number>,
  options?: { top?: number; gap?: number },
): T[];
