import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256, normalizePath, unique } from "./utils.js";
import { normalizeRemoteUrl } from "./git.js";

export function extractCodexSessionMetadata(content) {
  const metadata = {
    sessionId: null,
    title: null,
    projectRoots: [],
    workdirs: [],
    gitContexts: []
  };
  const projectRoots = new Set();
  const workdirs = new Set();
  const threadTitleCandidates = [];
  let firstUserMessageTitle = null;

  for (const item of readJsonlItems(content)) {
    const payload = item.payload;
    if (!payload || typeof payload !== "object") {
      continue;
    }

    if (item.type === "session_meta") {
      metadata.sessionId ||= payload.id || null;
      threadTitleCandidates.push(payload.thread_name, payload.title, payload.name);
      addPath(projectRoots, payload.cwd);
      if (payload.git && typeof payload.git === "object") {
        metadata.gitContexts.push({
          branch: payload.git.branch || null,
          commit: payload.git.commit_hash || null,
          repositoryUrl: payload.git.repository_url || null,
          cwd: typeof payload.cwd === "string" ? normalizeSessionPathReference(payload.cwd) : null
        });
      }
    } else if (item.type === "turn_context") {
      addPath(projectRoots, payload.cwd);
    } else if (item.type === "event_msg" && payload.type === "thread_name_updated") {
      threadTitleCandidates.push(payload.thread_name);
    } else if (item.type === "response_item" && payload.type === "message") {
      firstUserMessageTitle ||= getMessageTitle(payload);
    } else if (item.type === "response_item" && payload.type === "function_call" && payload.name === "exec_command") {
      const args = parseArguments(payload.arguments);
      addPath(workdirs, args?.workdir);
    }
  }

  metadata.projectRoots = [...projectRoots];
  metadata.workdirs = [...workdirs];
  metadata.title = chooseLatestTitle(threadTitleCandidates) || firstUserMessageTitle;
  return metadata;
}

export function loadCodexSessionTitles(codexRoot = join(homedir(), ".codex")) {
  const codexHome = resolveCodexHome(codexRoot);
  const titles = loadCodexStateTitles(codexHome);
  const indexPath = join(codexHome, "session_index.jsonl");
  if (!existsSync(indexPath)) {
    return titles;
  }

  for (const line of readFileSync(indexPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = JSON.parse(line);
      const title = cleanTitle(item.thread_name);
      if (item.id && title && !titles.has(item.id)) {
        titles.set(item.id, title);
      }
    } catch {
      // Ignore partial index lines.
    }
  }
  return titles;
}

export function cleanCodexTitle(value) {
  return cleanTitle(value);
}

export function resolveCodexHome(codexRoot = join(homedir(), ".codex")) {
  const normalized = normalizePath(codexRoot);
  const leaf = basename(normalized);
  if (leaf === "sessions" || leaf === "archived_sessions") {
    return dirname(normalized);
  }
  if (existsSync(join(normalized, "state_5.sqlite")) || existsSync(join(normalized, "session_index.jsonl"))) {
    return normalized;
  }
  const parent = dirname(normalized);
  if (existsSync(join(parent, "state_5.sqlite")) || existsSync(join(parent, "session_index.jsonl"))) {
    return parent;
  }
  return normalized;
}

function loadCodexStateTitles(codexHome) {
  const titles = new Map();
  const statePath = join(codexHome, "state_5.sqlite");
  if (!existsSync(statePath)) {
    return titles;
  }

  const result = spawnSync("python3", ["-", statePath], {
    input: `import json, sqlite3, sys
path = sys.argv[1]
try:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    cur = con.cursor()
    cols = {row[1] for row in cur.execute("pragma table_info(threads)")}
    wanted = [col for col in ("id", "title", "preview", "first_user_message") if col in cols]
    if "id" in wanted:
        query = "select " + ", ".join(wanted) + " from threads"
        for row in cur.execute(query):
            print(json.dumps(dict(zip(wanted, row)), ensure_ascii=False))
except Exception:
    pass
`,
    encoding: "utf8"
  });
  if (result.status !== 0 || !result.stdout) {
    return titles;
  }
  for (const line of result.stdout.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const item = JSON.parse(line);
      const title = chooseFirstTitle([item.title, item.preview, item.first_user_message]);
      if (item.id && title) {
        titles.set(item.id, title);
      }
    } catch {
      // Ignore partial SQLite title rows.
    }
  }
  return titles;
}

