# workflow.py 命令与各步细则

要运行某个阶段、查参数、写 routes JSON、选团队，或要确认某一步的细则时读本文件。档位、隔离和停止规则在 [SKILL.md](../SKILL.md)；派工单、计划、审阅和回执的格式在 [templates.md](templates.md)。

## 调用方式

从 Skill 目录调用 `python3 scripts/workflow.py 项目目录 轮次 尝试号 子命令`。每个阶段完成后脚本打印下一步。常驻主控就是当前 Claude Code 会话，由它在需要判断时写派工、放行意见和决定；固定交接由脚本执行。旧的 `research.py` 仍是独立的串行单轮入口（[single-round.md](single-round.md)）。

同一项目同一时刻只能有一条 workflow 命令在跑；另一条正在执行时脚本报错，改用 `status` 查看。workflow 已自动登记阶段、角色、调用和作业到进度页，主控无需重复录入。脚本保留被截断或缺回执的调用意图，由主控根据实际外部状态消除不确定性。

## 下一步卡片

每条推进状态的命令（`init`、`plan`、`dispatch`、`pilot`、`gate`、`formal`、`review`、`decide`、`revise`）以及 `status`、`resume` 结束时，都打印本尝试的下一步卡片；`guide` 只打印卡片，不改任何状态，尚未 `init` 时打印开轮卡片。卡片包括：

- **读**：本步要读的文件，路径相对项目目录，附字数（如三份封存计划、试跑回执、各份审阅和执行者意见）；
- **写**：主控要写的文件和必备小节（`本轮目标.md`、`派工单.md`、`放行核对.md`、`结果摘要.md`、`决定稿.md`）；
- **运行**：可直接粘贴的整行命令，形如 `cd 项目目录 && python3 …/workflow.py "$PWD" 轮 尝试 子命令 …`；
- **注意**：本步的少数关键规则。

主控按卡片推进，不读 `scripts/` 源码，也不预读 references。卡片里的占位词（如「工作目录」「项目名」）换成实际值；本文件其余部分在卡片不够用时按需查。

## routes JSON

选定来源后，主控把各 agent 写入一个 JSON 对象：键是 agent 名，值是 `{"client", "model", "effort"}`，三项都不能为空，另可加可选的 `label`；实际值用用户本次确认的配置。另可加一项 `Adjudicator`。

- **名称自取。** 字母开头，后接字母、数字、`_` 或 `-`，最长 24 个字符；忽略大小写后不能重名。`Adjudicator`、`Probe`、`lead`、`jupiter` 是保留名，不能放进团队。名称就是归档目录名，小写后是进度页卡片的键。
- **客户端任选。** 任何 agent 的 `client` 都可以是 `claude`、`agy` 或 `codex`，不再按名称固定。执行者用不同客户端时权限不同，见 [routing.md](routing.md)「执行者的客户端」。
- **卡片标签。** `label` 是进度页卡片上名称下面那一行，最长 40 个字符，卡片上约显示 11 个汉字或 19 个英文字符，超出部分用省略号；不写就显示「型号 · 推理强度」。它只用于显示，不传给客户端。每次 `init` 都按 routes 重写卡片标签，所以想长期保留的标签写在 routes 里，不要手动改看板。Adjudicator 的 `label` 在它第一次被调用、卡片出现时显示。
- **校验范围。** 本轮团队（规划者、执行者、审阅者）每人都必须在 routes 里；写了 `Adjudicator` 也会校验。routes 可以多写暂时不用的 agent，例如降级备选。

默认团队用 Claude、Gemini、Codex 三个名称，下面三个示例沿用它们。

标准档，顶级路由（示例）：

```json
{"Claude":{"client":"claude","model":"claude-fable-5-2","effort":"xhigh"},
 "Gemini":{"client":"agy","model":"gemini-4-neon-xhigh","effort":"xhigh"},
 "Codex":{"client":"codex","model":"gpt-6.2-astra","effort":"max"},
 "Adjudicator":{"client":"claude","model":"claude-fable-5-2","effort":"xhigh"}}
```

标准档，降级路由（示例，型号以启动时用户确认的为准）：

