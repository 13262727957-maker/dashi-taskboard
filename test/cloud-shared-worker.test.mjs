import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createCloudWorkerHarness } from "./helpers/cloud-worker-harness.mjs";

let cloud;
const alice = "Alice";
const bob = "Bob";

before(async () => {
  cloud = await createCloudWorkerHarness();
});

after(async () => {
  await cloud?.dispose();
});

async function createProject(id, actorName = alice) {
  return cloud.request("/api/projects", {
    method: "POST",
    actorName,
    json: {
      id,
      name: id.toUpperCase(),
      workspacePath: `/Users/${actorName.toLowerCase()}/${id}`,
    },
  });
}

async function createTask(projectId, title, actorName = alice, extra = {}) {
  return cloud.request("/api/tasks", {
    method: "POST",
    actorName,
    json: {
      projectId,
      title,
      description: "",
      status: "backlog",
      priority: "none",
      labels: [],
      ...extra,
    },
  });
}

test("Basic authentication protects static assets, APIs, and attachment content", async () => {
  for (const pathname of ["/", "/api/projects", "/api/attachments/missing/content"]) {
    const missing = await cloud.request(pathname);
    assert.equal(missing.response.status, 401);
    assert.match(missing.response.headers.get("www-authenticate") ?? "", /^Basic\b/i);

    const invalid = await cloud.request(pathname, {
      actorName: alice,
      password: "wrong",
    });
    assert.equal(invalid.response.status, 401);
    assert.match(invalid.response.headers.get("www-authenticate") ?? "", /^Basic\b/i);
  }
});

test("the Basic username becomes the trusted actor while the shared password grants access", async () => {
  const project = await createProject("alpha");
  assert.equal(project.response.status, 201);
  assert.equal(project.body.project.workspacePath, null);

  const userTask = await createTask("alpha", "Created in browser", alice);
  assert.equal(userTask.response.status, 201);
  assert.equal(userTask.body.task.creatorType, "user");
  assert.equal(userTask.body.task.creatorName, alice);
  assert.match(userTask.body.task.creatorId, /^basic:/);

  const agentTask = await cloud.request("/api/tasks", {
    method: "POST",
    actorName: bob,
    headers: { "x-taskboard-client": "taskctl" },
    json: {
      projectId: "alpha",
      title: "Created through taskctl",
      status: "backlog",
      priority: "none",
      labels: [],
    },
  });
  assert.equal(agentTask.response.status, 201);
  assert.equal(agentTask.body.task.creatorType, "agent");
  assert.match(agentTask.body.task.creatorName, /Codex Agent/);
  assert.match(agentTask.body.task.creatorName, /Bob/);
});

test("projects, tasks, comments, relations, and workflows preserve the current API contract", async () => {
  const parent = await createTask("alpha", "Parent");
  const child = await createTask("alpha", "Child");
  const relation = await cloud.request(
    `/api/tasks/${child.body.task.id}/relations/parent/${parent.body.task.id}`,
    {
      method: "POST",
      actorName: alice,
      json: { version: child.body.task.version },
    },
  );
  assert.equal(relation.response.status, 200);
  assert.equal(relation.body.task.relations.parent.id, parent.body.task.id);

  const comment = await cloud.request(`/api/tasks/${child.body.task.id}/comments`, {
    method: "POST",
    actorName: bob,
    json: { body: "Review note" },
  });
  assert.equal(comment.response.status, 201);
  assert.equal(comment.body.comment.authorName, bob);

  const workspace = {
    version: 1,
    tabs: [{ id: "delivery", name: "Delivery" }],
    activeWorkflowId: "delivery",
    snapshots: {
      delivery: {
        nodes: [],
        flow: { version: 2, root: { items: [] } },
        selectedNodeId: null,
      },
    },
  };
  const saved = await cloud.request("/api/projects/alpha/workflow-workspace", {
    method: "PUT",
    actorName: alice,
    json: { version: 0, workspace },
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.body.workflow.version, 1);

  const listed = await cloud.request("/api/tasks?projectId=alpha&archived=false", {
    actorName: alice,
  });
  assert.equal(listed.response.status, 200);
  assert.ok(listed.body.tasks.some((task) => task.id === child.body.task.id));
});

test("concurrent issue creation has unique identifiers and stale writes return 409", async () => {
  const created = await Promise.all(
    Array.from({ length: 12 }, (_, index) => createTask("alpha", `Concurrent ${index}`)),
  );
  for (const result of created) assert.equal(result.response.status, 201);
  const identifiers = created.map((result) => result.body.task.identifier);
  assert.equal(new Set(identifiers).size, identifiers.length);

  const task = created[0].body.task;
  const winner = await cloud.request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    actorName: alice,
    json: { version: task.version, title: "Winner" },
  });
  assert.equal(winner.response.status, 200);

  const stale = await cloud.request(`/api/tasks/${task.id}`, {
    method: "PATCH",
    actorName: bob,
    json: { version: task.version, title: "Stale" },
  });
  assert.equal(stale.response.status, 409);
  assert.equal(stale.body.error.code, "VERSION_CONFLICT");
  assert.deepEqual(stale.body.error.details, {
    expectedVersion: task.version,
    actualVersion: winner.body.task.version,
  });
});

