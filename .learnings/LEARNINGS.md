# Learnings

Corrections, insights, and knowledge gaps captured during development.

**Categories**: correction | insight | knowledge_gap | best_practice

---

## [LRN-20260824-001] correction

**Logged**: 2026-08-24T16:25:00+08:00
**Priority**: high
**Status**: pending
**Area**: git

### Summary
Before pushing, distinguish already-committed local commits from newly unstaged/untracked work and ask before bundling unrelated current work into a commit.

### Details
A push request was interpreted as permission to commit all current working tree changes, including recent documentation edits and unrelated in-progress feature code. The correct behavior is to inspect and report ahead commits, then ask before committing uncommitted work unless the user explicitly asked to include it.

### Suggested Action
For future push requests: show ahead commits and dirty worktree summary; push only existing commits by default; if dirty changes exist, ask whether to commit them or leave them local.

### Metadata
- Source: user_feedback
- Related Files: docs/taskboard-user-manual.html, server/app.mjs
- Tags: git,push,workflow

---
