---
name: manage-taskboard
description: Manage taskboard projects, issues, issue relations, and comments through the taskctl CLI. Use when Codex needs to track a new requirement, inspect project work, create or update issues, relate dependent work, add progress notes, begin work on an issue, record completion, or coordinate concurrent updates.
---

# Manage Taskboard

Use `taskctl` for every project, issue, and comment operation. Read [references/cli.md](references/cli.md) before choosing a command or option.

## Workflow

1. Search for an existing issue before creating one. Use `context current`, then list the project issues and compare their identifiers, titles, descriptions, and status.
   - If an issue already tracks the same requirement, append the new requirement or acceptance detail to that issue without discarding its existing scope.
   - If the work depends on, blocks, is blocked by, or is closely related to another issue, add the matching issue relation.
   - Use a parent/sub-issue relation when one requirement is a contained part of a larger issue. A child has one parent; a parent may have many sub-issues.
   - Create a new issue only when no existing issue reasonably tracks the requirement.
   - Do not create, append, or relate a tiny or trivial request that does not benefit from durable tracking.
2. Before executing an issue, read the latest issue content and all comments. Treat comments as part of the current requirements, especially when completed work has been returned for changes.
3. Create or update issues with the CLI; consume its JSON output.
   Issues created through `taskctl` are assigned to Codex Agent by default. Later CLI updates do not change the assignee.
4. Let `taskctl` attribute every issue, relation, or comment mutation to the current Codex conversation through `CODEX_THREAD_ID`. Outside Codex, pass the exact conversation id with `--thread-id`.
5. To claim a `todo` issue, move it to `in_progress` with `--if-version` from the latest read before starting implementation. If this claim reports a version conflict or a new read shows that its status changed, skip the issue and do not implement it.
6. Include `--if-version <version>` on every concurrent update, using the version returned by the latest read.
7. Before implementation, prove the real operation path to the user: entry point, action, data change or other side effect, and observable result. Cite the actual component, API, and file involved, or demonstrate the path in the product. This is not a test.
8. Implement the requested main path with the smallest direct change. Focus on the function itself and avoid over-design.
9. After implementation, demonstrate or verify only the direct operation path and give the result to the user for confirmation. Before confirmation, do not proactively add guardrails, mutation or regression tests, legacy compatibility protection, defensive extensions, or speculative fallbacks. After confirmation, add targeted protection or tests only when the user explicitly asks, or when the user reports a concrete failure scenario that requires them.
   - This workflow supersedes the earlier standing instruction that every feature must be developed test-first. Test-first language in older issues does not apply unless the user restates it for that issue after this rule.
   - Higher-priority safety and security requirements still apply. Keep validation required at real user-input or external-API boundaries, without expanding it into hypothetical protection beyond the requested path.
10. After implementation and the direct-path demonstration, add a comment summarizing the key changes, demonstrated path, result, and remaining risks; then move the issue to `in_review`. Never move it directly to `done`.
11. Move an issue from `in_review` to `done` only when the user explicitly confirms acceptance or explicitly asks to mark it complete. Agent demonstration alone is not sufficient.
12. Move work that cannot continue to `blocked`, and work that will not continue to `canceled`.

For version conflicts outside the initial claim, read the issue again, reconcile the newer state, and retry with its current version.
