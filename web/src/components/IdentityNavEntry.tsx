import { useState } from "react";

import {
  ApiError,
  clearIdentitySession,
  getIdentityUser,
  registerDeveloperIdentity,
  setIdentitySession,
} from "../api";
import { LinearIcon } from "./LinearIcon";

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function IdentityNavEntry() {
  const [open, setOpen] = useState(false);
  const [employeeNo, setEmployeeNo] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = getIdentityUser();

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
              <div><h2 id="identity-dialog-title">账号登记</h2><p>{user ? "当前账号已绑定本地任务面板。" : "登记一次后，之后打开面板会自动进入。"}</p></div>
              <button className="identity-dialog-close" type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button>
            </div>
            {user ? (
              <div className="identity-current-account">
                <strong>{user.displayName}</strong>
                <span>工号 {user.employeeNo}</span>
                <button className="identity-submit" type="button" onClick={switchAccount}>切换账号</button>
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
