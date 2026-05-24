import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const cli = join(repoRoot, "bin", "git-agent-sync.js");
const base = mkdtempSync(join(tmpdir(), "agent-sync-hooks-"));
const project = join(base, "project");
mkdirSync(project, { recursive: true });

run("git", ["init", "-b", "main"], project);
run("git", ["config", "user.name", "Agent Sync Test"], project);
run("git", ["config", "user.email", "test@example.invalid"], project);
writeFileSync(join(project, "README.md"), "# hooks\n");
run("git", ["add", "README.md"], project);
run("git", ["commit", "-m", "initial"], project);

run(process.execPath, [cli, "install-hooks"], project);
const hookPath = join(project, ".git", "hooks", "pre-push");
assert.equal(existsSync(hookPath), true);
assert.match(readFileSync(hookPath, "utf8"), /AGENT_SYNC_HOOK=pre-push/);
run(hookPath, [], project);

run(process.execPath, [cli, "uninstall-hooks"], project);
assert.equal(existsSync(hookPath), false);

writeFileSync(hookPath, "#!/bin/sh\necho custom\n");
assert.throws(() => run(process.execPath, [cli, "install-hooks"], project), /pre-push hook already exists/);
assert.throws(() => run(process.execPath, [cli, "uninstall-hooks"], project), /was not installed by agent-sync/);

console.log("hook install/uninstall test passed");

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    env: process.env,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || `command failed: ${command} ${args.join(" ")}`).trim());
  }
  return result.stdout.trim();
}
