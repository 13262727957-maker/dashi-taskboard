# Codex Taskboard

A local-first issue board that runs in a browser and can be embedded in Codex through the standalone CDP launcher or its injection script. The same HTTP API powers the React UI and the `taskctl` CLI used by the bundled Codex Skill.

For day-to-day usage, see the [任务面板使用手册](docs/taskboard-user-manual.md).

## Requirements

- Node.js 22.5 or newer

## Run locally

```bash
npm install
npm run build
npm start
```

Open <http://127.0.0.1:47824>. The SQLite database is stored at `.data/taskboard.sqlite`.

For development with live frontend reload:

```bash
npm run dev
```

The Vite UI runs at <http://127.0.0.1:5173> and proxies API requests to the local service.

## Use the CLI

Run it from the project:

```bash
npm run taskctl -- project create \
  --id my-project \
  --name "My project" \
  --workspace-path /absolute/path/to/repository

npm run taskctl -- issue create \
  --project my-project \
  --title "Implement the next slice" \
  --status todo \
  --priority high \
  --labels product,mvp
```

Use `npm link` if you want `taskctl` on your shell path. Set `CODEX_TASKBOARD_URL` to point the CLI at another local or LAN service. Cloud deployments are configured through the loopback companion with `taskctl cloud login`.

## Install the Codex Skill

Copy or symlink `skills/manage-taskboard` into the Codex skills directory, then start a new Codex task:

```bash
ln -s /absolute/path/to/codex-taskboard/skills/manage-taskboard \
  ~/.codex/skills/manage-taskboard
```

The Skill teaches Codex to inspect an issue, move it to `in_progress`, use optimistic versions, verify the work, and then move it to `in_review`; it moves the issue to `done` only after the user explicitly confirms acceptance or asks to mark it complete.

## Install as a local Codex plugin

From a terminal, run one install command:

```bash
curl -fsSL https://git.caijai.com/aiplus/cjtaskdashboard/-/raw/main/install.sh | bash
```

If you already cloned the repository, or if the GitLab raw URL is not available in your network, run the local installer from the checkout:

```bash
git clone https://git.caijai.com/aiplus/cjtaskdashboard.git ~/Desktop/Projects/cjtaskdashboard
cd ~/Desktop/Projects/cjtaskdashboard
npm run install:codex-plugin
```

The one-line installer updates an existing `~/Desktop/Projects/cjtaskdashboard` checkout by fetching `origin` and hard resetting to the latest remote commit before reinstalling the plugin and skill. If the remote fetch or hard reset fails, it stops instead of installing stale local code. Override the destination with `CJ_TASK_DASHBOARD_INSTALL_DIR=/path/to/cjtaskdashboard` or the repository with `CJ_TASK_DASHBOARD_REPO_URL=<url>`.

The installer opens the standalone Taskboard panel at the end. You can reopen the same panel from any terminal or any AI skill that can run shell commands:

```bash
dashi-taskboard open
```

Use the doctor when an AI agent or teammate needs to check the local service and panel entry:

```bash
dashi-taskboard doctor
```

The installer handles the local personal plugin marketplace for you: it copies the plugin source to `~/plugins/dashi-taskboard`, registers it in `~/.agents/plugins/marketplace.json`, installs/enables `dashi-taskboard@personal` in Codex, exposes the bundled `manage-taskboard` skill through both the plugin and `~/.codex/skills/manage-taskboard`, installs `dashi-taskboard` and `taskctl` at `~/.local/bin/`, builds the web UI, writes the macOS LaunchAgent for the local server, removes any previously managed Codex injector LaunchAgent, and then tries to open the standalone Taskboard panel. `dashi-taskboard open` starts or reuses the local server and opens `http://127.0.0.1:47824/?host=agent`; on macOS, Windows, and Linux it prefers a Chrome/Chromium/Edge app-window before falling back to the default browser. It does not require Codex sidebar injection, a debug port, or changes to any AI app bundle.

