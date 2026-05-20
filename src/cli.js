import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const TOOL_VERSION = "0.1.0";
const CONFIG_DIR = ".agent-sync";
const CONFIG_FILE = ".agent-sync/config.json";
const CACHE_FILE = ".agent-sync/last-scan.json";
const DEFAULT_AGENT_DIR = ".agent-sync-store";
const DEFAULT_STORE_GITIGNORE = "node_modules/\n.DS_Store\nThumbs.db\n";
const DEFAULT_STORE_BRANCH = "main";
const BINDINGS_FILE = "bindings.jsonl";
const SUPPORTED_AGENTS = ["codex", "claude"];

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
    push: () => pushCommand(gitRoot, options),
    pull: () => pullCommand(gitRoot, options),
    scan: () => scanCommand(gitRoot, options),
    "install-hooks": () => installHooksCommand(gitRoot, options),
    restore: () => restoreCommand(gitRoot, args, options),
    doctor: () => doctorCommand(gitRoot)
  };

  const handler = commands[command];
  if (!handler) {
    throw new Error(`unknown command "${command}". Run "git agent-sync --help".`);
  }

  await handler();
}

function parseArgs(rawArgs) {
  const args = [];
  const options = {};
  let command = rawArgs[0];

  if (command?.startsWith("-")) {
    command = undefined;
  }

  for (let i = command ? 1 : 0; i < rawArgs.length; i += 1) {
    const arg = rawArgs[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--yes" || arg === "-y") {
      options.yes = true;
    } else if (arg === "--all") {
      options.all = true;
    } else if (arg === "--current") {
      options.current = true;
    } else if (arg === "--no-adapt") {
      options.noAdapt = true;
    } else if (arg.startsWith("--branch=")) {
      options.branch = arg.slice("--branch=".length);
    } else if (arg === "--branch") {
      options.branch = rawArgs[++i];
    } else if (arg.startsWith("--commit=")) {
      options.commit = arg.slice("--commit=".length);
    } else if (arg === "--commit") {
      options.commit = rawArgs[++i];
    } else if (arg.startsWith("--remote=")) {
      options.remote = arg.slice("--remote=".length);
    } else if (arg === "--remote") {
      options.remote = rawArgs[++i];
    } else if (arg.startsWith("--store=")) {
      options.store = arg.slice("--store=".length);
    } else if (arg === "--store") {
      options.store = rawArgs[++i];
    } else {
      args.push(arg);
    }
  }

  return { command, args, options };
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

function getGitRoot() {
  const result = runGit(["rev-parse", "--show-toplevel"], process.cwd(), { allowFail: true });
  if (result.status !== 0) {
    throw new Error("not inside a Git repository");
  }
  return normalizePath(result.stdout.trim());
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
  const config = readConfig(gitRoot);
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
  const config = readConfig(gitRoot);
  const selector = parseSelector(options, { requireSelector: true });
  const bindings = queryBindings(config, selector, gitRoot);

  if (options.json) {
    console.log(JSON.stringify(bindings, null, 2));
    return;
  }

  printBindings(bindings, selector);
}

function pushCommand(gitRoot) {
  const config = readConfig(gitRoot);
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
  const config = readConfig(gitRoot);
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

function restoreCommand(gitRoot, args, options) {
  const config = readConfig(gitRoot);
  const bundleId = args[0];
  const selector = parseSelector(options, { requireSelector: false });
  const restoreModes = [Boolean(bundleId), Boolean(options.all), Boolean(selector)].filter(Boolean).length;
  if (restoreModes !== 1) {
    throw new Error("restore requires exactly one of a bundle id, --all, --current, --branch, or --commit");
  }

  if (selector) {
    const matches = queryBindings(config, selector, gitRoot);
    if (!matches.length) {
      throw new Error(`no bindings found for ${formatSelector(selector)}`);
    }
    restoreMatches(config, matches, options);
    return;
  }

  const bundle = findProjectBundle(config);
  if (!bundle) {
    throw new Error("no manifest found in sidecar store. Run pull first.");
  }

  const manifest = readJson(bundle.manifestPath);
  const matches = options.all ? manifest.matches : manifest.matches.filter((item) => item.bundleId === bundleId);
  if (!matches.length) {
    throw new Error(`no bundle found for "${bundleId}"`);
  }

  restoreMatches(config, matches, options);
}

function restoreMatches(config, matches, options = {}) {
  for (const match of matches) {
    const source = join(config.storePath, match.storeRelativePath);
    const target = getRestoreTarget(match);
    mkdirSync(dirname(target), { recursive: true });
    const result = restoreSessionFile(config, match, source, target, options);
    const suffix = result.adapted
      ? ` (adapted ${result.fromPlatform} -> ${result.toPlatform}, shell ${result.shell})`
      : "";
    console.log(`restored ${match.agent}: ${target}${suffix}`);
  }
}

function installHooksCommand(gitRoot) {
  readConfig(gitRoot);
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
  const config = existsSync(join(gitRoot, CONFIG_FILE)) ? readConfig(gitRoot) : null;
  const checks = [
    ["git root", gitRoot],
    ["node", process.version],
    ["codex dir", existsSync(join(homedir(), ".codex")) ? "found" : "missing"],
    ["claude dir", existsSync(join(homedir(), ".claude")) ? "found" : "missing"],
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

function scanSessions(gitRoot, config) {
  const needles = unique([
    normalizePath(gitRoot),
    normalizePath(gitRoot).replaceAll("/", "\\"),
    normalizeRemoteUrl(getProjectRemote(gitRoot) || ""),
    basename(gitRoot),
    config.projectName
  ].filter(Boolean));

  const candidates = [
    ...findAgentFiles("codex", getAgentRoot("codex")),
    ...findAgentFiles("claude", getAgentRoot("claude"))
  ];

  const matches = candidates
    .map((candidate) => {
      const content = safeRead(candidate.path);
      const matchedBy = needles.filter((needle) => content.includes(needle));
      if (!matchedBy.length) {
        return null;
      }
      const hash = sha256(content);
      return {
        agent: candidate.agent,
        originalPath: shrinkHome(candidate.path),
        absolutePath: candidate.path,
        agentRelativePath: toSlash(relative(candidate.root, candidate.path)),
        bytes: Buffer.byteLength(content),
        sha256: hash,
        bundleId: `${candidate.agent}-${hash.slice(0, 12)}`,
        matchedBy: matchedBy.slice(0, 3),
        modifiedAt: statSync(candidate.path).mtime.toISOString()
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.originalPath.localeCompare(b.originalPath));

  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    projectId: config.projectId,
    projectIdentity: config.projectIdentity,
    projectName: config.projectName,
    projectRoot: gitRoot,
    candidates: candidates.length,
    matches
  };
}

function findAgentFiles(agent, root) {
  if (!existsSync(root)) {
    return [];
  }
  return walk(root)
    .filter((file) => file.endsWith(".jsonl") || file.endsWith(".json"))
    .map((path) => ({ agent, path: normalizePath(path), root: normalizePath(root) }));
}

function getAgentRoot(agent) {
  if (agent === "codex") {
    return process.env.AGENT_SYNC_CODEX_DIR || join(homedir(), ".codex", "sessions");
  }
  if (agent === "claude") {
    return process.env.AGENT_SYNC_CLAUDE_DIR || join(homedir(), ".claude", "projects");
  }
  throw new Error(`unsupported agent "${agent}"`);
}

function getRestoreTarget(match) {
  if (match.agentRelativePath) {
    return join(getAgentRoot(match.agent), match.agentRelativePath);
  }
  return expandHome(match.originalPath);
}

function restoreSessionFile(config, match, source, target, options) {
  if (options.noAdapt || !shouldAdaptSessionFile(match, source)) {
    copyFileSync(source, target);
    return { adapted: false };
  }

  const content = readFileSync(source, "utf8");
  const localPlatform = getLocalPlatform();
  const localShell = getLocalShell();
  const sourcePlatform = detectSessionPlatform(content);
  if (!sourcePlatform || getPlatformFamily(sourcePlatform) === getPlatformFamily(localPlatform)) {
    copyFileSync(source, target);
    return { adapted: false };
  }

  const result = adaptCodexSessionContent(content, {
    fromPlatform: sourcePlatform,
    toPlatform: localPlatform,
    shell: localShell,
    projectRoot: config.projectRoot
  });
  writeFileSync(target, result.content);
  return {
    adapted: result.adapted,
    fromPlatform: sourcePlatform,
    toPlatform: localPlatform,
    shell: localShell
  };
}

function shouldAdaptSessionFile(match, source) {
  return match.agent === "codex" && (source.endsWith(".jsonl") || source.endsWith(".json"));
}

function adaptCodexSessionContent(content, context) {
  let adapted = false;
  const lines = content.split(/\r?\n/);
  const hasTrailingNewline = content.endsWith("\n") || content.endsWith("\r\n");
  const adaptedLines = lines.map((line) => {
    if (!line) {
      return line;
    }
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      return line;
    }

    const lineAdapted = adaptCodexSessionItem(item, context);
    adapted = adapted || lineAdapted;
    return lineAdapted ? JSON.stringify(item) : line;
  });

  if (!hasTrailingNewline && adaptedLines.at(-1) === "") {
    adaptedLines.pop();
  }

  return { adapted, content: adaptedLines.join("\n") };
}

function adaptCodexSessionItem(item, context) {
  let adapted = false;
  const payload = item.payload;
  if (!payload || typeof payload !== "object") {
    return false;
  }

  if (item.type === "session_meta") {
    if (replacePayloadCwd(payload, context.projectRoot, context.fromPlatform)) {
      adapted = true;
    }
    payload.agentSyncAdapted = {
      version: 1,
      fromPlatform: context.fromPlatform,
      toPlatform: context.toPlatform,
      restoredAt: new Date().toISOString(),
      strategy: "safe-restore-environment",
      shell: context.shell,
      projectRoot: context.projectRoot
    };
    adapted = true;
  }

  if (item.type === "turn_context" && replacePayloadCwd(payload, context.projectRoot, context.fromPlatform)) {
    adapted = true;
  }

  if (item.type === "event_msg" && replacePayloadCwd(payload, context.projectRoot, context.fromPlatform)) {
    adapted = true;
  }

  if (item.type === "response_item" && payload.type === "function_call" && payload.name === "exec_command") {
    if (adaptExecCommandArguments(payload, context)) {
      adapted = true;
    }
  }

  return adapted;
}

function replacePayloadCwd(payload, projectRoot, sourcePlatform) {
  if (!isSourcePlatformPath(payload.cwd, sourcePlatform)) {
    return false;
  }
  payload.cwd = projectRoot;
  return true;
}

function adaptExecCommandArguments(payload, context) {
  if (typeof payload.arguments !== "string") {
    return false;
  }
  let args;
  try {
    args = JSON.parse(payload.arguments);
  } catch {
    return false;
  }
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return false;
  }

  let adapted = false;
  if (isSourcePlatformPath(args.workdir, context.fromPlatform)) {
    args.workdir = context.projectRoot;
    adapted = true;
  }
  if (isSourcePlatformShell(args.shell, context.fromPlatform)) {
    args.shell = context.shell;
    adapted = true;
  }

  if (adapted) {
    payload.arguments = JSON.stringify(args);
  }
  return adapted;
}

function detectSessionPlatform(content) {
  const lines = content.split(/\r?\n/);
  let sawWindows = false;
  let sawDarwin = false;
  let sawLinux = false;
  let sawPosix = false;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    let item;
    try {
      item = JSON.parse(line);
    } catch {
      continue;
    }

    const signals = collectPlatformSignals(item);
    sawWindows = sawWindows || signals.some((value) => isWindowsPath(value) || isWindowsShell(value));
    sawDarwin = sawDarwin || signals.some(isDarwinPath);
    sawLinux = sawLinux || signals.some(isLinuxPath);
    sawPosix = sawPosix || signals.some((value) => isPosixPath(value) || isPosixShell(value));
  }

  if (sawWindows) {
    return "win32";
  }
  if (sawDarwin && !sawLinux) {
    return "darwin";
  }
  if (sawLinux && !sawDarwin) {
    return "linux";
  }
  if (sawDarwin) {
    return "darwin";
  }
  if (sawLinux) {
    return "linux";
  }
  if (sawPosix) {
    return "posix";
  }
  return null;
}

function collectPlatformSignals(item) {
  const payload = item.payload;
  if (!payload || typeof payload !== "object") {
    return [];
  }

  const signals = [payload.cwd, payload.workdir, payload.shell, payload.command].filter(Boolean);
  if (item.type !== "response_item" || payload.type !== "function_call" || typeof payload.arguments !== "string") {
    return signals;
  }

  try {
    const args = JSON.parse(payload.arguments);
    if (args && typeof args === "object" && !Array.isArray(args)) {
      signals.push(args.cwd, args.workdir, args.shell);
    }
  } catch {
    return signals;
  }
  return signals.filter(Boolean);
}

function isSourcePlatformPath(value, sourcePlatform) {
  if (sourcePlatform === "win32") {
    return isWindowsPath(value);
  }
  if (sourcePlatform === "posix") {
    return isPosixPath(value);
  }
  return false;
}

function isSourcePlatformShell(value, sourcePlatform) {
  if (sourcePlatform === "win32") {
    return isWindowsShell(value);
  }
  if (sourcePlatform === "posix") {
    return isPosixShell(value);
  }
  return false;
}

function isWindowsPath(value) {
  return typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value);
}

function isPosixPath(value) {
  return isDarwinPath(value) || isLinuxPath(value);
}

function isDarwinPath(value) {
  return typeof value === "string" && /^\/Users\//.test(value);
}

function isLinuxPath(value) {
  return typeof value === "string" && (/^\/home\//.test(value) || /^\/workspace\//.test(value));
}

function isWindowsShell(value) {
  return typeof value === "string" && /(^|[\\/])(powershell|pwsh|cmd)(\.exe)?$/i.test(value);
}

function isPosixShell(value) {
  return typeof value === "string" && /(^|\/)(zsh|bash|sh|fish)$/.test(value);
}

function getLocalPlatform() {
  return process.platform;
}

function getLocalShell() {
  if (process.platform === "win32") {
    return process.env.ComSpec || "cmd.exe";
  }
  return process.env.SHELL || "/bin/sh";
}

function getPlatformFamily(platform) {
  return platform === "win32" ? "win32" : "posix";
}

function walk(root) {
  const files = [];
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files;
}

function copyMatchesToStore(config, scan) {
  const copied = [];
  const projectDir = join(config.storePath, "projects", config.projectId);
  for (const match of scan.matches) {
    const source = expandHome(match.originalPath);
    const storeRelativePath = join(
      "projects",
      config.projectId,
      match.agent,
      `${match.bundleId}${source.endsWith(".json") ? ".json" : ".jsonl"}`
    );
    const target = join(config.storePath, storeRelativePath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    match.storeRelativePath = toSlash(storeRelativePath);
    copied.push(match);
  }
  mkdirSync(projectDir, { recursive: true });
  return copied;
}

function writeManifest(config, scan, gitContext = null) {
  const manifest = {
    ...scan,
    tool: "git-agent-sync",
    toolVersion: TOOL_VERSION,
    projectIdentity: config.projectIdentity,
    projectRemote: getProjectRemote(config.projectRoot),
    gitContext,
    legacyProjectIds: config.legacyProjectIds || [],
    matches: scan.matches.map(({ absolutePath, ...item }) => item)
  };
  writeJson(join(config.storePath, "projects", config.projectId, "manifest.json"), manifest);
}

function writeBindings(config, matches, gitContext) {
  if (!matches.length) {
    return 0;
  }

  const existing = readBindings(config);
  const seen = new Set(existing.map(bindingKey));
  const additions = [];
  const boundAt = new Date().toISOString();

  for (const match of matches) {
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
      branch: gitContext.branch,
      headCommit: gitContext.headCommit,
      baseCommit: gitContext.baseCommit,
      dirty: gitContext.dirty
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

function queryBindings(config, selector, gitRoot) {
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

function parseSelector(options, { requireSelector }) {
  const selectors = [
    options.current ? { type: "current" } : null,
    options.branch !== undefined ? { type: "branch", value: options.branch } : null,
    options.commit !== undefined ? { type: "commit", value: options.commit } : null
  ].filter(Boolean);

  if (selectors.length > 1) {
    throw new Error("choose only one of --current, --branch, or --commit");
  }
  if (!selectors.length) {
    if (requireSelector) {
      throw new Error("list requires one of --current, --branch, or --commit");
    }
    return null;
  }

  const selector = selectors[0];
  if ((selector.type === "branch" || selector.type === "commit") && !selector.value) {
    throw new Error(`--${selector.type} requires a value`);
  }
  return selector;
}

function formatSelector(selector) {
  if (selector.type === "current") {
    return "current";
  }
  return `${selector.type} ${selector.value}`;
}

function readConfig(gitRoot) {
  const path = join(gitRoot, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new Error("agent-sync is not initialized. Run \"git agent-sync init\" first.");
  }
  const config = readJson(path);
  const projectName = config.projectName || basename(gitRoot);
  const projectIdentity = config.projectIdentity || getProjectIdentity(gitRoot);
  const legacyProjectId = legacyProjectIdForPath(gitRoot);
  const stableId = stableProjectId(projectName, projectIdentity);
  const configuredProjectId = config.projectId;
  const isLegacyConfig = !config.projectIdentity;
  const migrated = {
    ...config,
    projectName,
    projectRoot: gitRoot,
    storePath: normalizePath(resolve(gitRoot, config.storePath || DEFAULT_AGENT_DIR)),
    projectIdentity,
    projectId: isLegacyConfig ? stableId : config.projectId || stableId,
    legacyProjectIds: unique([...(config.legacyProjectIds || []), configuredProjectId, legacyProjectId].filter(Boolean))
  };
  adoptExistingProjectBundle(migrated);
  return migrated;
}

function writeConfig(gitRoot, config) {
  writeJson(join(gitRoot, CONFIG_FILE), config);
}

function ensureStoreRepo(storePath, remote) {
  mkdirSync(storePath, { recursive: true });
  if (!existsSync(join(storePath, ".git"))) {
    runGit(["init", "-b", DEFAULT_STORE_BRANCH], storePath);
  }
  runGit(["config", "user.name", "agent-sync"], storePath);
  runGit(["config", "user.email", "agent-sync@example.invalid"], storePath);
  const gitignore = join(storePath, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, DEFAULT_STORE_GITIGNORE);
  }
  if (remote) {
    const current = runGit(["remote", "get-url", "origin"], storePath, { allowFail: true });
    if (current.status !== 0) {
      runGit(["remote", "add", "origin", remote], storePath);
    } else if (current.stdout.trim() !== remote) {
      runGit(["remote", "set-url", "origin", remote], storePath);
    }
  }
}

function syncStoreFromRemote(storePath, remote) {
  if (!remote) {
    return false;
  }

  const remoteHead = runGit(["ls-remote", "--heads", "origin", DEFAULT_STORE_BRANCH], storePath, { allowFail: true });
  if (remoteHead.status !== 0 || !remoteHead.stdout.trim()) {
    return false;
  }

  runGit(["fetch", "origin", DEFAULT_STORE_BRANCH], storePath);
  const branch = runGit(["rev-parse", "--verify", DEFAULT_STORE_BRANCH], storePath, { allowFail: true });
  if (branch.status !== 0) {
    removeBootstrapGitignore(storePath);
    runGit(["checkout", "-B", DEFAULT_STORE_BRANCH, `origin/${DEFAULT_STORE_BRANCH}`], storePath);
    return true;
  }

  const upstream = runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], storePath, { allowFail: true });
  if (upstream.status !== 0 || upstream.stdout.trim() !== `origin/${DEFAULT_STORE_BRANCH}`) {
    runGit(["branch", "--set-upstream-to", `origin/${DEFAULT_STORE_BRANCH}`, DEFAULT_STORE_BRANCH], storePath);
  }
  runGit(["pull", "--ff-only"], storePath);
  return true;
}

function removeBootstrapGitignore(storePath) {
  const gitignore = join(storePath, ".gitignore");
  if (!existsSync(gitignore)) {
    return;
  }
  const status = runGit(["status", "--porcelain", "--", ".gitignore"], storePath, { allowFail: true });
  const content = readFileSync(gitignore, "utf8");
  if (status.stdout.trim() === "?? .gitignore" && content === DEFAULT_STORE_GITIGNORE) {
    unlinkSync(gitignore);
  }
}

function writeGitignoreEntry(gitRoot, entry) {
  const gitignore = join(gitRoot, ".gitignore");
  const line = `${entry}/`;
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (!existing.split(/\r?\n/).includes(line)) {
    writeFileSync(gitignore, `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${line}\n`);
  }
}

function adoptExistingProjectBundle(config) {
  const bundle = findProjectBundle(config);
  if (!bundle || bundle.projectId === config.projectId) {
    return;
  }
  config.projectId = bundle.projectId;
  config.legacyProjectIds = unique([...(config.legacyProjectIds || []), bundle.projectId]);
}

function findProjectBundle(config) {
  const projectsDir = join(config.storePath, "projects");
  const directIds = unique([config.projectId, ...(config.legacyProjectIds || [])].filter(Boolean));
  for (const projectId of directIds) {
    const manifestPath = join(projectsDir, projectId, "manifest.json");
    if (existsSync(manifestPath)) {
      return { projectId, manifestPath };
    }
  }

  if (!existsSync(projectsDir)) {
    return null;
  }

  const candidates = readdirSync(projectsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const manifestPath = join(projectsDir, entry.name, "manifest.json");
      if (!existsSync(manifestPath)) {
        return null;
      }
      const manifest = readJson(manifestPath);
      const score = scoreProjectManifest(config, manifest);
      return { projectId: entry.name, manifestPath, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.projectId.localeCompare(b.projectId));

  return candidates[0]?.score > 0 ? candidates[0] : null;
}

function scoreProjectManifest(config, manifest) {
  let score = 0;
  if (manifest.projectId && config.legacyProjectIds?.includes(manifest.projectId)) {
    score += 5;
  }
  if (manifest.legacyProjectIds?.includes(config.projectId)) {
    score += 5;
  }
  if (manifest.projectIdentity && manifest.projectIdentity === config.projectIdentity) {
    score += 4;
  }
  if (manifest.projectName && manifest.projectName === config.projectName) {
    score += 2;
  }
  const manifestRepo = normalizeRemoteUrl(manifest.projectRemote || manifest.remote || "");
  if (manifestRepo && `git:${manifestRepo}` === config.projectIdentity) {
    score += 4;
  }
  return score;
}

function getProjectIdentity(gitRoot) {
  const remote = getProjectRemote(gitRoot);
  if (remote) {
    return `git:${normalizeRemoteUrl(remote)}`;
  }
  return `name:${basename(gitRoot)}`;
}

function getProjectRemote(gitRoot) {
  const origin = runGit(["config", "--get", "remote.origin.url"], gitRoot, { allowFail: true });
  if (origin.status === 0 && origin.stdout.trim()) {
    return origin.stdout.trim();
  }
  const remotes = runGit(["remote"], gitRoot, { allowFail: true });
  if (remotes.status !== 0) {
    return null;
  }
  const firstRemote = remotes.stdout.split(/\r?\n/).find(Boolean);
  if (!firstRemote) {
    return null;
  }
  const url = runGit(["config", "--get", `remote.${firstRemote}.url`], gitRoot, { allowFail: true });
  return url.status === 0 && url.stdout.trim() ? url.stdout.trim() : null;
}

function getGitContext(gitRoot) {
  const headCommit = getHeadCommit(gitRoot);
  return {
    branch: getCurrentBranch(gitRoot),
    headCommit,
    baseCommit: headCommit,
    dirty: isWorktreeDirty(gitRoot)
  };
}

function getCurrentBranch(gitRoot) {
  const result = runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], gitRoot, { allowFail: true });
  return result.status === 0 && result.stdout.trim() ? result.stdout.trim() : null;
}

function getHeadCommit(gitRoot) {
  const result = runGit(["rev-parse", "HEAD"], gitRoot, { allowFail: true });
  if (result.status !== 0 || !result.stdout.trim()) {
    throw new Error("cannot read HEAD commit; commit the project at least once before syncing bindings");
  }
  return result.stdout.trim();
}

function isWorktreeDirty(gitRoot) {
  const result = runGit(["status", "--porcelain"], gitRoot, { allowFail: true });
  return result.status === 0 && Boolean(result.stdout.trim());
}

function normalizeRemoteUrl(remote) {
  const value = remote.trim();
  if (!value) {
    return "";
  }
  let normalized = value.replace(/^git\+/, "").replace(/\.git$/i, "");
  const ssh = normalized.match(/^git@([^:]+):(.+)$/);
  if (ssh) {
    normalized = `https://${ssh[1]}/${ssh[2]}`;
  }
  normalized = normalized.replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/");
  normalized = normalized.replace(/^https?:\/\//i, "").toLowerCase();
  return normalized;
}

function runGit(args, cwd, options = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0 && !options.allowFail) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result;
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function stableProjectId(projectName, projectIdentity) {
  return `${projectName}-${sha256(projectIdentity).slice(0, 10)}`;
}

function legacyProjectIdForPath(gitRoot) {
  return `${basename(gitRoot)}-${sha256(normalizePath(gitRoot)).slice(0, 10)}`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function unique(values) {
  return [...new Set(values)];
}

function normalizePath(path) {
  return resolve(path).replaceAll("\\", "/");
}

function toSlash(path) {
  return path.replaceAll("\\", "/");
}

function shrinkHome(path) {
  const home = normalizePath(homedir());
  const normalized = normalizePath(path);
  if (normalized.startsWith(`${home}/`)) {
    return `~/${relative(home, normalized).replaceAll(sep, "/")}`;
  }
  return normalized;
}

function expandHome(path) {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return join(homedir(), path.slice(2));
  }
  return path;
}
