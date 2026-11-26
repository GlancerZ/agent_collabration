---
name: spatial-research-agent
description: 用 Claude、Gemini 和 Codex 协作设计、复核或执行空间转录组 foundation model 的预训练对照、空间消融与跨患者迁移评估。
---

# 空间模型科研协作

把用户原始问题和三方可共享的背景写入 UTF-8 Markdown。尽量保留原话，补上可用数据、split、checkpoint、算力预算和用户要做的决定。比如「用两个已有 checkpoint 判断真实邻域是否提高未见患者上的细胞类型预测；只做评估，按 donor 配对，不重新训练」。给 Gemini 的输入只包含这份材料，以保留独立意见。

需要 Python 3.8+，以及已登录且可在终端非交互运行的 claude、agy（Google Antigravity CLI）和 codex。个人 Google 账号请按 [Antigravity 官方指南](https://antigravity.google/docs/getting-started?tab=cli) 安装 agy，运行 agy 登录。命令在 PATH 中可见时，从仓库根目录运行：

```sh
python3 skills/spatial-research-agent/scripts/research.py brief.md --project /path/to/research-project --out runs/pilot-01
```

安装成 skill 后使用本文件同目录下的 scripts/research.py。默认让 Codex 只读核对项目并规划。用户要求实际执行实验时加 --execute，让 Codex 在指定工作区内写入。Gemini 评审默认使用 Gemini 4 Neon High；通过 agy models 查看可用型号，用 --gemini-model 指定其他型号。Claude 和 Codex 沿用各自 CLI 的模型设置。Claude 和 Gemini 在临时目录工作，主控依据任务说明与执行报告整合结论。项目数据路径提供给 Codex，任务说明及各阶段文字输出可能传给对应的模型服务。

每次运行使用新的输出目录。依次保存原始任务、Claude 草案、Gemini 独立评审、综合方案、Codex 报告与最终结论。运行中断时查看最后完成的阶段和终端错误；重新执行前核对已生成的实验文件或已提交的作业。最终汇报引用项目中的证据路径，并区分已观察的结果与待验证的假设。

## 复核远程服务器已有结果

三个模型的 CLI 都运行在本机。已有评估终表时，先确认作业状态、回单对应的实验条件和文件更新时间，再选取这次决策需要的汇总文件。通过已配置的 SSH 别名读取指定文件，Codex 在本地 evidence 副本中复核。每个文件使用不同的文件名。示例从仓库根目录运行：

```sh
python3 skills/spatial-research-agent/scripts/research.py brief.md \
  --ssh-host my-cluster \
  --remote-file /project/eval/results/paired.csv \
  --remote-file /project/eval/results/receipt.json \
  --out runs/remote-review-01
```

SSH 默认复用别名配置的连接。已有独立 ControlMaster 时加 `--control-socket /path/to/socket`。账号需要 MFA 时，在终端完成一次该别名的认证，再复用连接。远程模式只读取列出的文件；文件和来源清单保存在本地运行目录。若需从逐供体预测重新计算，先在服务器按同一队列、任务、折和供体配对，导出汇总表后再交给模型。只取得队列均值时，在结论中注明配对区间尚待核实。任务说明可包含允许 Claude 和 Gemini 独立查看的队列级摘要。

比较新旧骨干时，把旧骨干上已有的强读出加入表格，核对两版同名读出的维数、归一化及每个分支的定义。对分支增益，分别用各自骨干的完整读出减去其基线，再按同一供体比较两版增益；报告分数单位、优化方向和区间。基线已经出现的版本差异需要单独解释。

Claude Code 暂不可用时，可用 `agy models` 核对账号可选的 Claude 型号，并显式加 `--claude-agy-model claude-opus-5-5-medium`。这会将主控的输入及执行报告经 Antigravity 发送给选定型号。Gemini 仍只收到任务说明和自己的评审指令。
