import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const cli = join(repoRoot, "bin", "git-agent-sync.js");
const base = realpathSync(mkdtempSync(join(tmpdir(), "agent-sync-e2e-")));
const bareProjectRemote = join(base, "project.git");
const bareStoreRemote = join(base, "store.git");
const machineA = join(base, "machine-a");
const machineBParent = join(base, "machine-b");
const projectName = "agent-sync-e2e-project";
const projectA = join(machineA, projectName);
const projectB = join(machineBParent, projectName);
const codexA = join(base, "codex-a");
const codexB = join(base, "codex-b");
const codexBranch = join(base, "codex-branch");
const codexCommit = join(base, "codex-commit");
const claudeA = join(base, "claude-a");
const claudeB = join(base, "claude-b");
const windowsRoot = `C:\\Users\\woodq\\FullStack\\${projectName}`;

mkdirSync(machineA, { recursive: true });
mkdirSync(machineBParent, { recursive: true });
mkdirSync(projectA, { recursive: true });
mkdirSync(codexA, { recursive: true });
mkdirSync(codexB, { recursive: true });
mkdirSync(codexBranch, { recursive: true });
mkdirSync(codexCommit, { recursive: true });
mkdirSync(claudeA, { recursive: true });
mkdirSync(claudeB, { recursive: true });
mkdirSync(join(codexA, "archived_sessions"), { recursive: true });
mkdirSync(join(codexA, "2026", "05", "21"), { recursive: true });

run("git", ["init", "--bare", "-b", "main", bareProjectRemote], base);
run("git", ["init", "--bare", "-b", "main", bareStoreRemote], base);
run("git", ["init", "-b", "main"], projectA);
run("git", ["config", "user.name", "Agent Sync Test"], projectA);
run("git", ["config", "user.email", "test@example.invalid"], projectA);
run("git", ["remote", "add", "origin", bareProjectRemote], projectA);
writeFileSync(join(projectA, "README.md"), "# e2e\n");
run("git", ["add", "README.md"], projectA);
run("git", ["commit", "-m", "initial"], projectA);
run("git", ["push", "-u", "origin", "main"], projectA);

agent(projectA, codexA, claudeA, ["init", "--remote", bareStoreRemote]);
run("git", ["add", ".gitignore"], projectA);
run("git", ["commit", "-m", "ignore agent sync files"], projectA);
run("git", ["push"], projectA);
const currentCommit = run("git", ["rev-parse", "HEAD"], projectA);

const sessionPath = join(codexA, "2026", "05", "21", "session.jsonl");
const foreignSessionPath = join(codexA, "2026", "05", "21", "foreign-session.jsonl");
const archivedPath = join(codexA, "archived_sessions", "archived-session.jsonl");
writeJsonl(sessionPath, [
  {
    type: "session_meta",
    payload: {
      id: "session-current",
      cwd: windowsRoot,
      git: {
        commit_hash: currentCommit,
        branch: "main",
        repository_url: bareProjectRemote
      }
    }
  },
  { type: "turn_context", payload: { cwd: windowsRoot } },
  {
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      arguments: JSON.stringify({
        cmd: `Get-ChildItem ${windowsRoot}\\src`,
        workdir: windowsRoot,
        shell: "powershell.exe"
      })
    }
  }
]);
writeCodexState(codexA, [
  ["session-current", "Continue e2e session", "Preview should not win", "First message should not win"]
]);
writeJsonl(foreignSessionPath, [
  {
    type: "session_meta",
    payload: {
      id: "foreign-session",
      cwd: "/Users/woodq/FullStack/Agent-Sync",
      git: {
        commit_hash: "foreign-commit",
        branch: "main",
        repository_url: "https://github.com/Wood-Q/Agent-Sync.git"
      }
    }
  },
  { type: "turn_context", payload: { cwd: "/Users/woodq/FullStack/Agent-Sync" } },
  {
    type: "response_item",
    payload: {
      type: "message",
      role: "user",
      content: `This Agent-Sync session mentions ${projectName} but belongs elsewhere.`
    }
  }
]);
writeJsonl(archivedPath, [
  {
    type: "session_meta",
    payload: {
      id: "archived-session",
      cwd: windowsRoot,
      git: {
        commit_hash: currentCommit,
        branch: "main",
        repository_url: bareProjectRemote
      }
    }
  },
  { type: "turn_context", payload: { cwd: windowsRoot } }
]);

const pushOut = agent(projectA, codexA, claudeA, ["push"]);
assert.match(pushOut, /1 matched session file\(s\), 1 new binding\(s\)/);
assert.match(pushOut, /archived removed/);
assert.equal(run("git", ["status", "--porcelain", "--", ".agent-sync-store"], projectA), "");
assert.equal(run("git", ["status", "--porcelain"], projectA), "");
assert.equal(run("git", ["ls-files", ".agent-sync-store"], projectA), "");
assert.equal(run("git", ["grep", "-n", "Agent-Sync", "HEAD", "--", "projects"], join(projectA, ".agent-sync-store"), { allowFail: true }), "");
assert.match(run("git", ["log", "-1", "--pretty=%s"], join(projectA, ".agent-sync-store")), new RegExp(`sync ${projectName} Codex sessions at ${currentCommit.slice(0, 12)}`));

