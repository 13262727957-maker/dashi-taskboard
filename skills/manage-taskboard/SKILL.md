---
name: manage-taskboard
description: Install and use Dashi Taskboard through local CLI tools. Use when an AI agent needs to clone/install Dashi Taskboard, open the standalone Dashi panel window, check the local service, track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, coordinate concurrent updates, or scan prior project conversations into meaningful task cards.
---

# Manage Taskboard

Use `dashi-taskboard open` when the user asks to open or show the Dashi Taskboard panel. If `dashi-taskboard` is not installed, bootstrap Dashi from the GitHub repository first. Use `dashi-taskboard doctor` when the user asks to check the local panel/server state. Use `taskctl` for every project, issue, and comment operation. Read [references/cli.md](references/cli.md) before choosing a command or option.

## Install Bootstrap

When `command -v dashi-taskboard` fails, install Dashi before trying panel or task commands:

```bash
mkdir -p ~/Desktop/Projects
cd ~/Desktop/Projects
git clone https://github.com/13262727957-maker/dashi-taskboard.git
cd dashi-taskboard
npm run install:codex-plugin
dashi-taskboard doctor
dashi-taskboard open
```

If the repository already exists, `cd` into it and run `git pull` before `npm run install:codex-plugin`. If `dashi-taskboard` is still not on PATH after install, call `~/.local/bin/dashi-taskboard doctor` and `~/.local/bin/dashi-taskboard open`.

The GitHub repository may be private. If `git clone` fails for authentication or network access, report that blocker and ask the user to grant access or clone the repository manually.

## Panel Window

When the user asks to open, show, view, or bring up the Dashi Taskboard panel, run:

```bash
dashi-taskboard open
```

If `dashi-taskboard` is not on PATH, call `~/.local/bin/dashi-taskboard open`. This opens the standalone local panel window backed by `http://127.0.0.1:47824/?host=agent`; on macOS it prefers a Chrome/Chromium-style app-mode window before falling back to the default browser. It does not require Codex sidebar injection or a debug port.

For health checks, run:

```bash
dashi-taskboard doctor
```

## Prior Conversation Scans

When the user asks to scan previous, prior, or historical project conversations and turn them into task cards, run a standard scan before creating or updating issues:

1. Gather relevant prior project conversations and group repeated discussion into coherent work items.
2. For each candidate work item, run a lightweight repository evidence scan using likely feature, route, component, migration, test, config, and API keywords. Prefer `rg`/`rg --files`; do not read broad unrelated files unless the scan points to them.
3. Classify status from the strongest evidence, not conversation alone:
   - `backlog`: only an idea/request is present, with no clear commitment or repository evidence.
   - `todo`: the work is committed or partially present, but gaps, acceptance criteria, or verification remain unclear.
   - `in_progress`: recent implementation is active and not yet self-verified.
   - `in_review`: implementation evidence plus self-verification exists, but the user has not accepted it.
   - `done`: the user explicitly confirms acceptance or asks to mark complete.
   - `blocked`: progress cannot continue because required environment, credentials, data, dependency, or decision is missing.
4. Record evidence in each issue description or a comment using compact tags such as `evidence:conversation`, `evidence:code`, `evidence:test`, `evidence:runtime`, `acceptance:pending`, and `confidence:low|medium|high`.
5. If evidence conflicts, choose the less-final status and describe the uncertainty. Prefer `todo` for "implemented but possibly incomplete"; use `in_review` only when self-verification evidence is present.

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
