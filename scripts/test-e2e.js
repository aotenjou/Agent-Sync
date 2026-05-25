import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

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
const codexIndex = join(base, "codex-index");
const codexShortIndex = join(base, "codex-short-index");
const codexBranch = join(base, "codex-branch");
const codexCommit = join(base, "codex-commit");
const claudeA = join(base, "claude-a");
const claudeB = join(base, "claude-b");
const windowsRoot = `C:\\Users\\woodq\\FullStack\\${projectName}`;
const pushMessage = "feat: add user login API";
const conversationAtMs = Date.parse("2026-05-23T02:14:00.000Z");

mkdirSync(machineA, { recursive: true });
mkdirSync(machineBParent, { recursive: true });
mkdirSync(projectA, { recursive: true });
mkdirSync(codexA, { recursive: true });
mkdirSync(codexB, { recursive: true });
mkdirSync(codexIndex, { recursive: true });
mkdirSync(codexShortIndex, { recursive: true });
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
  ["session-current", "Continue e2e session", "Preview should not win", "First message should not win", conversationAtMs - 3600000, conversationAtMs]
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

const pushOut = agent(projectA, codexA, claudeA, ["push", "--m", pushMessage]);
assert.match(pushOut, /1 matched session file\(s\), 1 new binding\(s\)/);
assert.match(pushOut, /archived removed/);
assert.equal(run("git", ["status", "--porcelain", "--", ".agent-sync-store"], projectA), "");
assert.equal(run("git", ["status", "--porcelain"], projectA), "");
assert.equal(run("git", ["ls-files", ".agent-sync-store"], projectA), "");
assert.equal(run("git", ["grep", "-n", "Agent-Sync", "HEAD", "--", "projects"], join(projectA, ".agent-sync-store"), { allowFail: true }), "");
assert.equal(run("git", ["log", "-1", "--pretty=%s"], join(projectA, ".agent-sync-store")), pushMessage);
assert.equal(run("git", ["log", "-1", "--pretty=%an <%ae>"], join(projectA, ".agent-sync-store")), "Agent Sync Test <test@example.invalid>");
seedForeignStoreProject(base, bareStoreRemote);

run("git", ["clone", bareProjectRemote, projectB], machineBParent);
agent(projectB, codexB, claudeB, ["init", "--remote", bareStoreRemote]);
const pullOut = agent(projectB, codexB, claudeB, ["pull"]);
assert.match(pullOut, /1 session file\(s\) available for restore/);
const sparseConfig = run("git", ["config", "--get", "core.sparseCheckout"], join(projectB, ".agent-sync-store"));
const sparsePatterns = readFileSync(join(projectB, ".agent-sync-store", ".git", "info", "sparse-checkout"), "utf8");
assert.equal(sparseConfig, "true");
assert.match(sparsePatterns, /\/projects\/\*\/manifest\.json/);
assert.match(sparsePatterns, /\/projects\/agent-sync-e2e-project-/i);
assert.equal(existsSync(join(projectB, ".agent-sync-store", "projects", "ForeignProject-deadbeef00", "manifest.json")), true);
assert.equal(existsSync(join(projectB, ".agent-sync-store", "projects", "ForeignProject-deadbeef00", "codex", "codex-foreign.jsonl")), false);

const byLatest = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--latest", "--json"]));
const byCurrent = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--current", "--json"]));
const byBranch = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--branch", "main", "--json"]));
const byCommit = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--commit", currentCommit.slice(0, 8), "--json"]));
assert.equal(byLatest.length, 1);
assert.equal(byCurrent.length, 1);
assert.equal(byBranch.length, 1);
assert.equal(byCommit.length, 1);
assert.equal(existsSync(join(projectB, ".agent-sync-store", "projects", byCurrent[0].projectId, "bindings.idx.json")), true);
assert.equal(byCurrent[0].title, "Continue e2e session");
assert.equal(byCurrent[0].projectCommit, currentCommit);
assert.equal(byCurrent[0].commitMessage, pushMessage);
assert.equal(byCurrent[0].authorName, "Agent Sync Test");
assert.equal(byCurrent[0].authorEmail, "test@example.invalid");
assert.equal(byCurrent[0].conversationAt, new Date(conversationAtMs).toISOString());
assert.match(readFileSync(join(projectB, ".agent-sync-store", byCurrent[0].storeRelativePath), "utf8"), /session-current/);