Keep the cloned repository in place after installing this basic local-plugin version. The installed plugin and skill live under `~/plugins/dashi-taskboard`, but the local server, `dashi-taskboard`, and `taskctl` shims still run from the cloned repository path.

The bundled `manage-taskboard` skill treats the standalone panel as the default UI path. When the user asks an AI agent to open the task panel, the skill should run:

```bash
dashi-taskboard open
```

### Optional Codex Sidebar Injection

Codex sidebar injection remains available only as a manual enhanced mode. The one-click installer does not install or start it by default. If you deliberately want the embedded Codex sidebar panel for local development, run the project-local launcher and keep that terminal open:

```bash
npm run codex
```

You can also attach to a Codex instance that was already launched with CDP:

```bash
npm run codex:inject -- --port 9229 --open
```

If an older install left the injector LaunchAgent behind, rerun the installer or stop it directly:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.dashi-taskboard.codex-injector.plist
```

Restore it later with `npm run install:codex-plugin`.

Run the Codex plugin doctor after install or after opening Codex in Taskboard mode:

```bash
npm run doctor:codex-plugin
```

After the full Codex restart, capture a direct panel proof:

```bash
npm run verify:codex-panel
```

This opens the injected Taskboard panel and writes `.data/codex-taskboard-panel-proof.png`.

Uninstall the local plugin, Codex plugin state, managed skill link, `dashi-taskboard`/`taskctl`/`dashi-codex` shims, and LaunchAgents with:

```bash
npm run uninstall:codex-plugin
```

On macOS, the Codex plugin installer automatically reads `.data/sqlserver-identity.env` when present and injects the supported `TASKBOARD_SQLSERVER_*` values into the background LaunchAgent. The file is intentionally ignored by git. A complete file lets the panel connect to the SQL Server identity database on open; without it, the panel starts in local draft mode. The one-line installer also runs `npm run identity:intranet-connect -- --quiet` before plugin installation: when the internal SQL Server is reachable, it can create `.data/sqlserver-identity.env` from `TASKBOARD_SQLSERVER_USER`/`TASKBOARD_SQLSERVER_PASSWORD`, `CJ_TASKBOARD_SQLSERVER_USER`/`CJ_TASKBOARD_SQLSERVER_PASSWORD`, or a macOS Keychain generic password with service `cj-task-dashboard-sqlserver` and account equal to the SQL Server user.

Windows has the same standalone panel entry points. To start the local service automatically after the current user signs in, open PowerShell in the repository and run:

```powershell
npm run windows:install
```

Set `TASKBOARD_SQLSERVER_HOST`, `TASKBOARD_SQLSERVER_USER`, `TASKBOARD_SQLSERVER_PASSWORD`, and `TASKBOARD_SQLSERVER_DATABASE` as user environment variables before installing the scheduled task. The task runs only for the current Windows user and writes its output to `.data/windows-taskboard-server.log`. Remove it with:

```powershell
npm run windows:uninstall
```

The Windows launcher uses Chrome or Edge app mode when available and falls back to the default browser. Codex embedded injection remains a separate macOS-only path; Windows should use the standalone panel.

## Embed in Codex

### Recommended: keep your current window and open a separate Taskboard window

Keep the existing Codex window open. From the Taskboard repository, start a second Codex instance with a dedicated CDP port:

```bash
open -n -a /Applications/ChatGPT.app --args \
  --remote-debugging-port=9231 \
  --remote-allow-origins=http://127.0.0.1:9231
```

After the new Codex window appears, run the injector in another terminal:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 \
npm run codex:inject -- --port 9231 --open
```

Keep the injector terminal running while using the embedded panel. The original Codex window remains unchanged, and the new window receives the Taskboard sidebar entry. If port `9231` is occupied, use another port in both commands.

### Alternative: restart Codex with the standalone launcher

