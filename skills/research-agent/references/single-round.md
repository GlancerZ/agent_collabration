# 单轮辅助脚本 research.py

用户只要一次串行的规划、执行和汇总，不走五步流程时读本文件。research.py 没有并发规划、执行检查点、独立双审或五步归档；五步流程用 workflow.py（[workflow-commands.md](workflow-commands.md)）。

## 本机运行

需要 Python 3.8+，以及已登录且可在终端非交互运行的 claude、agy（Google Antigravity CLI）和 codex。个人 Google 账号请按 [Antigravity 官方指南](https://antigravity.google/docs/getting-started?tab=cli) 安装 agy，运行 agy 登录。命令在 PATH 中可见时，从仓库根目录运行：

```sh
python3 skills/research-agent/scripts/research.py brief.md --project /path/to/research-project --out runs/pilot-01
```

安装成 skill 后使用 Skill 目录下的 scripts/research.py。默认让 Codex 只读核对项目并规划。用户要求实际执行实验时加 `--execute`，让 Codex 在指定工作区内写入。Gemini 评审默认使用 Gemini 4 Neon High；通过 `agy models` 查看可用型号，用 `--gemini-model` 指定其他型号。选择 default 时，Claude Code 和 Codex 分别沿用各自的模型配置；推理强度的情况见 [routing.md](routing.md)。Claude 和 Gemini 在临时目录工作，主控依据任务说明与执行报告整合结论。项目数据路径提供给 Codex，任务说明及各阶段文字输出可能传给对应的模型服务。

单轮脚本每次运行使用新的输出目录，依次保存原始任务、Claude、Gemini 和 Codex 各自的规划稿、综合方案、Codex 报告与最终结论。运行中断时查看最后完成的阶段和终端错误；重新执行前核对已生成的实验文件或已提交的作业。最终汇报引用项目中的证据路径，并区分已观察的结果与待验证的假设。

## 在集群上实际执行

当用户要求跑实验、实现改动或产出结果时，选择执行模式。模型选好后，三方先独立规划，主控在本机汇总派工，执行阶段通过 SSH 把任务交给服务器上已登录的 Codex CLI。它在指定项目目录使用 workspace-write，能编写脚本、运行分析并按集群规则提交作业。远程登录环境需要能找到 codex。若授权、沙箱或调度失败，报告具体原因和已完成阶段。交付前核对真实输出；对排队作业保留 job ID 并根据用户要求追踪到完成。

```sh
python3 skills/research-agent/scripts/research.py brief.md \
  --ssh-host my-cluster --remote-project /project/my-study --execute \
  --out runs/experiment-01
```

可以复用下文的 `--control-socket`。三方只需一个 SSH 通道；Claude 和 Gemini 仍在本机调用。SSH 工作区由服务器端 Codex 自身的沙箱约束。

## 复核远程服务器已有结果

三个模型的 CLI 都运行在本机。已有评估终表时，先确认作业状态、回单对应的实验条件和文件更新时间，再选取这次决策需要的汇总文件。通过已配置的 SSH 别名读取指定文件，Codex 在本地 evidence 副本中复核。每个文件使用不同的文件名。示例从仓库根目录运行：

```sh
python3 skills/research-agent/scripts/research.py brief.md \
  --ssh-host my-cluster \
  --remote-file /project/eval/results/paired.csv \
  --remote-file /project/eval/results/receipt.json \
  --out runs/remote-review-01
```

SSH 默认复用别名配置的连接。已有独立 ControlMaster 时加 `--control-socket /path/to/socket`。账号需要 MFA 时，在终端完成一次该别名的认证，再复用连接（[compute.md](compute.md)）。远程复核模式只读取列出的文件；文件和来源清单保存在本地运行目录。若原始材料需留在服务器，在服务器完成获准的核对，再提供可共享、可追溯的证据。说明本次直接查验了什么，以及哪些结论还需要原始材料。

## 用 Antigravity 提供 Claude

用户已选择让 Antigravity 提供 Claude 时，可用 `agy models` 核对账号可选的 Claude 型号，并显式加 `--claude-agy-model claude-opus-5-5-medium`。这会将主控的输入及执行报告经 Antigravity 发送给选定型号。
