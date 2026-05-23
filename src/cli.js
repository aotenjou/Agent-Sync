import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  CACHE_FILE,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_AGENT_DIR,
  DEFAULT_STORE_BRANCH,
  SUPPORTED_AGENTS,
  TOOL_VERSION
} from "./constants.js";
import { parseArgs, parseSelector, formatSelector } from "./args.js";
import { getAgentRoot, scanSessions } from "./agents.js";
import { getBindingsPath, inspectBindings, queryBindings, writeBindings } from "./bindings.js";
import { extractCodexSessionMetadata, loadCodexSessionTitles } from "./codex-session.js";
import {
  legacyProjectIdForPath,
  readConfig,
  stableProjectId,
  writeConfig,
  writeGitignoreEntry
} from "./config.js";
import { getGitContext, getGitRoot, getGitValue, getProjectIdentity, runGit } from "./git.js";
import { restoreCommand } from "./restore.js";
import {
  adoptExistingProjectBundle,
  copyMatchesToStore,
  ensureStoreRepo,
  findProjectBundle,
  getManifestPath,
  pruneArchivedManifestEntries,
  pruneArchivedSidecarEntries,
  pruneForeignProjectSidecarEntries,
  syncStoreFromRemote,
  writeManifest
} from "./store.js";
import { normalizePath, readJson, unique, writeJson } from "./utils.js";
import { getCodexArchiveInfo, isArchivedCodexSessionPath, summarizeCodexArchiveInfo } from "./codex-archive.js";

export async function main(argv) {
  const { command, args, options } = parseArgs(argv.slice(2));

  if (!command || command === "help" || options.help) {
    printHelp();
    return;
  }

  if (command === "--version" || command === "version") {
    console.log(TOOL_VERSION);
    return;
  }

  const gitRoot = getGitRoot();
  const commands = {
    init: () => initCommand(gitRoot, args, options),
    status: () => statusCommand(gitRoot, options),
    list: () => listCommand(gitRoot, options),
    push: () => pushCommand(gitRoot),
    pull: () => pullCommand(gitRoot),
    scan: () => scanCommand(gitRoot, options),
    "install-hooks": () => installHooksCommand(gitRoot),
    restore: () => restoreCommand(gitRoot, args, options, readConfigWithBundle(gitRoot)),
    doctor: () => doctorCommand(gitRoot)
  };

  const handler = commands[command];
  if (!handler) {
    throw new Error(`unknown command "${command}". Run "git agent-sync --help".`);
  }

  await handler();
}

function printHelp() {
  console.log(`git-agent-sync ${TOOL_VERSION}

Usage:
  git agent-sync init [--remote <url>|<url>] [--store <path>]
  git agent-sync status [--json]
  git agent-sync list --current|--branch <name>|--commit <sha> [--json]
  git agent-sync push
  git agent-sync pull
  git agent-sync scan [--json]
  git agent-sync restore <bundle-id>|--all|--current|--branch <name>|--commit <sha> [index|--index <n>] [--no-adapt]
  git agent-sync install-hooks
  git agent-sync doctor

MVP behavior:
  - Detects Codex sessions in ~/.codex/sessions/**/*.jsonl
  - Detects Claude Code sessions in ~/.claude/projects/**/*.jsonl
  - Stores matched session files in a sidecar Git repo
  - Does not add agent sessions to your project Git history
`);
}