export function getCodexProjectMatch(metadata, content, config, projectRemote = "") {
  const remoteMatch = matchCodexRemote(metadata, projectRemote);
  if (hasKnownDifferentRemote(metadata, projectRemote)) {
    return { matched: false, reason: "codex:foreign-git" };
  }

  const pathOwnership = getCodexPathOwnership(metadata, config);
  if (pathOwnership.foreign.length) {
    return {
      matched: false,
      reason: pathOwnership.matched.length ? "codex:mixed-cwd" : "codex:foreign-cwd"
    };
  }

  if (remoteMatch) {
    return remoteMatch;
  }

  if (pathOwnership.matched.length) {
    return { matched: true, matchedBy: ["codex:cwd"] };
  }

  if (hasStructuredProjectIdentity(metadata)) {
    return { matched: false, reason: "codex:structured-no-match" };
  }

  return { matched: false, reason: "codex:missing-project-metadata" };
}

export function getCodexContentProjectMatch(content, config, projectRemote = getConfigRemoteIdentity(config)) {
  const metadata = extractCodexSessionMetadata(content);
  return getCodexProjectMatch(metadata, content, config, projectRemote);
}

export function isCodexSessionContentForProject(content, config, projectRemote = getConfigRemoteIdentity(config)) {
  return getCodexContentProjectMatch(content, config, projectRemote).matched;
}

export function isCodexSessionForProject(metadata, config) {
  return getCodexProjectMatch(metadata, "", config, getConfigRemoteIdentity(config)).matched;
}

function getConfigRemoteIdentity(config) {
  return config?.projectIdentity?.startsWith("git:") ? config.projectIdentity.slice("git:".length) : "";
}

function isProjectPathReference(value, config) {
  const path = normalizeSessionPathReference(value).toLowerCase();
  const projectRoot = normalizeSessionPathReference(config.projectRoot).toLowerCase();
  if (path === projectRoot || path.startsWith(`${projectRoot}/`)) {
    return true;
  }
  const projectName = config.projectName.toLowerCase();
  return path.split("/").some((part) => cleanPathSegment(part).toLowerCase() === projectName);
}

function matchCodexRemote(metadata, projectRemote) {
  if (!projectRemote) {
    return null;
  }
  const metadataRemotes = getMetadataRemotes(metadata);
  return metadataRemotes.includes(projectRemote)
    ? { matched: true, matchedBy: [`git:${projectRemote}`] }
    : null;
}

function hasKnownDifferentRemote(metadata, projectRemote) {
  if (!projectRemote) {
    return false;
  }
  const metadataRemotes = getMetadataRemotes(metadata);
  return metadataRemotes.length > 0 && !metadataRemotes.includes(projectRemote);
}

function getMetadataRemotes(metadata) {
  return unique(
    (metadata.gitContexts || [])
      .map((item) => normalizeRemoteUrl(item.repositoryUrl || ""))
      .filter(Boolean)
  );
}

function hasStructuredProjectIdentity(metadata) {
  return getMetadataRemotes(metadata).length > 0 || getStructuredProjectPaths(metadata).length > 0;
}

function getStructuredProjectPaths(metadata) {
  return unique([...(metadata.projectRoots || []), ...(metadata.workdirs || [])].filter(Boolean));
}

function getCodexPathOwnership(metadata, config) {
  const matched = [];
  const foreign = [];
  for (const path of getStructuredProjectPaths(metadata)) {
    if (isProjectPathReference(path, config)) {
      matched.push(path);
    } else {
      foreign.push(path);
    }
  }
  return { matched, foreign };
}

function getMessageTitle(payload) {
  if (payload.role !== "user") {
    return null;
  }
  const text = getMessageText(payload);
  return cleanTitle(text);
}

function chooseFirstTitle(values) {
  for (const value of values) {
    const title = cleanTitle(value);
    if (title) {
      return title;
    }
  }
  return null;
}

function chooseLatestTitle(values) {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const title = cleanTitle(values[i]);
    if (title) {
      return title;
    }
  }
  return null;
}

function getMessageText(payload) {
  if (typeof payload.content === "string") {
    return payload.content;
  }
  if (!Array.isArray(payload.content)) {
    return "";
  }
  return payload.content
    .map((item) => item?.text || item?.input_text || "")
    .filter(Boolean)
    .join("\n");
}

