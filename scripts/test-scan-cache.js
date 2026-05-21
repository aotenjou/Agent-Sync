import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scanSessions } from "../src/agents.js";
import { getCodexArchiveInfo } from "../src/codex-archive.js";
import { SCAN_CACHE_FILE } from "../src/constants.js";

const base = mkdtempSync(join(tmpdir(), "agent-sync-scan-cache-"));
const project = join(base, "MokioAgent");
const codexRoot = join(base, "codex", "sessions");
const claudeRoot = join(base, "claude", "projects");
mkdirSync(project, { recursive: true });
mkdirSync(join(codexRoot, "2026", "05", "21"), { recursive: true });
mkdirSync(claudeRoot, { recursive: true });

process.env.AGENT_SYNC_CODEX_DIR = codexRoot;
process.env.AGENT_SYNC_CLAUDE_DIR = claudeRoot;

const config = {
  projectId: "MokioAgent-cache-test",
  projectIdentity: "name:MokioAgent",
  projectName: "MokioAgent",
  projectRoot: project
};

const sessionPath = join(codexRoot, "2026", "05", "21", "session.jsonl");
writeFileSync(sessionPath, makeSession("first"));

const first = scanSessions(project, config, getCodexArchiveInfo(codexRoot, { gitRoot: project }));
assert.equal(first.candidates, 1);
assert.equal(first.matches.length, 1);
assert.equal(first.cache.refreshed, 1);
assert.equal(first.cache.cached, 0);

const second = scanSessions(project, config, getCodexArchiveInfo(codexRoot, { gitRoot: project }));
assert.equal(second.matches.length, 1);
assert.equal(second.cache.refreshed, 0);
assert.equal(second.cache.cached, 1);
assert.equal(second.cache.skipped, 1);

writeFileSync(sessionPath, makeSession("second-with-new-content"));
const third = scanSessions(project, config, getCodexArchiveInfo(codexRoot, { gitRoot: project }));
assert.equal(third.matches.length, 1);
assert.equal(third.cache.refreshed, 1);
assert.equal(third.cache.cached, 0);
assert.notEqual(third.matches[0].sha256, second.matches[0].sha256);

const scanCache = JSON.parse(readFileSync(join(project, SCAN_CACHE_FILE), "utf8"));
assert.equal(Object.keys(scanCache.files).length, 1);
assert.equal(scanCache.files[sessionPath.replaceAll("\\", "/")].matched, true);

console.log("scan cache test passed");

function makeSession(marker) {
  return [
    {
      type: "session_meta",
      payload: {
        id: `cache-${marker}`,
        cwd: project,
        git: {
          commit_hash: marker,
          branch: "main",
          repository_url: null
        }
      }
    },
    { type: "turn_context", payload: { cwd: project } }
  ].map((item) => JSON.stringify(item)).join("\n") + "\n";
}