run("git", ["clone", bareProjectRemote, projectB], machineBParent);
agent(projectB, codexB, claudeB, ["init", "--remote", bareStoreRemote]);
const pullOut = agent(projectB, codexB, claudeB, ["pull"]);
assert.match(pullOut, /1 session file\(s\) available for restore/);

const byLatest = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--latest", "--json"]));
const byCurrent = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--current", "--json"]));
const byBranch = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--branch", "main", "--json"]));
const byCommit = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--commit", currentCommit.slice(0, 8), "--json"]));
assert.equal(byLatest.length, 1);
assert.equal(byCurrent.length, 1);
assert.equal(byBranch.length, 1);
assert.equal(byCommit.length, 1);
assert.equal(byCurrent[0].title, "Continue e2e session");
assert.equal(byCurrent[0].projectCommit, currentCommit);
assert.match(readFileSync(join(projectB, ".agent-sync-store", byCurrent[0].storeRelativePath), "utf8"), /session-current/);

const logOut = agent(projectB, codexB, claudeB, ["log", "--current"]);
assert.match(logOut, /1\. Continue e2e session/);
assert.match(logOut, /restore:\s+git agent-sync restore --current <index>/);
assert.match(logOut, /show:\s+git agent-sync show --current <index>/);

const showOut = agent(projectB, codexB, claudeB, ["show", "--latest", "1"]);
assert.match(showOut, /title:\s+Continue e2e session/);
assert.match(showOut, new RegExp(`project commit:\\s+${currentCommit}`));
assert.match(agent(projectB, codexB, claudeB, ["show", byCurrent[0].bundleId]), /bundle:/);

const restoreOut = agent(projectB, codexB, claudeB, ["restore", "--current"]);
assert.match(restoreOut, /restored codex:/);
assert.match(agent(projectB, codexB, claudeB, ["restore", "--latest", "1"]), /restored codex:/);
assert.match(agent(projectB, codexB, claudeB, ["restore", "--current", "1"]), /restored codex:/);
assert.match(agent(projectB, codexBranch, claudeB, ["restore", "--branch", "main"]), /restored codex:/);
assert.match(agent(projectB, codexCommit, claudeB, ["restore", "--commit", currentCommit.slice(0, 8)]), /restored codex:/);
const restored = parseJsonl(readFileSync(join(codexB, "2026", "05", "21", "session.jsonl"), "utf8"));
const args = JSON.parse(restored[2].payload.arguments);
assert.equal(restored[0].payload.cwd, projectB);
assert.equal(restored[1].payload.cwd, projectB);
assert.equal(args.workdir, projectB);
assert.equal(args.shell, process.env.SHELL || "/bin/sh");
assert.equal(args.cmd, `Get-ChildItem ${projectB}/src`);
assert.ok(restored[0].payload.agentSyncAdapted);

const doctor = agent(projectB, codexB, claudeB, ["doctor"]);
assert.match(doctor, /ok\s+manifest\s+1 match\(es\)/);
assert.match(doctor, /ok\s+bindings\s+1 valid, 0 invalid/);
assert.match(doctor, /archived skipped/);

console.log(JSON.stringify({ base, currentCommit }, null, 2));

function agent(cwd, codexDir, claudeDir, args) {
  return run(process.execPath, [cli, ...args], cwd, {
    AGENT_SYNC_CODEX_DIR: codexDir,
    AGENT_SYNC_CLAUDE_DIR: claudeDir
  });
}

function run(command, args, cwd, env = {}) {
  const options = env && Object.prototype.hasOwnProperty.call(env, "allowFail")
    ? { allowFail: env.allowFail, env: {} }
    : { allowFail: false, env };
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...options.env },
    encoding: "utf8"
  });
  if (result.status !== 0 && !options.allowFail) {
    console.error(`FAILED: ${command} ${args.join(" ")}`);
    if (result.error) {
      console.error(result.error.message);
    }
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`command failed: ${command} ${args.join(" ")}`);
  }
  return result.stdout.trim();
}

function writeJsonl(path, items) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${items.map((item) => JSON.stringify(item)).join("\n")}\n`);
}

function writeCodexState(codexHome, rows) {
  const result = spawnSync("python3", ["-", join(codexHome, "state_5.sqlite")], {
    input: `import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("create table threads (id text primary key, title text not null, preview text not null, first_user_message text not null)")
for row in ${JSON.stringify(rows)}:
    con.execute("insert into threads values (?, ?, ?, ?)", row)
con.commit()
`,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "failed to create fake Codex state");
  }
}

function parseJsonl(content) {
  return content.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
