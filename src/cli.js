import { existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { queryBindings, writeBindings } from "./bindings.js";
import {
  legacyProjectIdForPath,
  readConfig,
  stableProjectId,
  writeConfig,
  writeGitignoreEntry
} from "./config.js";
import { getGitContext, getGitRoot, getProjectIdentity, runGit } from "./git.js";
import { restoreCommand } from "./restore.js";
import {
  adoptExistingProjectBundle,
  copyMatchesToStore,
  ensureStoreRepo,
  findProjectBundle,
  syncStoreFromRemote,
  writeManifest
} from "./store.js";
import { normalizePath, readJson, unique, writeJson } from "./utils.js";

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
  git agent-sync restore <bundle-id>|--all|--current|--branch <name>|--commit <sha> [--no-adapt]
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

  printBindings(bindings, selector);
}

function pushCommand(gitRoot) {
  const config = readConfigWithBundle(gitRoot);
  ensureStoreRepo(config.storePath, config.remote);
  syncStoreFromRemote(config.storePath, config.remote);
  adoptExistingProjectBundle(config);
  writeConfig(gitRoot, config);
  const gitContext = getGitContext(gitRoot);
  const scan = scanSessions(gitRoot, config);
  writeJson(join(gitRoot, CACHE_FILE), scan);

  const copied = copyMatchesToStore(config, scan);
  writeManifest(config, scan, gitContext);
  const bindingsAdded = writeBindings(config, scan.matches, gitContext);

  runGit(["add", "."], config.storePath);
  const diff = runGit(["diff", "--cached", "--quiet"], config.storePath, { allowFail: true });
  if (diff.status === 0) {
    console.log(`agent-sync: no sidecar changes (${copied.length} matched sessions).`);
  } else {
    runGit(["commit", "-m", `sync ${config.projectName} agent sessions`], config.storePath);
    console.log(`agent-sync: committed ${copied.length} matched session file(s), ${bindingsAdded} new binding(s).`);
  }

  if (config.remote) {
    runGit(["push", "-u", "origin", DEFAULT_STORE_BRANCH], config.storePath);
    console.log("agent-sync: pushed sidecar repo.");
  }
}

function pullCommand(gitRoot) {
  const config = readConfigWithBundle(gitRoot);
  ensureStoreRepo(config.storePath, config.remote);

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

function doctorCommand(gitRoot) {
  const config = existsSync(join(gitRoot, CONFIG_FILE)) ? readConfigWithBundle(gitRoot) : null;
  const codexRoot = getAgentRoot("codex");
  const claudeRoot = getAgentRoot("claude");
  const checks = [
    ["git root", gitRoot],
    ["node", process.version],
    ["codex dir", existsSync(codexRoot) ? codexRoot : "missing"],
    ["claude dir", existsSync(claudeRoot) ? claudeRoot : "missing"],
    ["config", config ? join(gitRoot, CONFIG_FILE) : "missing"]
  ];
  if (config) {
    checks.push(["store", existsSync(config.storePath) ? config.storePath : "missing"]);
    checks.push(["remote", config.remote || "none"]);
    checks.push(["identity", config.projectIdentity]);
    checks.push(["project id", config.projectId]);
    checks.push(["legacy id", config.legacyProjectIds?.join(", ") || "none"]);
  }
  for (const [label, value] of checks) {
    console.log(`${label.padEnd(10)} ${value}`);
  }
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
  if (!scan.matches.length) {
    console.log("hint: sessions are matched when their file content mentions this repo path or repo name.");
    return;
  }
  for (const match of scan.matches) {
    console.log(`- ${match.bundleId} ${match.agent} ${match.originalPath} (${match.bytes} bytes)`);
  }
}

function printBindings(bindings, selector) {
  console.log(`selector: ${formatSelector(selector)}`);
  console.log(`bindings: ${bindings.length}`);
  for (const binding of bindings) {
    const branch = binding.branch || "detached";
    const dirty = binding.dirty ? "dirty" : "clean";
    console.log(`- ${binding.bundleId} ${binding.agent} ${binding.headCommit} ${branch} ${dirty} ${binding.originalPath}`);
  }
}
