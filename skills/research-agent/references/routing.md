# 路由与角色配置

启动时确认团队和各角色的客户端、型号和推理强度，选执行者的客户端，做冷启动验收，或要核实配置是否真的生效时读本文件。授权问询规则（展示、等用户明确选择、不沿用上次选择）和按档位推荐的型号在 [SKILL.md](../SKILL.md) 的「启动」和「模型与推理强度」。

## 启动问询主会话

启动问询主会话默认使用用户自己的 Claude Code、Opus 5.5、Extra High（`xhigh`），负责询问研究目标、数据位置、授权范围和各角色配置。用户可显式另选启动配置。新开该主会话时可运行：

```sh
claude --model claude-opus-5-5 --effort xhigh --strict-mcp-config \
  --tools "Bash,Read,Edit,Write,Glob,Grep,Agent,Skill,AskUserQuestion,WebSearch,WebFetch"
```

后两个参数只给主控留下它用得到的工具。工具定义随每次请求重发，主控一个项目要发几十到上百次请求，所以这是最大的固定开销：实测同一句话的请求，Claude Code 默认约 3.7 万 token，这样启动约 2 万；桌面版会话带着应用工具和连接器，约 7 万（数据见 [context-and-usage.md](context-and-usage.md)）。项目确实要用某个连接器时，去掉 `--strict-mcp-config`，改用 `--mcp-config` 只加载那一个。桌面版无法裁剪内置工具，长项目建议在终端启动主控。

在该会话输入 `/research-agent`。已经打开的会话沿用客户端实际设置；Skill 文字本身无法切换已经处理当前消息的模型。启动时分别确认并记录常驻主控、深度判断会话，以及团队里谁规划、谁执行、谁审阅和每个成员的客户端、型号与推理强度；独立审阅（标准档还有独立规划）先问人数，再问是哪几个，用户没说人数时不按默认值直接开轮；模型和客户端分别记录。用户对本项目的明确选择优先。

## 角色与客户端

下表是默认团队（Claude、Gemini、Codex）的建议来源。五步流程里 agent 名称可以自取，任何 agent 都可以用 `claude`、`agy` 或 `codex` 客户端，规划者和审阅者可增可减，执行者可另选；写法见 [workflow-commands.md](workflow-commands.md)「团队」。

| 角色 | 建议的独立来源 | 型号示例 |
|---|---|---|
| Claude 常驻主控、常规审核 | 用户自己的 Claude Code 登录 | Opus 5.5 |
| Claude 独立规划、关键科研审核、争议裁决建议 | 同一 Claude Code 账户，另开会话 | Fable 5.2，Extra High |
| Gemini 独立规划和独立验收 | Antigravity 的 Google 登录 | Gemini 4 Neon High（`--gemini-model gemini-4-neon-high`） |
| Codex 独立规划、执行、修改、自检与结果解读 | 当前 Codex 会话；单轮脚本启动目标机器上的 Codex CLI | 当前配置，或明确指定 `--codex-model` |
| 争议裁决（routes 里的 `Adjudicator`，可选） | claude、agy 或 codex 客户端 | 例如 Fable 5.2，Extra High |

只有用户明确选择让 Antigravity 提供 Claude 时，才在单轮脚本用 `--claude-agy-model`，或在五步流程的 routes 里把 Claude 的 client 写成 `agy`。路由记录表示请求的客户端与型号；服务返回的实际型号或登录方式可另记，实际扣费以各账户账单为准。routes JSON 的写法见 [workflow-commands.md](workflow-commands.md)。

## 执行者的客户端

执行者在工作目录里实现和运行，权限按客户端不同。规划者、审阅者和 Adjudicator 不受影响：它们一律不开工具（claude 用 `--tools ""`，agy 在 settings 里拒绝命令、写文件和读文件，codex 用只读沙箱并关闭 shell）。