const defaultLogOut = agent(projectB, codexB, claudeB, ["log"]);
assert.match(defaultLogOut, /Index: 1/);
assert.match(defaultLogOut, /Title: Continue e2e session/);
assert.match(defaultLogOut, /Author: Agent Sync Test <test@example.invalid>/);
assert.match(defaultLogOut, /Date:\s+Sat May 23 10:14:00 2026 \+0800/);
assert.match(defaultLogOut, new RegExp(`\\s{4}${pushMessage}`));
assert.match(defaultLogOut, /restore:\s+git agent-sync restore --index <index>/);
assert.match(defaultLogOut, /Restore: git agent-sync restore --index 1/);
const allJson = JSON.parse(agent(projectB, codexB, claudeB, ["log", "--json"]));
assert.equal(allJson.length, 1);
assert.equal(allJson[0].bundleId, byCurrent[0].bundleId);

const logOut = agent(projectB, codexB, claudeB, ["log", "--current"]);
assert.match(logOut, /Index: 1/);
assert.match(logOut, /Title: Continue e2e session/);
assert.match(logOut, new RegExp(`\\s{4}${pushMessage}`));
assert.match(logOut, /restore:\s+git agent-sync restore --current <index>/);
assert.match(logOut, /show:\s+git agent-sync show --current <index>/);

const showOut = agent(projectB, codexB, claudeB, ["show", "--latest", "1"]);
assert.match(showOut, /title:\s+Continue e2e session/);
assert.match(showOut, new RegExp(`project commit:\\s+${currentCommit}`));
assert.match(agent(projectB, codexB, claudeB, ["show", byCurrent[0].bundleId]), /bundle:/);

const restoreOut = agent(projectB, codexB, claudeB, ["restore", "--current"]);
assert.match(restoreOut, /restored codex:/);
assert.match(restoreOut, /registered codex thread: session-current/);
assert.match(agent(projectB, codexB, claudeB, ["restore", "--latest", "1"]), /restored codex:/);
assert.match(agent(projectB, codexB, claudeB, ["restore", "--current", "1"]), /restored codex:/);
assert.match(agent(projectB, codexIndex, claudeB, ["restore", "--index", "1"]), /restored codex:/);
assert.match(agent(projectB, codexShortIndex, claudeB, ["restore", "--i", "1"]), /restored codex:/);
const badIndex = agentResult(projectB, codexB, claudeB, ["restore", "--index", "2"]);
assert.notEqual(badIndex.status, 0);
assert.match(badIndex.stderr, /restore index 2 is out of range for log \(1 binding\(s\)\)/);
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
const restoredThread = readCodexThread(codexB, "session-current");
assert.equal(restoredThread.rollout_path, join(codexB, "2026", "05", "21", "session.jsonl").replaceAll("\\", "/"));
assert.equal(restoredThread.cwd, projectB);
assert.equal(restoredThread.title, "Continue e2e session");
assert.equal(restoredThread.git_sha, currentCommit);
assert.equal(restoredThread.git_branch, "main");
assert.equal(restoredThread.git_origin_url, bareProjectRemote);
assert.equal(restoredThread.archived, 0);
assert.equal(readCodexThreadCount(codexB, "session-current"), 1);
assert.match(readFileSync(join(codexB, "session_index.jsonl"), "utf8"), /Continue e2e session/);

const codexNoRegister = join(base, "codex-no-register");
mkdirSync(codexNoRegister, { recursive: true });
assert.match(agent(projectB, codexNoRegister, claudeB, ["restore", "--current", "1", "--no-register"]), /restored codex:/);
assert.equal(existsSync(join(codexNoRegister, "state_5.sqlite")), false);

