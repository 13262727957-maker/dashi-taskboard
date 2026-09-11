---
name: manage-taskboard
description: 安装和使用 CJ Task Dashboard；配置每天 09:00 至 20:00 每半小时扫描 Codex 对话的定时任务，断网时共用面板 SQLite 整理卡片，联网后按 SQL Server 绑定核对并提交。
---

# CJ Task Dashboard

Use `dashi-taskboard open` when the user asks to open or show the CJ Task Dashboard panel. If `dashi-taskboard` is not installed, bootstrap CJ Task Dashboard from the GitLab repository first. If the user asks to install, reinstall, update, upgrade, fix an old version, or refresh the panel/skill, always run the update bootstrap even when `dashi-taskboard` already exists; an existing command can point at an old checkout. Use `dashi-taskboard doctor` when the user asks to check the local panel/server state. Prefer `taskctl` for project, issue, and comment operations. Scheduled reconciliation uses the panel's local SQLite and verified company submission operations described in references/scheduled-scan.md; a local save is not proof of company submission. The installer provides these commands at `~/.local/bin/dashi-taskboard` and `~/.local/bin/taskctl`; if the shell cannot resolve them, call those paths directly. Read [references/cli.md](references/cli.md) before choosing a command or option.

## Install Bootstrap

When the user asks to install, reinstall, update, upgrade, or fix an old/stale CJ Task Dashboard install, run the bootstrap command even if `command -v dashi-taskboard` succeeds. The bootstrap must fetch `origin`, hard reset the checkout to the latest remote commit, rebuild the web UI, recopy the plugin source, refresh the legacy skill link, and reinstall the local CLI shims. Local code changes in the install directory are overwritten; if the remote fetch or hard reset fails, the installer must stop instead of installing from stale local code:

```bash
curl -fsSL https://git.caijai.com/aiplus/cjtaskdashboard/-/raw/main/install.sh | bash
```

When `command -v dashi-taskboard` fails and the user only wants to open or use the panel, install CJ Task Dashboard with the same bootstrap command before trying panel or task commands.

If the one-line installer cannot fetch the script, use the fallback clone/update flow:

```bash
mkdir -p ~/Desktop/Projects
cd ~/Desktop/Projects
if [ -d cjtaskdashboard/.git ]; then
  git -C cjtaskdashboard fetch --prune origin
  git -C cjtaskdashboard reset --hard @{u}
  git -C cjtaskdashboard clean -fd -e .data/ -e node_modules/ -e .env -e '.env.*' -e .dev.vars
else
  git clone https://git.caijai.com/aiplus/cjtaskdashboard.git
fi
cd cjtaskdashboard
npm run install:codex-plugin
dashi-taskboard doctor
dashi-taskboard open
```

After any install or update, run `dashi-taskboard doctor`. If `dashi-taskboard` is still not on PATH after install, call `~/.local/bin/dashi-taskboard doctor` and `~/.local/bin/dashi-taskboard open`.

If the user reports that another agent still sees an old skill after installation, verify these files on that machine:

```bash
ls -l ~/.codex/skills/manage-taskboard
ls -l ~/plugins/dashi-taskboard/skills/manage-taskboard/SKILL.md
```

The legacy skill path must be a symlink or junction to `~/plugins/dashi-taskboard/skills/manage-taskboard`. If it is a copied directory or points somewhere else, rerun the installer from the latest checkout. Restart Codex after reinstalling so the skill catalog reloads.

The GitLab repository may be private. If `git clone` fails for authentication or network access, report that blocker and ask the user to grant access or clone the repository manually.

## Panel Window

When the user asks to open, show, view, or bring up the CJ Task Dashboard panel, run:

```bash
dashi-taskboard open
```

If `dashi-taskboard` is not on PATH, call `~/.local/bin/dashi-taskboard open`. This opens the standalone local panel window backed by `http://127.0.0.1:47824/?host=agent`; on macOS, Windows, and Linux it prefers a Chrome/Chromium/Edge app-window before falling back to the default browser. It does not require Codex sidebar injection or a debug port.

For health checks, run:

```bash
dashi-taskboard doctor
```

## Planning First

This section applies to explicit planning/card-creation requests, not pure discussion, skill editing, authorized schedule setup, or scheduled reconciliation. Those modes follow their own workflow and do not stop after creating planning cards.

