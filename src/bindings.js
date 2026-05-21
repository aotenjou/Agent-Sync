import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BINDINGS_FILE } from "./constants.js";
import { getGitContext } from "./git.js";
import { getCodexBindingContext } from "./codex-session.js";

export function writeBindings(config, matches, gitContext) {
  if (!matches.length) {
    return 0;
  }

  const existing = readBindings(config);
  const seen = new Set(existing.map(bindingKey));
  const additions = [];
  const boundAt = new Date().toISOString();

  for (const match of matches) {
    const bindingContext = getMatchBindingContext(match, gitContext, config);
    const binding = {
      version: 1,
      boundAt,
      projectId: config.projectId,
      projectIdentity: config.projectIdentity,
      bundleId: match.bundleId,
      agent: match.agent,
      sha256: match.sha256,
      storeRelativePath: match.storeRelativePath,
      originalPath: match.originalPath,
      agentRelativePath: match.agentRelativePath,
      branch: bindingContext.branch,
      headCommit: bindingContext.headCommit,
      baseCommit: bindingContext.baseCommit,
      dirty: bindingContext.dirty
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

function readBindings(config) {
  const bindingsPath = getBindingsPath(config);
  if (!existsSync(bindingsPath)) {
    return [];
  }
  return readFileSync(bindingsPath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function queryBindings(config, selector, gitRoot) {
  const bindings = readBindings(config);
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
  return bindings.filter((binding) => matchesCommit(binding.headCommit, commit) || matchesCommit(binding.baseCommit, commit));
}

function filterBindingsByBranch(bindings, branch) {
  return bindings.filter((binding) => binding.branch === branch);
}

function dedupeBindings(bindings, mode) {
  const seen = new Set();
  const result = [];
  for (const binding of bindings) {
    const key = mode === "commit" ? `${binding.bundleId}:${binding.headCommit}` : bindingKey(binding);
    if (!seen.has(key)) {
      seen.add(key);
      result.push(binding);
    }
  }
  return result.sort((a, b) => {
    const time = String(b.boundAt || "").localeCompare(String(a.boundAt || ""));
    return time || a.bundleId.localeCompare(b.bundleId);
  });
}

function matchesCommit(value, query) {
  return Boolean(value && query && value.startsWith(query));
}

function bindingKey(binding) {
  return `${binding.bundleId}:${binding.headCommit}:${binding.branch || ""}`;
}

function getBindingsPath(config) {
  return join(config.storePath, "projects", config.projectId, BINDINGS_FILE);
}

function getMatchBindingContext(match, fallbackGitContext, config) {
  if (match.agent === "codex" && match.metadata) {
    return getCodexBindingContext(match.metadata, fallbackGitContext, config, match);
  }
  return fallbackGitContext;
}
