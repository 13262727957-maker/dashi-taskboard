import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { ApiError } from "../api";
import { labelColor } from "../labels";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type DevelopmentContext,
  type DevelopmentScan,
  type Project,
  type Recurrence,
  type Task,
  type TaskDraft,
  type TaskPriority,
  type TaskStatus,
} from "../types";
import { STATUS_DETAILS } from "./BoardColumn";
import { LinearIcon, LinearPriorityIcon, LinearStatusIcon } from "./LinearIcon";

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  none: "无优先级",
  urgent: "紧急",
  high: "高",
  medium: "中",
  low: "低",
};

const RECURRENCE_UNITS: Record<Recurrence["unit"], string> = {
  day: "天",
  week: "周",
  month: "月",
  year: "年",
};

interface TaskEditorProps {
  task: Task | null;
  initialStatus: TaskStatus;
  project: Project | null;
  labels: string[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  onCancel: () => void;
  onSave: (draft: TaskDraft, attachments: File[]) => Promise<void>;
}

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function isoDate(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function dateFromNow(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return isoDate(date);
}

function endOfWeek(): string {
  const date = new Date();
  const daysUntilFriday = (5 - date.getDay() + 7) % 7;
  date.setDate(date.getDate() + daysUntilFriday);
  return isoDate(date);
}

function displayDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" })
    .format(new Date(`${value}T12:00:00`));
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(context: DevelopmentContext): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? "detached"} · ${folder}`;
}

export function TaskEditor({
  task,
  initialStatus,
  project,
  labels: availableLabels,
  developmentScan,
  developmentScanLoading,
  onCancel,
  onSave,
}: TaskEditorProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(task?.title ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [status, setStatus] = useState<TaskStatus>(task?.status ?? initialStatus);
  const [priority, setPriority] = useState<TaskPriority>(task?.priority ?? "none");
  const [selectedLabels, setSelectedLabels] = useState<string[]>(task?.labels ?? []);
  const [labelSearch, setLabelSearch] = useState("");
  const [developmentContext, setDevelopmentContext] = useState<DevelopmentContext | null>(task?.developmentContext ?? null);
  const [dueDate, setDueDate] = useState(task?.dueDate ?? "");
  const [recurrence, setRecurrence] = useState<Recurrence | null>(task?.recurrence ?? null);
  const [menu, setMenu] = useState<"labels" | "more" | "due" | "recurrence" | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<File[]>([]);

  const developmentOptions = useMemo(() => {
    const options = [...developmentScan.contexts];
    if (developmentContext && !options.some((option) => contextValue(option) === contextValue(developmentContext))) {
      options.unshift(developmentContext);
    }
    return options;
  }, [developmentContext, developmentScan.contexts]);

  const filteredLabels = availableLabels.filter((label) => (
    !labelSearch.trim() || label.toLocaleLowerCase().includes(labelSearch.trim().toLocaleLowerCase())
  ));
  const customLabel = labelSearch.trim();
  const canCreateLabel = Boolean(customLabel) && !availableLabels.includes(customLabel);

  useEffect(() => {
    dialogRef.current?.showModal();
    titleRef.current?.focus();
    return () => {
      if (dialogRef.current?.open) dialogRef.current.close();
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle) {
      setError("请为议题填写一个简短、明确的标题。");
      titleRef.current?.focus();
      return;
    }
    if (recurrence && !dueDate) {
      setError("重复议题需要先设置最早截止日期。");
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await onSave({
        title: cleanTitle,
        description: description.trim(),
        status,
        priority,
        labels: selectedLabels,
        developmentContext,
        dueDate: dueDate || null,
        recurrence,
      }, attachments);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "VERSION_CONFLICT") {
        setError("这个议题已在其他位置发生变更，请关闭并刷新后重试。");
      } else {
        setError(caught instanceof Error ? caught.message : "无法保存这个议题。");
      }
    } finally {
      setSaving(false);
    }
  }

  function addAttachments(files: FileList) {
    const selected = Array.from(files);
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setAttachmentError(`“${oversized.name}” 超过 25 MB，无法上传。`);
      return;
    }
    setAttachmentError(null);
    setAttachments((current) => {
      const existing = new Set(current.map(fileKey));
      return [...current, ...selected.filter((file) => !existing.has(fileKey(file)))];
    });
  }

  function toggleLabel(label: string) {
    setSelectedLabels((current) => current.includes(label)
      ? current.filter((item) => item !== label)
      : [...current, label]);
  }

  function chooseDueDate(value: string) {
    setDueDate(value);
    setMenu(null);
  }

  return (
    <dialog
      ref={dialogRef}
      className={`task-dialog${expanded ? " is-expanded" : ""}`}
      aria-labelledby="task-dialog-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!saving) onCancel();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && !saving) onCancel();
      }}
    >
      <form className="task-form" onSubmit={handleSubmit}>
        <header className="dialog-header">
          <div className="dialog-context">
            <span className="dialog-project-icon" aria-hidden="true">{project?.name.slice(0, 1).toUpperCase() ?? "L"}</span>
            <span>{project?.name ?? "Local"}</span>
            <span className="dialog-chevron"><LinearIcon name="chevronRight" /></span>
            <strong id="task-dialog-title">{task ? task.identifier : "新建议题"}</strong>
          </div>
          <div className="dialog-header-actions">
            <button type="button" className="icon-button dialog-expand" aria-label={expanded ? "收起编辑器" : "展开编辑器"} onClick={() => setExpanded((current) => !current)}>
              <LinearIcon name="expand" />
            </button>
            <button type="button" className="icon-button dialog-close" onClick={onCancel} disabled={saving} aria-label="关闭编辑器">
              <LinearIcon name="close" />
            </button>
          </div>
        </header>

        <div className="form-body">
          <label className="composer-title">
            <span className="sr-only">标题</span>
            <input ref={titleRef} value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Issue title" maxLength={240} autoComplete="off" />
          </label>
          <label className="composer-description">
            <span className="sr-only">描述</span>
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Add description…" rows={5} />
          </label>

          <div className="property-row">
            <label className="property-control property-status">
              <LinearStatusIcon status={status} className={`status-icon-${STATUS_DETAILS[status].tone}`} />
              <span className="sr-only">状态</span>
              <select value={status} onChange={(event) => setStatus(event.target.value as TaskStatus)}>
                {TASK_STATUSES.map((value) => <option value={value} key={value}>{STATUS_DETAILS[value].label}</option>)}
              </select>
            </label>
            <label className={`property-control property-priority priority-${priority}`}>
              <LinearPriorityIcon priority={priority} />
              <span className="sr-only">优先级</span>
              <select value={priority} onChange={(event) => setPriority(event.target.value as TaskPriority)}>
                {TASK_PRIORITIES.map((value) => <option value={value} key={value}>{PRIORITY_LABELS[value]}</option>)}
              </select>
            </label>
            <span className="property-control property-project"><span className="dialog-project-icon" aria-hidden="true">{project?.name.slice(0, 1).toUpperCase() ?? "L"}</span>{project?.name ?? "Local"}</span>
            <div className="composer-menu-anchor">
              <button className="property-control" type="button" onClick={() => setMenu(menu === "labels" ? null : "labels")}>
                <LinearIcon name="label" />
                <span>{selectedLabels.length > 0 ? selectedLabels.join(", ") : "标签"}</span>
              </button>
              {menu === "labels" && (
                <div className="composer-popover label-popover">
                  <input autoFocus value={labelSearch} onChange={(event) => setLabelSearch(event.target.value)} placeholder="Add labels…" aria-label="搜索标签" />
                  <div className="label-options">
                    {filteredLabels.map((label) => (
                      <button type="button" key={label} onClick={() => toggleLabel(label)}>
                        <i style={{ background: labelColor(label) }} />
                        <span>{label}</span>
                        {selectedLabels.includes(label) && <b><LinearIcon name="check" /></b>}
                      </button>
                    ))}
                    {canCreateLabel && <button type="button" onClick={() => { toggleLabel(customLabel); setLabelSearch(""); }}><i style={{ background: labelColor(customLabel) }} /><span>创建 “{customLabel}”</span></button>}
                  </div>
                </div>
              )}
            </div>

            <label className="property-control property-development" title={developmentScan.workspacePath ?? undefined}>
              <LinearIcon name="branch" />
              <span className="sr-only">代码分支或 Worktree</span>
              <select
                value={contextValue(developmentContext)}
                disabled={developmentScanLoading}
                onChange={(event) => setDevelopmentContext(event.target.value ? JSON.parse(event.target.value) as DevelopmentContext : null)}
              >
                <option value="">{developmentScanLoading ? "正在扫描 Git…" : "分支 / Worktree"}</option>
                <optgroup label="代码分支">
                  {developmentOptions.filter((context) => context.type === "branch").map((context) => <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context)}</option>)}
                </optgroup>
                <optgroup label="Worktree">
                  {developmentOptions.filter((context) => context.type === "worktree").map((context) => <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context)}</option>)}
                </optgroup>
              </select>
            </label>

            {dueDate && <button className="property-control" type="button" onClick={() => setMenu("due")}><span>截止 {displayDate(dueDate)}</span></button>}
            {recurrence && <button className="property-control" type="button" onClick={() => setMenu("recurrence")}><span>每 {recurrence.interval} {RECURRENCE_UNITS[recurrence.unit]}</span></button>}

            <div className="composer-menu-anchor">
              <button className="property-control property-more" type="button" aria-label="更多属性" onClick={() => setMenu(menu === "more" ? null : "more")}><LinearIcon name="more" /></button>
              {menu === "more" && (
                <div className="composer-popover more-popover">
                  <button type="button" onClick={() => setMenu("due")}><span><LinearIcon name="calendarAdd" /></span><strong>设置截止日期</strong><kbd>⇧ D</kbd><b><LinearIcon name="chevronRight" /></b></button>
                  <button type="button" onClick={() => setMenu("recurrence")}><span><LinearIcon name="recurrence" /></span><strong>设置重复…</strong><b><LinearIcon name="chevronRight" /></b></button>
                </div>
              )}
              {menu === "due" && (
                <div className="composer-popover due-popover">
                  <label className="custom-date-row"><span>自定义…</span><input type="date" value={dueDate} onChange={(event) => chooseDueDate(event.target.value)} /></label>
                  <button type="button" onClick={() => chooseDueDate(dateFromNow(1))}><strong>明天</strong><span>{displayDate(dateFromNow(1))}</span></button>
                  <button type="button" onClick={() => chooseDueDate(endOfWeek())}><strong>本周结束</strong><span>{displayDate(endOfWeek())}</span></button>
                  <button type="button" onClick={() => chooseDueDate(dateFromNow(7))}><strong>一周后</strong><span>{displayDate(dateFromNow(7))}</span></button>
                  {dueDate && <button className="destructive-menu-row" type="button" onClick={() => { setDueDate(""); setRecurrence(null); setMenu(null); }}>清除截止日期</button>}
                </div>
              )}
              {menu === "recurrence" && (
                <div className="composer-popover recurrence-popover">
                  <label><span>最早截止日期</span><input type="date" value={dueDate || dateFromNow(7)} onChange={(event) => setDueDate(event.target.value)} /></label>
                  <label><span>重复频率</span><span className="recurrence-controls"><input type="number" min="1" max="365" value={recurrence?.interval ?? 1} onChange={(event) => setRecurrence({ interval: Number(event.target.value), unit: recurrence?.unit ?? "week" })} /><select value={recurrence?.unit ?? "week"} onChange={(event) => setRecurrence({ interval: recurrence?.interval ?? 1, unit: event.target.value as Recurrence["unit"] })}>{Object.entries(RECURRENCE_UNITS).map(([unit, label]) => <option value={unit} key={unit}>{label}</option>)}</select></span></label>
                  <button className="recurrence-save" type="button" onClick={() => { if (!dueDate) setDueDate(dateFromNow(7)); if (!recurrence) setRecurrence({ interval: 1, unit: "week" }); setMenu(null); }}>设置重复</button>
                  {recurrence && <button className="destructive-menu-row" type="button" onClick={() => { setRecurrence(null); setMenu(null); }}>清除重复</button>}
                </div>
              )}
            </div>
          </div>

          {attachments.length > 0 && (
            <ul className="composer-attachment-list" aria-label="待上传附件">
              {attachments.map((file, index) => (
                <li key={`${fileKey(file)}:${index}`}><span className="composer-attachment-file-icon" aria-hidden="true"><LinearIcon name="file" /></span><span className="composer-attachment-copy"><strong>{file.name}</strong><span>{fileSize(file.size)} · 保存后上传</span></span><button type="button" disabled={saving} aria-label={`移除 ${file.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><LinearIcon name="close" /></button></li>
              ))}
            </ul>
          )}
          {attachmentError && <div className="form-error" role="alert">{attachmentError}</div>}
          {error && <div className="form-error" role="alert">{error}</div>}
        </div>

        <footer className="dialog-footer">
          <button className="composer-attach-icon" type="button" disabled={saving} onClick={() => attachmentInputRef.current?.click()} aria-label="上传附件">
            <LinearIcon name="attachment" />{attachments.length > 0 && <span>{attachments.length}</span>}
          </button>
          <input ref={attachmentInputRef} type="file" multiple hidden onChange={(event) => { if (event.currentTarget.files) addAttachments(event.currentTarget.files); event.currentTarget.value = ""; }} />
          <div className="dialog-actions">
            {task && <span className="dialog-updated">编辑 {task.identifier}</span>}
            <button className="button primary" type="submit" disabled={saving}>{saving ? "正在保存…" : task ? "保存更改" : "创建议题"}</button>
          </div>
        </footer>
      </form>
    </dialog>
  );
}
