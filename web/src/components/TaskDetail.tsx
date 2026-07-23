import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  ApiError,
  attachmentContentUrl,
  createComment,
  deleteAttachment,
  deleteComment,
  listAttachments,
  listComments,
  uploadAttachment,
  uploadCommentAttachment,
  updateComment,
} from "../api";
import { TASK_STATUSES } from "../types";
import type {
  ActorIdentity,
  ActorType,
  Attachment,
  Comment,
  DevelopmentContext,
  DevelopmentScan,
  Recurrence,
  Task,
  TaskDraft,
  TaskPriority,
  TaskStatus,
  WorkflowOption,
} from "../types";
import { STATUS_DETAILS } from "./BoardColumn";
import { LabelPicker } from "./LabelPicker";
import { LinearIcon, LinearPriorityIcon, LinearStatusIcon } from "./LinearIcon";

const MAX_ATTACHMENT_SIZE = 25 * 1024 * 1024;

const PRIORITY_DETAILS: Record<TaskPriority, { label: string; bars: number }> = {
  none: { label: "无优先级", bars: 0 },
  urgent: { label: "紧急", bars: 3 },
  high: { label: "高", bars: 3 },
  medium: { label: "中", bars: 2 },
  low: { label: "低", bars: 1 },
};

interface TaskDetailProps {
  task: Task;
  currentUser: ActorIdentity;
  availableLabels: string[];
  workflows: WorkflowOption[];
  developmentScan: DevelopmentScan;
  developmentScanLoading: boolean;
  commentsRevision: number;
  attachmentsRevision: number;
  onUpdate: (task: Task, changes: Partial<TaskDraft>) => Promise<Task>;
  onOpenThread: (threadId: string) => void;
  onOpenInThread: (task: Task) => void;
  openingThread: boolean;
  onError: (message: string | null) => void;
  onAnnounce: (message: string) => void;
}

function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "操作未完成，请重试。";
}

function exactTime(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function relativeTime(value: string): string {
  const seconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 30) return formatter.format(days, "day");
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(value));
}

function resizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "0px";
  element.style.height = `${element.scrollHeight}px`;
}

function fileSize(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function fileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}`;
}

function contextValue(context: DevelopmentContext | null): string {
  return context ? JSON.stringify(context) : "";
}

function contextLabel(context: DevelopmentContext): string {
  if (context.type === "branch") return context.branch;
  const folder = context.path.split(/[\\/]/).filter(Boolean).at(-1) ?? context.path;
  return `${context.branch ?? "detached"} · ${folder}`;
}

function renderInlineText(value: string): ReactNode[] {
  return value.split(/(`[^`]+`)/g).filter(Boolean).map((part, index) => (
    part.startsWith("`") && part.endsWith("`")
      ? <code key={`${part}:${index}`}>{part.slice(1, -1)}</code>
      : <span key={`${part}:${index}`}>{part}</span>
  ));
}

