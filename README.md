# git-agent-sync

`git-agent-sync` is a Git-style helper for syncing local AI coding-agent sessions through a separate private Git repository.

It solves one specific problem: source code can move with `git clone`, but local Codex and Claude Code conversations normally stay on the machine where they were created.

## What It Does

- Scans Codex sessions in `~/.codex/sessions/**/*.jsonl`
- Skips archived Codex sessions by default: `~/.codex/archived_sessions/**/*.jsonl` and threads marked `archived = 1` in `state_5.sqlite`
- Scans Claude Code sessions in `~/.claude/projects/**/*.jsonl`
- Uses local mtime/size/hash caches so unchanged session files are not reread on every scan
- Matches Codex sessions only through native JSONL metadata; sessions missing project `git/cwd/workdir` metadata or recording another Git remote / project path are rejected
- Copies matched sessions into a sidecar Git repo at `.agent-sync-store/`
- Pushes and pulls that sidecar repo without adding sessions to your project commits
- Restores pulled sessions back into the local Codex or Claude session directory
- Adapts restored Codex sessions across operating systems without changing the sidecar source
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
git agent-sync restore --current 1
git agent-sync restore --branch <name>
git agent-sync restore --branch <name> 1
git agent-sync restore --commit <sha>
git agent-sync restore --commit <sha> 1
git agent-sync restore --current --no-adapt
git agent-sync install-hooks
git agent-sync doctor
```

`doctor` prints `ok` / `warn` / `fail` checks for the project root, config, sidecar store, remote reachability, sidecar branch/upstream, manifest, bindings, resolved Codex / Claude session roots, project identity, current project id, and legacy ids used for compatibility.
It also shows archived Codex thread counts so you can confirm archived sessions are not being treated as active sync candidates.

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

For Codex sessions, new bindings prefer the Git context that Codex already saved inside the session JSONL. Agent-Sync reads `session_meta.payload.git.commit_hash`, `session_meta.payload.git.branch`, and `session_meta.payload.git.repository_url`, then falls back to the business repo's Git state at push time when those fields are missing or do not belong to the current project. `dirty` is still taken from the business repo at push time because Codex sessions do not provide a reliable per-session dirty flag.

```bash
git agent-sync list --current
git agent-sync list --branch main
git agent-sync list --commit 4f7c2a1
```

Human-readable output shows the conversation title first and numbers each result. `--json` keeps returning the raw machine-readable bindings.

Restore can use the same selectors:

```bash
git agent-sync restore --current
git agent-sync restore --branch main
git agent-sync restore --commit 4f7c2a1
```

When a selector matches multiple sessions, append the displayed number to restore only one:

```bash
git agent-sync restore --current 1
git agent-sync restore --branch main 2
git agent-sync restore --commit 4f7c2a1 3
```

Commit matching is the primary lookup path. `--current` first matches the current `HEAD` commit, then falls back to the current branch if no commit binding exists. Branches are historical labels from sync time; they do not follow mutable branch pointers. Detached HEAD syncs store `branch: null` and remain queryable by commit.

## Cross-Platform Restore Adaptation

Codex session files can contain the shell, working directory, and project-root paths used on the source machine. For example, a session created on Windows may contain `powershell.exe` and `C:\...\MokioAgent` paths. When restored on macOS or Linux, those stale references can make the continued session try to use a missing terminal or a project directory that does not exist.

By default, `restore` keeps the sidecar source file unchanged and adapts only the restored local Codex copy when it detects a cross-platform session:

- `session_meta.payload.cwd`, `turn_context.payload.cwd`, and `event_msg.payload.cwd` are mapped to the current project root.
- `exec_command` function-call `workdir` is mapped to the current project root.
- `exec_command` function-call `shell` is mapped to the current machine shell, such as `$SHELL` on macOS or Linux.
- Source project-root path references inside transcript strings, command arguments, outputs, sandbox metadata, and edited-file lists are mapped to the current project root.
- Command syntax is not translated. A historical PowerShell command remains a PowerShell command in the transcript, but any embedded source project path is remapped.
- Restored Codex sessions get an `agentSyncAdapted` marker in `session_meta.payload` for auditability.

To restore the exact sidecar file without any local adaptation:

```bash
git agent-sync restore --current --no-adapt
git agent-sync restore --commit 4f7c2a1 --no-adapt
```

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
.agent-sync/scan-cache.json
.agent-sync/archive-cache.json
```

`last-scan.json` is the latest human-readable scan result. `scan-cache.json` is an internal file index keyed by mtime, size, and hash, so unchanged session files can be reused without rereading their contents. `archive-cache.json` stores the Codex archived-session set and refreshes only when `state_5.sqlite` or `archived_sessions/` changes.

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

## Source Layout

The CLI entrypoint is intentionally small. `src/cli.js` handles command dispatch, while the behavior lives in focused modules:

```text
src/
  args.js            # CLI argument and selector validation
  agents.js          # Codex / Claude discovery and scan matching
  bindings.js        # Git context binding history
  scan-cache.js      # Incremental session scan cache
  codex-archive.js   # Codex archived-session detection and cache
  codex-session.js   # Codex JSONL metadata extraction and restore adaptation
  config.js          # Local project config and identity
  git.js             # Git root, remote, and worktree context
  restore.js         # Restore flow and target paths
  store.js           # Sidecar Git store and manifest
  utils.js           # Shared JSON, hash, path, and walk helpers
```

Codex scanning and restore adaptation follow Codex's native JSONL shape. The extractor reads per-session facts from `session_meta.payload.cwd`, `session_meta.payload.git`, `turn_context.payload.cwd`, and `response_item.payload.arguments.workdir`. Restore path mapping uses those structured fields first, then scans transcript strings only as a fallback, while skipping opaque fields such as `encrypted_content`.

Codex project ownership is strict and based only on structured metadata: `repository_url` must match the current project remote, and `cwd` / `workdir` must not include another project path. A session that belongs to another Git repository, another project path, multiple project workdirs, or has no structured project metadata is skipped even if its transcript text mentions this project name, and restore applies the same guard before writing into the local Codex directory.

Agent-Sync intentionally does not use these `.codex` files as core project/session truth:

- `session_index.jsonl` only contains session id, title, and update time, so it is useful for future display but not for project ownership.
- `config.toml` contains trusted project paths and user settings, but it is not a per-session record.
- `.codex-global-state.json` is app/UI state and can include personal history unrelated to a project.
- `shell_snapshots/` can be large and privacy-sensitive, so it is not part of default MVP sync.

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

## Development Checks

Run the full MVP test suite:

```bash
npm run test
```

The suite includes:

- `npm run check`: JavaScript syntax checks and `git diff --check`.
- `npm run smoke`: CLI entrypoint help output.
- `npm run test:bindings`: `bindings.jsonl` compatibility and invalid-line handling.
- `npm run test:codex-session`: Windows / macOS / Linux style Codex path adaptation.
- `npm run test:scan-cache`: unchanged session files are reused from the local scan cache.
- `npm run test:archive-cache`: archived Codex session sets are reused until archive state changes.
- `npm run test:e2e`: two temporary project clones plus a bare sidecar remote, covering `push`, `pull`, `list --current`, `list --branch`, `list --commit`, `restore`, `doctor`, and verification that `.agent-sync-store` is not tracked by the business repo.

## Troubleshooting

Start with:

```bash
git agent-sync doctor
```

`doctor` reports whether the sidecar remote is reachable, whether the sidecar store is on the expected branch, whether `manifest.json` and `bindings.jsonl` are readable, and how many local agent session files are visible.

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