| 客户端 | workflow.py 给执行者的权限 | 限制 |
|---|---|---|
| `codex`（默认） | `codex exec --sandbox workspace-write` | 由 Codex 沙箱限制在工作区内写入；默认不联网，`dispatch --network` 才放开（只对本机 codex 执行者生效）。 |
| `claude` | `claude -p --permission-mode acceptEdits --allowedTools Bash,Read,Edit,Write,Glob,Grep --strict-mcp-config`，保留会话记录 | 没有操作系统沙箱：Bash 能联网，也能写工作区外的文件。`--network` 对它不起作用。 |
| `agy` | `agy --mode accept-edits`，并用 `--settings` 允许 `command(*)`、`write_file(*)`、`read_file(*)`，拒绝 `mcp(*)` | 同样没有操作系统沙箱。无头运行的 agy 会自动拒绝未允许的操作，所以 settings 之外的工具不可用。 |

- 执行者不用 codex 时，`init` 打印提示：没有 Codex 沙箱，网络和工作区外写入不受 workflow.py 限制。主控在派工单里写清可写范围，放行时核对实际改动。
- 本机执行者不论哪个客户端，都把 `UV_CACHE_DIR`、`MPLCONFIGDIR`、`NUMBA_CACHE_DIR`、`XDG_CACHE_HOME` 指到工作目录下的 `.cache/`。经 `--ssh` 远程执行时不设这些变量，远程主机要装好并登录所选客户端。
- `pilot`、`formal` 的 `--codex-session` 只在执行者用 codex 客户端时可用。按 Codex 会话文件（`$CODEX_HOME/sessions`，默认 `~/.codex`）核算用量只适用于 codex 客户端的调用；用 `codex exec resume` 中途改指令（[troubleshooting.md](troubleshooting.md)）只适用于 codex 执行者。
- **agy 执行者还没有用真实调用核实过。** 第一次用之前，按下文「核实配置要真调用一次」做一次真调用，通过后再派工。

## Claude 在各阶段的分工

常驻 Opus 负责收件、汇总派工、检查作业状态和维护项目进度页。第三步常规代码检查由 Opus 对照派工单放行；需要判断方法或评估设计能否回答研究问题时，调用已确认的 Fable 配置提出意见。

第一步由独立的 Fable 会话提交 Claude 的规划稿。第四步若要解释关键结果、区分竞争假设或判断研究方向，由新的 Fable 会话完成 Claude 的独立验收；例行按表核对可用独立 Opus 会话。两者都遵守相同的证据隔离规则。

第五步意见一致且达标时由 Opus 收尾。裁决建议的触发条件和登记要求见 SKILL.md「模型与推理强度」，调用方式是 `adjudicate`（[workflow-commands.md](workflow-commands.md)）。

分阶段选型由五步流程的主持会话执行。用 workflow.py 时，同一个 agent 名在同一轮里的规划和审阅用同一条路由。要让 Fable 规划、Opus 审阅，在 routes 里写两个名称（如 `Fable`、`Opus`），分别放进 `--planners` 和 `--reviewers`；要换某个名称的型号，在新一轮 `init --routes` 时换。单轮辅助脚本的 Claude 型号参数适用于该次脚本的全部 Claude 调用。

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
- Claude Code 的推理强度用 `--effort xhigh`；Codex 用 `-c model_reasoning_effort=max`。research.py 目前不传推理强度；五步循环由 workflow.py 按 routes 里的 `effort` 拼命令（claude 客户端用 `--effort`，codex 用 `-c model_reasoning_effort=…`，agy 用 `--effort`）。
- **agy 执行者另做一次。** 在一次性空目录里，用与 workflow.py 相同的参数让它写一个文件并运行一条命令，例如：

  ```sh
  cd "$(mktemp -d)" && agy --disable-slash-commands --effort high --output-format json --mode accept-edits \
    --settings '{"permissions":{"allow":["command(*)","write_file(*)","read_file(*)"],"deny":["mcp(*)"]}}' \
    --model 已确认型号 -p "写 ok.txt，内容为 OK；再运行 ls 并在回复里给出结果"
  ```

  确认 json 里 `is_error` 不为真、`response` 有内容、`ok.txt` 出现在该目录且目录外没有新文件；被自动拒绝或写到目录外时停下，告诉用户，暂不用 agy 执行者。claude 执行者同理，可用 `claude -p --permission-mode acceptEdits --allowedTools Bash,Read,Edit,Write,Glob,Grep --strict-mcp-config --output-format json` 先试一次。