test("archived tasks are excluded from project issue counts", async () => {
  const project = await createProject("archive-count");
  assert.equal(project.response.status, 201);
  const task = await createTask("archive-count", "Archive me");
  const before = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(
    before.body.projects.find((candidate) => candidate.id === "archive-count").issueCount,
    1,
  );

  const archived = await cloud.request(`/api/tasks/${task.body.task.id}/archive`, {
    method: "POST",
    actorName: alice,
    json: { version: task.body.task.version },
  });
  assert.equal(archived.response.status, 200);
  const after = await cloud.request("/api/projects", { actorName: alice });
  assert.equal(
    after.body.projects.find((candidate) => candidate.id === "archive-count").issueCount,
    0,
  );
});

test("R2 attachment upload, download, delete, and D1 failure compensation form one closed lifecycle", async () => {
  const task = await createTask("alpha", "Attachment owner");
  const uploaded = await cloud.request(`/api/tasks/${task.body.task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("evidence.txt"),
    },
    body: "attachment body",
  });
  assert.equal(uploaded.response.status, 201);
  const attachment = uploaded.body.attachment;
  const downloaded = await cloud.request(`/api/attachments/${attachment.id}/content`, {
    actorName: bob,
  });
  assert.equal(downloaded.response.status, 200);
  assert.equal(downloaded.body, "attachment body");

  const deleted = await cloud.request(`/api/attachments/${attachment.id}`, {
    method: "DELETE",
    actorName: alice,
  });
  assert.equal(deleted.response.status, 204);
  assert.equal((await cloud.listAttachmentKeys()).length, 0);

  await cloud.db.exec(`
    CREATE TRIGGER fail_attachment_insert
    BEFORE INSERT ON attachments
    WHEN NEW.filename = 'fail.txt'
    BEGIN
      SELECT RAISE(ABORT, 'intentional attachment metadata failure');
    END;
  `);
  const beforeKeys = await cloud.listAttachmentKeys();
  const failed = await cloud.request(`/api/tasks/${task.body.task.id}/attachments`, {
    method: "POST",
    actorName: alice,
    headers: {
      "content-type": "text/plain",
      "x-taskboard-filename": encodeURIComponent("fail.txt"),
    },
    body: "must be compensated",
  });
  assert.equal(failed.response.status, 500);
  assert.deepEqual(await cloud.listAttachmentKeys(), beforeKeys);
});

test("the global revision is monotonic and lets clients poll only when data changed", async () => {
  const initial = await cloud.request("/api/revisions?since=0", { actorName: alice });
  assert.equal(initial.response.status, 200);
  const baseline = initial.body.revision;

  const unchanged = await cloud.request(`/api/revisions?since=${baseline}`, {
    actorName: alice,
  });
  assert.equal(unchanged.body.changed, false);

  await createTask("alpha", "Revision mutation");
  const changed = await cloud.request(`/api/revisions?since=${baseline}`, {
    actorName: bob,
  });
  assert.equal(changed.body.changed, true);
  assert.ok(changed.body.revision > baseline);

  const current = await cloud.request(`/api/revisions?since=${changed.body.revision}`, {
    actorName: alice,
  });
  assert.equal(current.body.changed, false);
});

test("cloud-only local capability routes return an explicit companion requirement", async () => {
  const meta = await cloud.request("/api/meta", { actorName: alice });
  assert.equal(meta.response.status, 200);
  assert.equal(meta.body.mode, "cloud");
  assert.deepEqual(meta.body.realtime, { transport: "poll", intervalMs: 2000 });
  assert.equal(meta.body.localCapabilities.available, false);

  for (const pathname of [
    "/api/device-workspaces",
    "/api/workflow-capabilities",
    "/api/projects/alpha/development-contexts",
  ]) {
    const result = await cloud.request(pathname, { actorName: alice });
    assert.equal(result.response.status, 409);
    assert.equal(result.body.error.code, "LOCAL_COMPANION_REQUIRED");
  }
});
