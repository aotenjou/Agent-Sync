# git-agent-sync

`git-agent-sync` 是一个 Git 风格的 AI 编程会话同步工具。

它解决一个很具体的问题：业务代码可以通过 `git clone` 到另一台机器，但 Codex、Claude Code 这类 code agent 的本地会话通常不会跟过去。

这个工具会扫描本机的 Codex / Claude Code 会话，找出和当前 Git 项目相关的文件，然后同步到一个独立的私有 Git 仓库里。

> Git for your AI coding sessions.

## 当前能力

- 作为 Git 子命令使用：`git agent-sync ...`
- 扫描 Codex 会话：`~/.codex/sessions/**/*.jsonl`
- 扫描 Claude Code 会话：`~/.claude/projects/**/*.jsonl`
- 根据项目路径、仓库名、业务仓库 remote 匹配相关会话
- 把匹配到的会话复制到 sidecar Git 仓库 `.agent-sync-store/`
- 支持把 sidecar 仓库推送到专门的私有远程仓库
- 支持在另一台机器拉取 sidecar 仓库并恢复会话
- 支持恢复时对跨平台 Codex session 做轻量适配，不修改 sidecar 原文件
- 为每次同步的 session 记录轻量 Git 上下文绑定
- 支持按当前 Git 状态、branch、commit 查询或恢复 session
- 支持 `pre-push` hook，在业务仓库 `git push` 前自动同步会话
- 使用业务仓库 remote 生成跨平台稳定的 `projectId`
- 兼容旧版本按本地绝对路径生成的历史 bundle
- 不会把 `.codex` / `.claude` 文件加入业务项目的 Git 提交

## 安装

本地开发阶段：

```bash
cd ~/Agent-Sync
npm install
npm link
git agent-sync --help
```

发布到 npm 后：

```bash
npm install -g git-agent-sync
```

## 完整使用流程

先创建一个专门保存 agent 会话的私有仓库，例如：

```text
git@github.com:yourname/agent-session-store.git
```

不要直接把会话存进业务代码仓库。会话里可能包含私有代码、API key、终端输出、本地路径、prompt 和调试信息。

在已有会话的机器上：

```bash
cd your-project
git agent-sync init --remote git@github.com:yourname/agent-session-store.git
git agent-sync status
git agent-sync push
```

在另一台机器上：

```bash
git clone git@github.com:yourname/your-project.git
cd your-project
git agent-sync init --remote git@github.com:yourname/agent-session-store.git
git agent-sync pull
git agent-sync list --current
git agent-sync restore --all
```

`init` 也支持把远程地址作为第一个位置参数：

```bash
git agent-sync init git@github.com:yourname/agent-session-store.git
```

## 自动同步

安装 Git hook：

```bash
git agent-sync install-hooks
```

它会写入：

```text
.git/hooks/pre-push
```

之后你正常执行：

```bash
git push
```

hook 会先运行：

```bash
git-agent-sync push
```

## 命令列表

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
git agent-sync restore --current --no-adapt
git agent-sync install-hooks
git agent-sync doctor
```

`doctor` 会输出 Git 项目根目录、本地配置、sidecar store、Codex / Claude 目录、远程仓库、项目 identity、当前 `projectId` 和兼容旧数据使用的 legacy id。

## 跨平台项目身份

旧版本用“业务项目本地绝对路径”计算 `projectId`。这会导致同一个项目在 Windows、macOS、Linux，甚至同一台机器的不同目录下生成不同 ID。

现在的规则：

- 如果业务项目配置了 Git remote，优先用规范化后的 remote URL 生成 `projectId`
- 同一个 GitHub 仓库的 SSH / HTTPS 地址会规范化成同一个 identity
- 如果业务项目没有 remote，则退回用目录名生成 identity
- 旧版路径生成的 ID 会保存在 `legacyProjectIds`
- `pull` 和 `restore` 会按当前 ID、legacy ID、项目 identity、项目名查找兼容 bundle
- 新备份会记录会话相对于 agent 根目录的路径，恢复时映射到当前机器的 Codex / Claude 目录，而不是源机器的绝对路径

示例配置：

```json
{
  "projectId": "MokioAgent-1a2b3c4d5e",
  "projectIdentity": "git:github.com/wood-q/mokioagent",
  "legacyProjectIds": ["MokioAgent-f49ebafc58"]
}
```

## Git 上下文绑定

每次 `push` 会在 sidecar project bundle 中写入一个轻量历史索引：

```text
.agent-sync-store/
  projects/
    <project-id>/
      bindings.jsonl