```json
{"Claude":{"client":"claude","model":"claude-opus-5-5","effort":"xhigh"},
 "Gemini":{"client":"agy","model":"gemini-4-neon-high","effort":"high"},
 "Codex":{"client":"codex","model":"gpt-6.2-astra","effort":"max"}}
```

轻量档（默认执行者 Codex、审阅者 Claude，所以只需 Claude 和 Codex；Adjudicator 可选）：

```json
{"Claude":{"client":"claude","model":"claude-opus-5-5","effort":"xhigh"},
 "Codex":{"client":"codex","model":"gpt-6.2-sol","effort":"max"},
 "Adjudicator":{"client":"claude","model":"claude-fable-5-2","effort":"xhigh"}}
```

## 团队：规划者、执行者、审阅者

`init` 用三个参数从 routes 里选人，名称用逗号分隔：

- `--planners A,B,…`：独立规划者，只用于标准档；轻量档给出即拒绝，由主控写计划。
- `--worker W`：唯一的执行者，负责实现、试跑和正式运行。
- `--reviewers X,Y,…`：独立审阅者，两档都可用。

**默认值与沿用。** 不给就沿用上一轮的团队。首次 `init` 时执行者是 Codex；标准档规划者和审阅者都是 Claude、Gemini、Codex，轻量档审阅者是 Claude。换档时审阅者回到新档的默认值（标准档三方、轻量档 Claude），除非同时给 `--reviewers`；从轻量档升标准档且未给 `--planners` 时，规划者用默认三方；执行者始终沿用。

**团队固定到本次尝试。** 同一尝试和它的返工（递增尝试号）必须用同一组规划者、执行者和审阅者，给出不同的值即拒绝；只能在新一轮改。

**人数。** 用户可以增减规划者和审阅者。每多一位，就多一次完整调用和一份要读的首稿，token 和主控读稿时间大致按比例增加；同一阶段的调用并发，墙钟时间取决于最慢的一方。标准档少于两方规划或审阅时，`init` 打印提示：失去独立对照，只在用户同意时这样配。

**执行者用非 codex 客户端时**，`init` 打印提示：没有 Codex 沙箱，网络和工作区外写入不受 workflow.py 限制。各客户端的权限见 [routing.md](routing.md)「执行者的客户端」。

**目录和看板跟着名称走。** 每位成员的首稿和回执在 `轮次/NNN/<名称>/尝试-NN/`，执行者的试跑和正式回执是其中的 `pilot.md`、`formal.md`。首稿封存不限人数。`init` 把团队传给进度页，按团队画卡片（[progress-page.md](progress-page.md)）。

自定义团队的 routes（示例；同一个 Claude 型号可以用两个名称分别规划和审阅）：

```json
{"Fable":{"client":"claude","model":"claude-fable-5-2","effort":"xhigh","label":"Fable 5.2 · 规划审阅"},
 "Opus":{"client":"claude","model":"claude-opus-5-5","effort":"xhigh"},
 "Gemini":{"client":"agy","model":"gemini-4-neon-xhigh","effort":"xhigh"},
 "Codex":{"client":"codex","model":"gpt-6.2-astra","effort":"max"},
 "GPT":{"client":"codex","model":"gpt-6.2-sol","effort":"max"},
 "Adjudicator":{"client":"claude","model":"claude-fable-5-2","effort":"xhigh"}}
```

```sh
# 第 1 轮：Fable、Gemini、Codex 规划，Codex 执行，只要 Fable、Gemini 两方审阅
python3 scripts/workflow.py 项目 1 1 init --routes 团队.json --tier standard \
  --planners Fable,Gemini,Codex --worker Codex --reviewers Fable,Gemini
# 第 2 轮：沿用路由、规划者和执行者，审阅扩到四方
python3 scripts/workflow.py 项目 2 1 init --reviewers Fable,Opus,Gemini,GPT
# 第 3 轮：改由 Opus（claude 客户端）执行，其余沿用；init 会打印没有 Codex 沙箱的提示
python3 scripts/workflow.py 项目 3 1 init --worker Opus
```

## 子命令