const doctor = agent(projectB, codexB, claudeB, ["doctor"]);
assert.match(doctor, /ok\s+manifest\s+1 match\(es\)/);
assert.match(doctor, /ok\s+bindings\s+1 valid, 0 invalid/);
assert.match(doctor, /ok\s+store sparse\s+enabled/);
assert.match(doctor, /archived skipped/);

console.log(JSON.stringify({ base, currentCommit }, null, 2));

function agent(cwd, codexDir, claudeDir, args) {
  return run(process.execPath, [cli, ...args], cwd, agentEnv(codexDir, claudeDir));
}

function agentResult(cwd, codexDir, claudeDir, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, ...agentEnv(codexDir, claudeDir) },
    encoding: "utf8"
  });
}

function agentEnv(codexDir, claudeDir) {
  return {
    AGENT_SYNC_CODEX_DIR: codexDir,
    AGENT_SYNC_CLAUDE_DIR: claudeDir,
    TZ: "Asia/Shanghai"
  };
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

function seedForeignStoreProject(baseDir, remote) {
  const seed = join(baseDir, "store-seed");
  run("git", ["clone", remote, seed], baseDir);
  run("git", ["config", "user.name", "Agent Sync Test"], seed);
  run("git", ["config", "user.email", "test@example.invalid"], seed);
  const projectDir = join(seed, "projects", "ForeignProject-deadbeef00");
  mkdirSync(join(projectDir, "codex"), { recursive: true });
  writeFileSync(join(projectDir, "manifest.json"), JSON.stringify({
    projectId: "ForeignProject-deadbeef00",
    projectName: "ForeignProject",
    projectIdentity: "git:example.com/foreign/project",
    matches: [{
      agent: "codex",
      bundleId: "codex-foreign",
      storeRelativePath: "projects/ForeignProject-deadbeef00/codex/codex-foreign.jsonl",
      originalPath: "~/.codex/sessions/foreign.jsonl"
    }]
  }, null, 2));
  writeFileSync(join(projectDir, "bindings.jsonl"), `${JSON.stringify({
    version: 2,
    syncRunId: "foreign-run",
    syncedAt: "2026-05-20T00:00:00.000Z",
    projectId: "ForeignProject-deadbeef00",
    projectIdentity: "git:example.com/foreign/project",
    projectBranch: "main",
    projectCommit: "foreign-commit",
    bundleId: "codex-foreign",
    agent: "codex",
    sessionId: "foreign-session",
    title: "Foreign session",
    storeRelativePath: "projects/ForeignProject-deadbeef00/codex/codex-foreign.jsonl",
    originalPath: "~/.codex/sessions/foreign.jsonl"
  })}\n`);
  writeJsonl(join(projectDir, "codex", "codex-foreign.jsonl"), [
    {
      type: "session_meta",
      payload: {
        id: "foreign-session",
        cwd: "/tmp/foreign",
        git: {
          commit_hash: "foreign-commit",
          branch: "main",
          repository_url: "https://example.com/foreign/project.git"
        }
      }
    }
  ]);
  run("git", ["add", "projects/ForeignProject-deadbeef00"], seed);
  run("git", ["commit", "-m", "seed foreign project"], seed);
  run("git", ["push", "origin", "main"], seed);
}

function writeCodexState(codexHome, rows) {
  const db = new Database(join(codexHome, "state_5.sqlite"));
  db.exec("create table threads (id text primary key, title text not null, preview text not null, first_user_message text not null, created_at_ms integer, updated_at_ms integer)");
  const insert = db.prepare("insert into threads values (?, ?, ?, ?, ?, ?)");
  for (const row of rows) {
    insert.run(...row);
  }
  db.close();
}

function readCodexThread(codexHome, id) {
  const db = new Database(join(codexHome, "state_5.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return db.prepare("select * from threads where id = ?").get(id) || {};
  } finally {
    db.close();
  }
}

function readCodexThreadCount(codexHome, id) {
  const db = new Database(join(codexHome, "state_5.sqlite"), { readonly: true, fileMustExist: true });
  try {
    return db.prepare("select count(*) as count from threads where id = ?").get(id).count;
  } finally {
    db.close();
  }
}

function parseJsonl(content) {
  return content.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