function initCommand(gitRoot, args, options) {
  mkdirSync(join(gitRoot, CONFIG_DIR), { recursive: true });

  const projectName = basename(gitRoot);
  const storePath = normalizePath(resolve(gitRoot, options.store || DEFAULT_AGENT_DIR));
  const remote = options.remote || args[0] || null;
  const projectIdentity = getProjectIdentity(gitRoot);
  const legacyProjectId = legacyProjectIdForPath(gitRoot);
  const config = {
    version: 1,
    projectId: stableProjectId(projectName, projectIdentity),
    projectIdentity,
    legacyProjectIds: unique([legacyProjectId].filter(Boolean)),
    projectName,
    projectRoot: gitRoot,
    storePath,
    remote,
    agents: SUPPORTED_AGENTS,
    createdAt: new Date().toISOString()
  };

  ensureStoreRepo(storePath, config.remote);
  adoptExistingProjectBundle(config);
  writeConfig(gitRoot, config);
  writeGitignoreEntry(gitRoot, CONFIG_DIR);
  writeGitignoreEntry(gitRoot, DEFAULT_AGENT_DIR);

  console.log(`agent-sync initialized for ${projectName}`);
  console.log(`config: ${join(gitRoot, CONFIG_FILE)}`);
  console.log(`store:  ${storePath}`);
  console.log(`project id: ${config.projectId}`);
  if (config.remote) {
    console.log(`remote: ${config.remote}`);
  }
}

function statusCommand(gitRoot, options) {
  const config = readConfigWithBundle(gitRoot);
  const scan = scanSessions(gitRoot, config);
  writeJson(join(gitRoot, CACHE_FILE), scan);

  if (options.json) {
    console.log(JSON.stringify(scan, null, 2));
    return;
  }

  printScan(scan, config);
}

function scanCommand(gitRoot, options) {
  return statusCommand(gitRoot, options);
}

function listCommand(gitRoot, options) {
  const config = readConfigWithBundle(gitRoot);
  const selector = parseSelector(options, { requireSelector: true });
  const bindings = queryBindings(config, selector, gitRoot);

  if (options.json) {
    console.log(JSON.stringify(bindings, null, 2));
    return;
  }

  printBindings(config, bindings, selector);
}

function pushCommand(gitRoot) {
  const config = readConfigWithBundle(gitRoot);
  ensureStoreRepo(config.storePath, config.remote);
  syncStoreFromRemote(config.storePath, config.remote);
  adoptExistingProjectBundle(config);
  writeConfig(gitRoot, config);
  const gitContext = getGitContext(gitRoot);
  const archiveInfo = getCodexArchiveInfo(getAgentRoot("codex"), { gitRoot });
  const scan = scanSessions(gitRoot, config, archiveInfo);
  writeJson(join(gitRoot, CACHE_FILE), scan);

  const pruned = pruneArchivedSidecarEntries(config, archiveInfo);
  const foreignPruned = pruneForeignProjectSidecarEntries(config);
  const copied = copyMatchesToStore(config, scan, archiveInfo);
  writeManifest(config, scan, gitContext);
  const bindingsAdded = writeBindings(config, scan.matches, gitContext);

  runGit(["add", "."], config.storePath);
  const diff = runGit(["diff", "--cached", "--quiet"], config.storePath, { allowFail: true });
  if (diff.status === 0) {
    console.log(`agent-sync: no sidecar changes (${copied.length} matched sessions, ${pruned.removedFiles} archived removed, ${foreignPruned.removedFiles} foreign removed).`);
  } else {
    runGit(["commit", "-m", `sync ${config.projectName} agent sessions`], config.storePath);
    console.log(`agent-sync: committed ${copied.length} matched session file(s), ${bindingsAdded} new binding(s), ${pruned.removedFiles} archived removed, ${foreignPruned.removedFiles} foreign removed.`);
  }

  if (config.remote) {
    runGit(["push", "-u", "origin", DEFAULT_STORE_BRANCH], config.storePath);
    console.log("agent-sync: pushed sidecar repo.");
  }
}

