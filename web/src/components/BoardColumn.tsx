import { useEffect, useMemo, useState } from "react";
import type { DragEvent } from "react";
import type { Task, TaskStatus } from "../types";
import { ColumnVisibilityMenu } from "./ColumnVisibilityMenu";
import { LinearIcon, LinearStatusIcon } from "./LinearIcon";
import { TaskCard } from "./TaskCard";
import "./CompletedHistory.css";

export const STATUS_DETAILS: Record<
  TaskStatus,
  { label: string; tone: string }
> = {
  backlog: { label: "积压事项", tone: "backlog" },
  todo: { label: "待办事项", tone: "todo" },
  in_progress: { label: "进行中", tone: "progress" },
  in_review: { label: "审核中", tone: "review" },
  blocked: { label: "已阻塞", tone: "blocked" },
  done: { label: "完成", tone: "done" },
  canceled: { label: "已取消", tone: "canceled" },
};

export function StatusIcon({ status }: { status: TaskStatus }) {
  return <LinearStatusIcon status={status} />;
}

interface BoardColumnProps {
  status: TaskStatus;
  statusIndex: number;
  tasks: Task[];
  isDropTarget: boolean;
  draggedTaskId: string | null;
  draggedTaskHeight: number;
  movingTaskId: string | null;
  settlingTaskId: string | null;
  contextMenuTaskId: string | null;
  onCreate: (status: TaskStatus) => void;
  onEdit: (task: Task) => void;
  onContextMenu: (task: Task, position: { x: number; y: number }) => void;
  onMove: (task: Task, status: TaskStatus) => void;
  onDragStart: (task: Task, height: number) => void;
  onDragEnd: () => void;
  onDragEnter: (status: TaskStatus) => void;
  onDrop: (status: TaskStatus, taskId: string, beforeTaskId: string | null) => void;
  onOpenThread: (threadId: string) => void;
  onHide: (status: TaskStatus) => void;
}

