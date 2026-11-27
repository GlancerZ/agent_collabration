# Pipeline 进度页

启动或恢复项目时初始化进度页，或需要手动登记阶段、调用、作业和事件时读本文件。token 的取得方式和主控用量口径在 [context-and-usage.md](context-and-usage.md)。

## 页面

启动或恢复项目时，主控先初始化进度页，把页面路径告诉用户。页面写在 `项目/进度/index.html`，用户直接用浏览器打开即可。页面每 5 秒重新加载 `status.js`，用的是重新插入 `<script>` 标签的办法，因为 `file://` 下不能用 fetch。内容包括：

- 按实际轮次展示五步流程；有轮数上限时显示到上限；
- agent 关系图：主控、Claude、Gemini、Codex、集群，正在调用的节点会发光、连线会流动；
- 每个 agent 的累计 token（分输入、缓存读、缓存写、输出四段）和逐次调用表；
- 集群作业和事件时间线。

进度页只用于展示。首稿封存前页面显示什么，见 SKILL.md「证据隔离与首稿封存」；能否据页面判定重跑，见 [archive-and-recovery.md](archive-and-recovery.md)。

## 启动时初始化

从 Skill 目录运行，可重复执行：

```sh
python3 scripts/progress.py 项目目录 init --title 项目名 --limits "≤8 GPU · 最多 2 轮" --max-rounds 2 \
  --cluster JUPITER --model lead="Opus 5.5 · xhigh" --model claude="Fable 5.2 · xhigh" \
  --model gemini="4 Neon · XHigh" --model codex="gpt-6.2-astra · max" \
  --lead-transcript ~/.claude/projects/<目录键>/<会话ID>.jsonl [--lead-root 主控工作目录]
```

- 会话 ID 可以从会话的 scratchpad 路径中读出。只显式绑定当前项目的主控会话文件。换会话时重新 init 并追加绑定；脚本仅累计工作目录属于项目（或 `--lead-root` 指定目录）的消息，按会话与消息 ID 去重。旧版自动选择的路径需重新确认并绑定。未绑定时可从明确登记的调用统计用量。
- 主控用量每次写入时从这个会话记录重新统计，并按 message id 去重，因为同一次响应会写成多行。`refresh` 只重算主控用量。
- `--max-rounds` 不能低于当前轮次。
- 改了模板后，用 `init --refresh-template` 覆盖 index.html。

## 每次交接都当场记录

用 workflow.py 时这些登记已自动完成（[workflow-commands.md](workflow-commands.md)）；手动调用或补登时用下列命令，参数含义见脚本头部注释：

- `stage 轮 步 [说明]`：更新当前所处的轮次和步骤。
- `agent 角色 running|waiting|done|failed|idle "任务"`：在调用前后各记一次，节点据此高亮。角色为 lead、claude、gemini、codex、jupiter。
- `call 角色 阶段 --model … --from-claude-json|--from-codex-session|--from-codex-log|--from-agy-json|--from-agy-transcript 文件`：在调用结束时记录。也可以直接传 `--input/--output/--cache-read/--cache-write/--total/--seconds`。`--key` 作为幂等键，同键不重复登记；`--replace N` 覆盖第 N 条。拿不到用量时页面标“未记录”。
- `job 作业号 名称 状态 --gpus N [--used-gpus N] [--node-hours X] [--gpu-hours X] [--note …]`：提交作业和状态变化时记录。分配卡数与实用卡数不一致时脚本提示核对。
- `event "文字" [--agent 角色]`：其他重要事件。
