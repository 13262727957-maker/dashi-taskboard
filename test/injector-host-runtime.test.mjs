import assert from "node:assert/strict";
import { test } from "node:test";

import {
  handleHostBindingPayload,
  restartResidentInjector,
} from "../scripts/codex-injector-runtime.mjs";

const currentAutomationRequest = {
  id: "host-request-1",
  action: "automation",
  requestId: "automation-request-1",
  operation: "ensure-active",
  taskboardProjectId: "local",
  codexProjectId: "codex-project",
  projectName: "Local",
  workspacePath: "/tmp/project",
  skillPath: "/tmp/manage-taskboard/SKILL.md",
  intervalMinutes: 10,
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
};

test("a stale automation parser receives an immediate host error instead of timing out", async () => {
  const responses = [];
  const staleParser = () => null;

  const result = await Promise.race([
    handleHostBindingPayload(
      {
        payload: JSON.stringify(currentAutomationRequest),
        executionContextId: 12,
      },
      {
        parseAutomationRequest: staleParser,
        ensure: async () => assert.fail("ensure must not run"),
        runAutomation: async () => assert.fail("automation must not run"),
        prefill: async () => assert.fail("prefill must not run"),
        sendResponse: async (_executionContextId, response) => responses.push(response),
      },
    ),
    new Promise((_, reject) => setTimeout(() => reject(new Error("host response timed out")), 50)),
  ]);

  assert.deepEqual(result, { responded: true, accepted: false });
  assert.deepEqual(responses, [{
    id: currentAutomationRequest.id,
    ok: false,
    error: "任务面板宿主不支持当前自动认领配置，请重新构建并刷新 Codex 面板",
  }]);
});

test("refresh replaces only the resident injector before reloading its iframe", async () => {
  const calls = [];
  const replacement = await restartResidentInjector(9231, {
    findResident: () => 4321,
    stopResident: async (pid) => calls.push(["stop", pid]),
    startResident: (port) => {
      calls.push(["start", port]);
      return { pid: 9876, started: true };
    },
    waitUntilReady: async (port, pid) => calls.push(["ready", port, pid]),
  });

  assert.deepEqual(replacement, {
    previousPid: 4321,
    pid: 9876,
    restarted: true,
  });
  assert.deepEqual(calls, [
    ["stop", 4321],
    ["start", 9231],
    ["ready", 9231, 9876],
  ]);
});
