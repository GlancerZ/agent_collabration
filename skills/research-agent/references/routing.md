# 路由与角色配置

启动时确认各角色的客户端、型号和推理强度，做冷启动验收，或要核实配置是否真的生效时读本文件。授权问询规则（展示、等用户明确选择、不沿用上次选择）和按档位推荐的型号在 [SKILL.md](../SKILL.md) 的「启动」和「模型与推理强度」。

## 启动问询主会话

启动问询主会话默认使用用户自己的 Claude Code、Opus 5.5、Extra High（`xhigh`），负责询问研究目标、数据位置、授权范围和各角色配置。用户可显式另选启动配置。新开该主会话时可运行：

```sh
claude --model claude-opus-5-5 --effort xhigh
```

在该会话输入 `/research-agent`。已经打开的会话沿用客户端实际设置；Skill 文字本身无法切换已经处理当前消息的模型。启动时分别确认并记录常驻主控、深度判断会话以及 Gemini 和 Codex 的客户端、型号与推理强度；模型和客户端分别记录。用户对本项目的明确选择优先。

## 角色与客户端

| 角色 | 建议的独立来源 | 型号示例 |
|---|---|---|
| Claude 常驻主控、常规审核 | 用户自己的 Claude Code 登录 | Opus 5.5 |
| Claude 独立规划、关键科研审核、争议裁决建议 | 同一 Claude Code 账户，另开会话 | Fable 5.2，Extra High |
| Gemini 独立规划和独立验收 | Antigravity 的 Google 登录 | Gemini 4 Neon High（`--gemini-model gemini-4-neon-high`） |
| 独立规划、执行、修改、自检与结果解读 | 当前 Codex 会话；单轮脚本启动目标机器上的 Codex CLI | 当前配置，或明确指定 `--codex-model` |
| 争议裁决（routes 里的 `Adjudicator`，可选） | claude、agy 或 codex 客户端 | 例如 Fable 5.2，Extra High |

只有用户明确选择让 Antigravity 提供 Claude 时，才在单轮脚本用 `--claude-agy-model`，或在五步流程的 routes 里把 Claude 的 client 写成 `agy`。路由记录表示请求的客户端与型号；服务返回的实际型号或登录方式可另记，实际扣费以各账户账单为准。routes JSON 的写法见 [workflow-commands.md](workflow-commands.md)。

## Claude 在各阶段的分工

常驻 Opus 负责收件、汇总派工、检查作业状态和维护项目进度页。第三步常规代码检查由 Opus 对照派工单放行；需要判断方法或评估设计能否回答研究问题时，调用已确认的 Fable 配置提出意见。

第一步由独立的 Fable 会话提交 Claude 的规划稿。第四步若要解释关键结果、区分竞争假设或判断研究方向，由新的 Fable 会话完成 Claude 的独立验收；例行按表核对可用独立 Opus 会话。两者都遵守相同的证据隔离规则。

第五步意见一致且达标时由 Opus 收尾。裁决建议的触发条件和登记要求见 SKILL.md「模型与推理强度」，调用方式是 `adjudicate`（[workflow-commands.md](workflow-commands.md)）。

分阶段选型由五步流程的主持会话执行。用 workflow.py 时，同一轮里 Claude 角色的规划和审阅用同一条路由；要在 Fable 和 Opus 之间切换，在新一轮 `init --routes` 时换。单轮辅助脚本的 Claude 型号参数适用于该次脚本的全部 Claude 调用。

## 冷启动验收

在新终端或全新主持会话中，清空本次任务的选择，保留用户原有登录。从仓库根目录运行以下预览；它只询问并打印路由，不读研究数据、不连 SSH、不发模型请求。

```sh
python3 skills/research-agent/scripts/research.py --show-routing
```

1. 验证先看见 Claude 来源选项，以及 Gemini 和 Codex 各自的固定入口；再填写各角色型号。对话主持者应在聊天中提问，不能为用户抢先填 `--use-defaults`。
2. 选择 Claude Code 后检查预览为 `claude / agy / codex`。改选 Antigravity 的 Claude，再次检查主控为 `agy`。非交互运行须传各角色选择；用户明确接受其余默认值时可加 `--use-defaults`。
3. 用模拟 CLI 检查实际执行参数和失败路径。Claude Code 失败应停在该阶段，其他订阅不接管。把预览、模拟调用和真实服务回报分开记录。预览通过后，正式调用继续使用已确认的同一组参数。

## 核实配置要真调用一次

每个角色各发一条 "Reply OK"：

- Claude：看 json 输出里的 `modelUsage`，确认服务端实际用的型号。
- Codex：看会话头里的 `model:` 和 `reasoning effort:`。
- Gemini：先用 `agy models` 确认型号存在，推理强度写在型号名里（如 `gemini-4-neon-xhigh`）。
- Claude Code 的推理强度用 `--effort xhigh`；Codex 用 `-c model_reasoning_effort=max`。research.py 目前不传推理强度；五步循环由 workflow.py 按 routes 里的 `effort` 拼命令（Claude 用 `--effort`，Codex 用 `-c model_reasoning_effort=…`，agy 用 `--effort`）。
