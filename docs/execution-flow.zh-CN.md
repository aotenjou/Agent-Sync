# 工具执行链路

Agent-Sync 的核心链路可以理解为：业务仓库只负责代码，sidecar 仓库只负责 agent 会话。两者通过项目 identity、Git 上下文和 session 元数据关联，但不会把会话文件写进业务仓库历史。

```text
业务仓库
  |
  | 1. init
  v
.agent-sync/config.json
  |
  | 2. scan/status
  v
本机 Codex / Claude session
  |
  | 3. push
  v
.agent-sync-store/
  projects/<projectId>/
    manifest.json
    bindings.jsonl
    codex/*.jsonl
    claude/*.jsonl
  |
  | 4. sidecar git push/pull
  v
私有 session store 远程仓库
  |
  | 5. pull + list/restore
  v
另一台机器的 Codex / Claude session 目录
```

## 1. 初始化：建立项目身份和 sidecar store

运行：

```bash
git agent-sync init --remote git@github.com:yourname/agent-session-store.git
```

工具会做几件事：

- 读取当前业务仓库 Git root。
- 根据业务仓库 remote 生成稳定的 `projectIdentity` 和 `projectId`。
- 创建 `.agent-sync/config.json`，保存当前机器的本地配置。
- 创建 `.agent-sync-store/`，它本身是一个独立 Git 仓库。
- 自动把 `.agent-sync/` 和 `.agent-sync-store/` 写入业务仓库 `.gitignore`。

这一阶段不会复制 session，也不会提交业务仓库代码。

## 2. 扫描：找到属于当前项目的 session

运行：

```bash
git agent-sync status
```

或：

```bash
git agent-sync scan
```

工具会扫描：

- Codex：`~/.codex/sessions/**/*.jsonl`
- Claude Code：`~/.claude/projects/**/*.jsonl`

Codex session 会优先读取 JSONL 里的原生结构字段，例如：

- `session_meta.payload.cwd`
- `session_meta.payload.git.repository_url`
- `session_meta.payload.git.branch`
- `session_meta.payload.git.commit_hash`
- `turn_context.payload.cwd`
- `exec_command.arguments.workdir`

Claude session 暂时继续使用路径、remote、仓库名等文本匹配逻辑。

扫描结果会写入：

```text
.agent-sync/last-scan.json
```

这个文件只是本机缓存，不会进入业务仓库提交。

## 3. 推送：把 session 写入 sidecar 仓库

运行：

```bash
git agent-sync push
```

工具会重新扫描当前项目相关 session，然后把匹配到的文件复制到：

```text
.agent-sync-store/projects/<projectId>/
```

同时写入两个关键索引：

- `manifest.json`：当前项目最新可恢复 session 快照。
- `bindings.jsonl`：历史 Git 上下文索引，用来按 current / branch / commit 查询。

`bindings.jsonl` 会记录：

- session bundle id
- agent 类型
- sidecar 内相对路径
- 原始 session 路径
- branch
- headCommit
- baseCommit
- dirty 状态

对于 Codex session，`branch/headCommit/baseCommit` 会优先使用 session JSONL 自己记录的 Git 元数据；缺失或不属于当前项目时，再回退到 `push` 时业务仓库的 Git 状态。

最后，工具只会在 `.agent-sync-store/` 这个独立 Git 仓库里提交并推送：

```text
业务仓库 Git 历史：不包含 session 文件
sidecar Git 历史：包含 session 备份和索引
```

## 4. 拉取：在另一台机器同步 sidecar store

在另一台机器的同一个业务项目中运行：

```bash
git agent-sync init --remote git@github.com:yourname/agent-session-store.git
git agent-sync pull
```

工具会：

- 初始化本机 `.agent-sync/config.json`。
- 初始化或更新本机 `.agent-sync-store/`。
- 从私有 session store 远程仓库拉取 sidecar 数据。
- 根据当前项目 identity、legacy id、项目名等信息找到兼容的 project bundle。

`pull` 只同步 sidecar store，不会立刻写入 `~/.codex` 或 `~/.claude`。

## 5. 查询：按当前代码位置找到 session

拉取后可以查询：

```bash
git agent-sync list --current
git agent-sync list --branch main
git agent-sync list --commit 4f7c2a1
```

查询规则：

- `--commit <sha>` 匹配 `headCommit` 或 `baseCommit`，支持短 SHA。
- `--branch <name>` 匹配历史记录里的 branch 标签，不解析当前分支指针。
- `--current` 先匹配当前 `HEAD` commit；如果没有结果，再回退到当前 branch。

也就是说，当你切换到某个历史 commit 或 branch 后，可以直接找回当时相关的 agent session。

## 6. 恢复：写回当前机器的 agent session 目录

运行：

```bash
git agent-sync restore --current
git agent-sync restore --branch main
git agent-sync restore --commit 4f7c2a1
git agent-sync restore --all
```

工具会从 sidecar store 读取 session 文件，并恢复到当前机器对应目录：

- Codex：`~/.codex/sessions/...`
- Claude Code：`~/.claude/projects/...`

Codex session 默认会在恢复时做轻量跨平台适配：

- 把源机器项目根路径映射为当前业务仓库根路径。
- 把 Windows shell 与 POSIX shell 做安全切换。
- 修正 `cwd`、`workdir`、结构化命令参数和 transcript 里的项目路径。
- 不修改 sidecar store 中的原始 session 文件。
- 不翻译 PowerShell / bash / zsh 命令语法。

如果需要完全原样恢复，可以使用：

```bash
git agent-sync restore --current --no-adapt
```

## 7. 诊断：检查整条链路是否健康

运行：

```bash
git agent-sync doctor
```

`doctor` 会检查：

- 当前 Git root
- 本地配置是否存在
- sidecar store 是否存在
- sidecar remote 是否可达
- sidecar 当前分支和 upstream
- `manifest.json` 是否可读
- `bindings.jsonl` 是否可读、有无坏行
- Codex / Claude session 目录是否存在
- 当前能看到多少 agent session 文件

如果 `pull` 后找不到 session，或者 `restore` 没有恢复出预期文件，优先看 `doctor` 输出。
