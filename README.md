# git-agent-sync

`git-agent-sync` is a tiny MVP for syncing local AI coding-agent sessions with a Git sidecar repository.

The intended user experience:

```bash
npm install -g git-agent-sync
cd your-project
git agent-sync init --remote git@github.com:you/agent-session-store.git
git agent-sync install-hooks
git agent-sync push
```

After installation, Git can discover the CLI as a subcommand:

```bash
git agent-sync status
git agent-sync pull
git agent-sync restore --all
```

## What this MVP supports

- Codex session discovery from `~/.codex/sessions/**/*.jsonl`
- Claude Code session discovery from `~/.claude/projects/**/*.jsonl`
- Conservative project matching by current Git root path or repo name in session content
- Sidecar Git store in `.agent-sync-store/` by default
- Optional remote push/pull
- A `pre-push` hook that runs `git-agent-sync push`

It does **not** add `.codex` or `.claude` files to your project commits.

## Commands

```bash
git agent-sync init [--remote <url>] [--store <path>]
git agent-sync status [--json]
git agent-sync push
git agent-sync pull
git agent-sync restore <bundle-id>
git agent-sync restore --all
git agent-sync install-hooks
git agent-sync doctor
```

`install-hooks` writes `.git/hooks/pre-push`, so it needs normal write access to the repository's `.git` directory.

## Local development

```bash
npm install
npm link
git agent-sync --help
```

## Current design

The project keeps a local config at:

```text
.agent-sync/config.json
```

The default sidecar store lives at:

```text
.agent-sync-store/
```

That directory is added to `.gitignore` during `init`.

`.agent-sync/` is also added to `.gitignore`; it stores local machine config and scan cache.

Inside the sidecar repo:

```text
projects/
  <project-id>/
    manifest.json
    codex/
      codex-<hash>.jsonl
    claude/
      claude-<hash>.jsonl
```

## Non-standard session paths

For tests or custom installs, override discovery roots:

```bash
AGENT_SYNC_CODEX_DIR=/path/to/codex/sessions git agent-sync status
AGENT_SYNC_CLAUDE_DIR=/path/to/claude/projects git agent-sync status
```

## Security note

This MVP copies raw session files. Those files may include secrets, code snippets, local paths, prompts, and terminal output.

Use a private remote. A production version should add default encryption and secret redaction before remote push.
