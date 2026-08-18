#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const serviceName = "cj-task-dashboard-sqlserver";

function parseOption(name) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith("--")) {
    return process.argv[index + 1];
  }
  return "";
}

function runSecurity(args, options = {}) {
  const result = spawnSync("security", args, {
    encoding: "utf8",
    stdio: options.stdio ?? "pipe",
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`security ${args.join(" ")} failed${detail ? `\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

async function promptHidden(question) {
  if (!process.stdin.isTTY) {
    throw new Error("Password prompt requires an interactive terminal. Run with --password-env ENV_NAME in non-interactive environments.");
  }
  output.write(question);
  spawnSync("sh", ["-c", "stty -echo < /dev/tty"], { stdio: "ignore" });
  const rl = createInterface({ input, output });
  try {
    return await rl.question("");
  } finally {
    rl.close();
    spawnSync("sh", ["-c", "stty echo < /dev/tty"], { stdio: "ignore" });
    output.write("\n");
  }
}

async function main() {
  if (process.platform !== "darwin") {
    throw new Error("Keychain credential storage currently supports macOS only.");
  }

  const rl = createInterface({ input, output });
  let user = parseOption("user") || process.env.TASKBOARD_SQLSERVER_USER || process.env.CJ_TASKBOARD_SQLSERVER_USER;
  try {
    if (!user) user = (await rl.question("SQL Server user: ")).trim();
  } finally {
    rl.close();
  }
  if (!user) throw new Error("SQL Server user is required.");

  const passwordEnv = parseOption("password-env");
  const password = passwordEnv
    ? process.env[passwordEnv]
    : process.env.TASKBOARD_SQLSERVER_PASSWORD
      || process.env.CJ_TASKBOARD_SQLSERVER_PASSWORD
      || await promptHidden("SQL Server password: ");
  if (!password) throw new Error("SQL Server password is required.");

  runSecurity([
    "add-generic-password",
    "-U",
    "-s", serviceName,
    "-a", user,
    "-w", password,
  ]);

  console.error(`[cj-task-dashboard] Stored SQL Server password in macOS Keychain service '${serviceName}' for account '${user}'.`);
  console.error("[cj-task-dashboard] Future installs can run npm run identity:intranet-connect to generate .data/sqlserver-identity.env.");
}

main().catch((error) => {
  console.error(`[cj-task-dashboard] ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