function DescriptionDocument({ value }: { value: string }) {
  return (
    <div className="issue-description-document">
      {value.split("\n").map((line, index) => {
        const heading = /^(#{1,3})\s+(.+)$/.exec(line);
        if (heading) {
          const content = renderInlineText(heading[2]);
          if (heading[1].length === 1) return <h2 key={index}>{content}</h2>;
          if (heading[1].length === 2) return <h3 key={index}>{content}</h3>;
          return <h4 key={index}>{content}</h4>;
        }
        const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
        if (bullet) {
          return <div className="description-list-item" key={index}><span>•</span><p>{renderInlineText(bullet[1])}</p></div>;
        }
        const numbered = /^\s*(\d+)\.\s+(.+)$/.exec(line);
        if (numbered) {
          return <div className="description-list-item" key={index}><span>{numbered[1]}.</span><p>{renderInlineText(numbered[2])}</p></div>;
        }
        if (!line.trim()) return <div className="description-spacer" key={index} aria-hidden="true" />;
        return <p key={index}>{renderInlineText(line)}</p>;
      })}
    </div>
  );
}

function ConversationLink({
  threadId,
  onOpen,
}: {
  threadId: string;
  onOpen: (threadId: string) => void;
}) {
  return (
    <button
      className="issue-conversation-link"
      type="button"
      title={`查看对话 ${threadId}`}
      onClick={() => onOpen(threadId)}
    >
      <LinearIcon name="conversation" />
      <strong>查看对话</strong>
      <span className="conversation-divider" aria-hidden="true" />
      <span className="conversation-thread-id">{threadId}</span>
    </button>
  );
}

function ActorAvatar({
  type,
  name,
  avatarUrl,
}: {
  type: ActorType;
  name: string;
  avatarUrl: string | null;
}) {
  return (
    <div className={`comment-avatar actor-avatar-${type}`} aria-hidden="true">
      {type === "agent" ? (
        <img
          className="actor-avatar-image actor-avatar-agent-image"
          src="/codex-agent-logo.png"
          alt=""
        />
      ) : avatarUrl ? (
        <img className="actor-avatar-image" src={avatarUrl} alt="" referrerPolicy="no-referrer" />
      ) : name.slice(0, 1)}
    </div>
  );
}

export function TaskDetail({
  task,
  currentUser,
  availableLabels,
  workflows,
  developmentScan,
  developmentScanLoading,
  commentsRevision,
  attachmentsRevision,
  onUpdate,
  onOpenThread,
  onOpenInThread,
  openingThread,
  onError,
  onAnnounce,
}: TaskDetailProps) {
  const [currentTask, setCurrentTask] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [editingDescription, setEditingDescription] = useState(false);
  const [labelMenuOpen, setLabelMenuOpen] = useState(false);
  const [savingProperty, setSavingProperty] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [attachmentsLoading, setAttachmentsLoading] = useState(true);
  const [attachmentsError, setAttachmentsError] = useState<string | null>(null);
  const [uploadingAttachments, setUploadingAttachments] = useState(false);
  const [pendingAttachmentDelete, setPendingAttachmentDelete] = useState<Attachment | null>(null);
  const [deletingAttachment, setDeletingAttachment] = useState(false);
  const [comments, setComments] = useState<Comment[]>([]);
  const [commentsLoading, setCommentsLoading] = useState(true);
  const [commentsError, setCommentsError] = useState<string | null>(null);
  const [draft, setDraft] = useState(() => window.localStorage.getItem(`taskboard.comment-draft.${task.id}`) ?? "");
  const [pendingCommentFiles, setPendingCommentFiles] = useState<File[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [activeMenuId, setActiveMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingBody, setEditingBody] = useState("");
  const [savingCommentId, setSavingCommentId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Comment | null>(null);
  const [deleting, setDeleting] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const descriptionRef = useRef<HTMLTextAreaElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const commentAttachmentInputRef = useRef<HTMLInputElement>(null);
  const workflowAvailable = !currentTask.workflowId
    || workflows.some((workflow) => workflow.id === currentTask.workflowId);

  useEffect(() => {
    setCurrentTask(task);
    if (document.activeElement !== titleRef.current) setTitle(task.title);
    if (document.activeElement !== descriptionRef.current) setDescription(task.description);
  }, [task]);

  useEffect(() => {
    resizeTextarea(titleRef.current);
    resizeTextarea(descriptionRef.current);
  }, [title, description, editingDescription]);

  useEffect(() => {
    if (!editingDescription) return;
    requestAnimationFrame(() => {
      descriptionRef.current?.focus();
      resizeTextarea(descriptionRef.current);
    });
  }, [editingDescription]);

  useEffect(() => {
    const controller = new AbortController();
    setCommentsError(null);
    void listComments(task.id, controller.signal).then(
      (nextComments) => {
        setComments(nextComments);
        setCommentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setCommentsError(messageFor(error));
        setCommentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [commentsRevision, task.id]);

  useEffect(() => {
    const controller = new AbortController();
    setAttachmentsLoading(true);
    setAttachmentsError(null);
    void listAttachments(task.id, controller.signal).then(
      (nextAttachments) => {
        setAttachments(nextAttachments.filter((attachment) => !attachment.commentId));
        setAttachmentsLoading(false);
      },
      (error) => {
        if ((error as Error).name === "AbortError") return;
        setAttachmentsError(messageFor(error));
        setAttachmentsLoading(false);
      },
    );
    return () => controller.abort();
  }, [attachmentsRevision, task.id]);

  useEffect(() => {
    const key = `taskboard.comment-draft.${task.id}`;
    if (draft) window.localStorage.setItem(key, draft);
    else window.localStorage.removeItem(key);
  }, [draft, task.id]);

  useEffect(() => {
    function handleShortcut(event: globalThis.KeyboardEvent) {
      if (event.key.toLowerCase() !== "r" || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select, [contenteditable='true']")) return;
      event.preventDefault();
      composerRef.current?.focus();
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (!activeMenuId) return;
    function closeMenu(event: PointerEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(`[data-comment-menu-root="${activeMenuId}"]`)) setActiveMenuId(null);
    }
    function closeWithEscape(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setActiveMenuId(null);
    }
    document.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeWithEscape);
    return () => {
      document.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeWithEscape);
    };
  }, [activeMenuId]);

  async function saveTask(changes: Partial<TaskDraft>, property: string) {
    setSavingProperty(property);
    onError(null);
    try {
      const saved = await onUpdate(currentTask, changes);
      setCurrentTask(saved);
      setTitle(saved.title);
      setDescription(saved.description);
      onAnnounce(`${saved.identifier} 已更新。`);
      return saved;
    } catch (error) {
      onError(messageFor(error));
      setTitle(currentTask.title);
      setDescription(currentTask.description);
      return null;
    } finally {
      setSavingProperty(null);
    }
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.blur();
    }
    if (event.key === "Escape") {
      setTitle(currentTask.title);
      event.currentTarget.blur();
    }
  }

  async function saveTitle() {
    const normalized = title.trim();
    if (!normalized) {
      setTitle(currentTask.title);
      onError("议题标题不能为空。");
      return;
    }
    if (normalized === currentTask.title) {
      setTitle(normalized);
      return;
    }
    await saveTask({ title: normalized }, "title");
  }

  async function saveDescription() {
    const normalized = description.trim();
    if (normalized === currentTask.description) return;
    await saveTask({ description: normalized }, "description");
  }

  async function submitComment() {
    const body = draft.trim();
    if ((!body && pendingCommentFiles.length === 0) || submitting) return;
    setSubmitting(true);
    setCommentsError(null);
    try {
      const comment = await createComment(task.id, body);
      const results = await Promise.allSettled(
        pendingCommentFiles.map((file) => uploadCommentAttachment(comment.id, file)),
      );
      const uploaded = results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
      const nextComment = { ...comment, attachments: [...comment.attachments, ...uploaded] };
      setComments((current) => [...current, nextComment]);
      setDraft("");
      setPendingCommentFiles([]);
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      const failed = results.length - uploaded.length;
      if (failed > 0) setCommentsError(`评论已发布，但有 ${failed} 个附件上传失败。`);
      else onAnnounce(uploaded.length > 0 ? "评论和附件已发布。" : "评论已发布。");
      requestAnimationFrame(() => composerRef.current?.focus());
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSubmitting(false);
    }
  }

  function stageCommentFiles(files: FileList) {
    const selected = Array.from(files);
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setCommentsError(`“${oversized.name}” 超过 25 MB，无法上传。`);
      if (commentAttachmentInputRef.current) commentAttachmentInputRef.current.value = "";
      return;
    }
    setCommentsError(null);
    setPendingCommentFiles((current) => {
      const existing = new Set(current.map(fileKey));
      return [...current, ...selected.filter((file) => !existing.has(fileKey(file)))];
    });
  }

  function handleSubmitShortcut(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void submitComment();
    }
  }

  function beginEdit(comment: Comment) {
    setEditingId(comment.id);
    setEditingBody(comment.body);
    setActiveMenuId(null);
  }

  async function saveComment(comment: Comment) {
    const body = editingBody.trim();
    if (!body || body === comment.body) {
      if (body === comment.body) setEditingId(null);
      return;
    }
    setSavingCommentId(comment.id);
    setCommentsError(null);
    try {
      const updated = await updateComment(comment, body);
      setComments((current) => current.map((item) => item.id === updated.id ? updated : item));
      setEditingId(null);
      onAnnounce("评论已更新。");
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setSavingCommentId(null);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete || deleting) return;
    setDeleting(true);
    setCommentsError(null);
    try {
      await deleteComment(pendingDelete);
      setComments((current) => current.filter((comment) => comment.id !== pendingDelete.id));
      setPendingDelete(null);
      onAnnounce("评论已删除。");
    } catch (error) {
      setCommentsError(messageFor(error));
    } finally {
      setDeleting(false);
    }
  }

  async function uploadFiles(files: FileList) {
    const selected = Array.from(files);
    if (selected.length === 0 || uploadingAttachments) return;
    const oversized = selected.find((file) => file.size > MAX_ATTACHMENT_SIZE);
    if (oversized) {
      setAttachmentsError(`“${oversized.name}” 超过 25 MB，无法上传。`);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
      return;
    }

    setUploadingAttachments(true);
    setAttachmentsError(null);
    let uploaded = 0;
    try {
      for (const file of selected) {
        const attachment = await uploadAttachment(task.id, file);
        setAttachments((current) => current.some((item) => item.id === attachment.id)
          ? current
          : [...current, attachment]);
        uploaded += 1;
      }
      onAnnounce(uploaded === 1 ? "附件已上传。" : `${uploaded} 个附件已上传。`);
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setUploadingAttachments(false);
      if (attachmentInputRef.current) attachmentInputRef.current.value = "";
    }
  }

  async function confirmAttachmentDelete() {
    if (!pendingAttachmentDelete || deletingAttachment) return;
    setDeletingAttachment(true);
    setAttachmentsError(null);
    try {
      await deleteAttachment(pendingAttachmentDelete);
      setAttachments((current) => current.filter((attachment) => attachment.id !== pendingAttachmentDelete.id));
      setComments((current) => current.map((comment) => ({
        ...comment,
        attachments: comment.attachments.filter((attachment) => attachment.id !== pendingAttachmentDelete.id),
      })));
      setPendingAttachmentDelete(null);
      onAnnounce("附件已删除。");
    } catch (error) {
      setAttachmentsError(messageFor(error));
    } finally {
      setDeletingAttachment(false);
    }
  }

  const developmentOptions = [...developmentScan.contexts];
  if (
    currentTask.developmentContext
    && !developmentOptions.some((context) => contextValue(context) === contextValue(currentTask.developmentContext))
  ) {
    developmentOptions.unshift(currentTask.developmentContext);
  }

  return (
    <section className="issue-detail" aria-label={`${task.identifier} 议题详情`}>
      <div className="issue-detail-scroll">
        <div className="issue-detail-layout">
          <div className="issue-detail-main">
            <article className="issue-editor" aria-label="议题内容">
              <div className="issue-editor-content">
                <textarea
                  ref={titleRef}
                  className="issue-title-input"
                  rows={1}
                  value={title}
                  aria-label="议题标题"
                  disabled={savingProperty === "title"}
                  onChange={(event) => {
                    setTitle(event.target.value.replace(/\n/g, ""));
                    resizeTextarea(event.currentTarget);
                  }}
                  onKeyDown={handleTitleKeyDown}
                  onBlur={() => void saveTitle()}
                />
                {editingDescription ? (
                  <textarea
                    ref={descriptionRef}
                    className="issue-description-input"
                    rows={1}
                    value={description}
                    aria-label="议题描述"
                    placeholder="添加描述…"
                    disabled={savingProperty === "description"}
                    onChange={(event) => {
                      setDescription(event.target.value);
                      resizeTextarea(event.currentTarget);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        setDescription(currentTask.description);
                        setEditingDescription(false);
                      }
                    }}
                    onBlur={() => {
                      setEditingDescription(false);
                      void saveDescription();
                    }}
                  />
                ) : (
                  <div
                    className={`issue-description-read${description ? "" : " empty"}`}
                    role="button"
                    tabIndex={0}
                    aria-label="编辑议题描述"
                    onClick={() => setEditingDescription(true)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setEditingDescription(true);
                      }
                    }}
                  >
                    {description ? <DescriptionDocument value={description} /> : "添加描述…"}
                  </div>
                )}
                {currentTask.threadId && (
                  <div className="issue-conversation-list" aria-label="处理此议题的对话">
                    <ConversationLink threadId={currentTask.threadId} onOpen={onOpenThread} />
                  </div>
                )}
              </div>
            </article>

            <section className="issue-attachments" aria-labelledby="attachments-heading">
              <header className="attachments-heading">
                <div>
                  <h2 id="attachments-heading">附件</h2>
                  <span>{attachments.length}</span>
                </div>
                <button
                  className="attachment-add-button"
                  type="button"
                  disabled={uploadingAttachments}
                  onClick={() => attachmentInputRef.current?.click()}
                >
                  <LinearIcon name="attachment" />
                  {uploadingAttachments ? "上传中…" : "添加附件"}
                </button>
                <input
                  ref={attachmentInputRef}
                  type="file"
                  multiple
                  hidden
                  onChange={(event) => {
                    if (event.currentTarget.files) void uploadFiles(event.currentTarget.files);
                  }}
                />
              </header>

              {attachmentsLoading ? (
                <div className="attachments-loading" aria-label="正在加载附件" aria-busy="true"><i /><i /></div>
              ) : attachments.length > 0 ? (
                <ul className="attachment-list">
                  {attachments.map((attachment) => (
                    <li key={attachment.id}>
                      <a
                        className="attachment-link"
                        href={attachmentContentUrl(attachment)}
                        target="_blank"
                        rel="noreferrer"
                        title={`打开 ${attachment.filename}`}
                      >
                        <span className="attachment-file-icon" aria-hidden="true">
                          <LinearIcon name="file" />
                        </span>
                        <span className="attachment-copy">
                          <strong>{attachment.filename}</strong>
                          <span>{fileSize(attachment.size)} · {relativeTime(attachment.createdAt)}</span>
                        </span>
                      </a>
                      <div className="attachment-actions">
                        <a
                          href={attachmentContentUrl(attachment)}
                          download={attachment.filename}
                          aria-label={`下载 ${attachment.filename}`}
                          title="下载附件"
                        >
                          <LinearIcon name="openExternal" />
                        </a>
                        <button
                          type="button"
                          aria-label={`删除 ${attachment.filename}`}
                          title="删除附件"
                          onClick={() => setPendingAttachmentDelete(attachment)}
                        >
                          <LinearIcon name="trash" />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="attachments-empty">添加图片、文档或其他文件，单个文件不超过 25 MB。</p>
              )}
              {attachmentsError && <div className="attachments-error" role="alert">{attachmentsError}</div>}
            </section>

            <section className="activity-section" aria-labelledby="activity-heading">
              <header className="activity-heading">
                <h2 id="activity-heading">活动</h2>
                <span>{comments.length}</span>
              </header>

              <div className="activity-stream">
                <div className={`activity-entry activity-created is-${currentTask.creatorType}`}>
                  <ActorAvatar
                    type={currentTask.creatorType}
                    name={currentTask.creatorName}
                    avatarUrl={currentTask.creatorAvatarUrl}
                  />
                  <p>
                    <strong>{currentTask.creatorName}</strong>
                    <span className="actor-id">@{currentTask.creatorId}</span>
                    创建了此议题
                    <time title={exactTime(currentTask.createdAt)}>{relativeTime(currentTask.createdAt)}</time>
                  </p>
                </div>

                {commentsLoading ? (
                  <div className="comments-loading" aria-label="正在加载评论" aria-busy="true"><i /><i /></div>
                ) : comments.map((comment) => (
                  <article
                    className={`comment-entry is-${comment.authorType}`}
                    key={comment.id}
                    id={`comment-${comment.id}`}
                  >
                    <div className="comment-card">
                      <header className="comment-header">
                        <ActorAvatar
                          type={comment.authorType}
                          name={comment.authorName}
                          avatarUrl={comment.authorAvatarUrl}
                        />
                        <strong>{comment.authorName}</strong>
                        <span className="actor-id">@{comment.authorId}</span>
                        <time title={exactTime(comment.createdAt)}>{relativeTime(comment.createdAt)}</time>
                        {comment.version > 1 && <span title={`编辑于 ${exactTime(comment.updatedAt)}`}>已编辑</span>}
                        <div className="comment-actions" data-comment-menu-root={comment.id}>
                          <button
                            type="button"
                            className="comment-menu-trigger"
                            aria-label="评论操作"
                            aria-haspopup="menu"
                            aria-expanded={activeMenuId === comment.id}
                            onClick={() => setActiveMenuId((current) => current === comment.id ? null : comment.id)}
                          >
                            <LinearIcon name="more" />
                          </button>
                          {activeMenuId === comment.id && (
                            <div className="comment-action-menu" role="menu">
                              <button type="button" role="menuitem" onClick={() => beginEdit(comment)}>
                                <LinearIcon name="write" />
                                编辑评论
                              </button>
                              <button
                                type="button"
                                role="menuitem"
                                className="danger"
                                onClick={() => { setPendingDelete(comment); setActiveMenuId(null); }}
                              >
                                <LinearIcon name="trash" />
                                删除评论
                              </button>
                            </div>
                          )}
                        </div>
                      </header>

                      {editingId === comment.id ? (
                        <div className="comment-edit-form">
                          <textarea
                            autoFocus
                            value={editingBody}
                            rows={3}
                            aria-label="编辑评论"
                            onChange={(event) => setEditingBody(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Escape") setEditingId(null);
                              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                                event.preventDefault();
                                void saveComment(comment);
                              }
                            }}
                          />
                          <div>
                            <button className="button secondary" type="button" onClick={() => setEditingId(null)}>取消</button>
                            <button
                              className="button primary"
                              type="button"
                              disabled={!editingBody.trim() || savingCommentId === comment.id}
                              onClick={() => void saveComment(comment)}
                            >
                              {savingCommentId === comment.id ? "保存中…" : "保存"}
                            </button>
                          </div>
                        </div>
                      ) : (
                        comment.body && <div className="comment-body"><DescriptionDocument value={comment.body} /></div>
                      )}
                      {comment.attachments.length > 0 && (
                        <ul className="comment-attachment-list" aria-label="评论附件">
                          {comment.attachments.map((attachment) => (
                            <li key={attachment.id}>
                              <a
                                href={attachmentContentUrl(attachment)}
                                target="_blank"
                                rel="noreferrer"
                                title={`打开 ${attachment.filename}`}
                              >
                                <span className="attachment-file-icon" aria-hidden="true">
                                  <LinearIcon name="file" />
                                </span>
                                <span><strong>{attachment.filename}</strong><small>{fileSize(attachment.size)}</small></span>
                              </a>
                              <button
                                type="button"
                                aria-label={`删除 ${attachment.filename}`}
                                title="删除附件"
                                onClick={() => setPendingAttachmentDelete(attachment)}
                              >
                                <LinearIcon name="trash" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                      {comment.threadId && (
                        <div className="comment-conversation-link">
                          <ConversationLink threadId={comment.threadId} onOpen={onOpenThread} />
                        </div>
                      )}
                    </div>
                  </article>
                ))}
              </div>

              {commentsError && <div className="comments-error" role="alert">{commentsError}</div>}

              <form className="comment-composer" onSubmit={(event) => { event.preventDefault(); void submitComment(); }}>
                <div className="composer-author">
                  <ActorAvatar
                    type="user"
                    name={currentUser.name}
                    avatarUrl={currentUser.avatarUrl}
                  />
                  <strong>{currentUser.name}</strong>
                  <span className="actor-id">@{currentUser.id}</span>
                </div>
                <textarea
                  ref={composerRef}
                  value={draft}
                  rows={4}
                  maxLength={100_000}
                  placeholder="留下评论…"
                  aria-label="留下评论"
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleSubmitShortcut}
                />
                {pendingCommentFiles.length > 0 && (
                  <ul className="composer-attachment-list comment-composer-files" aria-label="待上传评论附件">
                    {pendingCommentFiles.map((file, index) => (
                      <li key={`${fileKey(file)}:${index}`}>
                        <span className="composer-attachment-file-icon" aria-hidden="true"><LinearIcon name="file" /></span>
                        <span className="composer-attachment-copy"><strong>{file.name}</strong><span>{fileSize(file.size)} · 发布后上传</span></span>
                        <button type="button" disabled={submitting} aria-label={`移除 ${file.name}`} onClick={() => setPendingCommentFiles((current) => current.filter((_, itemIndex) => itemIndex !== index))}><LinearIcon name="close" /></button>
                      </li>
                    ))}
                  </ul>
                )}
                <footer className="composer-footer">
                  <div className="composer-footer-leading">
                    <button
                      className="comment-attach-button"
                      type="button"
                      disabled={submitting}
                      aria-label="添加评论附件"
                      title="添加附件"
                      onClick={() => commentAttachmentInputRef.current?.click()}
                    >
                      <LinearIcon name="attachment" />
                    </button>
                    <span>草稿会自动保存</span>
                    <input
                      ref={commentAttachmentInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        if (event.currentTarget.files) stageCommentFiles(event.currentTarget.files);
                      }}
                    />
                  </div>
                  <div>
                    <kbd>⌘ Enter</kbd>
                    <button className="button primary" type="submit" disabled={(!draft.trim() && pendingCommentFiles.length === 0) || submitting}>
                      {submitting ? "发布中…" : "评论"}
                    </button>
                  </div>
                </footer>
              </form>
            </section>
          </div>

          <aside className="issue-properties" aria-label="议题属性">
            <button
              className="detail-open-thread-action"
              type="button"
              disabled={openingThread}
              onClick={() => onOpenInThread(currentTask)}
            >
              <LinearIcon name="conversation" />
              <span>{openingThread ? "正在打开…" : "在对话中打开"}</span>
            </button>
            <h2>属性</h2>
            <label className="detail-property-row">
              <span className={`detail-property-icon status-icon-${STATUS_DETAILS[currentTask.status].tone}`}><LinearStatusIcon status={currentTask.status} /></span>
              <span className="detail-property-label">状态</span>
              <select
                value={currentTask.status}
                disabled={savingProperty === "status"}
                onChange={(event) => void saveTask({ status: event.target.value as TaskStatus }, "status")}
              >
                {TASK_STATUSES.map((status) => (
                  <option value={status} key={status}>{STATUS_DETAILS[status].label}</option>
                ))}
              </select>
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon"><LinearPriorityIcon priority={currentTask.priority} /></span>
              <span className="detail-property-label">优先级</span>
              <select
                value={currentTask.priority}
                disabled={savingProperty === "priority"}
                onChange={(event) => void saveTask({ priority: event.target.value as TaskPriority }, "priority")}
              >
                {(Object.keys(PRIORITY_DETAILS) as TaskPriority[]).map((priority) => (
                  <option value={priority} key={priority}>{PRIORITY_DETAILS[priority].label}</option>
                ))}
              </select>
            </label>
            <div className="detail-property-row labels-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="label" />
              </span>
              <span className="detail-property-label">标签</span>
              <LabelPicker
                availableLabels={availableLabels}
                selectedLabels={currentTask.labels}
                open={labelMenuOpen}
                disabled={savingProperty === "labels"}
                className="detail-label-picker"
                triggerClassName="detail-label-trigger"
                placeholder="添加标签…"
                onOpenChange={setLabelMenuOpen}
                onChange={(nextLabels) => void saveTask({ labels: nextLabels }, "labels")}
              />
            </div>
            <label className="detail-property-row workflow-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="dashboard" />
              </span>
              <span className="detail-property-label">工作流</span>
              <select
                value={currentTask.workflowId ?? ""}
                disabled={savingProperty === "workflowId"}
                onChange={(event) => void saveTask({
                  workflowId: event.target.value || null,
                }, "workflowId")}
              >
                <option value="">未绑定</option>
                {!workflowAvailable && currentTask.workflowId && (
                  <option value={currentTask.workflowId}>当前设备未找到此流程</option>
                )}
                {workflows.map((workflow) => (
                  <option value={workflow.id} key={workflow.id}>{workflow.name}</option>
                ))}
              </select>
            </label>
            <label className="detail-property-row development-property">
              <span className="detail-property-icon" aria-hidden="true">
                <LinearIcon name="branch" />
              </span>
              <span className="detail-property-label">开发上下文</span>
              <select
                value={contextValue(currentTask.developmentContext)}
                disabled={developmentScanLoading || savingProperty === "developmentContext"}
                title={currentTask.developmentContext?.type === "worktree" ? currentTask.developmentContext.path : undefined}
                onChange={(event) => void saveTask({
                  developmentContext: event.target.value ? JSON.parse(event.target.value) as DevelopmentContext : null,
                }, "developmentContext")}
              >
                <option value="">{developmentScanLoading ? "正在扫描 Git…" : "未绑定"}</option>
                <optgroup label="代码分支">
                  {developmentOptions.filter((context) => context.type === "branch").map((context) => (
                    <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context)}</option>
                  ))}
                </optgroup>
                <optgroup label="Worktree">
                  {developmentOptions.filter((context) => context.type === "worktree").map((context) => (
                    <option value={contextValue(context)} key={contextValue(context)}>{contextLabel(context)}</option>
                  ))}
                </optgroup>
              </select>
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="calendar" /></span>
              <span className="detail-property-label">截止日期</span>
              <input
                type="date"
                value={currentTask.dueDate ?? ""}
                disabled={savingProperty === "dueDate"}
                onChange={(event) => void saveTask({
                  dueDate: event.target.value || null,
                  ...(event.target.value ? {} : { recurrence: null }),
                }, "dueDate")}
              />
            </label>
            <label className="detail-property-row">
              <span className="detail-property-icon" aria-hidden="true"><LinearIcon name="recurrence" /></span>
              <span className="detail-property-label">重复</span>
              <select
                value={currentTask.recurrence?.unit ?? ""}
                disabled={!currentTask.dueDate || savingProperty === "recurrence"}
                onChange={(event) => void saveTask({
                  recurrence: event.target.value
                    ? { interval: 1, unit: event.target.value as Recurrence["unit"] }
                    : null,
                }, "recurrence")}
              >
                <option value="">不重复</option>
                <option value="day">每天</option>
                <option value="week">每周</option>
                <option value="month">每月</option>
                <option value="year">每年</option>
              </select>
            </label>
            <div className="detail-timestamps">
              <span>创建于 {exactTime(currentTask.createdAt)}</span>
              {currentTask.updatedAt !== currentTask.createdAt && <span>更新于 {exactTime(currentTask.updatedAt)}</span>}
            </div>
          </aside>
        </div>
      </div>

      {pendingDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deleting) setPendingDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-comment-title">
            <h2 id="delete-comment-title">删除这条评论？</h2>
            <p>此操作无法撤销。</p>
            <div>
              <button className="button secondary" type="button" disabled={deleting} onClick={() => setPendingDelete(null)}>取消</button>
              <button className="button danger" type="button" disabled={deleting} onClick={() => void confirmDelete()}>{deleting ? "删除中…" : "删除评论"}</button>
            </div>
          </div>
        </div>
      )}

      {pendingAttachmentDelete && (
        <div className="delete-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !deletingAttachment) setPendingAttachmentDelete(null);
        }}>
          <div className="delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-attachment-title">
            <h2 id="delete-attachment-title">删除这个附件？</h2>
            <p>“{pendingAttachmentDelete.filename}” 将被永久删除，此操作无法撤销。</p>
            <div>
              <button className="button secondary" type="button" disabled={deletingAttachment} onClick={() => setPendingAttachmentDelete(null)}>取消</button>
              <button className="button danger" type="button" disabled={deletingAttachment} onClick={() => void confirmAttachmentDelete()}>{deletingAttachment ? "删除中…" : "删除附件"}</button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