When the user is asking to plan, test, validate, review scope, adapt to a client, split requirements, organize work, or turn an idea into tasks, create or update task cards before doing implementation work. Do not start editing code, running a long implementation, or executing a task just because the request contains an action verb.

Treat these as planning/card-creation requests unless the user explicitly says not to create cards: "拆解", "分成任务卡", "需求", "验收", "测试这个技能", "验证", "适配", "方案", "计划", "下一步", "roadmap", "todo", "backlog", "review what to do", or any multi-part feature request.

Required planning sequence:

1. Run `taskctl context current --cwd <cwd> --json`.
2. Run `taskctl issue list --project <projectId> --json` and check for existing cards.
3. Create or update a parent card for the overall requirement when the request has multiple parts.
4. Create child cards for concrete test cases, implementation slices, acceptance checks, and documentation/boundary decisions.
5. Relate the child cards to the parent with `issue relation add --type parent`.
6. Stop and summarize the created or updated cards. Do not implement them in the same turn unless the user explicitly asked to create cards and then start a specific first card.

Only execute implementation work when the user clearly asks to start/fix/implement a named issue, asks to continue after cards already exist, or makes a tiny request that does not benefit from durable tracking. If the user asks both to split work and execute it, create the cards first, then read and claim the named or first card with `--if-version` before implementing.

## Prior Conversation Scans

For historical scans, periodic conversation reconciliation, or evidence-based status assessment, read [references/scheduled-scan.md](references/scheduled-scan.md). Its Status Policy also governs issue delivery. Extract requirements from conversations, match existing cards, and verify task-specific delivery evidence. Never treat silence or a topic change as acceptance.

## Scheduled Scanning and Submission

For each authorized project, first reconcile its entire accessible conversation history, earliest to latest, in resumable batches through a fixed initial cutoff. Do not treat existing cards or a previously saved cursor as proof of full coverage. After full initial coverage, scan new messages incrementally while continuing unfinished-task follow-up. Read the First Full History Scan section of references/scheduled-scan.md before choosing the scan range.

When asked to enable automatic conversation scanning and task submission, create or update a recurring task every 30 minutes within the daily active window, with the final round at 20:00 in the user's timezone, following [references/scheduled-scan.md](references/scheduled-scan.md). Complete the setup workflow rather than stopping after creating planning cards. Distinguish schedule setup from its per-run reconciliation; scheduled invocations must not create another schedule.

Use the panel's existing SQLite through verified CLI/API operations for local cards, scan positions, source links, tracking, and submission records. Manual panel use and background scans share these records; do not create a separate skill database or JSON checkpoint. Continue verified local processing when SQL Server is unavailable, preserving bindings and pending submissions. On reconnection, refresh authoritative database bindings and remote changes before submitting with the existing local-to-remote card identities. Report missing capabilities for the affected stage only; do not claim local saves were submitted. The daily active window is 09:00-20:00 inclusive in Asia/Shanghai. Read references/scan-api.md for the implemented CLI/API contract.

A request to edit this skill does not itself create an automation or change the panel. Discussion alone does not create cards. Ordinary implementation remains subject to explicit task authorization; scanning never grants permission to execute discovered tasks.

## Workflow

1. Search for an existing issue before creating one. Use `context current`, then list the project issues and compare their identifiers, titles, descriptions, and status.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
2. Before executing an issue, read the latest issue content and all comments. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
   - In a description or comment, `![alt](/api/attachments/<id>/content)` marks an inline image at that exact position in the text.
   - When understanding that image is necessary, use `attachment download` to save it locally, then inspect the saved file with an available image-viewing tool.
3. Create or update issues with the CLI; consume its JSON output.
   Issues created through `taskctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
4. Let `taskctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`.
5. To claim a `todo` issue, move it to `in_progress` with `--if-version` from the latest read before starting implementation. If this claim reports a version conflict or a new read shows that its status changed, skip the issue and do not implement it.
6. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
7. Before requesting review, verify the requested work and acceptance criteria.
8. After implementation, record key changes, task-specific verification, delivery destination, and remaining work. Apply the Status Policy in references/scheduled-scan.md: use `done` only when the requested completion conditions have sufficient evidence, otherwise retain `in_progress` or use `in_review` as appropriate.
9. Preserve newer human status decisions. Explicit acceptance can complete an issue, but silence cannot. Scans may also complete an idle task with sufficient outcome evidence; the assistant's own delivery claim alone is insufficient.
10. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.
