import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DEFAULT_STORE_BRANCH, DEFAULT_STORE_GITIGNORE, TOOL_VERSION } from "./constants.js";
import { getProjectRemote, runGit } from "./git.js";
import { isArchivedCodexSessionPath } from "./codex-archive.js";
import { scoreProjectManifest } from "./config.js";
import { expandHome, normalizePath, readJson, toSlash, unique, writeJson } from "./utils.js";

export function ensureStoreRepo(storePath, remote) {
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

export function syncStoreFromRemote(storePath, remote) {
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

export function pruneArchivedSidecarEntries(config, archiveInfo) {
  if (!archiveInfo) {
    return { removedFiles: 0, removedBindings: 0 };
  }

  const bundleDir = getProjectBundleDir(config);
  if (!existsSync(bundleDir)) {
    return { removedFiles: 0, removedBindings: 0 };
  }

  const manifestPath = getManifestPath(config);
  const archivedStorePaths = new Set();
  const archivedOriginalPaths = new Set();

  if (existsSync(manifestPath)) {
    try {
      const manifest = readJson(manifestPath);
      for (const match of manifest.matches || []) {
        if (match.agent === "codex" && isArchivedCodexSessionPath(match.originalPath, archiveInfo)) {
          if (match.storeRelativePath) {
            archivedStorePaths.add(join(config.storePath, match.storeRelativePath));
          }
          if (match.originalPath) {
            archivedOriginalPaths.add(normalizePath(expandHome(match.originalPath)));
          }
        }
      }
    } catch {
      // keep going; bindings cleanup still works below
    }
  }

  const bindingsPath = join(bundleDir, "bindings.jsonl");
  let removedBindings = 0;
  if (existsSync(bindingsPath)) {
    const raw = readFileSync(bindingsPath, "utf8");
    const keptLines = [];
    for (const line of raw.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      let binding;
      try {
        binding = JSON.parse(line);
      } catch {
        keptLines.push(line);
        continue;
      }
      const originalPath = binding?.originalPath ? normalizePath(expandHome(binding.originalPath)) : "";
      const shouldRemove = binding?.agent === "codex" && isArchivedCodexSessionPath(binding.originalPath, archiveInfo);
      if (shouldRemove) {
        removedBindings += 1;
        if (binding.storeRelativePath) {
          archivedStorePaths.add(join(config.storePath, binding.storeRelativePath));
        }
        if (originalPath) {
          archivedOriginalPaths.add(originalPath);
        }
        continue;
      }
      keptLines.push(line);
    }
    if (removedBindings) {
      const content = keptLines.length ? `${keptLines.join("\n")}\n` : "";
      writeFileSync(bindingsPath, content);
    }
  }

  let removedFiles = 0;
  for (const filePath of archivedStorePaths) {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      removedFiles += 1;
    }
  }

  return { removedFiles, removedBindings, archivedOriginalPaths: archivedOriginalPaths.size };
}

export function copyMatchesToStore(config, scan, archiveInfo = null) {
  const copied = [];
  const projectDir = join(config.storePath, "projects", config.projectId);
  for (const match of scan.matches) {
    const source = expandHome(match.originalPath);
    if (archiveInfo && match.agent === "codex" && isArchivedCodexSessionPath(source, archiveInfo)) {
      continue;
    }
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

export function writeManifest(config, scan, gitContext = null) {
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

export function pruneArchivedManifestEntries(config, archiveInfo) {
  const manifestPath = getManifestPath(config);
  if (!archiveInfo || !existsSync(manifestPath)) {
    return { removed: 0 };
  }

  let manifest;
  try {
    manifest = readJson(manifestPath);
  } catch {
    return { removed: 0 };
  }

  if (!Array.isArray(manifest.matches) || !manifest.matches.length) {
    return { removed: 0 };
  }

  const keptMatches = [];
  let removed = 0;
  for (const match of manifest.matches) {
    if (match.agent === "codex" && isArchivedCodexSessionPath(match.originalPath, archiveInfo)) {
      removed += 1;
      continue;
    }
    keptMatches.push(match);
  }

  if (!removed) {
    return { removed: 0 };
  }

  manifest.matches = keptMatches;
  writeJson(manifestPath, manifest);
  return { removed };
}

export function adoptExistingProjectBundle(config) {
  const bundle = findProjectBundle(config);
  if (!bundle || bundle.projectId === config.projectId) {
    return;
  }
  config.projectId = bundle.projectId;
  config.legacyProjectIds = unique([...(config.legacyProjectIds || []), bundle.projectId]);
}

export function findProjectBundle(config) {
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

export function getProjectBundleDir(config) {
  return join(config.storePath, "projects", config.projectId);
}

export function getManifestPath(config) {
  return join(getProjectBundleDir(config), "manifest.json");
}