function pullCommand(gitRoot) {
  const config = readConfigWithBundle(gitRoot);
  ensureStoreRepo(config.storePath, config.remote);
  const archiveInfo = getCodexArchiveInfo(getAgentRoot("codex"), { gitRoot });

  if (config.remote) {
    const pulled = syncStoreFromRemote(config.storePath, config.remote);
    if (!pulled) {
      console.log(`agent-sync: remote has no ${DEFAULT_STORE_BRANCH} branch yet; push from a machine with sessions first.`);
    }
    console.log("agent-sync: pulled sidecar repo.");
    adoptExistingProjectBundle(config);
    writeConfig(gitRoot, config);
  } else {
    console.log("agent-sync: no remote configured; local sidecar store is already available.");
  }

  const pruned = pruneArchivedSidecarEntries(config, archiveInfo);
  const manifestPruned = pruneArchivedManifestEntries(config, archiveInfo);
  const foreignPruned = pruneForeignProjectSidecarEntries(config);
  if (pruned.removedFiles || pruned.removedBindings) {
    console.log(`agent-sync: pruned ${pruned.removedFiles} archived file(s) and ${pruned.removedBindings} archived binding(s).`);
  }
  if (manifestPruned.removed) {
    console.log(`agent-sync: pruned ${manifestPruned.removed} archived manifest entr${manifestPruned.removed === 1 ? "y" : "ies"}.`);
  }
  if (foreignPruned.removedFiles || foreignPruned.removedBindings || foreignPruned.removedManifestEntries) {
    console.log(`agent-sync: pruned ${foreignPruned.removedFiles} foreign project file(s), ${foreignPruned.removedBindings} binding(s), and ${foreignPruned.removedManifestEntries} manifest entr${foreignPruned.removedManifestEntries === 1 ? "y" : "ies"}.`);
  }
  commitStoreCleanup(config, pruned, manifestPruned, foreignPruned);

  const bundle = findProjectBundle(config);
  if (bundle) {
    const manifest = readJson(bundle.manifestPath);
    console.log(`agent-sync: ${manifest.matches.length} session file(s) available for restore.`);
    if (bundle.projectId !== config.projectId) {
      console.log(`agent-sync: using compatible project bundle ${bundle.projectId}.`);
    }
  }
}

function installHooksCommand(gitRoot) {
  readConfigWithBundle(gitRoot);
  const hooksDir = join(gitRoot, ".git", "hooks");
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, "pre-push");
  const hook = `#!/bin/sh
# Installed by git-agent-sync.
if command -v git-agent-sync >/dev/null 2>&1; then
  git-agent-sync push
elif command -v agent-sync >/dev/null 2>&1; then
  agent-sync push
else
  echo "agent-sync: git-agent-sync not found; skipping session sync" >&2
fi
`;
  writeFileSync(hookPath, hook, { mode: 0o755 });
  console.log(`agent-sync: installed pre-push hook at ${hookPath}`);
}

function commitStoreCleanup(config, archivedPruned, manifestPruned, foreignPruned) {
  const changed = Boolean(
    archivedPruned.removedFiles ||
    archivedPruned.removedBindings ||
    manifestPruned.removed ||
    foreignPruned.removedFiles ||
    foreignPruned.removedBindings ||
    foreignPruned.removedManifestEntries
  );
  if (!changed) {
    return;
  }

  runGit(["add", "."], config.storePath);
  const diff = runGit(["diff", "--cached", "--quiet"], config.storePath, { allowFail: true });
  if (diff.status !== 0) {
    runGit(["commit", "-m", `prune ${config.projectName} sidecar sessions`], config.storePath);
    console.log("agent-sync: committed sidecar cleanup locally; run push to publish it.");
  }
}

