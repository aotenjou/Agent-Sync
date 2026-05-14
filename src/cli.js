import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const TOOL_VERSION = "0.1.0";
const CONFIG_DIR = ".agent-sync";
const CONFIG_FILE = ".agent-sync/config.json";
const CACHE_FILE = ".agent-sync/last-scan.json";
const DEFAULT_AGENT_DIR = ".agent-sync-store";
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
    init: () => initCommand(gitRoot, options),
    status: () => statusCommand(gitRoot, options),
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
  git agent-sync init [--remote <url>] [--store <path>]
  git agent-sync status [--json]
  git agent-sync push
  git agent-sync pull
  git agent-sync scan [--json]
  git agent-sync restore <bundle-id> [--all]
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

function initCommand(gitRoot, options) {
  mkdirSync(join(gitRoot, CONFIG_DIR), { recursive: true });

  const projectName = basename(gitRoot);
  const storePath = normalizePath(resolve(gitRoot, options.store || DEFAULT_AGENT_DIR));
  const config = {
    version: 1,
    projectId: stableProjectId(gitRoot),
    projectName,
    projectRoot: gitRoot,
    storePath,
    remote: options.remote || null,
    agents: SUPPORTED_AGENTS,
    createdAt: new Date().toISOString()
  };

  ensureStoreRepo(storePath, config.remote);
  writeJson(join(gitRoot, CONFIG_FILE), config);
  writeGitignoreEntry(gitRoot, CONFIG_DIR);
  writeGitignoreEntry(gitRoot, DEFAULT_AGENT_DIR);

  console.log(`agent-sync initialized for ${projectName}`);
  console.log(`config: ${join(gitRoot, CONFIG_FILE)}`);
  console.log(`store:  ${storePath}`);
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

function pushCommand(gitRoot) {
  const config = readConfig(gitRoot);
  ensureStoreRepo(config.storePath, config.remote);
  const scan = scanSessions(gitRoot, config);
  writeJson(join(gitRoot, CACHE_FILE), scan);

  const copied = copyMatchesToStore(config, scan);
  writeManifest(config, scan);

  runGit(["add", "."], config.storePath);
  const diff = runGit(["diff", "--cached", "--quiet"], config.storePath, { allowFail: true });
  if (diff.status === 0) {
    console.log(`agent-sync: no sidecar changes (${copied.length} matched sessions).`);
  } else {
    runGit(["commit", "-m", `sync ${config.projectName} agent sessions`], config.storePath);
    console.log(`agent-sync: committed ${copied.length} matched session file(s).`);
  }

  if (config.remote) {
    runGit(["push", "-u", "origin", "main"], config.storePath);
    console.log("agent-sync: pushed sidecar repo.");
  }
}

function pullCommand(gitRoot) {
  const config = readConfig(gitRoot);
  ensureStoreRepo(config.storePath, config.remote);

  if (config.remote) {
    runGit(["pull", "--ff-only"], config.storePath);
    console.log("agent-sync: pulled sidecar repo.");
  } else {
    console.log("agent-sync: no remote configured; local sidecar store is already available.");
  }

  const manifestPath = join(config.storePath, "projects", config.projectId, "manifest.json");
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    console.log(`agent-sync: ${manifest.matches.length} session file(s) available for restore.`);
  }
}

function restoreCommand(gitRoot, args, options) {
  const config = readConfig(gitRoot);
  const bundleId = args[0];
  if (!bundleId && !options.all) {
    throw new Error("restore requires a bundle id, or pass --all");
  }

  const manifestPath = join(config.storePath, "projects", config.projectId, "manifest.json");
  if (!existsSync(manifestPath)) {
    throw new Error("no manifest found in sidecar store. Run pull first.");
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const matches = options.all ? manifest.matches : manifest.matches.filter((item) => item.bundleId === bundleId);
  if (!matches.length) {
    throw new Error(`no bundle found for "${bundleId}"`);
  }

  for (const match of matches) {
    const source = join(config.storePath, match.storeRelativePath);
    const target = expandHome(match.originalPath);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
    console.log(`restored ${match.agent}: ${target}`);
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
  }
  for (const [label, value] of checks) {
    console.log(`${label.padEnd(10)} ${value}`);
  }
}

function scanSessions(gitRoot, config) {
  const needles = unique([
    normalizePath(gitRoot),
    normalizePath(gitRoot).replaceAll("/", "\\"),
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
    .map((path) => ({ agent, path: normalizePath(path) }));
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

function writeManifest(config, scan) {
  const manifest = {
    ...scan,
    tool: "git-agent-sync",
    toolVersion: TOOL_VERSION,
    matches: scan.matches.map(({ absolutePath, ...item }) => item)
  };
  writeJson(join(config.storePath, "projects", config.projectId, "manifest.json"), manifest);
}

function printScan(scan, config) {
  console.log(`project: ${scan.projectName}`);
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

function readConfig(gitRoot) {
  const path = join(gitRoot, CONFIG_FILE);
  if (!existsSync(path)) {
    throw new Error("agent-sync is not initialized. Run \"git agent-sync init\" first.");
  }
  return JSON.parse(readFileSync(path, "utf8"));
}

function ensureStoreRepo(storePath, remote) {
  mkdirSync(storePath, { recursive: true });
  if (!existsSync(join(storePath, ".git"))) {
    runGit(["init", "-b", "main"], storePath);
  }
  runGit(["config", "user.name", "agent-sync"], storePath);
  runGit(["config", "user.email", "agent-sync@example.invalid"], storePath);
  const gitignore = join(storePath, ".gitignore");
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, "node_modules/\n.DS_Store\nThumbs.db\n");
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

function writeGitignoreEntry(gitRoot, entry) {
  const gitignore = join(gitRoot, ".gitignore");
  const line = `${entry}/`;
  const existing = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (!existing.split(/\r?\n/).includes(line)) {
    writeFileSync(gitignore, `${existing}${existing.endsWith("\n") || existing.length === 0 ? "" : "\n"}${line}\n`);
  }
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

function stableProjectId(gitRoot) {
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