```

`manifest.json` 仍然表示最新快照。`bindings.jsonl` 用于历史查询，会记录 session bundle、同步时的 branch、`HEAD` commit、`baseCommit`，以及业务工作区当时是否 dirty。

```bash
git agent-sync list --current
git agent-sync list --branch main
git agent-sync list --commit 4f7c2a1
```

恢复命令也支持相同 selector：

```bash
git agent-sync restore --current
git agent-sync restore --branch main
git agent-sync restore --commit 4f7c2a1
```

commit 是主要查询锚点。`--current` 会先匹配当前 `HEAD` commit；如果没有结果，再回退匹配当前 branch。branch 只是同步发生时的历史标签，不代表会跟随可变分支指针。detached HEAD 同步时会记录 `branch: null`，仍然可以通过 commit 查询。

## 跨平台恢复适配

Codex session 文件里可能记录创建会话时的 shell 和工作目录。例如 Windows 上创建的 session 可能包含 `powershell.exe` 和 `C:\...` 路径。把这类 session 恢复到 macOS 或 Linux 后，如果这些环境字段不变，继续会话时就可能一直尝试使用错误的终端。

默认情况下，`restore` 不会修改 sidecar store 中的原始文件，只会在检测到跨平台 Codex session 时适配恢复到本机的副本：

- `session_meta.payload.cwd`、`turn_context.payload.cwd`、`event_msg.payload.cwd` 会映射为当前业务仓库根目录。
- `exec_command` function call 里的 `workdir` 会映射为当前业务仓库根目录。
- `exec_command` function call 里的 `shell` 会映射为当前机器 shell，例如 macOS / Linux 上的 `$SHELL`。
- 不会翻译 `cmd` 命令正文。历史 PowerShell 命令仍然会作为历史 transcript 保留。
- 恢复后的 Codex session 会在 `session_meta.payload` 写入 `agentSyncAdapted` 标记，方便后续审计。

如果你需要完全按 sidecar 原文件恢复，不做任何本机适配：

```bash
git agent-sync restore --current --no-adapt
git agent-sync restore --commit 4f7c2a1 --no-adapt
```

## 本地目录结构

初始化后，业务项目里会出现：

```text
.agent-sync/
.agent-sync-store/
```

这两个目录会自动加入业务项目 `.gitignore`。

`.agent-sync/` 存本地配置和扫描缓存：

```text
.agent-sync/config.json
.agent-sync/last-scan.json
```

`.agent-sync-store/` 是一个独立的 sidecar Git 仓库，用来存会话备份：

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

## 自定义会话路径

如果你的 Codex 或 Claude Code 会话不在默认路径，可以用环境变量覆盖：

```bash
AGENT_SYNC_CODEX_DIR=/path/to/codex/sessions git agent-sync status
AGENT_SYNC_CLAUDE_DIR=/path/to/claude/projects git agent-sync status
```

Windows PowerShell 示例：

```powershell
$env:AGENT_SYNC_CODEX_DIR="D:\codex-sessions"
git agent-sync status
```

## 排查问题

如果 `pull` 提示没有 remote，重新初始化并传入远程仓库：

```bash
git agent-sync init --remote git@github.com:yourname/agent-session-store.git
```

如果旧版本曾经报“当前分支没有跟踪信息”，升级后重新运行：

```bash
git agent-sync pull
```

当前版本会自动 fetch `origin/main`，在需要时创建或绑定本地 `main -> origin/main`，然后再执行 fast-forward pull。

如果 `pull` 成功但没有显示可恢复会话，运行：

```bash
git agent-sync doctor
find .agent-sync-store/projects -maxdepth 2 -name manifest.json -print
```

这可以确认远程 store 里是否有当前项目 identity 或旧版 legacy id 对应的 bundle。

## 隐私提醒

当前 MVP 会复制原始会话文件，还没有加密和脱敏。

请务必使用私有仓库。

后续建议加入：

- `--encrypt`：用 `age` 或 GPG 加密后再提交
- secret redaction：自动过滤 API key、token、私钥片段
- 会话 transcript：生成可读 Markdown
- 冲突处理：多机器同一会话变更时保留双版本

## 发布到 npm

发布前先确认包名是否可用：

```bash
npm view git-agent-sync
```

如果返回 `404`，通常表示包名还没人用。

登录 npm：

```bash
npm login
```

检查即将发布的文件：

```bash
npm pack --dry-run
```

运行 smoke test：

```bash
npm run smoke
```

发布公开包：

```bash
npm publish --access public
```

发布成功后，其他人就可以安装：

```bash
npm install -g git-agent-sync
```

然后使用：

```bash
git agent-sync --help
```

## npm 发布前检查清单

- 修改 `package.json` 里的 `repository`、`bugs`、`homepage`
- 确认 `name` 没有被占用
- 确认 `version` 是新的版本号
- 确认 `bin/git-agent-sync.js` 第一行是 `#!/usr/bin/env node`
- 确认 `npm pack --dry-run` 里没有包含敏感文件
- 确认 npm 账号已经开启 2FA，或使用符合 npm 要求的 granular access token
- 确认远程 GitHub 仓库是公开项目仓库，session store 仓库仍然应该是私有仓库
