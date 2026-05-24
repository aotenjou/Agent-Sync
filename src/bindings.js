import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BINDINGS_FILE } from "./constants.js";
import { getGitContext } from "./git.js";

export function writeBindings(config, matches, gitContext, syncRunId = createSyncRunId(gitContext)) {
  const codexMatches = matches.filter((match) => match.agent === "codex");
  if (!codexMatches.length) {
    return 0;
  }

  const existing = readBindings(config);
  const seen = new Set(existing.map(bindingKey));
  const additions = [];
  const syncedAt = new Date().toISOString();

  for (const match of codexMatches) {
    const binding = {
      version: 2,
      syncRunId,
      syncedAt,
      boundAt: syncedAt,
      projectId: config.projectId,
      projectIdentity: config.projectIdentity,
      projectRemote: config.projectIdentity?.startsWith("git:") ? config.projectIdentity.slice("git:".length) : null,
      projectBranch: gitContext.branch,
      projectCommit: gitContext.headCommit,
      projectBaseCommit: gitContext.baseCommit,
      projectDirty: gitContext.dirty,
      bundleId: match.bundleId,
      agent: "codex",
      sessionId: match.metadata?.sessionId || null,
      title: match.metadata?.title || null,
      sha256: match.sha256,
      storeRelativePath: match.storeRelativePath,
      originalPath: match.originalPath,
      agentRelativePath: match.agentRelativePath
    };
    const key = bindingKey(binding);
    if (!seen.has(key)) {
      seen.add(key);
      additions.push(binding);
    }
  }

  if (!additions.length) {
    return 0;
  }

  const bindingsPath = getBindingsPath(config);
  mkdirSync(dirname(bindingsPath), { recursive: true });
  const content = [...existing, ...additions].map((item) => JSON.stringify(item)).join("\n");
  writeFileSync(bindingsPath, `${content}\n`);
  return additions.length;
}

export function inspectBindings(config) {
  const bindingsPath = getBindingsPath(config);
  const result = {
    path: bindingsPath,
    exists: existsSync(bindingsPath),
    totalLines: 0,
    valid: 0,
    invalid: 0,
    bindings: [],
    errors: []
  };

  if (!result.exists) {
    return result;
  }

  const lines = readFileSync(bindingsPath, "utf8").split(/\r?\n/);
  lines.forEach((line, index) => {
    if (!line.trim()) {
      return;
    }
    result.totalLines += 1;
    let binding;
    try {
      binding = JSON.parse(line);
    } catch (error) {
      result.invalid += 1;
      result.errors.push(`line ${index + 1}: invalid JSON (${error.message})`);
      return;
    }

    const normalized = normalizeBinding(binding);
    if (!normalized) {
      result.invalid += 1;
      result.errors.push(`line ${index + 1}: missing required binding fields`);
      return;
    }

    result.valid += 1;
    result.bindings.push(normalized);
  });

  return result;
}

function readBindings(config) {
  return inspectBindings(config).bindings;
}

export function queryBindings(config, selector, gitRoot) {
  const bindings = readBindings(config).filter((binding) => binding.agent === "codex");
  if (selector.type === "latest") {
    return dedupeBindings(filterBindingsByLatestSync(bindings), "latest");
  }
  if (selector.type === "current") {
    const context = getGitContext(gitRoot);
    const commitMatches = filterBindingsByCommit(bindings, context.headCommit);
    if (commitMatches.length || !context.branch) {
      return dedupeBindings(commitMatches, "commit");
    }
    return dedupeBindings(filterBindingsByBranch(bindings, context.branch), "branch");
  }
  if (selector.type === "commit") {
    return dedupeBindings(filterBindingsByCommit(bindings, selector.value), "commit");
  }
  if (selector.type === "branch") {
    return dedupeBindings(filterBindingsByBranch(bindings, selector.value), "branch");
  }
  throw new Error(`unsupported selector "${selector.type}"`);
}

function filterBindingsByCommit(bindings, commit) {
  return bindings.filter((binding) => {
    return matchesCommit(binding.projectCommit, commit) ||
      matchesCommit(binding.projectBaseCommit, commit);
  });
}

function filterBindingsByBranch(bindings, branch) {
  return bindings.filter((binding) => binding.projectBranch === branch);
}

function filterBindingsByLatestSync(bindings) {
  const latest = bindings
    .map((binding) => binding.syncRunId || binding.syncedAt || binding.boundAt || "")
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!latest) {
    return [];
  }
  return bindings.filter((binding) => {
    return binding.syncRunId === latest || (!binding.syncRunId && (binding.syncedAt || binding.boundAt) === latest);
  });
}

function dedupeBindings(bindings, mode) {
  const seen = new Set();
  const result = [];
  for (const binding of bindings) {
    const key = mode === "commit"
      ? `${binding.sessionId || binding.bundleId}:${binding.projectCommit}:${binding.bundleId}`
      : `${binding.sessionId || binding.bundleId}:${binding.bundleId}`;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(binding);
    }
  }
  return result.sort((a, b) => {
    const time = String(b.syncedAt || b.boundAt || "").localeCompare(String(a.syncedAt || a.boundAt || ""));
    return time || a.bundleId.localeCompare(b.bundleId);
  });
}

function matchesCommit(value, query) {
  return Boolean(value && query && value.startsWith(query));
}

function bindingKey(binding) {
  return `${binding.syncRunId || ""}:${binding.bundleId}:${binding.projectCommit || ""}:${binding.projectBranch || ""}`;
}

export function getBindingsPath(config) {
  return join(config.storePath, "projects", config.projectId, BINDINGS_FILE);
}

function normalizeBinding(binding) {
  if (!binding || typeof binding !== "object") {
    return null;
  }
  const projectCommit = binding.projectCommit || null;
  const projectBaseCommit = binding.projectBaseCommit || projectCommit;
  const projectBranch = binding.projectBranch ?? null;
  const normalized = {
    version: binding.version || 2,
    syncRunId: binding.syncRunId || null,
    syncedAt: binding.syncedAt || binding.boundAt || null,
    boundAt: binding.boundAt || binding.syncedAt || null,
    projectId: binding.projectId || null,
    projectIdentity: binding.projectIdentity || null,
    projectRemote: binding.projectRemote || null,
    projectBranch,
    projectCommit,
    projectBaseCommit,
    projectDirty: Boolean(binding.projectDirty ?? binding.dirty),
    bundleId: binding.bundleId || null,
    agent: binding.agent || null,
    sessionId: binding.sessionId || null,
    title: binding.title || null,
    sha256: binding.sha256 || null,
    storeRelativePath: binding.storeRelativePath || null,
    originalPath: binding.originalPath || null,
    agentRelativePath: binding.agentRelativePath || null
  };
  if (!normalized.bundleId || !normalized.agent || !normalized.storeRelativePath) {
    return null;
  }
  if (normalized.agent !== "codex") {
    return null;
  }
  if (!normalized.projectCommit && !normalized.projectBaseCommit && !normalized.projectBranch) {
    return null;
  }
  return normalized;
}

function createSyncRunId(gitContext) {
  return `${new Date().toISOString()}:${gitContext.headCommit || "no-head"}`;
}
