import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { getProjectRemote, normalizeRemoteUrl } from "./git.js";
import { extractCodexSessionMetadata, normalizeSessionPathReference } from "./codex-session.js";
import { normalizePath, safeRead, sha256, shrinkHome, toSlash, unique, walk } from "./utils.js";

export function scanSessions(gitRoot, config) {
  const projectRemote = normalizeRemoteUrl(getProjectRemote(gitRoot) || "");
  const needles = unique([
    normalizePath(gitRoot),
    normalizePath(gitRoot).replaceAll("/", "\\"),
    projectRemote,
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
      const metadata = candidate.agent === "codex" ? extractCodexSessionMetadata(content) : null;
      const matchedBy = candidate.agent === "codex"
        ? matchCodexSession(metadata, content, needles, config, projectRemote)
        : needles.filter((needle) => content.includes(needle));
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
        metadata: metadata || undefined,
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

function matchCodexSession(metadata, content, needles, config, projectRemote) {
  const metadataRemotes = metadata.gitContexts.map((item) => normalizeRemoteUrl(item.repositoryUrl || "")).filter(Boolean);
  if (projectRemote && metadataRemotes.includes(projectRemote)) {
    return [`git:${projectRemote}`];
  }

  const projectRoot = normalizeSessionPathReference(config.projectRoot).toLowerCase();
  const projectNameSuffix = `/${config.projectName.toLowerCase()}`;
  const rootCandidates = [...metadata.projectRoots, ...metadata.workdirs]
    .map(normalizeSessionPathReference)
    .map((value) => value.toLowerCase());
  if (rootCandidates.some((root) => root === projectRoot || root.endsWith(projectNameSuffix))) {
    return ["codex:cwd"];
  }

  if (content.includes(config.projectName)) {
    return ["codex:project-name"];
  }

  return needles.filter((needle) => content.includes(needle));
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
