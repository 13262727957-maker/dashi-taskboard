#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${CJ_TASK_DASHBOARD_REPO_URL:-https://git.caijai.com/aiplus/cjtaskdashboard.git}"
PROJECTS_DIR="${CJ_TASK_DASHBOARD_PROJECTS_DIR:-$HOME/Desktop/Projects}"
INSTALL_DIR="${CJ_TASK_DASHBOARD_INSTALL_DIR:-$PROJECTS_DIR/cjtaskdashboard}"

log() {
  printf '[cj-task-dashboard] %s\n' "$*"
}

fail() {
  printf '[cj-task-dashboard] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    fail "Missing required command '$1'. Install it and rerun this script."
  fi
}

require_command git
require_command node
require_command npm

mkdir -p "$PROJECTS_DIR" || fail "Cannot create projects directory: $PROJECTS_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  log "Updating existing checkout: $INSTALL_DIR"
  git -C "$INSTALL_DIR" pull --ff-only || fail "git pull failed. Resolve local changes, network, or authentication issues, then rerun."
elif [ -e "$INSTALL_DIR" ]; then
  fail "Install directory exists but is not a git checkout: $INSTALL_DIR"
else
  log "Cloning CJ Task Dashboard into $INSTALL_DIR"
  git clone "$REPO_URL" "$INSTALL_DIR" || fail "git clone failed. Check GitLab access, network connectivity, or CJ_TASK_DASHBOARD_REPO_URL."
fi

cd "$INSTALL_DIR" || fail "Cannot enter install directory: $INSTALL_DIR"

log "Installing Codex plugin, skill, CLI commands, and local server"
npm run install:codex-plugin || fail "npm run install:codex-plugin failed. Check Node/npm version, permissions, and installer output."

if command -v dashi-taskboard >/dev/null 2>&1; then
  log "Running doctor"
  dashi-taskboard doctor || fail "dashi-taskboard doctor failed. The install finished, but the local service needs attention."
  log "Opening standalone panel"
  dashi-taskboard open || log "Panel did not open automatically. Run 'dashi-taskboard open' when ready."
else
  log "Install completed, but dashi-taskboard is not on PATH yet."
  log "Try: ~/.local/bin/dashi-taskboard doctor && ~/.local/bin/dashi-taskboard open"
fi

log "Done"
