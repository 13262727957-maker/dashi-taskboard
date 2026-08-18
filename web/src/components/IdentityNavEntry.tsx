import { useEffect, useState } from "react";

import {
  ApiError,
  clearIdentitySession,
  connectIdentityDatabase,
  getIdentityStatus,
  getIdentityUser,
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
  const [employeeNo, setEmployeeNo] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [identityStatus, setIdentityStatus] = useState<IdentityStatus | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [host, setHost] = useState("192.188.106.61");
  const [port, setPort] = useState("1433");
  const [databaseUser, setDatabaseUser] = useState("");
  const [databasePassword, setDatabasePassword] = useState("");
  const [databaseName, setDatabaseName] = useState("dashi_taskboard_test");
  const [encrypt, setEncrypt] = useState(false);
  const [trustServerCertificate, setTrustServerCertificate] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const user = getIdentityUser();
  const identityReady = Boolean(identityStatus?.configured && identityStatus.initialized);

  useEffect(() => {
    if (!open || user) return;
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
  }, [open, user]);

  const connectDatabase = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await connectIdentityDatabase({
        host,
        port: Number(port),
        user: databaseUser,
        password: databasePassword,
        database: databaseName,
        encrypt,
        trustServerCertificate,
      });
      setIdentityStatus(result.status);
      setDatabasePassword("");
    } catch (requestError) {
      setError(errorMessage(requestError));
    } finally {
      setBusy(false);
    }
  };

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
              <div><h2 id="identity-dialog-title">{user ? "账号登记" : identityReady ? "账号登记" : "连接公司数据库"}</h2><p>{user ? "当前账号已绑定本地任务面板。" : identityReady ? "登记一次后，之后打开面板会自动进入。" : "先连接 SQL Server 公司库，连接成功后再登记账号。"}</p></div>
              <button className="identity-dialog-close" type="button" aria-label="关闭" onClick={() => setOpen(false)}>×</button>
            </div>
            {user ? (
              <div className="identity-current-account">
                <strong>{user.displayName}</strong>
                <span>工号 {user.employeeNo}</span>
                <button className="identity-submit" type="button" onClick={switchAccount}>切换账号</button>
              </div>
            ) : statusBusy && !identityStatus ? (
              <div className="identity-loading">正在检测公司库连接…</div>
            ) : !identityReady ? (
              <form onSubmit={connectDatabase}>
                <label className="identity-field"><span>SQL Server IP 地址</span><input value={host} onChange={(event) => setHost(event.target.value)} autoComplete="off" required /></label>
                <label className="identity-field"><span>端口</span><input value={port} onChange={(event) => setPort(event.target.value)} inputMode="numeric" required /></label>
                <label className="identity-field"><span>数据库名</span><input value={databaseName} onChange={(event) => setDatabaseName(event.target.value)} autoComplete="off" required /></label>
                <label className="identity-field"><span>用户名</span><input value={databaseUser} onChange={(event) => setDatabaseUser(event.target.value)} autoComplete="username" required /></label>
                <label className="identity-field"><span>密码</span><input value={databasePassword} onChange={(event) => setDatabasePassword(event.target.value)} autoComplete="current-password" type="password" required /></label>
                <label className="identity-check"><input type="checkbox" checked={encrypt} onChange={(event) => setEncrypt(event.target.checked)} /><span>启用加密连接</span></label>
                <label className="identity-check"><input type="checkbox" checked={trustServerCertificate} onChange={(event) => setTrustServerCertificate(event.target.checked)} /><span>信任服务器证书</span></label>
                {error && <div className="identity-error" role="alert">{error}</div>}
                <button className="identity-submit" type="submit" disabled={busy}>{busy ? "连接中…" : "连接公司数据库"}</button>
              </form>
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
