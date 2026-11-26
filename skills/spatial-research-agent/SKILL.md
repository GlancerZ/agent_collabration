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
