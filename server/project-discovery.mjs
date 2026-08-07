import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_PROJECT_ID } from "../shared/domain.mjs";

const PROJECT_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

async function existingDirectory(value) {
  if (typeof value !== "string" || !path.isAbsolute(value.trim())) return null;
  try {
    const resolved = await realpath(value.trim());
    return (await stat(resolved)).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
}

function slugify(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function stableProjectId(client, sourceProjectId, fallbackName) {
  const source = String(sourceProjectId ?? "").trim();
  if (PROJECT_ID_PATTERN.test(source)) return source;
  const name = slugify(fallbackName);
  const digest = createHash("sha1").update(`${client}:${source || fallbackName}`).digest("hex").slice(0, 12);
  return [client, name, digest].filter(Boolean).join("-").slice(0, 64);
}

function workspaceContains(workspacePath, cwd) {
  if (typeof workspacePath !== "string" || workspacePath.length === 0) return false;
  const relative = path.relative(path.resolve(workspacePath), cwd);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function byMostSpecificWorkspace(left, right) {
  return right.workspacePath.length - left.workspacePath.length;
}

function codexProjectName(project, root) {
  if (typeof project?.name === "string" && project.name.trim()) return project.name.trim();
  if (typeof project?.title === "string" && project.title.trim()) return project.title.trim();
  return path.basename(root);
}

async function discoverCodexProjectCandidates(codexStatePath) {
  try {
    const state = JSON.parse(await readFile(codexStatePath, "utf8"));
    const projects = state["local-projects"];
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return [];
    const candidates = [];
    for (const [sourceProjectId, project] of Object.entries(projects)) {
      const rootPaths = Array.isArray(project?.rootPaths) ? project.rootPaths : [];
      const root = await existingDirectory(rootPaths[0]);
      if (!root) continue;
      const name = codexProjectName(project, root);
      candidates.push({
        id: stableProjectId("codex", sourceProjectId, name),
        client: "codex",
        sourceProjectId,
        name,
        workspacePath: root,
        confidence: "high",
      });
    }
    return candidates;
  } catch {
    return [];
  }
}

function paseoProjectName(project, root) {
  if (typeof project?.customName === "string" && project.customName.trim()) return project.customName.trim();
  if (typeof project?.displayName === "string" && project.displayName.trim()) return project.displayName.trim();
  return path.basename(root);
}

function paseoWorkspaceName(workspace, root) {
  if (typeof workspace?.title === "string" && workspace.title.trim()) return workspace.title.trim();
  if (typeof workspace?.displayName === "string" && workspace.displayName.trim()) return workspace.displayName.trim();
  return path.basename(root);
}

async function readJsonArray(filename) {
  try {
    const value = JSON.parse(await readFile(filename, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

async function discoverPaseoProjectCandidates({ paseoProjectsPath, paseoWorkspacesPath }) {
  const candidatesByPath = new Map();
  const projects = await readJsonArray(paseoProjectsPath);
  for (const project of projects) {
    if (project?.archivedAt) continue;
    const root = await existingDirectory(project.rootPath);
    if (!root) continue;
    const sourceProjectId = String(project.projectId ?? root);
    const name = paseoProjectName(project, root);
    candidatesByPath.set(root, {
      id: stableProjectId("paseo", sourceProjectId, name),
      client: "paseo",
      sourceProjectId,
      name,
      workspacePath: root,
      confidence: "high",
    });
  }

  const workspaces = await readJsonArray(paseoWorkspacesPath);
  for (const workspace of workspaces) {
    if (workspace?.archivedAt) continue;
    const root = await existingDirectory(workspace.cwd ?? workspace.worktreeRoot);
    if (!root || candidatesByPath.has(root)) continue;
    const sourceProjectId = String(workspace.workspaceId ?? workspace.projectId ?? root);
    const name = paseoWorkspaceName(workspace, root);
    candidatesByPath.set(root, {
      id: stableProjectId("paseo", sourceProjectId, name),
      client: "paseo",
      sourceProjectId,
      name,
      workspacePath: root,
      confidence: "medium",
    });
  }

  return [...candidatesByPath.values()];
}

export async function discoverDeviceProjectCandidates(options) {
  const [codex, paseo] = await Promise.all([
    discoverCodexProjectCandidates(options.codexStatePath),
    discoverPaseoProjectCandidates({
      paseoProjectsPath: options.paseoProjectsPath,
      paseoWorkspacesPath: options.paseoWorkspacesPath,
    }),
  ]);
  return [...codex, ...paseo].sort((left, right) => (
    left.name.localeCompare(right.name) || left.client.localeCompare(right.client)
  ));
}

export async function readDeviceProjects(options) {
  const candidates = await discoverDeviceProjectCandidates(options);
  return {
    workspaces: Object.fromEntries(candidates.map((project) => [project.id, project.workspacePath])),
    projects: candidates,
  };
}

function resolveExistingProjectForPath(database, cwd) {
  const projects = database.listProjects();
  const matching = projects
    .filter((project) => workspaceContains(project.workspacePath, cwd))
    .sort(byMostSpecificWorkspace);
  return matching[0] ?? null;
}

function resolveCandidateForPath(database, candidates, cwd) {
  const projectsById = new Map(database.listProjects().map((project) => [project.id, project]));
  const matching = candidates
    .filter((candidate) => workspaceContains(candidate.workspacePath, cwd))
    .sort((left, right) => {
      const workspaceDifference = byMostSpecificWorkspace(left, right);
      if (workspaceDifference !== 0) return workspaceDifference;
      const leftProject = projectsById.get(left.id);
      const rightProject = projectsById.get(right.id);
      if (Boolean(leftProject) !== Boolean(rightProject)) return leftProject ? -1 : 1;
      const issueDifference = Number(rightProject?.issueCount ?? 0) - Number(leftProject?.issueCount ?? 0);
      if (issueDifference !== 0) return issueDifference;
      return left.client.localeCompare(right.client) || left.name.localeCompare(right.name);
    });
  return matching[0] ?? null;
}

export async function resolveMaterializedProjectForPath(database, options, cwdValue) {
  const cwd = path.resolve(cwdValue);
  let matchCwd = cwd;
  try {
    matchCwd = await realpath(cwd);
  } catch {}
  const existingProject = resolveExistingProjectForPath(database, matchCwd);
  if (existingProject) return { cwd, project: existingProject, materialized: false, source: "database" };

  const candidates = await discoverDeviceProjectCandidates(options);
  const candidate = resolveCandidateForPath(database, candidates, matchCwd);
  if (candidate) {
    const existingById = database.getProject(candidate.id);
    if (existingById) {
      const project = existingById.workspacePath === candidate.workspacePath
        ? existingById
        : database.updateProjectWorkspace(candidate.id, candidate.workspacePath);
      return {
        cwd,
        project,
        materialized: false,
        source: candidate.client,
        candidate,
      };
    }
    const project = database.createProject({
      id: candidate.id,
      name: candidate.name,
      workspacePath: candidate.workspacePath,
    });
    return { cwd, project, materialized: true, source: candidate.client, candidate };
  }

  const fallback = database.getProject(DEFAULT_PROJECT_ID) ?? database.listProjects()[0] ?? null;
  return { cwd, project: fallback, materialized: false, source: "fallback" };
}
