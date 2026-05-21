import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { expandHome, normalizePath, shrinkHome, walk } from "./utils.js";

export function getCodexArchiveInfo(codexRoot) {
  const codexHome = resolveCodexHome(codexRoot);
  const statePath = join(codexHome, "state_5.sqlite");
  const archivedSessionsDir = join(codexHome, "archived_sessions");
  const archivedPaths = new Set();
  const sources = [];

  if (existsSync(archivedSessionsDir)) {
    const files = walk(archivedSessionsDir);
    for (const file of files) {
      addArchivedPath(archivedPaths, file);
    }
    sources.push(`dir:${files.length}`);
  }

  const sqlite = readArchivedRolloutPaths(statePath);
  if (sqlite.ok) {
    for (const path of sqlite.paths) {
      addArchivedPath(archivedPaths, path);
    }
    sources.push(`state:${sqlite.paths.length}`);
  }

  return {
    codexHome: normalizePath(codexHome),
    statePath: normalizePath(statePath),
    archivedSessionsDir: normalizePath(archivedSessionsDir),
    archivedPaths,
    sourceSummary: sources.join(",") || "none",
    stateStatus: sqlite.status
  };
}

export function summarizeCodexArchiveInfo(info) {
  return {
    codexHome: shrinkHome(info.codexHome),
    statePath: shrinkHome(info.statePath),
    archivedSessionsDir: shrinkHome(info.archivedSessionsDir),
    archivedCount: info.archivedPaths.size,
    stateStatus: info.stateStatus,
    sourceSummary: info.sourceSummary
  };
}

export function isArchivedCodexSessionPath(path, archiveInfo) {
  if (!archiveInfo || !path) {
    return false;
  }

  const normalized = normalizeArchivePath(path);
  if (!normalized) {
    return false;
  }
  if (archiveInfo.archivedPaths.has(normalized)) {
    return true;
  }
  if (normalized.includes("/archived_sessions/")) {
    return true;
  }
  return false;
}

function resolveCodexHome(codexRoot) {
  const normalized = normalizePath(codexRoot);
  const leaf = basename(normalized);
  if (leaf === "sessions" || leaf === "archived_sessions") {
    return dirname(normalized);
  }
  if (existsSync(join(normalized, "state_5.sqlite"))) {
    return normalized;
  }
  const parent = dirname(normalized);
  if (existsSync(join(parent, "state_5.sqlite"))) {
    return parent;
  }
  return normalized;
}

function readArchivedRolloutPaths(statePath) {
  if (!existsSync(statePath)) {
    return { ok: false, status: "missing", paths: [] };
  }

  const result = spawnSync(
    "sqlite3",
    ["-noheader", statePath, "SELECT rollout_path FROM threads WHERE archived = 1 OR archived_at IS NOT NULL;"],
    { encoding: "utf8" }
  );

  if (result.error) {
    return { ok: false, status: `unavailable (${result.error.message})`, paths: [] };
  }
  if (result.status !== 0) {
    const message = (result.stderr || result.stdout || "").trim();
    return { ok: false, status: `unavailable (${message || `exit ${result.status}`})`, paths: [] };
  }

  return {
    ok: true,
    status: "ok",
    paths: result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
  };
}

function addArchivedPath(archivedPaths, path) {
  const normalized = normalizeArchivePath(path);
  if (!normalized) {
    return;
  }
  archivedPaths.add(normalized);
}

function normalizeArchivePath(path) {
  if (!path) {
    return "";
  }
  return normalizePath(expandHome(path));
}