function isLowSignalTitle(value) {
  const text = value.trim();
  return !text ||
    text.startsWith("<environment_context>") ||
    text.startsWith("</environment_context>") ||
    text.startsWith("<ide_") ||
    text.startsWith("<collaboration_mode>") ||
    text.startsWith("<skills_instructions>") ||
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<permissions instructions>") ||
    text.startsWith("Knowledge cutoff:") ||
    text.startsWith("You are Codex") ||
    text.includes("Traceback (most recent call last)") ||
    /^\([^)]+\)\s+[A-Z]:[\\/].*>/.test(text) ||
    /^[A-Z]:[\\/].*>/.test(text);
}

function cleanTitle(value) {
  if (typeof value !== "string") {
    return null;
  }
  const text = value.trim();
  if (!text) {
    return null;
  }
  if (!isLowSignalTitle(text)) {
    return compactTitle(text);
  }
  const recovered = recoverPromptFromLowSignalTitle(text);
  return recovered ? compactTitle(recovered) : null;
}

function recoverPromptFromLowSignalTitle(value) {
  const lines = value
    .replace(/\\r\\n|\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (isLowSignalTitleLine(line)) {
      continue;
    }
    if (/[\u4e00-\u9fff]/.test(line) || /[a-zA-Z]{3,}/.test(line)) {
      return line;
    }
  }
  return null;
}

function isLowSignalTitleLine(line) {
  return line.startsWith("<environment_context") ||
    line.startsWith("</environment_context") ||
    line.startsWith("<ide_") ||
    line.startsWith("<collaboration_mode>") ||
    line.startsWith("<skills_instructions>") ||
    line.startsWith("<permissions instructions>") ||
    line.startsWith("# AGENTS.md instructions") ||
    line.startsWith("Knowledge cutoff:") ||
    line.startsWith("You are Codex") ||
    line.startsWith("File ") ||
    line.startsWith("Traceback ") ||
    line.startsWith("Error code:") ||
    line.startsWith("openai.") ||
    line.startsWith("{'error':") ||
    /^\^+$/.test(line) ||
    /^\.*<\d+ lines>\.*$/.test(line) ||
    /^\([^)]+\)\s+[A-Z]:[\\/].*>/.test(line) ||
    /^[A-Z]:[\\/].*>/.test(line) ||
    /^[~\w.]+\(.*\)/.test(line) ||
    /^\([^)]+\)\s+.*(?:➜|\$|#|>)\s+/.test(line);
}

function compactTitle(value) {
  return value.replace(/\s+/g, " ").trim().slice(0, 96);
}

export function adaptCodexSessionContent(content, config) {
  const localPlatform = getLocalPlatform();
  const localShell = getLocalShell();
  const sourcePlatform = detectSessionPlatform(content);
  const metadata = extractCodexSessionMetadata(content);
  const pathMappings = inferProjectPathMappings(content, config, metadata);
  const shouldAdaptEnvironment = sourcePlatform && getPlatformFamily(sourcePlatform) !== getPlatformFamily(localPlatform);

  if (!shouldAdaptEnvironment && !pathMappings.length) {
    return { adapted: false, content };
  }

  const context = {
    fromPlatform: sourcePlatform || localPlatform,
    toPlatform: localPlatform,
    shell: localShell,
    projectRoot: config.projectRoot,
    pathMappings,
    shouldAdaptEnvironment
  };

  const result = rewriteCodexJsonl(content, context);
  return {
    ...result,
    fromPlatform: context.fromPlatform,
    toPlatform: context.toPlatform,
    shell: context.shell,
    pathMappings
  };
}