export function BoardColumn({
  status,
  statusIndex,
  tasks,
  isDropTarget,
  draggedTaskId,
  draggedTaskHeight,
  movingTaskId,
  settlingTaskId,
  contextMenuTaskId,
  onCreate,
  onEdit,
  onContextMenu,
  onMove,
  onDragStart,
  onDragEnd,
  onDragEnter,
  onDrop,
  onOpenThread,
  onHide,
}: BoardColumnProps) {
  const details = STATUS_DETAILS[status];
  const [completedExpanded, setCompletedExpanded] = useState(false);
  const [completedDays, setCompletedDays] = useState("7");
  const [completedSearch, setCompletedSearch] = useState("");
  const [completedPage, setCompletedPage] = useState(0);
  const completed = status === "done";
  const completedMatches = useMemo(() => {
    if (!completed) return tasks;
    const since = completedDays === "all" ? 0 : Date.now() - Number(completedDays) * 86400000;
    const query = completedSearch.trim().toLocaleLowerCase();
    return tasks.filter(task => Date.parse(task.completedAt ?? task.updatedAt) >= since
      && (!query || `${task.identifier} ${task.title} ${task.description}`.toLocaleLowerCase().includes(query)))
      .sort((a, b) => Date.parse(b.completedAt ?? b.updatedAt) - Date.parse(a.completedAt ?? a.updatedAt) || a.id.localeCompare(b.id));
  }, [completed, completedDays, completedSearch, tasks]);
  const completedPages = Math.max(1, Math.ceil(completedMatches.length / 20));
  const currentPage = Math.min(completedPage, completedPages - 1);
  const displayedTasks = completed
    ? completedExpanded ? completedMatches.slice(currentPage * 20, (currentPage + 1) * 20) : []
    : tasks;
  const [dropBeforeTaskId, setDropBeforeTaskId] = useState<string | null | undefined>();
  const taskIndexes = new Map(tasks.map((task, index) => [task.id, index]));
  const remainingTasks = tasks.filter((task) => task.id !== draggedTaskId);
  const remainingIndexes = new Map(remainingTasks.map((task, index) => [task.id, index]));
  const draggedTaskIndex = draggedTaskId ? taskIndexes.get(draggedTaskId) ?? -1 : -1;
  const beforeIndex = dropBeforeTaskId
    ? remainingIndexes.get(dropBeforeTaskId) ?? remainingTasks.length
    : remainingTasks.length;
  const previewIndex = isDropTarget && dropBeforeTaskId !== undefined ? beforeIndex : -1;
  const dragDistance = draggedTaskHeight + 8;

  useEffect(() => {
    if (!isDropTarget || !draggedTaskId) setDropBeforeTaskId(undefined);
  }, [draggedTaskId, isDropTarget]);

  function findDropBefore(container: HTMLElement, clientY: number): string | null {
    const cards = Array.from(container.querySelectorAll<HTMLElement>("[data-task-id]"))
      .filter((card) => card.dataset.taskId !== draggedTaskId);
    return cards.find((card) => clientY < card.getBoundingClientRect().top + card.offsetHeight / 2)
      ?.dataset.taskId ?? null;
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault();
    const taskId =
      event.dataTransfer.getData("application/x-taskboard-task") ||
      event.dataTransfer.getData("text/plain");
    if (taskId) onDrop(status, taskId, findDropBefore(event.currentTarget, event.clientY));
    setDropBeforeTaskId(undefined);
  }

  function getTaskDragShift(task: Task): number {
    if (!draggedTaskId || task.id === draggedTaskId) return 0;
    let shift = 0;
    const taskIndex = taskIndexes.get(task.id) ?? -1;
    const remainingIndex = remainingIndexes.get(task.id) ?? -1;

    if (draggedTaskIndex >= 0 && taskIndex > draggedTaskIndex) shift -= dragDistance;
    if (previewIndex >= 0 && remainingIndex >= previewIndex) shift += dragDistance;
    return shift;
  }

  return (
    <section
      className={`board-column status-${status}${completed ? " completed-history-column" : ""}${isDropTarget ? " is-drop-target" : ""}`}
      aria-labelledby={`column-${status}`}
      onDragEnter={() => onDragEnter(status)}
      onDragOver={(event) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        onDragEnter(status);
        setDropBeforeTaskId(findDropBefore(event.currentTarget, event.clientY));
      }}
      onDragLeave={(event) => {
        if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) {
          setDropBeforeTaskId(undefined);
        }
      }}
      onDrop={handleDrop}
    >
      <header className="column-header">
        <div className="column-heading">
          {completed && <button type="button" className="icon-button" aria-label={completedExpanded ? "收起已完成任务" : "展开已完成任务"} title={completedExpanded ? "收起已完成任务" : "展开已完成任务"} aria-expanded={completedExpanded} aria-controls="completed-history-list" onClick={() => setCompletedExpanded(value => !value)}>
            <LinearIcon name={completedExpanded ? "chevronDown" : "chevronRight"} />
          </button>}
          <span className={`status-icon status-icon-${details.tone}`}>
            <StatusIcon status={status} />
          </span>
          <h2 id={`column-${status}`}>{completed ? "已完成" : details.label}</h2>
          <span className="task-count" aria-label={`${tasks.length} 个议题`}>{tasks.length}</span>
        </div>
        <div className="column-actions">
          {tasks.length > 0 && (
            <ColumnVisibilityMenu
              label={details.label}
              action="hide"
              className="icon-button column-menu"
              onAction={() => onHide(status)}
            />
          )}
          <button
            type="button"
            className="icon-button add-task-button"
            onClick={() => onCreate(status)}
            aria-label={`在${details.label}中新建议题`}
            title={`添加到${details.label}`}
          >
            <LinearIcon name="plus" />
          </button>
        </div>
      </header>

      {completed && completedExpanded && <div className="completed-history-controls">
        <select aria-label="已完成任务时间范围" value={completedDays} onChange={event => { setCompletedDays(event.target.value); setCompletedPage(0); }}>
          <option value="7">最近 7 天</option><option value="30">最近 30 天</option><option value="all">全部</option>
        </select>
        <label className="completed-history-search"><LinearIcon name="search" /><input type="search" aria-label="搜索已完成任务" placeholder="搜索已完成任务" value={completedSearch} onChange={event => { setCompletedSearch(event.target.value); setCompletedPage(0); }} /></label>
      </div>}
      <div className="column-list" id={completed ? "completed-history-list" : undefined} hidden={completed && !completedExpanded}>
        {completed && completedExpanded && completedMatches.length === 0 && <div className="completed-history-empty" role="status">暂无匹配的已完成任务</div>}
        {displayedTasks.map((task) => {
          const dragShift = getTaskDragShift(task);
          return (
            <TaskCard
              key={task.id}
              task={task}
              statusIndex={statusIndex}
              isDragging={draggedTaskId === task.id}
              dragShift={dragShift}
              isMoving={movingTaskId === task.id}
              isSettling={settlingTaskId === task.id}
              isContextMenuOpen={contextMenuTaskId === task.id}
              onEdit={onEdit}
              onContextMenu={onContextMenu}
              onMove={onMove}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onOpenThread={onOpenThread}
            />
          );
        })}
      </div>
      {completed && completedExpanded && <nav className="completed-history-pagination" aria-label="已完成任务分页">
        <span aria-live="polite">{completedMatches.length} 条 · {currentPage + 1} / {completedPages}</span>
        <button type="button" className="icon-button" aria-label="上一页已完成任务" title="上一页" disabled={currentPage === 0} onClick={() => setCompletedPage(currentPage - 1)}><LinearIcon name="chevronLeft" /></button>
        <button type="button" className="icon-button" aria-label="下一页已完成任务" title="下一页" disabled={currentPage + 1 >= completedPages} onClick={() => setCompletedPage(currentPage + 1)}><LinearIcon name="chevronRight" /></button>
      </nav>}
    </section>
  );
}
