import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectBindings, queryBindings } from "../src/bindings.js";

const dir = mkdtempSync(join(tmpdir(), "agent-sync-bindings-"));
const config = { storePath: dir, projectId: "project" };
const projectDir = join(dir, "projects", config.projectId);
mkdirSync(projectDir, { recursive: true });

writeFileSync(join(projectDir, "bindings.jsonl"), [
  JSON.stringify({
    version: 2,
    syncRunId: "run-1",
    syncedAt: "2026-05-24T00:00:00.000Z",
    bundleId: "codex-1",
    agent: "codex",
    storeRelativePath: "projects/project/codex/codex-1.jsonl",
    projectCommit: "abc123",
    projectBranch: "main"
  }),
  "{not-json",
  JSON.stringify({ bundleId: "missing-required-fields" })
].join("\n") + "\n");

const summary = inspectBindings(config);
assert.equal(summary.exists, true);
assert.equal(summary.valid, 1);
assert.equal(summary.invalid, 2);
assert.equal(summary.bindings[0].projectCommit, "abc123");
assert.equal(summary.bindings[0].projectBaseCommit, "abc123");

const matches = queryBindings(config, { type: "commit", value: "abc" }, process.cwd());
assert.equal(matches.length, 1);
assert.equal(matches[0].bundleId, "codex-1");

const latest = queryBindings(config, { type: "latest" }, process.cwd());
assert.equal(latest.length, 1);
assert.equal(latest[0].bundleId, "codex-1");

console.log("bindings v2 test passed");
