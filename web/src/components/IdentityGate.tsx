import { useEffect, useState } from "react";

import {
  ApiError,
  clearIdentitySession,
  getIdentityStatus,
  registerDeveloperIdentity,
  restoreIdentitySession,
  setIdentitySession,
} from "../api";
import { LinearIcon } from "./LinearIcon";

type GateMode = "loading" | "login" | "local";

function messageFromError(error: unknown): string {
  return error instanceof ApiError ? error.message : error instanceof Error ? error.message : "操作失败，请稍后重试";
}

export function IdentityGate({ children }: { children: React.ReactNode }) {
  const embedded = new URLSearchParams(window.location.search).get("host") === "codex";
  const [mode, setMode] = useState<GateMode>(embedded ? "local" : "loading");
  const [employeeNo, setEmployeeNo] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (embedded) return;
    let cancelled = false;
    void getIdentityStatus()
      .then((status) => {
        if (cancelled) return;
        if (!status.configured) {
          clearIdentitySession();
          setMode("local");
          return;
        }
        if (restoreIdentitySession()) {
          setMode("local");
        } else {
          setMode("login");
        }
      })
      .catch(() => {
        if (cancelled) return;
        clearIdentitySession();
        setError(null);
        setMode("local");
      });
    return () => { cancelled = true; };
  }, [embedded]);

  if (mode === "loading") {
    return <div className="identity-screen"><div className="identity-loading">正在连接任务面板…</div></div>;
  }
  if (mode === "local") return <>{children}</>;

  const handleLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setIdentitySession(await registerDeveloperIdentity(employeeNo, displayName));
      setMode("local");
    } catch (requestError) {
      setError(messageFromError(requestError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="identity-screen">
      <section className="identity-panel" aria-labelledby="identity-title">
        <div className="identity-brand"><span className="identity-brand-mark"><LinearIcon name="project" /></span>任务面板</div>
        <form onSubmit={handleLogin}>
            <div className="identity-heading"><h1 id="identity-title">进入任务面板</h1><p>使用姓名和工号登记或进入任务面板。创建项目后，你会自动成为项目负责人。</p></div>
            <label className="identity-field"><span>姓名</span><input value={displayName} onChange={(event) => setDisplayName(event.target.value)} autoComplete="name" required /></label>
            <label className="identity-field"><span>工号</span><input value={employeeNo} onChange={(event) => setEmployeeNo(event.target.value)} autoComplete="username" required /></label>
            {error && <div className="identity-error" role="alert">{error}</div>}
            <button className="identity-submit" type="submit" disabled={busy}>{busy ? "登记中…" : "进入任务面板"}</button>
        </form>
      </section>
    </main>
  );
}