| 时机 | 子命令和交付 |
|---|---|
| 开轮 | `init [--routes 路由.json] [--tier light\|standard] [--planners A,B] [--worker W] [--reviewers X,Y] [--title 项目名] [--limits 限制] [--max-rounds N] [--cluster 名称] [--lead-transcript 文件] [--lead-root 目录]`。`--title`、`--limits`、`--max-rounds`、`--cluster` 直接写进进度页，不必另跑 progress.py。主控在 Claude Code 里运行时，init 从环境变量 `CLAUDE_CODE_SESSION_ID` 找到本会话记录，连同会话工作目录一起绑定为主控用量来源；`--lead-transcript` 可显式指定。首次必须给 `--routes`，后续轮不给就沿用上一轮。`--tier` 默认沿用上一轮，首轮为 standard。`--planners`、`--worker`、`--reviewers` 从 routes 里选团队，默认值和沿用规则见上文「团队」。`--lead-root` 可重复，转给进度页统计主控用量（[context-and-usage.md](context-and-usage.md)）；对已存在的尝试再次 `init --lead-root` 只补绑定，此时给出与台账不同的 `--tier`、`--routes` 或团队即拒绝。`--lead-root` 无效时 init 失败但不占用该尝试，改正后重跑即可。已有旧版归档从新轮接入；旧尝试断点按原恢复索引继续。 |
| 规划（仅标准档） | `plan --input 本轮目标.md`，可重复传入获准共享的 UTF-8 材料。并发发给各规划者，独立收件，收齐才发布到各自目录。下一轮自动附上上一轮主控决定。轻量档拒绝 `plan`。 |
| 派工 | Opus 写完派工单后 `dispatch 派工.md --workspace 工作目录`。远程执行加 `--ssh 已配置别名`，工作目录写远程绝对路径。`--network` 让本机 codex 客户端的执行者联网（只对 codex 客户端生效，`--ssh` 时也不生效；claude、agy 执行者本来就不受沙箱限制）。本机执行者经 SSH 操作集群时加 `--scheduler-ssh 别名`，`watch` 经该别名查 `sacct`（未给时用 `--ssh`，都没有则在本机查）。预算参数 `--nodes --cards-per-node --hours --max-cards --remaining-gpu-hours`：给了任一项就必须给前三项；脚本拒绝超过 `--max-cards` 的分配卡数或超过 `--remaining-gpu-hours` 的 GPU 小时，并打印节点小时和 GPU 小时上界。纯文字评审加 `--mode text`：第三步只整理已有材料，直接进入 review，不能带 `--ssh` 或节点、卡数、时限；这类轮次不能 `revise`，先 review 再 `decide next`。已登记作业未对账时拒绝派工。 |
| 试跑 | `pilot` 调执行者试跑；或 `pilot --receipt 已有回执.md [--codex-session 会话ID [--since ISO时间]]` 归档当前执行会话的交付，并按会话文件登记用量（`--codex-session` 须配 `--receipt`，`--since` 须配 `--codex-session`；`--codex-session` 只在执行者用 codex 客户端时可用）。回执归档在 `轮次/NNN/<执行者>/尝试-NN/pilot.md`。 |
| 放行 | Opus 查看结果后 `gate pass 核对意见.md --input 文件 [--input-dir 目录] [--remote-input 远程绝对路径]`。至少给一个 `--input` 或 `--input-dir`，都可重复。`--input` 绑定本机文件的 SHA-256；`--input-dir` 递归绑定目录下所有文件的清单（任意深度跳过 `.git`、`.venv`、`.cache`、`__pycache__`、`.pytest_cache`、`node_modules`、`.DS_Store`；`runs`、`data` 只在该目录顶层跳过；也跳过 probe 写入的 `request.txt`、`transcript.jsonl`），formal 时有新增、删除或修改都拒绝，并列出变化的路径。目录包含项目归档时拒绝，改绑更窄的目录。指向目录的符号链接只记录链接文本，其目标必须在同一目录内且未被跳过（如 `venv/lib64 -> lib`），指向外部的拒绝，改用 `--input-dir` 绑定链接目标。远程执行时 `gate pass` 必须用 `--remote-input` 绑定服务器上实际代码或配置。正式调用前重新检查全部哈希。需返工用 `gate revise` 加相同参数，再以递增的尝试号 `init`。 |
| 产品检验（可选） | 交付物本身是 agent 或 skill 时，在 `gate pass` 之后、`formal` 之前运行 `probe`，见 [product-probe.md](product-probe.md)。 |
| 正式运行 | `formal`，或 `formal --receipt 正式回执.md [--codex-session 会话ID [--since ISO时间]]`。正式回执已归档后重跑 `formal`（如归档后中断）不再核对放行哈希，因为运行本身可能写入已绑定目录。`formal --receipt` 归档的是已经跑完的外部运行：已放行文件被修改或删除、`--input` 或远程哈希变化时仍拒绝；只在 `--input-dir` 目录中新增文件时不拒绝，逐项打印警告并写进 `主控日志.md`，由主控核对它们是否只是运行产物。 |
| 调度器 | 回执中每行 `JOB_ID=12345`（数组任务 `12345_7`）自动登记，含 `JOB_ID` 但格式不符的行打印警告，可用 `job 12345` 补登。`watch --wait 300 --interval 30` 用 `sacct` 查询原作业（经 `--scheduler-ssh`，否则 `--ssh`，否则本机），等待期间无需模型；`--wait` 是截止秒数（默认 0，只查一次），超时打印“仍在队列中”并保留作业号。登记的是数组父作业号时，按各子任务行汇总并打印说明：有失败取失败状态，否则有未完成取未完成状态，全部完成才是 COMPLETED。只要还有未结束的作业就继续等到截止；全部到终态时，全为 COMPLETED 才正常返回，否则报错由主控对账；截止时仍有 RUNNING、PENDING、CONFIGURING、COMPLETING 以外的状态（如 UNKNOWN 或失败）也报错。未知和失败状态不能视作成功。已是终态的作业不再查询。查不到的作业（UNKNOWN、记录已清除）由主控核实后用 `job 12345 --state COMPLETED\|FAILED\|CANCELLED\|…`（任一 Slurm 终态）确认，脚本记入 `主控日志.md` 并在进度页标注“主控确认”。`gate pass`、`formal`、`review` 和 `adjudicate` 前要求全部已登记作业为 COMPLETED。已核实作业终止或放行版本改变时，Opus 可用 `revise 返工意见.md` 结束本次尝试（要求作业都处于终态，含 DEADLINE、BOOT_FAIL、REVOKED、SPECIAL_EXIT，且正式调用意图已对账）。 |
| 审阅 | `review --input 已有结果.md --input 配置摘要.txt` 冻结本轮派工及同版文本材料，独立送本轮审阅者。大文件用经批准的摘录和索引。 |
| 争议裁决（可选） | 审阅封存后、`decide` 之前：`adjudicate --input 争议点.md`。routes 里须有 Adjudicator。脚本把冻结材料、派工与验收标准、各审阅者的封存报告和争议点一次送出，回执在 `主控/尝试-NN/adjudicate/Adjudicator.md`；重复执行复用已有回执。 |
| 总验收 | Opus 收齐审阅后写决定：`decide done 决定.md` 交付，`decide next 决定.md` 进入新一轮，`decide hold 决定.md` 暂缓。Adjudicator 调用未对账时拒绝。主控同时按用户指示处理预算和是否继续。 |
| 交接 | `handoff` 写 `主控/尝试-NN/交接单.md`（不超过 40 行：项目说明前 15 行、档位与团队（`规划｜…。执行｜…。审阅｜…`）、路由、当前与下一步、派工／放行意见／决定／返工意见路径、封存首稿和冻结输入索引、裁决回执、无回执的调用意图、作业状态、是否暂停），并更新项目根目录的 `恢复点.md`；之后步骤推进时，`恢复点.md` 把这份交接单标为已过期。plan→dispatch、gate→formal、review→decide 时脚本会提示运行它。 |
| 关机与恢复 | `pause` 暂停新派工并保留在途工作（暂停时仍可 `watch`、`job`、`reconcile`、`handoff`、`status`）；回来用 `resume` 解除暂停并查看状态，`status` 可随时读取。重发同一阶段命令会复用已有回执。调用失败时，原始输出保存为该阶段目录下的 `角色.failed-时间戳.out` 和 `.err`，能解析到 Codex 会话号时一并打印，供对账。若调用意图存在而无回执，先确认原进程和作业，再用 `reconcile 角色 --receipt 已有报告.md`，或在确认原调用已结束且没有交付后用 `reconcile 角色 --ended`。角色可为本轮团队的任一成员（用 routes 里的名称）、Adjudicator（只在 decide 前）、Probe（只在 formal 前，且只能 `--ended`）。 |

