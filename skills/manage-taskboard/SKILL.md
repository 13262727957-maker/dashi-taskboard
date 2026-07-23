---
name: manage-taskboard
description: Manage taskboard projects, issues, and issue comments through the taskctl CLI. Use when Codex needs to inspect project work, create or update issues, add progress notes, begin work on an issue, record completion, or coordinate concurrent updates.
---

# Manage Taskboard

Use `taskctl` for every project, issue, and comment operation. Read [references/cli.md](references/cli.md) before choosing a command or option.

## Workflow

1. Inspect the relevant project and issue before changing them.
2. Create or update issues with the CLI; consume its JSON output.
   Issues created through `taskctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
3. Let `taskctl` attribute every issue or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`.
4. Set the issue status to `in_progress` before starting implementation.
5. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
6. Before requesting review, verify the requested work and acceptance criteria.
7. After implementation and self-verification, always move the issue to `in_review`; never move it directly to `done`.
8. Add a comment when the issue needs a durable progress note or verification result.
9. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Codex self-verification alone is not sufficient.
10. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

If an update reports a version conflict, read the issue again, reconcile the newer state, and retry with its current version.
