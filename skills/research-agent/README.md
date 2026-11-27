# Research Agent 使用指南

Research Agent 是一个从 Claude Code 启动的科研与工程协作 Skill。你给出项目目标和本轮授权，Claude 主控决定这一轮做什么，Codex 按派工单执行，审阅者根据已交付的结果写意见。脚本负责派发、收件、进度看板和断点记录。

## 在 Claude Code 里开始

已经安装过的用户，在**研究项目目录**打开 Claude Code，把下面这段作为一条消息发送即可。将方括号替换为实际路径。

```text
/research-agent 我想继续做空间转录组基础模型。本地代码在 [仓库路径]，已有结果在 JUPITER 的 [远程目录]，SSH 别名是 [别名]。第一轮只盘点现状：区分哪些功能已经实现、哪些实验确实跑过、哪些结果足以支持结论。请给我状态表、关键证据位置和下一轮建议。本轮不提交训练作业。先和我确认档位、模型来源与推理强度，再开始。
```

首次启动时，主控会说明选哪一档及理由，并确认各角色使用的客户端、型号和推理强度。你可以直接指定「Claude 用我的 Claude Code，Gemini 用我的 Antigravity，Codex 用我的 Codex CLI」。需要用集群时，给出可用的 SSH 别名、数据目录和资源限制。例如「同时最多一个四卡节点，累计最多 8 GPU 小时」。没有数值限制可以说「本轮不设」。[模型路由](references/routing.md) · [集群配置与预算](references/compute.md)

## 第一次安装与以后更新

准备好 Git、Python 3，以及本档使用的客户端。先在各自客户端完成登录，确认终端里可以启动 `claude`、`codex`；使用 Gemini 的项目还需要 `agy`。以下命令适用于 macOS 或 Linux。

**已有本地仓库**时，在仓库根目录运行以下命令，把 Skill 链接到 Claude Code。**首次下载**可以先运行 `git clone https://github.com/GlancerZ/agent_collabration.git`，再进入 `agent_collabration`。

```sh
mkdir -p "$HOME/.claude/skills"
ln -s "$PWD/skills/research-agent" "$HOME/.claude/skills/research-agent"
```

已经有链接时跳过这一步。可以用 `readlink "$HOME/.claude/skills/research-agent"` 查看它指向哪个仓库。以后在**链接指向的仓库**更新一次，再开新的 Claude Code 会话即可使用新版。对干净的本地工作区，从 GitHub 主分支更新可用：

```sh
git pull --ff-only origin main
```

## 一轮怎么走

| 步骤 | 标准档：科研问题、方法或方向仍需判断 | 轻量档：有明确测试标准的工程交付 |
|---|---|---|
| 1. 规划 | Claude、Gemini、Codex 各读同一份任务，独立写计划 | 主控直接写计划 |
| 2. 派工 | 主控综合计划，指定任务、交付物、验收标准和预算 | 主控把计划派给 Codex |
| 3. 执行 | Codex 先试跑，主控核对放行后再正式运行 | 同样先试跑、放行，再正式运行 |
| 4. 审阅 | 三方独立读同一版冻结结果，分别交报告 | 默认由 Claude 一方审阅，可在开轮时指定审阅者 |
| 5. 决定 | 主控收齐意见，决定交付、进入下一轮或暂停 | 同样由主控裁决；出现重大方法分歧时，可在新一轮升为标准档 |

**第四步只审阅已有交付。** 例如 Gemini 发现少测了一个边界条件，它在报告里写清缺口及影响。主控决定采纳后，下一轮由 Codex 补测；审阅时将原训练结果和新增证据一起看。这样，八小时的训练后面可以只接一轮几分钟的补测。每轮也可以只做盘点、复盘或总结。若只想让各方评已有文稿或结果，启动时说「本轮只做文字评审」，主控可用 `dispatch --mode text` 跳过试跑和正式计算。

## 看进度、暂停和接着做

| 想做什么 | 在同一项目里怎样操作 |
|---|---|
| 看现在谁在做 | 打开主控给出的本地 `进度/index.html`。页面自动刷新，每个项目各有一份。 |
| 临时关电脑 | 在当前 Claude Code 会话说「关电脑」。等主控确认恢复点和在途作业已记录，再关闭终端。已经提交到集群的作业仍按调度器状态跟踪。 |
| 换新会话继续 | 回到同一项目目录启动 Claude Code，输入 `/research-agent 从这个项目的恢复点继续，先核对已有回执和作业号。` |
| 找上一轮的依据 | 看项目根目录的 `恢复点.md`、`主控日志.md` 和 `轮次/`。阶段边界生成的短交接单会列出当前决定、未决项和证据位置。 |

断线后，主控先对账。已有报告会被复用；某一方交付状态不明时，先查原调用和已有文件。集群作业按原作业号核对，避免重复提交。长项目可以在阶段边界生成短交接单，换会话时先读交接单，有疑点再开对应的原件。[归档与恢复](references/archive-and-recovery.md) · [上下文与用量](references/context-and-usage.md)

## 需要手动查看时

平时在 Claude Code 里描述任务即可。要在终端查状态或参数，下面示例读取当前项目**第 1 轮、第 1 次尝试**；请换成恢复点里实际记录的轮次和尝试号。

```sh
workflow="$HOME/.claude/skills/research-agent/scripts/workflow.py"
python3 "$workflow" --help
python3 "$workflow" "$PWD" 1 1 status
```

五步流程的入口是 `scripts/workflow.py`。`scripts/research.py` 用于单次串行辅助。需要手动指定模型路由、远程工作目录、试跑放行、作业查询或裁决时，可直接查对应参数。[五步命令与路由示例](references/workflow-commands.md) · [单轮串行入口](references/single-round.md) · [常见问题](references/troubleshooting.md)
