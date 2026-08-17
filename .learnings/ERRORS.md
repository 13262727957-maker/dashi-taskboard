# Errors

Command failures and integration errors.

---

## [ERR-20260811-004] identity-project-api-probe-headers

**Logged**: 2026-08-11T16:49:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
The project API probe overwrote its JSON content type while adding the authorization header.

### Error
```text
Content-Type must be application/json
```

### Context
- The helper spread `init` after its generated headers, replacing `Content-Type` with the custom header object.
- This was a test harness issue, not an application failure.

### Suggested Fix
Merge request headers after spreading request options, then set the JSON content type explicitly for JSON bodies.

### Metadata
- Reproducible: no
- Related Files: none

---

## [ERR-20260811-003] identity-project-api-test

**Logged**: 2026-08-11T16:48:00+08:00
**Priority**: medium
**Status**: pending
**Area**: backend

### Summary
The first project/member integration probe assumed project creation succeeded before inspecting the response.

### Error
```text
TypeError: Cannot read properties of undefined (reading 'id')
```

### Context
- The probe attempted to read `projectResult.project.id` without printing the project creation response.
- The endpoint response needs to be inspected before continuing the chained operation.

### Suggested Fix
Validate each response status and payload before using dependent IDs in integration probes.

### Metadata
- Reproducible: unknown
- Related Files: server/app.mjs, server/sqlserver-identity.mjs

---

## [ERR-20260811-002] sqlserver-probe-query

**Logged**: 2026-08-11T16:30:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
The SQL Server connection succeeded, but the probe query used double quotes around a string argument to `SERVERPROPERTY`.

### Error
```text
Invalid column name 'ProductVersion'.
```

### Context
- The connection to the supplied SQL Server endpoint completed successfully.
- The query used `SERVERPROPERTY("ProductVersion")`; SQL Server interpreted it as an identifier.

### Suggested Fix
Use `SERVERPROPERTY('ProductVersion')` for string arguments.

### Metadata
- Reproducible: yes
- Related Files: none

---

## [ERR-20260811-001] npm-install-xlsx

**Logged**: 2026-08-11T16:21:00+08:00
**Priority**: low
**Status**: pending
**Area**: tooling

### Summary
The first attempt to install the Excel parser used an invalid package version string.

### Error
```text
npm error Invalid tag name "^0.แน" of package "xlsx@^0.แน"
```

### Context
- Command attempted: `npm install xlsx@^0.แน --save`
- The malformed version was introduced in the command itself; no project files were changed by npm.

### Suggested Fix
Use the package's valid published version range in a follow-up install command.

### Metadata
- Reproducible: no
- Related Files: package.json

---

## [ERR-20260808-001] node-test-paths

**Logged**: 2026-08-08T13:56:00+08:00
**Priority**: low
**Status**: resolved
**Area**: tests

### Summary
Focused Node test run failed when test filenames were passed without the `test/` directory prefix.

### Error
```text
Could not find 'manage-taskboard-skill.test.mjs, issue-relations.test.mjs'
```

### Context
- Command attempted: `npm test -- manage-taskboard-skill.test.mjs issue-relations.test.mjs`
- Correct command: `npm test -- test/manage-taskboard-skill.test.mjs test/issue-relations.test.mjs`
- The corrected command passed.

### Suggested Fix
Use repo-relative test paths with the `test/` prefix when invoking focused Node test files through `npm test --`.

### Metadata
- Reproducible: yes
- Related Files: test/manage-taskboard-skill.test.mjs, test/issue-relations.test.mjs

---

## [ERR-20260806-002] injector-tests

**Logged**: 2026-08-06T14:24:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: tests

### Summary
The focused injection test run failed because an automation payload containing current model and reasoningEffort values parsed to null.

### Error
```text
AssertionError [ERR_ASSERTION]: list must retain model and reasoningEffort
actual: null
```

### Context
- Command attempted: `node --test test/inject.test.mjs test/injector.test.mjs test/injector-host-runtime.test.mjs`
- The failing path is part of the injected Taskboard host bridge.

### Suggested Fix
Update the taskboard automation parser to accept the current model/reasoningEffort option values expected by the injection contract.

### Metadata
- Reproducible: yes
- Related Files: shared/taskboard-automation.mjs, test/inject.test.mjs

---

## [ERR-20260806-001] codex-plugin-install

**Logged**: 2026-08-06T14:03:00+08:00
**Priority**: medium
**Status**: resolved
**Area**: infra

### Summary
The first installer run failed after `npm install` because the helper tried to trim null stdout when stdio was inherited.

### Error
```text
Cannot read properties of null (reading 'trim')
```

### Context
- Command attempted: `npm run install:codex-plugin`
- The installer helper used `stdio: "inherit"` for child commands, which leaves `result.stdout` as null.

### Suggested Fix
Return an empty string when `result.stdout` is not a string, or avoid reading stdout for inherited-stdio commands.

### Metadata
- Reproducible: yes
- Related Files: scripts/codex-plugin-install.mjs

---

## [ERR-20260817-001] local-http-diagnostics

**Logged**: 2026-08-17T15:00:00+08:00
**Priority**: low
**Status**: resolved
**Area**: infra

### Summary
Interface timing diagnostics failed because `curl` is not available in this local shell environment.

### Error
```text
zsh:1: command not found: curl
```

### Context
- Command attempted: `curl -sS -o /tmp/taskboard.out -w ... http://127.0.0.1:47824/...`
- The same Taskboard endpoint timings were collected successfully with Node's built-in `fetch`.

### Suggested Fix
Use Node `fetch` snippets for local Taskboard HTTP diagnostics in this workspace unless `curl` availability is confirmed first.

### Metadata
- Reproducible: yes
- Related Files: server/app.mjs

---
