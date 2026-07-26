import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LinearIcon } from "./LinearIcon";

type AutomationStatus = "ACTIVE" | "PAUSED";
type IntervalMinutes = 5 | 10 | 15 | 30 | 60;
type AutomationModel = "gpt-5.5" | "gpt-5.4";
type ReasoningEffort = "medium" | "high" | "xhigh";

interface AutomationOptions {
  status: AutomationStatus;
  intervalMinutes: IntervalMinutes;
  model: AutomationModel;
  reasoningEffort: ReasoningEffort;
}

interface ProjectAutomationMenuProps {
  automation?: Partial<AutomationOptions>;
  pending: boolean;
  error: string | null;
  unavailableReason: string | null;
  onOpen: () => void;
  onSave: (options: AutomationOptions) => void;
}

const DEFAULT_OPTIONS: AutomationOptions = {
  status: "PAUSED",
  intervalMinutes: 5,
  model: "gpt-5.5",
  reasoningEffort: "high",
};

export function ProjectAutomationMenu({
  automation,
  pending,
  error,
  unavailableReason,
  onOpen,
  onSave,
}: ProjectAutomationMenuProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0, ready: false });
  const [draft, setDraft] = useState<AutomationOptions>(DEFAULT_OPTIONS);
  const status = automation?.status ?? "PAUSED";

  useEffect(() => {
    if (!open) return;
    setDraft({ ...DEFAULT_OPTIONS, ...automation });
  }, [open]);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current || !menuRef.current) return;
    const trigger = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(trigger.right - menu.width, window.innerWidth - menu.width - 8));
    const top = trigger.bottom + 8 + menu.height <= window.innerHeight
      ? trigger.bottom + 8
      : Math.max(8, trigger.top - menu.height - 8);
    setPosition({ left, top, ready: true });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function closeFromOutside(event: PointerEvent) {
      if (!menuRef.current?.contains(event.target as Node) && !triggerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    }
    function closeFromViewportChange() {
      setOpen(false);
    }
    function closeFromEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    window.addEventListener("resize", closeFromViewportChange);
    window.addEventListener("scroll", closeFromViewportChange, true);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
      window.removeEventListener("resize", closeFromViewportChange);
      window.removeEventListener("scroll", closeFromViewportChange, true);
    };
  }, [open]);

  const menu = open ? createPortal(
    <div
      ref={menuRef}
      className="project-automation-menu no-drag"
      role="dialog"
      aria-label="自动认领待办设置"
      style={{ left: position.left, top: position.top, visibility: position.ready ? "visible" : "hidden" }}
    >
      <div className="project-automation-menu-heading">
        <strong>自动认领待办</strong>
        <span className={draft.status === "ACTIVE" ? "is-active" : "is-paused"}>
          {draft.status === "ACTIVE" ? "运行中" : "已暂停"}
        </span>
      </div>
      <div className="project-automation-switch">
        <span>自动认领开关</span>
        <button
          type="button"
          className={`board-setting-switch${draft.status === "ACTIVE" ? " is-on" : ""}`}
          role="switch"
          aria-checked={draft.status === "ACTIVE"}
          disabled={pending}
          onClick={() => setDraft((current) => ({
            ...current,
            status: current.status === "ACTIVE" ? "PAUSED" : "ACTIVE",
          }))}
        >
          <span aria-hidden="true" />
        </button>
      </div>
      <label className="project-automation-field">
        <span>间隔</span>
        <select
          value={draft.intervalMinutes}
          disabled={pending}
          onChange={(event) => setDraft((current) => ({
            ...current,
            intervalMinutes: Number(event.target.value) as IntervalMinutes,
          }))}
        >
          {[5, 10, 15, 30, 60].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}
        </select>
      </label>
      <label className="project-automation-field">
        <span>模型</span>
        <select
          value={draft.model}
          disabled={pending}
          onChange={(event) => setDraft((current) => ({
            ...current,
            model: event.target.value as AutomationModel,
          }))}
        >
          <option value="gpt-5.5">gpt-5.5</option>
          <option value="gpt-5.4">gpt-5.4</option>
        </select>
      </label>
      <label className="project-automation-field">
        <span>推理强度</span>
        <select
          value={draft.reasoningEffort}
          disabled={pending}
          onChange={(event) => setDraft((current) => ({
            ...current,
            reasoningEffort: event.target.value as ReasoningEffort,
          }))}
        >
          <option value="medium">中</option>
          <option value="high">高</option>
          <option value="xhigh">最高</option>
        </select>
      </label>
      {unavailableReason && <p className="project-automation-note">{unavailableReason}</p>}
      {error && error !== unavailableReason && <p className="project-automation-error" role="alert">{error}</p>}
      <div className="project-automation-actions">
        <button type="button" onClick={() => setOpen(false)}>取消</button>
        <button
          type="button"
          className="primary"
          disabled={pending || Boolean(unavailableReason)}
          onClick={() => onSave(draft)}
        >
          保存
        </button>
      </div>
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`project-automation-trigger no-drag ${status === "ACTIVE" ? "is-active" : "is-paused"}`}
        aria-label={status === "ACTIVE" ? "自动认领待办：运行中" : "自动认领待办：已暂停"}
        aria-busy={pending}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={status === "ACTIVE" ? "自动认领待办：运行中" : "自动认领待办：已暂停"}
        onClick={() => {
          if (!open) {
            setPosition((current) => ({ ...current, ready: false }));
            onOpen();
          }
          setOpen((current) => !current);
        }}
      >
        <LinearIcon name={status === "ACTIVE" ? "play" : "pause"} />
      </button>
      {menu}
    </>
  );
}
