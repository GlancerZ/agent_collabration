# Agent Collaboration Skills

让本机的 **Codex CLI** 和 **Claude Code** 协作的两个 skill。两者都使用你已有的 CLI 登录和额度，不需要新的模型 API Key。

| | [local-agent-room](skills/local-agent-room/SKILL.md)（推荐） | [slack-dual-agent](skills/slack-dual-agent/SKILL.md) |
| --- | --- | --- |
| 交流渠道 | 本地目录里的文件聊天室 | Slack 频道 |
| 需要 | Python 3.8+ | Node.js 24+、两个 Slack app、常驻协调程序 |
| 谁来主持 | 你正在对话的那个 agent，带着完整上下文 | 协调程序，两个 agent 都以非交互方式运行 |
| 适合 | 个人使用、服务器和 HPC 登录节点、要第二意见或交叉检查 | 团队在 Slack 里发任务，自动跑完整的制作流水线 |
| 附加能力 | 无 | SSH、Playwright 浏览器、Mac 桌面 |

## local-agent-room：本地聊天室

两个 agent 和你共用一个目录当聊天室，每条消息一个文件，全程留痕。没有 Slack、没有后台进程、没有网络端口。

- **评审**：一方只读检查另一方的方案、结果或代码，意见要带证据。
- **独立作答后比较**：一方先封存自己的答案，另一方看不到它就作答，然后公开比较。
- **讨论并确认结论**：结论作为 proposal 提出，另一方必须对这个具体版本明确同意或不同意。不同意就修改后再发，直到对方同意；谈不拢时把分歧逐条告诉你。汇报的第一句是“已达成一致”还是“未达成一致”，由 `room.py outcome` 判定。
- **默认只读，由系统强制**：优先用 Codex 自带沙箱；沙箱起不来的机器（例如关闭了 user namespace 的 HPC 登录节点）改用内核 Landlock。
- **用户的规则自动传给对方**：写进聊天室的规则，每次调用都会带上。
- **你随时能看、能插话**：终端里 `room.py tail` 实时查看，`room.py post --as user` 发言。

### 安装

```sh
git clone https://github.com/GlancerZ/agent_collabration.git
cd agent_collabration
mkdir -p ~/.claude/skills && cp -R skills/local-agent-room ~/.claude/skills/
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills" && cp -R skills/local-agent-room "${CODEX_HOME:-$HOME/.codex}/skills/"
```

然后在 Claude Code 或 Codex 里直接说：

```text
让 Codex 也看一下这个方案，你们讨论后告诉我结论和分歧。
```

### 手动使用

```sh
ROOM="python3 skills/local-agent-room/scripts/room.py"
export AGENT_ROOM=$PWD/.agent-room/demo

$ROOM init --topic "方案复核" --rule "不修改任何文件"
$ROOM doctor                                   # 检查环境，不调用模型
$ROOM ask --as user --peer codex --mode review --ref plan.md "请复核 plan.md。"
$ROOM status
$ROOM outcome                                  # 双方是否已达成一致；没有就列出分歧
$ROOM log --out transcript.md
```

文档：[SKILL.md](skills/local-agent-room/SKILL.md) · [协作流程](skills/local-agent-room/references/protocol.md) · [安装、配置与排错](skills/local-agent-room/references/setup.md)

回归测试用假的 CLI，不调用模型：

```sh
python3 tests/test_room.py
```

## slack-dual-agent：Slack 版

在一个 Slack 频道中，使用现有 Codex CLI + Claude Code 执行任务、交换意见并给出明确结果。包含中文操作协议、可运行的本机协调程序、Slack manifests、管理界面和回归测试。

- **独立模式**：分别完成并展示原始成果，互评修订、比较优点，最后整合为更好的结果并独立复查。
- **协作模式**：交换计划、分工执行、整合与复查。
- **讨论决策**：直接形成明确共同结论，保留理由、条件和分歧，不强制文件。
- **自然追问**：看结果/问状态直接答复，真正修改才继续必要阶段。
- **完成通知**：Codex 在原讨论串通知并广播 @发起者，说明如何继续需求。
- **可选能力**：依赖安装、已有 SSH alias、独立 Playwright 浏览器、目标 Mac 已支持的官方 Computer Use 适配。

两位保留各自账户、session和目录。默认一次执行一个任务，其余排队，任务内两位可并行。无需 Docker。

### 安装

克隆后复制技能目录（已有同名目录时先检查差异）：

```sh
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
cp -R skills/slack-dual-agent "${CODEX_HOME:-$HOME/.codex}/skills/"
```

在支持本机 skill 的 Codex 调用：

```text
使用 $slack-dual-agent 在本机搭建 Slack 双 agent 系统。
使用现有 Codex CLI 和 Claude Code，先核对账户与模型来源。
```

### 准备运行目录

需要 Node.js 24+、Git 和两个已登录的 CLI。以下仅创建新目录和本机初始配置，默认不启用 Slack 或附加能力：

```sh
node skills/slack-dual-agent/scripts/check-package.mjs
node skills/slack-dual-agent/scripts/materialize.mjs --destination /absolute/path/agent-room
cd /absolute/path/agent-room
npm ci --ignore-scripts --no-audit --no-fund
node src/main.js doctor
node src/manage.js start
```

打开 `http://127.0.0.1:7417`，按 [搭建指南](skills/slack-dual-agent/references/setup.md) 安装两个 Slack app，在本机填凭据与允许列表，邀请 bot 到指定公开频道，再连接。

```text
@Codex independent 设计一个番茄钟网页
@Codex collaborate 讨论两个方案，给出共同认可的建议，不需要文件
```

只 @Codex 一次。新任务频道另发；查看、解释、修改和 `pause/resume/cancel/status` 在原串继续。验收要求可选。

运行目录 `npm test` 做回归，`npm run demo` 不调用模型/Slack，`node smoke.js` 用 CLI 额度做真实小任务。模拟测试不能证明实际连接。

系统在本机运行，成果链接默认仅本机可访问，未发布公网。Mac 桌面适配依赖当地官方 Computer Use、访问上下文和原生审批，普通 CLI 不保证可用。

## 目录

```text
skills/local-agent-room/
  SKILL.md                    技能入口
  agents/openai.yaml          展示元数据
  references/                 协作流程；安装、配置与排错
  scripts/room.py             聊天室和调用对方 CLI 的全部逻辑（单文件，只用标准库）
  scripts/ro_exec.py          用 Landlock 限制写入的包装脚本
skills/slack-dual-agent/
  SKILL.md                    技能入口
  agents/openai.yaml          展示元数据
  references/                 接入、协议、身份、能力、维护
  scripts/                    校验与无覆盖材料化脚本
  assets/coordinator/         协调程序、网页、manifests、测试、锁文件
  assets/coordinator-manifest.json  文件清单与 SHA-256
tests/
  test_room.py                local-agent-room 的回归测试
  package.test.mjs            slack-dual-agent 的打包测试
```

仓库排除运行配置、凭据、SSH 信息、聊天室记录、用户任务和历史截图。

Slack 版的架构借鉴 [Triglav](https://github.com/adam-drag/triglav)，附带代码独立实现，没有复制其源码或资源。依赖遵循各自许可证；不打包 CLI、浏览器或官方桌面插件二进制。