function rewriteCodexJsonl(content, context) {
  let adapted = false;
  const adaptedLines = content.split(/\r?\n/).map((line) => {
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

  return { adapted, content: adaptedLines.join("\n") };
}

function adaptCodexSessionItem(item, context) {
  let adapted = false;
  const payload = item.payload;
  if (payload && typeof payload === "object" && item.type === "response_item" && payload.type === "function_call" && payload.name === "exec_command") {
    if (adaptExecCommandArguments(payload, context)) {
      adapted = true;
    }
  }

  if (replaceProjectPathReferences(item, context.pathMappings)) {
    adapted = true;
  }

  if (!payload || typeof payload !== "object") {
    return adapted;
  }

  if (item.type === "session_meta") {
    if (context.shouldAdaptEnvironment && replacePayloadCwd(payload, context.projectRoot, context.fromPlatform)) {
      adapted = true;
    }
    payload.agentSyncAdapted = {
      version: 1,
      fromPlatform: context.fromPlatform,
      toPlatform: context.toPlatform,
      restoredAt: new Date().toISOString(),
      strategy: "safe-restore-environment-and-paths",
      shell: context.shell,
      projectRoot: context.projectRoot,
      projectPathMappingCount: context.pathMappings.length,
      projectPathMappingHashes: context.pathMappings.map((mapping) => sha256(mapping.source).slice(0, 12))
    };
    adapted = true;
  }

  if (context.shouldAdaptEnvironment && item.type === "turn_context" && replacePayloadCwd(payload, context.projectRoot, context.fromPlatform)) {
    adapted = true;
  }

  if (context.shouldAdaptEnvironment && item.type === "event_msg" && replacePayloadCwd(payload, context.projectRoot, context.fromPlatform)) {
    adapted = true;
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
  const args = parseArguments(payload.arguments);
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return false;
  }

  let adapted = false;
  if (context.shouldAdaptEnvironment && isSourcePlatformPath(args.workdir, context.fromPlatform)) {
    args.workdir = context.projectRoot;
    adapted = true;
  }
  if (context.shouldAdaptEnvironment && isSourcePlatformShell(args.shell, context.fromPlatform)) {
    args.shell = context.shell;
    adapted = true;
  }
  if (replaceProjectPathReferences(args, context.pathMappings)) {
    adapted = true;
  }

  if (adapted) {
    payload.arguments = JSON.stringify(args);
  }
  return adapted;
}

function inferProjectPathMappings(content, config, metadata = extractCodexSessionMetadata(content)) {
  const roots = new Set();
  const structuredRoots = new Set([...metadata.projectRoots, ...metadata.workdirs]);
  for (const root of structuredRoots) {
    const projectRoot = truncatePathAtProjectName(root, config.projectName);
    if (projectRoot) {
      roots.add(projectRoot);
    }
  }

  if (!roots.size) {
    for (const item of readJsonlItems(content)) {
      collectProjectPathRoots(item, config.projectName, roots);
    }
  }

  const target = normalizePath(config.projectRoot);
  return [...roots]
    .map((source) => buildProjectPathMapping(source, target))
    .filter(Boolean)
    .sort((a, b) => b.source.length - a.source.length);
}

function collectProjectPathRoots(value, projectName, roots) {
  if (typeof value === "string") {
    for (const root of extractProjectPathRoots(value, projectName)) {
      roots.add(root);
    }
    return;
  }
  if (!value || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectProjectPathRoots(item, projectName, roots);
    }
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "encrypted_content") {
      continue;
    }
    collectProjectPathRoots(child, projectName, roots);
  }
}

