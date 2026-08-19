---
name: manage-taskboard
description: Install and use CJ Task Dashboard through local CLI tools. Use when an AI agent needs to clone/install CJ Task Dashboard, open the standalone CJ task panel window, check the local service, split a requirement into task cards before implementation, track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, coordinate concurrent updates, or scan prior project conversations into meaningful task cards.
---

# CJ Task Dashboard

Use `dashi-taskboard open` when the user asks to open or show the CJ Task Dashboard panel. If `dashi-taskboard` is not installed, bootstrap CJ Task Dashboard from the GitLab repository first. If the user asks to install, reinstall, update, upgrade, fix an old version, or refresh the panel/skill, always run the update bootstrap even when `dashi-taskboard` already exists; an existing command can point at an old checkout. Use `dashi-taskboard doctor` when the user asks to check the local panel/server state. Use `taskctl` for every project, issue, and comment operation. The installer provides these commands at `~/.local/bin/dashi-taskboard` and `~/.local/bin/taskctl`; if the shell cannot resolve them, call those paths directly. Read [references/cli.md](references/cli.md) before choosing a command or option.

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

When the user asks to scan previous, prior, or historical project conversations and turn them into task cards, run a standard scan before creating or updating issues:

1. Gather relevant prior project conversations and group repeated discussion into coherent work items.
2. Treat old work as already-resolved until evidence says otherwise. Historical scans should not pile completed work into `todo` just because the user never said "done"; real users often move to the next topic silently after accepting a delivered result.
3. For each candidate work item, run a lightweight repository evidence scan using likely feature, route, component, migration, test, config, and API keywords. Prefer `rg`/`rg --files`; do not read broad unrelated files unless the scan points to them. When code exists, classify from code/runtime evidence first and use conversation only to find requirement origin, later rejection, replacement, or acceptance.
4. When there is no repository code for the project or the requested area, classify from the conversation evidence chain in this order: explicit user acceptance, implicit acceptance, assistant delivery, active work, committed request, idea only.
5. Classify status from the strongest current evidence:
   - `done`: explicit user acceptance exists; OR repository/runtime evidence shows the requested behavior exists and no later user rejection/rollback appears; OR in conversation-only scans, the assistant delivered the work and the user then switched to a new unrelated topic without later rejecting the delivered result. Record implicit cases with `evidence:implicit-acceptance`.
   - `in_review`: delivery or implementation evidence exists, but the user continues discussing the same feature with unresolved adjustments, asks "why is it still...", says it is not right yet, or the scan cannot tell whether a later related comment was satisfied.
   - `todo`: the user clearly requested the work, but no delivery/code/runtime evidence exists; OR implementation is only partial and a concrete remaining gap is still present. Do not use `todo` for delivered work merely because there is no explicit user acceptance.
   - `in_progress`: the conversation shows active work in progress and no delivery outcome, or repo evidence shows recent local changes without verification.
   - `blocked`: progress cannot continue because required environment, credentials, data, permission, network access, or a user decision is missing.
   - `canceled`: the user explicitly withdrew the request, replaced it with a different direction, said "撤回/不要/说错了/不是这个", or later work superseded the original requirement.
   - `backlog`: only an idea, question, or possible direction is present, with no clear user decision to do it.
6. Decide whether a later user message is a new topic or same-topic rework:
   - Treat as a new topic when the subject area changes, such as UI polish -> installer, project overview -> database connection, statistics -> uninstall/reinstall, or skill packaging -> panel design. If assistant delivery happened before this switch and there is no later rejection, mark the earlier work `done` with `evidence:implicit-acceptance`.
   - Treat as same-topic rework when the user says the same feature is wrong, ugly, too wide, not scrolling, still old, missing data, not the requested direction, or asks for another adjustment to the same surface. Keep that work `in_review` or split a new child `todo` for the adjustment.
7. Preserve hierarchy instead of reopening whole features:
   - If the main feature was delivered and later comments are polish or refinements, keep the parent `done`/`in_review` based on acceptance evidence and create/update child cards for the specific refinements.
   - If a delivered approach is replaced, mark the old child `canceled` or `superseded` in the description and create/update the new child.
8. Record compact evidence in each issue description or comment, such as `evidence:conversation`, `evidence:code`, `evidence:test`, `evidence:runtime`, `evidence:delivery`, `evidence:implicit-acceptance`, `acceptance:explicit|implicit|pending`, and `confidence:low|medium|high`.
9. If evidence conflicts, avoid dumping the item into `todo`. Prefer `in_review` for delivered-but-questionable work, `canceled` for replaced work, and `todo` only when a concrete unimplemented gap remains.

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
8. After implementation and self-verification, add a comment summarizing the key changes, verification, result, and remaining risks; then move the issue to `in_review`. Never move it directly to `done`.
9. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
10. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.
