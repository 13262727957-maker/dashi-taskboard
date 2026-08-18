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

refresh_existing_checkout() {
  local checkout_dir="$1"
  log "Fetching latest code for existing checkout: $checkout_dir"
  git -C "$checkout_dir" fetch --prune origin || fail "git fetch failed. Resolve network or authentication issues, then rerun."

  local branch
  branch="$(git -C "$checkout_dir" rev-parse --abbrev-ref HEAD)" || fail "Cannot determine current git branch."
  if [ "$branch" = "HEAD" ]; then
    log "Checkout is in detached HEAD state; resetting directly to the remote default branch."
  fi

  local remote_ref
  remote_ref="$(git -C "$checkout_dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)"
  if [ -z "$remote_ref" ]; then
    local default_branch
    default_branch="$(git -C "$checkout_dir" remote show origin | sed -n 's/.*HEAD branch: //p' | head -n 1)"
    remote_ref="origin/${default_branch:-main}"
  fi

  git -C "$checkout_dir" rev-parse --verify "$remote_ref^{commit}" >/dev/null \
    || fail "Cannot resolve remote ref '$remote_ref'. Check the checkout branch and origin remote."

  local local_commit remote_commit
  local_commit="$(git -C "$checkout_dir" rev-parse HEAD)"
  remote_commit="$(git -C "$checkout_dir" rev-parse "$remote_ref")"
  if [ "$local_commit" = "$remote_commit" ]; then
    log "Checkout is already at latest remote commit: $local_commit"
  else
    log "Resetting checkout from $local_commit to $remote_commit; local code changes in the install directory will be overwritten"
  fi

  git -C "$checkout_dir" reset --hard "$remote_ref" \
    || fail "Hard reset to '$remote_ref' failed. Resolve permissions or git state, then rerun."

  git -C "$checkout_dir" clean -fd \
    -e .data/ \
    -e node_modules/ \
    -e .env \
    -e .env.* \
    -e .dev.vars \
    || fail "Cleaning untracked install files failed. Resolve permissions or git state, then rerun."
}

mkdir -p "$PROJECTS_DIR" || fail "Cannot create projects directory: $PROJECTS_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  refresh_existing_checkout "$INSTALL_DIR"
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
