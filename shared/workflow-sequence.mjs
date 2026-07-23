function nodePosition(node) {
  return {
    x: Number.isFinite(node.position?.x) ? node.position.x : 0,
    y: Number.isFinite(node.position?.y) ? node.position.y : 0,
  };
}

function compareNodes(left, right) {
  const leftPosition = nodePosition(left);
  const rightPosition = nodePosition(right);
  return leftPosition.y - rightPosition.y
    || leftPosition.x - rightPosition.x
    || left.id.localeCompare(right.id);
}

export function orderedWorkflowStepIds(nodes, edges) {
  const roots = nodes.filter((node) => !node.parentId);
  const rootsById = new Map(roots.map((node) => [node.id, node]));
  const outgoing = new Map(roots.map((node) => [node.id, []]));
  const incoming = new Map(roots.map((node) => [node.id, 0]));

  for (const edge of edges) {
    if (
      edge.source === edge.target
      || !rootsById.has(edge.source)
      || !rootsById.has(edge.target)
    ) {
      continue;
    }
    const targets = outgoing.get(edge.source);
    if (targets.includes(edge.target)) continue;
    targets.push(edge.target);
    incoming.set(edge.target, incoming.get(edge.target) + 1);
  }

  for (const targets of outgoing.values()) {
    targets.sort((leftId, rightId) => (
      compareNodes(rootsById.get(leftId), rootsById.get(rightId))
    ));
  }

  const ordered = [];
  const visited = new Set();
  const visit = (id) => {
    if (visited.has(id)) return;
    visited.add(id);
    ordered.push(id);
    for (const targetId of outgoing.get(id)) visit(targetId);
  };

  roots
    .filter((node) => incoming.get(node.id) === 0)
    .sort(compareNodes)
    .forEach((node) => visit(node.id));
  roots.sort(compareNodes).forEach((node) => visit(node.id));
  return ordered;
}

export function insertWorkflowStep(stepIds, stepId, afterStepId) {
  const next = stepIds.filter((id) => id !== stepId);
  if (afterStepId === null) {
    next.push(stepId);
    return next;
  }
  const afterIndex = next.indexOf(afterStepId);
  next.splice(afterIndex < 0 ? next.length : afterIndex + 1, 0, stepId);
  return next;
}

export function reorderWorkflowStep(stepIds, stepId, targetIndex, pinnedStepId) {
  if (stepId === pinnedStepId || !stepIds.includes(stepId)) return [...stepIds];
  const next = stepIds.filter((id) => id !== stepId);
  const minimumIndex = next[0] === pinnedStepId ? 1 : 0;
  const insertionIndex = Math.max(
    minimumIndex,
    Math.min(Number.isFinite(targetIndex) ? Math.trunc(targetIndex) : next.length, next.length),
  );
  next.splice(insertionIndex, 0, stepId);
  return next;
}

export function workflowSequenceEdges(stepIds) {
  return stepIds.slice(1).map((target, index) => {
    const source = stepIds[index];
    return {
      id: `sequence-${source}-${target}`,
      source,
      target,
    };
  });
}

export function layoutWorkflowSteps(
  nodes,
  stepIds,
  heights = {},
  { top = 0, gap = 0 } = {},
) {
  const positions = new Map();
  let y = top;
  for (const id of stepIds) {
    positions.set(id, { x: 0, y });
    const height = Number.isFinite(heights[id]) ? heights[id] : 0;
    y += height + gap;
  }
  const laidOut = nodes.map((node) => (
    !node.parentId && positions.has(node.id)
      ? { ...node, position: positions.get(node.id) }
      : node
  ));
  const nodesById = new Map(laidOut.map((node) => [node.id, node]));
  const orderedRoots = stepIds
    .map((id) => nodesById.get(id))
    .filter((node) => node && !node.parentId);
  const orderedRootIds = new Set(orderedRoots.map((node) => node.id));
  return [
    ...orderedRoots,
    ...laidOut.filter((node) => !node.parentId && !orderedRootIds.has(node.id)),
    ...laidOut.filter((node) => node.parentId),
  ];
}
