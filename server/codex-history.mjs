import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function textFromContent(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((item) => {
    if (typeof item === "string") return item;
    if (!item || typeof item !== "object") return "";
    return typeof item.text === "string" ? item.text : typeof item.content === "string" ? item.content : "";
  }).filter(Boolean).join("\n");
}

function cleanMessage(value) {
  const raw = String(value ?? "");
  const userMessage = raw.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/)?.[1] ?? raw;
  return userMessage
    .replace(/<taskboard_context>[\s\S]*?<\/taskboard_context>/g, "")
    .replace(/\[\$manage-taskboard\]\([^)]*\)\s*e-taskboard/g, "")
    .trim();
}

function isTaskboardSummarySession(records) {
  return records.some((record) => (
    record?.type === "event_msg"
    && record?.payload?.type === "user_message"
    && typeof record.payload.message === "string"
    && record.payload.message.includes("本地项目新增对话整理")
  ));
}

function messageFromRecord(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== "object") return null;
  if (record.type === "event_msg" && payload.type === "user_message") {
    return { role: "user", content: cleanMessage(payload.message) };
  }
  if (record.type === "event_msg" && payload.type === "agent_message") {
    return { role: "assistant", content: cleanMessage(payload.message) };
  }
  if (record.type === "response_item" && payload.type === "message") {
    // The app-server may echo the fully wrapped prompt as a response item.
    // The event_msg user_message below is the actual user turn we want.
    const role = payload.role === "assistant" ? payload.role : null;
    const content = cleanMessage(textFromContent(payload.content));
    return role && content ? { role, content } : null;
  }
  return null;
}

async function jsonlFiles(root) {
  const output = [];
  async function visit(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(entries.map(async (entry) => {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) return visit(filename);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) output.push(filename);
      return undefined;
    }));
  }
  await visit(root);
  return output;
}

function isWithinWorkspace(workspacePath, cwd) {
  if (!workspacePath || !cwd) return false;
  const relative = path.relative(path.resolve(workspacePath), path.resolve(cwd));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sessionMeta(records) {
  const record = records.find((item) => item.type === "session_meta");
  const payload = record?.payload;
  return payload && typeof payload === "object" ? payload : null;
}

export async function collectCodexProjectConversations({ workspacePath, cursors = {}, codexHome = path.join(os.homedir(), ".codex") }) {
  if (!workspacePath) return { candidates: [], sourceCursors: {} };
  const roots = [path.join(codexHome, "sessions"), path.join(codexHome, "archived_sessions")];
  const files = (await Promise.all(roots.map((root) => jsonlFiles(root)))).flat();
  const candidates = [];
  const sourceCursors = {};

  for (const filename of files) {
    let raw;
    try {
      raw = await readFile(filename, "utf8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    const records = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try { records.push(JSON.parse(line)); } catch { /* Ignore a partially-written last line. */ }
    }
    const meta = sessionMeta(records);
    if (!meta || !isWithinWorkspace(workspacePath, meta.cwd)) continue;
    if (isTaskboardSummarySession(records)) continue;
    const sourceId = String(meta.id ?? meta.session_id ?? path.basename(filename, ".jsonl"));
    const startOffset = Number(cursors[sourceId] ?? 0);
    let offset = 0;
    const messages = [];
    for (const line of lines) {
      const lineBytes = Buffer.byteLength(line, "utf8") + 1;
      const recordEnd = offset + lineBytes;
      if (recordEnd > startOffset && line.trim()) {
        try {
          const message = messageFromRecord(JSON.parse(line));
          if (message) messages.push(message);
        } catch { /* Ignore malformed records while the session is being written. */ }
      }
      offset = recordEnd;
    }
    if (messages.length === 0) continue;
    const sourceBytes = Buffer.byteLength(raw, "utf8");
    sourceCursors[sourceId] = String(sourceBytes);
    const userText = messages.filter((message) => message.role === "user").map((message) => message.content).join("\n").trim();
    const assistantText = messages.filter((message) => message.role === "assistant").map((message) => message.content).join("\n").trim();
    const firstUserMessage = messages.find((message) => message.role === "user")?.content ?? "";
    candidates.push({
      sourceThreadId: sourceId,
      sourceCursor: `${sourceId}:${sourceBytes}`,
      title: (firstUserMessage || meta.thread_name || "Codex 项目对话").replace(/\s+/g, " ").slice(0, 300),
      description: [
        "来源：Codex 本地项目会话",
        userText ? `需求：${userText.slice(0, 4000)}` : "",
        assistantText ? `进展：${assistantText.slice(-6000)}` : "",
        `来源会话：${sourceId}`,
      ].filter(Boolean).join("\n\n"),
    });
  }
  return { candidates, sourceCursors };
}