function doctorCommand(gitRoot) {
  const config = existsSync(join(gitRoot, CONFIG_FILE)) ? readConfigWithBundle(gitRoot) : null;
  const codexRoot = getAgentRoot("codex");
  const claudeRoot = getAgentRoot("claude");
  const codexArchive = getCodexArchiveInfo(codexRoot, config ? { gitRoot } : {});
  const checks = [];
  addCheck(checks, "git root", "ok", gitRoot);
  addCheck(checks, "node", "ok", process.version);
  addCheck(checks, "codex dir", existsSync(codexRoot) ? "ok" : "warn", existsSync(codexRoot) ? codexRoot : "missing");
  addCheck(checks, "codex archive", codexArchive.stateStatus === "ok" ? "ok" : "warn", describeCodexArchive(codexArchive));
  addCheck(checks, "claude dir", existsSync(claudeRoot) ? "ok" : "warn", existsSync(claudeRoot) ? claudeRoot : "missing");
  addCheck(checks, "config", config ? "ok" : "fail", config ? join(gitRoot, CONFIG_FILE) : "missing");
  if (config) {
    addCheck(checks, "store", existsSync(config.storePath) ? "ok" : "fail", existsSync(config.storePath) ? config.storePath : "missing");
    addCheck(checks, "remote", checkRemote(config), config.remote || "none");
    addCheck(checks, "store git", checkStoreGit(config), describeStoreGit(config));
    addCheck(checks, "manifest", checkManifest(config), describeManifest(config));
    addCheck(checks, "bindings", checkBindings(config), describeBindings(config));
    addCheck(checks, "codex files", "ok", `${countAgentFiles(codexRoot, codexArchive)} file(s) visible, ${codexArchive.archivedPaths.size} archived skipped`);
    addCheck(checks, "claude files", "ok", `${countAgentFiles(claudeRoot)} file(s)`);
    addCheck(checks, "identity", "ok", config.projectIdentity);
    addCheck(checks, "project id", "ok", config.projectId);
    addCheck(checks, "legacy id", "ok", config.legacyProjectIds?.join(", ") || "none");
  }
  for (const check of checks) {
    console.log(`${check.status.padEnd(5)} ${check.label.padEnd(12)} ${check.value}`);
  }
}

function addCheck(checks, label, status, value) {
  checks.push({ label, status, value });
}

function checkRemote(config) {
  if (!config.remote) {
    return "warn";
  }
  if (!existsSync(join(config.storePath, ".git"))) {
    return "fail";
  }
  const result = runGit(["ls-remote", "--heads", "origin"], config.storePath, { allowFail: true });
  return result.status === 0 ? "ok" : "fail";
}

function checkStoreGit(config) {
  if (!existsSync(join(config.storePath, ".git"))) {
    return "fail";
  }
  const branch = getGitValue(["rev-parse", "--abbrev-ref", "HEAD"], config.storePath);
  return branch === DEFAULT_STORE_BRANCH ? "ok" : "warn";
}

function describeStoreGit(config) {
  if (!existsSync(join(config.storePath, ".git"))) {
    return "missing .git";
  }
  const branch = getGitValue(["rev-parse", "--abbrev-ref", "HEAD"], config.storePath) || "unknown";
  const upstream = getGitValue(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], config.storePath) || "no upstream";
  return `${branch}, ${upstream}`;
}

function checkManifest(config) {
  const path = getManifestPath(config);
  if (!existsSync(path)) {
    return "warn";
  }
  try {
    const manifest = readJson(path);
    return Array.isArray(manifest.matches) ? "ok" : "fail";
  } catch {
    return "fail";
  }
}

function describeManifest(config) {
  const path = getManifestPath(config);
  if (!existsSync(path)) {
    return "missing";
  }
  try {
    const manifest = readJson(path);
    const count = Array.isArray(manifest.matches) ? manifest.matches.length : 0;
    return `${count} match(es)`;
  } catch (error) {
    return `invalid JSON (${error.message})`;
  }
}

function checkBindings(config) {
  const summary = inspectBindings(config);
  if (!summary.exists) {
    return "warn";
  }
  return summary.invalid ? "warn" : "ok";
}

function describeBindings(config) {
  const summary = inspectBindings(config);
  if (!summary.exists) {
    return `missing (${getBindingsPath(config)})`;
  }
  const base = `${summary.valid} valid, ${summary.invalid} invalid`;
  return summary.errors.length ? `${base}; ${summary.errors.slice(0, 2).join("; ")}` : base;
}

