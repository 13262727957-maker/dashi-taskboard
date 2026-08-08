import os from "node:os";
import path from "node:path";

export function defaultTaskboardDataDirectory(env = process.env, platform = process.platform) {
  if (env.CODEX_TASKBOARD_DATA_DIR) return path.resolve(env.CODEX_TASKBOARD_DATA_DIR);
  if (platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "CJ Task Dashboard");
  }
  if (platform === "win32") {
    return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "CJ Task Dashboard");
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "cj-task-dashboard");
}

export function defaultTaskboardDatabasePath(env = process.env, platform = process.platform) {
  return path.join(defaultTaskboardDataDirectory(env, platform), "taskboard.sqlite");
}

export function defaultTaskboardPanelProfileDirectory(env = process.env, platform = process.platform) {
  return path.join(defaultTaskboardDataDirectory(env, platform), "panel-browser-profile");
}