## 开轮、返工与换档

- 新一轮要求上一轮已 `decide next`、`done` 或 `hold`，轮次加 1、尝试号为 1。返工（`gate revise` 或 `revise` 之后）用同一轮、尝试号加 1，自动继承派工单、工作目录、SSH（含调度器 SSH）、资源和联网设置，并把返工意见附到派工单末尾，从 `pilot` 开始。脚本不会按当前余额重新核对继承的资源：返工 `init` 前，主控按当前剩余额度（计入在途作业）重新核对预算；不够时不返工，改在新一轮重新派工。
- 档位、团队（规划者、执行者、审阅者）和路由只能在新一轮改；返工必须沿用，给出不同的值即拒绝。轮次不能早于进度页当前轮，也不能超过进度页的轮数上限。
- 轻量档 `init` 后下一步是 `dispatch`；标准档是 `plan`。
- 升档：上一轮 `decide next` 写明理由后，新一轮 `init --tier standard --routes 顶级路由.json`。未给 `--planners`、`--reviewers` 时用默认三方，routes 须含 Claude、Gemini、Codex。
- 切换顶级／降级路由：新一轮 `init --routes 对应路由.json`，理由写进主控日志。

## 各步细则

以下补充 SKILL.md 中流程摘要之外的细节。

**第二步 派工。** 派工单按 [templates.md](templates.md) 的模板写，计算资源一节见 [compute.md](compute.md)。

