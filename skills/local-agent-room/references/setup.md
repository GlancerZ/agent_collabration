# 安装、配置与排错

## 需要什么

- Python 3.8 以上，只用标准库。不需要 Node、Slack、数据库或任何常驻进程。
- 至少一个已登录的 CLI：Codex CLI（`codex`）或 Claude Code（`claude`）。
  - 主持人模式要求**对方**的 CLI 在本机能以非交互方式调用（`codex exec` 或 `claude -p`）。
  - 对方只有交互式会话时用双开模式，这时不需要任何 CLI 可被调用。

## 安装

skill 目录整个复制过去即可，两个 agent 用同一份文件：

```sh
git clone https://github.com/GlancerZ/agent_collabration.git
cd agent_collabration

# Claude Code（个人级；也可以放进项目的 .claude/skills/）
mkdir -p ~/.claude/skills && cp -R skills/local-agent-room ~/.claude/skills/

# Codex CLI
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills" && cp -R skills/local-agent-room "${CODEX_HOME:-$HOME/.codex}/skills/"
```

已有同名目录时先比较差异再覆盖。安装只是复制文件：不启动任何东西，不修改两个 CLI 的配置。

装完检查环境（不调用模型）：

```sh
python3 ~/.claude/skills/local-agent-room/scripts/room.py doctor
```

## 聊天室放在哪

- 一个话题一个聊天室，放在项目目录下的 `.agent-room/<话题>/`，并把 `.agent-room/` 加进 `.gitignore`。
- 用环境变量 `AGENT_ROOM` 或每条命令的 `--room` 指定。两个 agent 必须指向同一个目录。
- 目录权限是 0700。聊天室里是普通 JSON 文件，可以直接看，也可以整个目录归档或删除。
- 可以放在共享文件系统上（GPFS、Lustre、NFS）。消息序号用硬链接原子分配，多个进程同时写不会重号；不支持硬链接的文件系统自动退回独占创建。

```
<聊天室>/
  room.json             主题、规则、对方 CLI 的可选配置
  messages/000001.json  每条消息一个文件
  cursors/<名字>.json   每个参与者读到了哪一条
  sessions/<名字>.json  ask 记下的对方会话 id，用于续接
  calls/                每次 ask 的提示词、完整命令、耗时、退出码、最后一条回复
```

## 写入限制靠什么保证

`ask` 默认让对方只读。“只读”由系统强制，不只是提示词里的一句话。脚本每次调用前自动判断用哪一种，`doctor` 会显示结果，每条回复的 `meta.isolation` 和 `calls/` 里的记录也会写明。

| 方式 | 何时使用 | 只读时 | `--write` 时 |
| --- | --- | --- | --- |
| `sandbox` | Codex 自带沙箱可用：macOS，或允许 user namespace 的 Linux | Codex 的 `read-only` 沙箱 | `workspace-write`：只能写工作目录 |
| `landlock` | Linux 上 Codex 沙箱起不来，但内核支持 Landlock | 内核拒绝一切写入，例外见下 | 额外允许写 `--cd` 指定的工作目录 |
| `tools` | 对方是 Claude Code | 只给 Read、Grep、Glob | 再加 Edit、Write；始终没有 Bash |
| `none` | 加了 `--unsandboxed` | 没有任何系统级限制 | 同左 |

### HPC 登录节点

很多集群关闭了 user namespace（`cat /proc/sys/user/max_user_namespaces` 是 0）。Codex 自带的 bubblewrap 沙箱在这种机器上建不起来，报 `bwrap: Creating new namespace failed`，结果是沙箱模式下 Codex 一条命令都执行不了，连读文件都不行。常见的应对是把 Codex 配成 `danger-full-access`，但那样就没有任何限制了。

这个 skill 的做法是用 `scripts/ro_exec.py` 给 Codex 进程套上 Linux Landlock：不需要 root，不需要 user namespace，由内核拒绝写入，Codex 和它启动的所有子进程都绕不过去。Codex 本身以 `danger-full-access` 运行（否则它会去启动 bubblewrap），实际的限制来自 Landlock。

Landlock 模式下仍然可写的只有：

- Codex 自己的状态目录（`$CODEX_HOME`，默认 `~/.codex`），它要在这里存会话和日志；
- 临时目录（`$TMPDIR` 和 `/tmp`）以及 `/dev`；
- 聊天室的 `calls/` 目录；
- 加了 `--write` 时的工作目录；
- `room.json` 里 `peers.codex.writable` 额外列出的目录。

要知道的两点：Landlock 只拦改动文件系统的操作，**不拦读取和联网**；需要内核 5.13 以上并启用 landlock（`cat /sys/kernel/security/lsm` 里能看到）。两种方式都不可用时，`ask` 会拒绝执行并说明原因，这时只有用户明确同意才能加 `--unsandboxed`。

`ro_exec.py` 也可以单独使用：

```sh
python3 scripts/ro_exec.py --probe
python3 scripts/ro_exec.py --allow-write /tmp --allow-write /dev -- <任意命令>
```

## 可选配置

环境变量：

| 变量 | 作用 |
| --- | --- |
| `AGENT_ROOM` | 聊天室目录 |
| `AGENT_ROOM_CODEX_BIN`、`AGENT_ROOM_CLAUDE_BIN` | 对方 CLI 的路径，不在 `PATH` 里时用 |
| `AGENT_ROOM_ISOLATION` | 强制 `sandbox` 或 `landlock`，跳过自动判断 |
| `AGENT_ROOM_ROLE` | 当前进程是谁（`claude` 或 `codex`），用来拦住以对方身份发言的误操作 |

