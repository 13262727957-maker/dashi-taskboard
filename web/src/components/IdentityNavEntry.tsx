import { useEffect, useState } from "react";

import {
  ApiError,
  clearRememberedIdentity,
  clearIdentitySession,
  getIdentityStatus,
  getIdentityUser,
  getRememberedIdentity,
  registerDeveloperIdentity,
  setIdentitySession,
  type IdentityStatus,
} from "../api";
import { LinearIcon } from "./LinearIcon";

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function IdentityNavEntry() {
  const [open, setOpen] = useState(false);
  const [employeeNo, setEmployeeNo] = useState(() => getRememberedIdentity()?.employeeNo ?? "");
  const [displayName, setDisplayName] = useState(() => getRememberedIdentity()?.displayName ?? "");
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = getIdentityUser();
  const identityReady = Boolean(identityStatus?.configured && identityStatus.initialized);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    setStatusBusy(true);
    getIdentityStatus(controller.signal)
      .then(setIdentityStatus)
      .catch((statusError) => {
        if (statusError instanceof Error && statusError.name === "AbortError") return;
        setIdentityStatus({ configured: false, initialized: false, userCount: 0, employeeCount: 0 });
      })
      .finally(() => setStatusBusy(false));
    return () => controller.abort();
  }, [open]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setIdentitySession(await registerDeveloperIdentity(employeeNo, displayName));
      window.location.reload();
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

  const switchAccount = () => {
    clearIdentitySession();
    clearRememberedIdentity();
    setOpen(true);
    setEmployeeNo("");
    setDisplayName("");
    setError(null);
  };

  return (
    <>
      <button className="identity-nav-entry" type="button" onClick={() => setOpen(true)}>
        <span className="nav-glyph" aria-hidden="true"><LinearIcon name="myIssues" /></span>
        <span className="identity-nav-copy">
          <strong>{user?.displayName ?? "登录账号"}</strong>
          <small>{user ? `工号 ${user.employeeNo}` : "首次使用时登记一次"}</small>
        </span>
      </button>
      {open && (
        <div className="identity-dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="identity-dialog" role="dialog" aria-modal="true" aria-labelledby="identity-dialog-title">
            <div className="identity-dialog-heading">
              <div><h2 id="identity-dialog-title">{user && identityReady ? "账号登记" : identityReady ? "账号登记" : "公司库状态"}</h2><p>{user && identityReady ? "当前账号已绑定本地任务面板。" : identityReady ? "登记一次后，之后打开面板会自动进入。" : "面板会根据本机配置自动连接公司库。"}</p></div>
              <button className="identity-dialog-close" type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button>
            </div>
            {user && identityReady ? (
              <div className="identity-current-account">
                <strong>{user.displayName}</strong>
                <span>工号 {user.employeeNo}</span>
                <button className="identity-submit" type="button" onClick={switchAccount}>切换账号</button>
              </div>
            ) : statusBusy && !identityStatus ? (
              <div className="identity-loading">正在检测公司库连接…</div>
            ) : !identityReady ? (
              <div className="identity-unavailable" role="status">
                <strong>暂未连接公司数据库</strong>
                <p>请确认 `.data/sqlserver-identity.env` 已配置，并重新启动任务面板。</p>
                {error && <div className="identity-error" role="alert">{error}</div>}
              </div>
            ) : (
              <form onSubmit={submit}>
                <label className="identity-field"><span>姓名</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required /></label>
                <label className="identity-field"><span>工号</span><input value={employeeNo} onChange={(event) => setEmployeeNo(event.target.value)} autoComplete="username" required /></label>
                {error && <div className="identity-error" role="alert">{error}</div>}
                <button className="identity-submit" type="submit" disabled={busy}>{busy ? "登记中…" : "登记并进入"}</button>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}