**第三步 执行与放行。** 试跑是小规模的，交代码改动、配置和试跑输出；正式运行是放行后的第二份指令。无代码任务检查关键推导、原文或抽样结果。返工时列出偏差与复验条件，缺证时指出缺少的材料，重新核对后才能继续。记录实际方法、输入、产物位置与版本；涉及计算或调度时记录配置、命令与作业号。对排队或运行中的作业，主持会话用同一作业号查询进度，完成后读取产物；等待期间停留在第三步。正式产物就绪即冻结验收标准、实际输出、配置和来源索引。资源方面的放行检查见 [compute.md](compute.md)。

**第四步 审阅。** 审阅者按 [templates.md](templates.md) 的审阅模板交报告。规划时只接收共同背景，审阅时另接收同一份可共享的实验产物与验收标准。

**第五步 总验收。** 主控在审阅首稿全部封存后，连同执行者意见一起读，记录各审阅者的共识和分歧，对照原目标决定下一步；目标达到则交付。采纳的补测、修正和新实验连同理由进入下一轮共同输入；下一轮第三步才由执行者执行。决定文件的写法见 [templates.md](templates.md)。

## 轮次安排

以下示例按默认团队写（三方规划和审阅，Codex 执行）。

**接手已有项目时，首轮可只盘点现状。** 用户指定短盘点时，第一步三方各写简短的盘点计划，第二步 Opus 定范围，第三步 Codex 查现有仓库和获准查看的远程记录。交付一份状态表，逐项区分代码已实现、作业已提交或在跑、结果已产出、结论已有证据，以及仍待确认的事项；附关键代码位置、配置、作业记录和结果文件。仅有实现不能证明实验跑过。第四步三方读同一份材料，各自判断项目进展和证据缺口，第五步 Opus 汇总并选下一轮目标。盘点轮可以到此结束，改进或新训练另行派工。

**不同轮次可以长短不同。** 例如第一轮由 Codex 训练 8 小时。第四步 Gemini 读已有结果，指出少测一个边界条件，主控在第五步决定采纳，并记录哪项结论仍待确认。第二轮只围绕这个缺口规划、派工；Codex 复用第一轮的模型和产物，做一次短时补测。主控把第一轮仍适用的结果、第二轮新增文件和两轮对应的模型／配置版本一起交给三方。第四步只回答「新增证据是否补上缺口、合看两轮后结论是什么、还缺什么」。若版本或口径有变，在报告标明哪些结果还能合看。Opus 总验收后，再决定第三轮是否值得安排新的长时训练。盘点、改进、短补测和长训练都可以按实际需要安排；证据充分时也可以连续几轮做长训练。
