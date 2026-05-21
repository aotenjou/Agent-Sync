import assert from "node:assert/strict";
import { adaptCodexSessionContent, extractCodexSessionMetadata } from "../src/codex-session.js";

const targetRoot = "/Users/test/workspace/MokioAgent";
const localShell = process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : process.env.SHELL || "/bin/sh";

for (const fixture of [
  {
    name: "windows",
    root: "C:\\Users\\woodq\\FullStack\\MokioAgent",
    shell: "powershell.exe",
    cmd: "Get-ChildItem C:\\Users\\woodq\\FullStack\\MokioAgent\\src"
  },
  {
    name: "linux",
    root: "/home/woodq/FullStack/MokioAgent",
    shell: "bash",
    cmd: "ls /home/woodq/FullStack/MokioAgent/src"
  },
  {
    name: "macos",
    root: "/Users/woodq/FullStack/MokioAgent",
    shell: "zsh",
    cmd: "ls /Users/woodq/FullStack/MokioAgent/src"
  }
]) {
  const content = makeSession(fixture);
  const metadata = extractCodexSessionMetadata(content);
  assert.equal(metadata.sessionId, `${fixture.name}-session`);
  assert.equal(metadata.projectRoots[0], fixture.root.replaceAll("\\", "/"));
  assert.equal(metadata.workdirs[0], fixture.root.replaceAll("\\", "/"));
  assert.equal(metadata.gitContexts[0].commit, `${fixture.name}-commit`);

  const result = adaptCodexSessionContent(content, {
    projectName: "MokioAgent",
    projectRoot: targetRoot
  });
  assert.equal(result.adapted, true);
  const lines = parseJsonl(result.content);
  const args = JSON.parse(lines[2].payload.arguments);
  assert.equal(lines[0].payload.cwd, targetRoot);
  assert.equal(lines[1].payload.cwd, targetRoot);
  assert.equal(args.workdir, targetRoot);
  assert.equal(args.cmd.endsWith(`${targetRoot}/src`), true);
  assert.equal(lines[3].payload.output.endsWith(`${targetRoot}/src/index.js`), true);
  assert.equal(lines[3].payload.encrypted_content, `keep ${fixture.root}\\secret.txt`);
  assert.ok(lines[0].payload.agentSyncAdapted);

  const shouldChangeShell = process.platform === "win32" ? fixture.name !== "windows" : fixture.name === "windows";
  assert.equal(args.shell, shouldChangeShell ? localShell : fixture.shell);
}

console.log("codex session path adaptation test passed");

function makeSession({ name, root, shell, cmd }) {
  return [
    {
      type: "session_meta",
      payload: {
        id: `${name}-session`,
        cwd: root,
        git: {
          commit_hash: `${name}-commit`,
          branch: name,
          repository_url: `https://example.com/${name}/MokioAgent.git`
        }
      }
    },
    { type: "turn_context", payload: { cwd: root } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "exec_command",
        arguments: JSON.stringify({ cmd, workdir: root, shell })
      }
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        output: `opened ${root}\\src\\index.js`,
        encrypted_content: `keep ${root}\\secret.txt`
      }
    }
  ].map((line) => JSON.stringify(line)).join("\n") + "\n";
}

function parseJsonl(content) {
  return content.trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}
