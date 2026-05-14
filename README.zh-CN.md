# git-agent-sync

`git-agent-sync` 是一个 Git 风格的 AI 编程会话同步工具 MVP。

它的目标是解决一个很具体的问题：代码可以通过 `git clone` 到另一台机器，但 Codex、Claude Code 这类 code agent 的本地会话不会跟着过去。

这个工具会扫描本机的 Codex / Claude Code 会话文件，找出和当前 Git 项目相关的会话，然后把它们同步到一个专门的私有 Git 仓库里。

> 口号：Git for your AI coding sessions.

## 当前 MVP 能做什么

- 作为 Git 子命令使用：`git agent-sync ...`
- 扫描 Codex 会话：`~/.codex/sessions/**/*.jsonl`
- 扫描 Claude Code 会话：`~/.claude/projects/**/*.jsonl`
- 根据当前 Git 项目的路径或仓库名匹配相关会话
- 把匹配到的会话文件复制到 sidecar Git 仓库
- 支持绑定一个私有远程仓库专门存放会话
- 支持 `pre-push` hook，在 `git push` 前自动同步会话
- 不会把 `.codex` / `.claude` 文件加入业务项目的 Git 提交

## 安装

本地开发阶段：

```bash
cd E:\WOODQPersonal\Agent-Sync
npm link
```

之后在任意 Git 项目里就可以使用：

```bash
git agent-sync --help
```

如果发布到 npm 后，用户可以这样安装：

```bash
npm install -g git-agent-sync
```

## 推荐使用方式：专门建一个私有仓库

建议新建一个单独的私有仓库，比如：

```text
agent-session-store
my-agent-history
ai-coding-sessions
```

不要直接把会话存进业务代码仓库。会话里可能包含私有代码、API key、终端输出、本地路径、prompt 和调试信息。

假设你的私有仓库地址是：

```bash
git@github.com:yourname/agent-session-store.git
```

进入某个业务项目：

```bash
cd E:\YourProject
```

初始化并绑定远程仓库：

```bash
git agent-sync init --remote git@github.com:yourname/agent-session-store.git
```

查看当前能识别到哪些会话：

```bash
git agent-sync status
```

同步到私有仓库：

```bash
git agent-sync push
```

在另一台机器上：

```bash
cd E:\YourProject
git agent-sync init --remote git@github.com:yourname/agent-session-store.git
git agent-sync pull
git agent-sync restore --all
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

hook 会在 push 前自动运行：

```bash
git-agent-sync push
```

## 命令列表

```bash
git agent-sync init [--remote <url>] [--store <path>]
git agent-sync status [--json]
git agent-sync scan [--json]
git agent-sync push
git agent-sync pull
git agent-sync restore <bundle-id>
git agent-sync restore --all
git agent-sync install-hooks
git agent-sync doctor
```

## 本地目录结构

初始化后，业务项目里会出现：

```text
.agent-sync/
.agent-sync-store/
```

这两个目录会自动加入 `.gitignore`。

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
