# 产品检验：交付物本身是 agent 或 skill

交付物本身是一个 agent、skill 或会调用模型的工具，需要在正式运行前让它真实跑一次时读本文件。

## 顺序

`gate pass` 放行之后、`formal` 之前，用 `probe` 让 Claude Code 在工作目录里按一条真实请求运行被交付的产品，保存完整会话记录。正式运行时，Codex 先审计这些会话，再做改动。

1. `gate pass`：放行版本已绑定（建议用 `--input-dir` 绑定代码目录）。
2. `probe`：可运行多次，每次换一个新的 `--outdir`。
3. `formal`：脚本先重新核对放行哈希，再把每次检验的记录附进提示词，要求 Codex 在改动前审计各检验会话，引用证据说明是否读取禁读路径、决策理由能否在产物中回查、是否改动代码；缺少直接证据时标明无法核实。

正式调用意图或回执已存在后不能再 probe。有未对账的 probe 时，`formal` 和 `revise` 都会拒绝。

## 命令

```sh
python3 scripts/workflow.py 项目目录 轮次 尝试号 probe --request 请求.txt --outdir runs/probe-01 \
  --model claude-opus-5-5 [--effort xhigh] [--allow "Read,Bash"] [--deny-read 禁读路径 …]
```

| 参数 | 含义 |
|---|---|
| `--request` | 必填。交给产品的请求文本（UTF-8，非空），经 stdin 传入。 |
| `--outdir` | 必填。工作目录内的相对路径，不能含 `..`；同一目录不能重复使用。 |
| `--model` | 必填。运行产品的 Claude 型号。 |
| `--effort` | 可选。推理强度。 |
| `--allow` | 可选。逗号分隔的 Claude 工具权限，传给 `--allowedTools`。 |
| `--deny-read` | 可选，可接多个路径，传给 `--disallowedTools`。Claude Code 把 `Read(/路径)` 当作相对项目根目录，所以绝对路径传成 `Read(//绝对路径)`，相对路径原样传成 `Read(路径)`。 |

脚本在工作目录中运行 `claude -p --model … --strict-mcp-config --output-format stream-json --verbose`，请求和会话记录写到 `工作目录/outdir/request.txt` 与 `transcript.jsonl`，同时在 `主控/尝试-NN/probe/<标记>/` 留一份 `transcript.jsonl` 和 `stderr.log`，用量登记到进度页的 claude 节点。派工带 `--ssh` 时在远程工作目录运行。产品退出码非零、会话记录里没有结果事件或结果报错，即判失败，查看上述两份文件。

## 注意

- 放行哈希在 probe 前后都会核对。目录清单会跳过 probe 自己写入的 `request.txt` 和 `transcript.jsonl`，所以 `--outdir` 可以放在已绑定目录内；产品运行若改动或新增了已绑定目录中的其他文件，formal 拒绝，按返工处理。
- `Read` 禁读规则只约束 Read 工具。`--allow` 含 Bash 时，产品可以用 shell 命令读取禁读路径，脚本会打印警告；要严格禁读，就不放开 Bash，或在 formal 审计时核对会话中的命令。
- probe 中断（有意图无回执）时，核实原进程已结束，用 `reconcile Probe --ended` 对账，再用新的 `--outdir` 重跑。

## Skill 自审

Skill 自审时，将每项放行条件绑定到可执行用例或静态证据。试跑只运行派工指定的子集；正式运行接受主控补充的用例，逐项归档命令、退出码、标准输出与错误、预期和实际值、环境及源码运行前后哈希。主控可直接读取这些记录；未执行、静态判断和实测结论分开记录。交付前检查验收标准与证据逐项对应。
