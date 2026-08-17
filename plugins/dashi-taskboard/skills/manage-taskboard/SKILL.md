---
name: manage-taskboard
description: Install and use CJ Task Dashboard through local CLI tools. Use when an AI agent needs to clone/install CJ Task Dashboard, open the standalone CJ task panel window, check the local service, split a requirement into task cards before implementation, track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, or coordinate concurrent updates.
---

# CJ Task Dashboard

Use `dashi-taskboard open` when the user asks to open or show the CJ Task Dashboard panel. If `dashi-taskboard` is not installed, bootstrap CJ Task Dashboard from the GitLab repository first. Use `dashi-taskboard doctor` when the user asks to check the local panel/server state. Use `taskctl` for every project, issue, and comment operation. The installer provides these commands at `~/.local/bin/dashi-taskboard` and `~/.local/bin/taskctl`; if the shell cannot resolve them, call those paths directly. Read [references/cli.md](references/cli.md) before choosing a command or option.

## Install Bootstrap

When `command -v dashi-taskboard` fails, install CJ Task Dashboard before trying panel or task commands:

```bash
curl -fsSL https://git.caijai.com/aiplus/cjtaskdashboard/-/raw/main/install.sh | bash
```

If the one-line installer cannot fetch the script, use the fallback clone flow:

```bash
mkdir -p ~/Desktop/Projects
cd ~/Desktop/Projects
git clone https://git.caijai.com/aiplus/cjtaskdashboard.git
cd cjtaskdashboard
npm run install:codex-plugin
dashi-taskboard doctor
dashi-taskboard open
```

If the repository already exists, `cd` into it and run `git pull` before `npm run install:codex-plugin`. If `dashi-taskboard` is still not on PATH after install, call `~/.local/bin/dashi-taskboard doctor` and `~/.local/bin/dashi-taskboard open`.

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
