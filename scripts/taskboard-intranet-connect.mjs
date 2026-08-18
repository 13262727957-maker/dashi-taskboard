#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(scriptPath), "..");
const envPath = path.join(projectRoot, ".data", "sqlserver-identity.env");
const quiet = process.argv.includes("--quiet");

const defaults = {
  host: process.env.CJ_TASKBOARD_SQLSERVER_HOST || process.env.TASKBOARD_SQLSERVER_HOST || "192.188.106.61",
  port: Number(process.env.CJ_TASKBOARD_SQLSERVER_PORT || process.env.TASKBOARD_SQLSERVER_PORT || 1433),
  database: process.env.CJ_TASKBOARD_SQLSERVER_DATABASE || process.env.TASKBOARD_SQLSERVER_DATABASE || "dashi_taskboard_test",
  encrypt: process.env.CJ_TASKBOARD_SQLSERVER_ENCRYPT || process.env.TASKBOARD_SQLSERVER_ENCRYPT || "false",
  trustCert: process.env.CJ_TASKBOARD_SQLSERVER_TRUST_CERT || process.env.TASKBOARD_SQLSERVER_TRUST_CERT || "true",
};

const requiredKeys = [
  "TASKBOARD_SQLSERVER_HOST",
  "TASKBOARD_SQLSERVER_USER",
  "TASKBOARD_SQLSERVER_PASSWORD",
  "TASKBOARD_SQLSERVER_DATABASE",
];

function log(message) {
  if (!quiet) console.error(`[cj-task-dashboard] ${message}`);
}

function parseEnvValue(value) {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseEnvFile(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const normalized = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const separator = normalized.indexOf("=");
    if (separator <= 0) continue;
    values[normalized.slice(0, separator).trim()] = parseEnvValue(normalized.slice(separator + 1));
  }
  return values;
}

async function readExistingEnv() {
  try {
    return parseEnvFile(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function hasCompleteIdentityEnv(values) {
  return requiredKeys.every((key) => values[key]);
}

function canReach(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function readKeychainPassword(account) {
  if (process.platform !== "darwin" || !account) return "";
  const result = spawnSync("security", [
    "find-generic-password",
    "-s", "cj-task-dashboard-sqlserver",
    "-a", account,
    "-w",
  ], {
    encoding: "utf8",
    stdio: "pipe",
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function main() {
  const existing = await readExistingEnv();
  const host = existing.TASKBOARD_SQLSERVER_HOST || defaults.host;
  const port = Number(existing.TASKBOARD_SQLSERVER_PORT || defaults.port);

  if (!await canReach(host, port)) {
    log(`SQL Server ${host}:${port} is not reachable; intranet identity auto-connect skipped.`);
    return;
  }

  if (hasCompleteIdentityEnv(existing)) {
    log(`Existing ${envPath} is complete and SQL Server is reachable.`);
    return;
  }

  const user = process.env.TASKBOARD_SQLSERVER_USER
    || process.env.CJ_TASKBOARD_SQLSERVER_USER
    || existing.TASKBOARD_SQLSERVER_USER
    || "";
  const password = process.env.TASKBOARD_SQLSERVER_PASSWORD
    || process.env.CJ_TASKBOARD_SQLSERVER_PASSWORD
    || existing.TASKBOARD_SQLSERVER_PASSWORD
    || readKeychainPassword(user);

  if (!user || !password) {
    log("SQL Server is reachable, but credentials were not found in env vars or macOS Keychain service 'cj-task-dashboard-sqlserver'.");
    return;
  }

  const next = {
    TASKBOARD_SQLSERVER_HOST: host,
    TASKBOARD_SQLSERVER_PORT: String(port),
    TASKBOARD_SQLSERVER_USER: user,
    TASKBOARD_SQLSERVER_PASSWORD: password,
    TASKBOARD_SQLSERVER_DATABASE: existing.TASKBOARD_SQLSERVER_DATABASE || defaults.database,
    TASKBOARD_SQLSERVER_ENCRYPT: existing.TASKBOARD_SQLSERVER_ENCRYPT || defaults.encrypt,
    TASKBOARD_SQLSERVER_TRUST_CERT: existing.TASKBOARD_SQLSERVER_TRUST_CERT || defaults.trustCert,
  };
  await mkdir(path.dirname(envPath), { recursive: true });
  await writeFile(
    envPath,
    `${Object.entries(next).map(([key, value]) => `${key}=${shellQuote(value)}`).join("\n")}\n`,
    { mode: 0o600 },
  );
  log(`Wrote ${envPath}; rerun npm run install:codex-plugin to inject it into the background service.`);
}

main().catch((error) => {
  console.error(`[cj-task-dashboard] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
