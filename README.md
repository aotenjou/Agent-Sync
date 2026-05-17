# git-agent-sync

`git-agent-sync` is a Git-style helper for syncing local AI coding-agent sessions through a separate private Git repository.

It solves one specific problem: source code can move with `git clone`, but local Codex and Claude Code conversations normally stay on the machine where they were created.

## What It Does

- Scans Codex sessions in `~/.codex/sessions/**/*.jsonl`
- Scans Claude Code sessions in `~/.claude/projects/**/*.jsonl`
- Matches sessions to the current Git project by repo path, repo name, or repo remote
- Copies matched sessions into a sidecar Git repo at `.agent-sync-store/`
- Pushes and pulls that sidecar repo without adding sessions to your project commits
- Restores pulled sessions back into the local Codex or Claude session directory
- Records lightweight Git context bindings for each pushed session
- Lists or restores sessions by the current Git state, branch, or commit
- Uses a cross-platform project identity based on the project Git remote when available
- Falls back to legacy path-based bundles so older stores still restore

## Install

For local development:

```bash
cd ~/Agent-Sync
npm install
npm link
git agent-sync --help
```

After publishing:

```bash
npm install -g git-agent-sync
```

## Complete Workflow

Create a private repository just for agent sessions, for example:

```text
git@github.com:you/agent-session-store.git
```

On the machine that already has useful sessions:

```bash
cd your-project
git agent-sync init --remote git@github.com:you/agent-session-store.git
git agent-sync status
git agent-sync push
```

On another machine:

```bash
git clone git@github.com:you/your-project.git
cd your-project
git agent-sync init --remote git@github.com:you/agent-session-store.git
git agent-sync pull
git agent-sync list --current
git agent-sync restore --all
```

You can also pass the session-store URL as the first positional argument:

```bash
git agent-sync init git@github.com:you/agent-session-store.git
```

## Automatic Push

Install the pre-push hook in each project where you want automatic session sync:

```bash
git agent-sync install-hooks
```

After that, normal project pushes run `git-agent-sync push` first:

```bash
git push
```

## Commands

```bash
git agent-sync init [--remote <url>|<url>] [--store <path>]
git agent-sync status [--json]
git agent-sync list --current [--json]
git agent-sync list --branch <name> [--json]
git agent-sync list --commit <sha> [--json]
git agent-sync scan [--json]
git agent-sync push
git agent-sync pull
git agent-sync restore <bundle-id>
git agent-sync restore --all
git agent-sync restore --current
git agent-sync restore --branch <name>
git agent-sync restore --commit <sha>
git agent-sync install-hooks
git agent-sync doctor
```

`doctor` prints the project root, local config, sidecar store, session roots, remote, project identity, current project id, and legacy ids used for compatibility.

## Cross-Platform Project Identity

Older versions derived `projectId` from the absolute project path. That made the same project look different across Windows, macOS, Linux, or even two folders on the same machine.

Current behavior:

- If the project has a Git remote, `projectId` is derived from a normalized remote URL.
- SSH and HTTPS forms of the same GitHub repo normalize to the same identity.
- If the project has no remote, `projectId` falls back to the repo directory name.
- Old path-based ids are kept in `legacyProjectIds`.
- `pull` and `restore` can find older bundles by legacy id, project identity, or project name.
- New bundles store each session's path relative to its agent root, so restore maps sessions into the current machine's Codex or Claude directory instead of the source machine's absolute path.

Example config:

```json
{
  "projectId": "MokioAgent-1a2b3c4d5e",
  "projectIdentity": "git:github.com/wood-q/mokioagent",
  "legacyProjectIds": ["MokioAgent-f49ebafc58"]
}
```

## Git Context Bindings

Each `push` writes a lightweight historical index at:

```text
.agent-sync-store/
  projects/
    <project-id>/
      bindings.jsonl
```

`manifest.json` remains the latest snapshot. `bindings.jsonl` is used for historical lookup and records the session bundle, branch, `HEAD` commit, `baseCommit`, and whether the project worktree was dirty when the session was synced.

```bash
git agent-sync list --current
git agent-sync list --branch main
git agent-sync list --commit 4f7c2a1
```

Restore can use the same selectors:

```bash
git agent-sync restore --current
git agent-sync restore --branch main
git agent-sync restore --commit 4f7c2a1
```

Commit matching is the primary lookup path. `--current` first matches the current `HEAD` commit, then falls back to the current branch if no commit binding exists. Branches are historical labels from sync time; they do not follow mutable branch pointers. Detached HEAD syncs store `branch: null` and remain queryable by commit.

## Local Files

Initialization creates:

```text
.agent-sync/
.agent-sync-store/
```

Both directories are added to the project `.gitignore`.

`.agent-sync/` stores local machine config and scan cache:

```text
.agent-sync/config.json
.agent-sync/last-scan.json
```

`.agent-sync-store/` is an independent Git repository:

```text
.agent-sync-store/
  projects/
    <project-id>/
      manifest.json
      bindings.jsonl
      codex/
        codex-<hash>.jsonl
      claude/
        claude-<hash>.jsonl
```

## Non-Standard Session Paths

For tests or custom installs, override discovery roots:

```bash
AGENT_SYNC_CODEX_DIR=/path/to/codex/sessions git agent-sync status
AGENT_SYNC_CLAUDE_DIR=/path/to/claude/projects git agent-sync status
```

Windows PowerShell example:

```powershell
$env:AGENT_SYNC_CODEX_DIR="D:\codex-sessions"
git agent-sync status
```

## Troubleshooting

If `pull` says there is no remote, initialize again with a remote:

```bash
git agent-sync init --remote git@github.com:you/agent-session-store.git
```

If `pull` previously failed with "no tracking information", rerun it with the current version. The tool now fetches `origin/main`, checks out or tracks it when needed, then pulls with `--ff-only`.

If `pull` succeeds but no sessions are available, run:

```bash
git agent-sync doctor
find .agent-sync-store/projects -maxdepth 2 -name manifest.json -print
```

This helps confirm whether the remote store contains a bundle for the current project identity or a compatible legacy id.

## Security Note

This MVP copies raw session files. Those files may include secrets, code snippets, local paths, prompts, and terminal output.

Use a private remote. A production version should add default encryption and secret redaction before remote push.
