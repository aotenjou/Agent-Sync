import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { getCodexArchiveInfo, isArchivedCodexSessionPath, summarizeCodexArchiveInfo } from "./codex-archive.js";
import { getProjectRemote, normalizeRemoteUrl } from "./git.js";
import {
  extractCodexSessionMetadata,
  getCodexProjectMatch,
  loadCodexSessionTitles,
  resolveCodexHome
} from "./codex-session.js";
import {
  buildMatchBase,
  createScanCacheEntry,
  getCandidateStat,
  loadScanCache,
  pruneScanCacheFiles,
  restoreCachedScanEntry,
  writeScanCache
} from "./scan-cache.js";
import { normalizePath, safeRead, sha256, unique, walk } from "./utils.js";

export function scanSessions(gitRoot, config, archiveInfo = null) {
  const projectRemote = normalizeRemoteUrl(getProjectRemote(gitRoot) || "");
  const codexRoot = getAgentRoot("codex");
  const codexArchiveInfo = archiveInfo || getCodexArchiveInfo(codexRoot, { gitRoot });
  const codexTitles = loadCodexSessionTitles(codexRoot);
  const codexTitleSignature = getCodexTitleSourceSignature(codexRoot);
  const needles = unique([
    normalizePath(gitRoot),
    normalizePath(gitRoot).replaceAll("/", "\\"),
    projectRemote,
    basename(gitRoot),
    config.projectName
  ].filter(Boolean));

  const candidates = [
    ...findAgentFiles("codex", codexRoot).filter((candidate) => !isArchivedCodexSessionPath(candidate.path, codexArchiveInfo)),
    ...findAgentFiles("claude", getAgentRoot("claude"))
  ];

  const cache = prepareScanCache(gitRoot, config, projectRemote, needles, candidates, codexTitleSignature);
  const stats = {
    cached: 0,
    refreshed: 0,
    skipped: 0
  };
  const matches = candidates
    .map((candidate) => scanCandidate(candidate, cache, stats, needles, config, projectRemote, codexTitles))
    .filter((match) => match)
    .sort((a, b) => a.agent.localeCompare(b.agent) || a.originalPath.localeCompare(b.originalPath));
  writeScanCache(gitRoot, cache);

  return {
    version: 1,
    scannedAt: new Date().toISOString(),
    projectId: config.projectId,
    projectIdentity: config.projectIdentity,
    projectName: config.projectName,
    projectRoot: gitRoot,
    candidates: candidates.length,
    cache: stats,
    matches,
    archive: summarizeCodexArchiveInfo(codexArchiveInfo)
  };
}

function prepareScanCache(gitRoot, config, projectRemote, needles, candidates, codexTitleSignature) {
  const cache = loadScanCache(gitRoot);
  const contextKey = JSON.stringify({
    projectId: config.projectId,
    projectIdentity: config.projectIdentity,
    projectRoot: normalizePath(gitRoot),
    projectName: config.projectName,
    projectRemote,
    needles,
    codexTitleSignature
  });
  if (cache.contextKey !== contextKey) {
    cache.files = {};
    cache.contextKey = contextKey;
  }
  return pruneScanCacheFiles(cache, candidates);
}

function getCodexTitleSourceSignature(codexRoot) {
  const codexHome = resolveCodexHome(codexRoot);
  return {
    codexHome,
    files: ["state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm", "session_index.jsonl"]
      .map((file) => [file, fileSignature(join(codexHome, file))])
  };
}

function fileSignature(path) {
  try {
    const stat = statSync(path);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs
    };
  } catch {
    return { exists: false };
  }
}

function scanCandidate(candidate, cache, stats, needles, config, projectRemote, codexTitles) {
  const stat = getCandidateStat(candidate);
  if (!stat) {
    return null;
  }

  const cached = restoreCachedScanEntry(candidate, stat, cache);
  if (cached) {
    stats.cached += 1;
    if (cached.skipped) {
      stats.skipped += 1;
    }
    return cached.match;
  }

  stats.refreshed += 1;
  const content = safeRead(candidate.path);
  const metadata = candidate.agent === "codex" ? extractCodexSessionMetadata(content) : null;
  if (metadata?.sessionId && codexTitles.has(metadata.sessionId)) {
    metadata.title = codexTitles.get(metadata.sessionId);
  }
  const matchedBy = candidate.agent === "codex"
    ? matchCodexSession(metadata, content, needles, config, projectRemote)
    : needles.filter((needle) => content.includes(needle));
  const hash = sha256(content);
  const match = matchedBy.length
    ? {
        ...buildMatchBase(candidate, content, hash, stat),
        matchedBy: matchedBy.slice(0, 3),
        metadata: metadata || undefined
      }
    : null;

  cache.files[normalizePath(candidate.path)] = createScanCacheEntry(candidate, stat, {
    bytes: Buffer.byteLength(content),
    sha256: hash,
    match
  });
  return match;
}

function matchCodexSession(metadata, content, needles, config, projectRemote) {
  const projectMatch = getCodexProjectMatch(metadata, content, config, projectRemote);
  if (projectMatch.matched) {
    return projectMatch.matchedBy;
  }
  return [];
}

function findAgentFiles(agent, root) {
  if (!existsSync(root)) {
    return [];
  }
  return walk(root)
    .filter((file) => file.endsWith(".jsonl") || file.endsWith(".json"))
    .map((path) => ({ agent, path: normalizePath(path), root: normalizePath(root) }));
}

export function getAgentRoot(agent) {
  if (agent === "codex") {
    return process.env.AGENT_SYNC_CODEX_DIR || join(homedir(), ".codex", "sessions");
  }
  if (agent === "claude") {
    return process.env.AGENT_SYNC_CLAUDE_DIR || join(homedir(), ".claude", "projects");
  }
  throw new Error(`unsupported agent "${agent}"`);
}