function describeCodexArchive(info) {
  const summary = summarizeCodexArchiveInfo(info);
  return `${summary.archivedCount} archived session(s), state ${summary.stateStatus}, ${summary.sourceSummary}, cache ${summary.cacheStatus}`;
}

function countAgentFiles(root, archiveInfo = null) {
  if (!existsSync(root)) {
    return 0;
  }
  const stack = [root];
  let count = 0;
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(path);
      } else if (entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".json"))) {
        if (archiveInfo && isArchivedCodexSessionPath(path, archiveInfo)) {
          continue;
        }
        count += 1;
      }
    }
  }
  return count;
}

function readConfigWithBundle(gitRoot) {
  const config = readConfig(gitRoot);
  adoptExistingProjectBundle(config);
  return config;
}

function printScan(scan, config) {
  console.log(`project: ${scan.projectName}`);
  console.log(`id:      ${config.projectId}`);
  console.log(`store:   ${config.storePath}`);
  console.log(`scan:    ${scan.candidates} candidate file(s), ${scan.matches.length} match(es)`);
  if (scan.cache) {
    console.log(`cache:   ${scan.cache.cached} reused, ${scan.cache.refreshed} refreshed`);
  }
  if (!scan.matches.length) {
    console.log("hint: sessions are matched when their file content mentions this repo path or repo name.");
    return;
  }
  for (const match of scan.matches) {
    console.log(`- ${match.bundleId} ${match.agent} ${match.originalPath} (${match.bytes} bytes)`);
  }
}

function printBindings(config, bindings, selector) {
  const titles = loadCodexSessionTitles();
  console.log(`selector: ${formatSelector(selector)}`);
  console.log(`bindings: ${bindings.length}`);
  if (bindings.length) {
    console.log(`restore:  git agent-sync restore ${formatSelectorForCommand(selector)} <index>`);
  }
  bindings.forEach((binding, index) => {
    const branch = binding.branch || "detached";
    const dirty = binding.dirty ? "dirty" : "clean";
    const title = getBindingTitle(config, binding, titles);
    console.log(`${index + 1}. ${title}`);
    console.log(`   ${binding.bundleId} ${binding.agent} ${binding.headCommit || "no-commit"} ${branch} ${dirty}`);
    console.log(`   ${binding.originalPath}`);
  });
}

function getBindingTitle(config, binding, titles) {
  if (binding.title) {
    return binding.title;
  }
  if (binding.agent === "codex") {
    const title = titles.get(binding.sessionId) || getStoredSessionTitle(config, binding);
    if (title) {
      return title;
    }
  }
  const storedTitle = getStoredSessionTitle(config, binding);
  if (storedTitle) {
    return storedTitle;
  }
  return binding.bundleId;
}

function formatSelectorForCommand(selector) {
  if (selector.type === "current") {
    return "--current";
  }
  return `--${selector.type} ${selector.value}`;
}

function getStoredSessionTitle(config, binding) {
  if (!binding.storeRelativePath) {
    return null;
  }
  try {
    const content = readFileSync(join(config.storePath, binding.storeRelativePath), "utf8");
    if (binding.agent === "codex") {
      return extractCodexSessionMetadata(content).title || null;
    }
    if (binding.agent === "claude") {
      return getClaudeSessionTitle(content);
    }
  } catch {
    return null;
  }
  return null;
}

function getClaudeSessionTitle(content) {
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = JSON.parse(line);
      const title = getClaudeItemTitle(item);
      if (title) {
        return title;
      }
    } catch {
      // Ignore partial JSONL lines.
    }
  }
  return null;
}

function getClaudeItemTitle(item) {
  const text = item?.message?.content
    ?.map((entry) => typeof entry?.text === "string" ? entry.text : "")
    .find((value) => value && !isLowSignalTitle(value));
  return text ? compactTitle(text) : null;
}

function isLowSignalTitle(value) {
  const text = value.trim();
  return text.startsWith("<ide_") || text.startsWith("Base directory for this skill:");
}

function compactTitle(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 96);
}