Quit every running Codex window, then run:

```bash
CODEX_TASKBOARD_HOST=127.0.0.1 npm run codex
```

This starts the local Taskboard service when needed, launches the official macOS Codex app with a loopback-only CDP port, injects a native-looking Taskboard entry after Plugins, and keeps watching both the service and replacement renderers. Opening Taskboard asks this launcher to health-check the fixed local service, restart it when needed, and rebuild a failed iframe. Keep this command running while using the embedded panel. The launcher does not modify `ChatGPT.app` or its `app.asar`.

Codex 26.715.52143 ships a renderer CSP that blocks arbitrary HTTP iframes. The launcher therefore enables CDP CSP bypass, reloads that renderer once, installs the document-start script, and waits until the Taskboard OOPIF is actually loaded. CDP is unauthenticated to other processes on the same machine, so only run trusted local code while the launcher is active.

To inject into a Codex instance that was already launched with CDP by another method, run:

```bash
npm run codex:inject -- --port 9229 --open
```

This command also stays resident so the injected tab can restart Taskboard after a service exit. Stop it with `Ctrl-C`.

The script adds a Taskboard entry to the Codex sidebar and renders the iframe across Codex's complete main workspace, including the contextual titlebar area so Taskboard's own header does not leave an empty strip. That full rectangular header is placed above Electron's draggable layer and marked `no-drag`; because the native contextual actions are suppressed while Taskboard is active, its own actions use their normal edge padding without an artificial right-side gap. The native sidebar stays mounted, while the previous page selection and contextual header are temporarily suppressed; choosing another Codex page restores them.

“在对话中打开” selects the corresponding native Codex project when one is available and opens an unsent native composer with `$manage-taskboard ISSUE-ID`. A conversation is attributed only after it actually processes the issue: `taskctl` reads Codex's `CODEX_THREAD_ID` and records that ID on the issue or comment mutation. Recorded IDs are clickable through Codex's native route bridge. Each issue can bind either one Git branch or one worktree; the options are scanned from the selected Codex project's repository instead of being typed by hand. The integration uses Codex's existing project, composer, and route markers; it does not patch React, replace `fetch`, load private chunks, or edit Codex data files.

To use a different UI origin, set `window.__CODEX_TASKBOARD_URL__` before the user script runs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODEX_TASKBOARD_HOST` | `127.0.0.1` | HTTP bind address; set `0.0.0.0` only when using a trusted, authenticated LAN boundary |
| `CODEX_TASKBOARD_PORT` | `47824` | Local HTTP port |
| `CODEX_TASKBOARD_DATA_DIR` | `.data` | SQLite data directory |
| `CODEX_TASKBOARD_URL` | `http://127.0.0.1:47824` | CLI API origin |

Set `CODEX_TASKBOARD_HOST=0.0.0.0` only behind an authenticated, trusted LAN boundary. In that mode `npm start` prints the available LAN URLs and teammates can point `taskctl` at `http://<host-ip>:47824`.

LAN mode has no account authentication: anyone on the trusted local network who can reach the URL can read and write the taskboard. Public internet and cloud deployment require an authenticated deployment boundary.

## Share through Cloudflare

For two trusted collaborators, the taskboard can run on Cloudflare with Worker Static Assets and API routes, D1 as the authoritative business database, and a private R2 bucket for attachments. The deployment uses HTTPS Basic Authentication with a shared password and refreshes open boards after a global revision changes.

Each device keeps its own project checkout mapping and continues to use a local companion for Codex, Git/worktree, Skill, and MCP capabilities. Cloud mode never falls back to or double-writes the local SQLite database.

See [Cloud collaboration](docs/cloud-collaboration.md) for owner deployment, existing GitHub installation setup, password rotation, local path mapping, and the one-time local-data migration flow.

## Verify

```bash
npm run check
```

This runs TypeScript checking, a production frontend build, and the server/CLI/injection test suite.