function extractProjectPathRoots(value, projectName) {
  const roots = [];
  const windowsPaths = value.match(/[A-Za-z]:[\\/][^\r\n"'<>|]*/g) || [];
  const posixPaths = value.match(/\/[^\s\r\n"'`]*/g) || [];
  for (const candidate of [...windowsPaths, ...posixPaths]) {
    const root = truncatePathAtProjectName(candidate, projectName);
    if (root) {
      roots.push(root);
    }
  }
  return roots;
}

function truncatePathAtProjectName(value, projectName) {
  const separatorMatch = value.match(/[\\/]/);
  const separator = separatorMatch?.[0] || "/";
  const isAbsolutePosix = value.startsWith("/");
  const rawParts = value.split(/[\\/]+/);
  const parts = rawParts.filter(Boolean);
  const index = parts.findIndex((part) => cleanPathSegment(part).toLowerCase() === projectName.toLowerCase());
  if (index < 0) {
    return null;
  }
  const rootParts = parts.slice(0, index + 1);
  const root = isAbsolutePosix ? `${separator}${rootParts.join(separator)}` : rootParts.join(separator);
  return trimTrailingPathSeparators(root);
}

function buildProjectPathMapping(source, target) {
  const cleanSource = trimTrailingPathSeparators(source);
  if (!cleanSource || samePathReference(cleanSource, target)) {
    return null;
  }

  const variants = unique([
    cleanSource,
    cleanSource.replaceAll("\\", "/"),
    cleanSource.replaceAll("/", "\\"),
    cleanSource.replaceAll("\\", "\\\\")
  ]).filter((variant) => variant && !samePathReference(variant, target));

  return {
    source: cleanSource,
    target,
    variants: variants.sort((a, b) => b.length - a.length)
  };
}

function replaceProjectPathReferences(value, mappings) {
  if (!mappings?.length || !value || typeof value !== "object") {
    return false;
  }

  let changed = false;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (typeof value[i] === "string") {
        const next = replaceProjectPathString(value[i], mappings);
        if (next !== value[i]) {
          value[i] = next;
          changed = true;
        }
      } else if (replaceProjectPathReferences(value[i], mappings)) {
        changed = true;
      }
    }
    return changed;
  }

  for (const [key, child] of Object.entries(value)) {
    if (shouldSkipPathRewriteKey(key)) {
      continue;
    }
    if (typeof child === "string") {
      const next = replaceProjectPathString(child, mappings);
      if (next !== child) {
        value[key] = next;
        changed = true;
      }
    } else if (replaceProjectPathReferences(child, mappings)) {
      changed = true;
    }
  }
  return changed;
}

function shouldSkipPathRewriteKey(key) {
  return key === "encrypted_content";
}

function replaceProjectPathString(value, mappings) {
  let result = value;
  for (const mapping of mappings) {
    for (const variant of mapping.variants) {
      const pattern = new RegExp(`${escapeRegExp(variant)}((?:[\\\\/][^\\s"'<>|]*)*)`, "g");
      result = result.replace(pattern, (_match, suffix = "") => `${mapping.target}${normalizePathSuffix(suffix)}`);
    }
  }
  return result;
}

function normalizePathSuffix(value) {
  return value.replace(/[\\/]+/g, "/");
}

function cleanPathSegment(value) {
  return value.replace(/[),.:;\]}]+$/g, "");
}

function trimTrailingPathSeparators(value) {
  return value.replace(/[\\/]+$/g, "");
}

function samePathReference(left, right) {
  const normalize = (value) => trimTrailingPathSeparators(value).replaceAll("\\", "/").toLowerCase();
  return normalize(left) === normalize(right);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function detectSessionPlatform(content) {
  let sawWindows = false;
  let sawDarwin = false;
  let sawLinux = false;
  let sawPosix = false;

  for (const item of readJsonlItems(content)) {
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

function* readJsonlItems(content) {
  for (const line of content.split(/\r?\n/)) {
    if (!line) {
      continue;
    }
    try {
      yield JSON.parse(line);
    } catch {
      // Ignore partial or non-JSON transcript lines from older clients.
    }
  }
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

  const args = parseArguments(payload.arguments);
  if (args && typeof args === "object" && !Array.isArray(args)) {
    signals.push(args.cwd, args.workdir, args.shell);
  }
  return signals.filter(Boolean);
}

function parseArguments(value) {
  if (typeof value !== "string") {
    return null;
  }
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function addPath(paths, value) {
  if (typeof value === "string" && (isWindowsPath(value) || isPosixPath(value))) {
    paths.add(normalizeSessionPathReference(value));
  }
}

export function normalizeSessionPathReference(value) {
  return trimTrailingPathSeparators(String(value).replaceAll("\\", "/"));
}

function isSourcePlatformPath(value, sourcePlatform) {
  if (sourcePlatform === "win32") {
    return isWindowsPath(value);
  }
  if (sourcePlatform === "posix") {
    return isPosixPath(value);
  }
  if (sourcePlatform === "darwin") {
    return isDarwinPath(value);
  }
  if (sourcePlatform === "linux") {
    return isLinuxPath(value);
  }
  return false;
}

function isSourcePlatformShell(value, sourcePlatform) {
  if (sourcePlatform === "win32") {
    return isWindowsShell(value);
  }
  if (sourcePlatform === "posix" || sourcePlatform === "darwin" || sourcePlatform === "linux") {
    return isPosixShell(value);
  }
  return false;
}

function isWindowsPath(value) {
  return typeof value === "string" && /^[A-Za-z]:[\\/]/.test(value);
}

function isPosixPath(value) {
  return typeof value === "string" && /^\//.test(value);
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