`room.json` 里的 `peers`（手工编辑）：

```json
{
  "peers": {
    "codex": {"bin": "codex", "extra_args": [], "isolation": "landlock", "writable": ["/path/extra"]},
    "claude": {"bin": "/absolute/path/claude", "extra_args": []}
  }
}
```

`extra_args` 原样追加到对方的命令上。脚本不修改两个 CLI 的全局配置，模型沿用各自已有的设置；需要指定时用 `ask --model`。

## 调用对方时实际执行的命令

```sh
# Codex（sandbox 方式；landlock 方式在前面加上 ro_exec.py，并把 sandbox_mode 换成 danger-full-access）
codex exec [resume <会话>] --json --skip-git-repo-check -o <输出文件> \
  -c 'approval_policy="never"' -c 'sandbox_mode="read-only"' -

# Claude Code
claude -p --output-format json --permission-mode dontAsk --allowedTools Read,Grep,Glob [--resume <会话>]
```

提示词从标准输入传入。子进程的环境变量里去掉了另一家 agent 的变量（例如调用 Codex 时去掉所有 `CLAUDE_*`、`ANTHROPIC_*`）和名字像凭据的变量（含 `TOKEN`、`SECRET`、`PASSWORD`、`API_KEY`、`CREDENTIAL`），对方自己的变量保留。`ask --dry-run` 可以只看命令和提示词，不发消息也不调用。

CLI 升级后参数可能变化。先看 `codex exec --help` 和 `claude --help`，再用 `extra_args` 调整；不要因为某个参数不认识就退回到无限制运行。

## 排错

| 现象 | 原因和处理 |
| --- | --- |
| `找不到 codex/claude 的命令行程序` | 对方的 CLI 不在 `PATH` 里。设置 `AGENT_ROOM_*_BIN`，或改用双开模式 |
| `自带的沙箱和内核 Landlock 都不可用` | 这台机器没法从系统层面保证只读。只有用户同意才能加 `--unsandboxed` |
| `当前进程看起来是 X，不能以 Y 的身份发言` | 你在替对方或替用户发言。用自己的名字发 |
| 调用失败并提示登录、401、额度 | 需要用户在本机重新登录或等额度恢复。不要换账户或换模型绕过 |
| Landlock 下对方报 `Permission denied` | 只读生效了，这是预期行为。确实要写时取得用户同意后用 `--write`，或在 `peers.codex.writable` 里加目录 |
| 对方超时 | 默认 900 秒。把问题拆小，或用 `--timeout` 调大；超时的调用已被中止，聊天室里有记录 |
| 续接会话失败 | 脚本会自动改用新会话重试一次。也可以手动加 `--fresh` |
| `agree 只能指向 proposal` | 表态必须 `--reply-to` 一条别人提出的 proposal |
| 对方回复了但 proposal 仍是待表态 | 它没有给出明确的 `VERDICT: agree #N`。再问一次，或在汇报里如实说明 |

## 验证范围

回归测试用假的 CLI，不调用模型，也不联网：

```sh
python3 tests/test_room.py
```

它覆盖：并发写入不重号、未读游标、身份检查、proposal 状态、四种 ask 模式、封存与篡改检测、会话续接与失败重试、环境变量清理、三种写入限制的选择和 Landlock 的实际拦截。测试通过说明聊天室和调用流程的逻辑正确，不说明真实 CLI 在你的机器上可用。

换机器或升级 CLI 后，用一次真实的小调用确认：

```sh
$ROOM init --topic 连通性测试 && $ROOM doctor
$ROOM ask --as claude --peer codex "连通性测试：请读取工作目录下 README.md 的第一行并原样告诉我。"
```

2026-11-10 在一台 HPC 登录节点上的实测（aarch64 Linux，内核 5.14，GPFS，`max_user_namespaces=0`，Python 3.9 和 3.12，codex-cli 0.163.0）：

- 回归测试 20 项全部通过。
- 真实调用 Codex 成功：新会话、续接会话（对方记得上一个问题）、Landlock 方式下读取实际文件并执行只读命令。
- Landlock 拦截生效：允许目录之外的写入、建目录、移动文件和追加都被内核拒绝，子进程的子进程同样被拒绝。

没有实测的部分：把 Claude Code 当作对方来调用（那台机器的 `PATH` 里没有 `claude`，命令按官方的非交互参数编写，只用假 CLI 测过）；macOS；Codex 自带沙箱可用时的真实调用。在这些环境里第一次使用前先跑上面的小调用。

## 和 slack-dual-agent 的关系

同一个仓库里的 `skills/slack-dual-agent/` 是原来的版本：一个 Node 24 常驻协调程序，用 Slack 频道收任务，带本机管理页、SQLite、浏览器和 Mac 桌面能力。它适合团队在 Slack 里发任务、需要自动跑完整流水线的场景。

`local-agent-room` 保留了它的协作规则：独立作答不偷看、凭证据验收、同意要对着具体版本、轮数有上限、追问先分流。去掉的是 Slack、常驻进程、网页和附加能力模块。两者互不依赖，可以同时安装。
