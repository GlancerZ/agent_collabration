"""Run a spatial foundation model study with Claude, Gemini and Codex."""
import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

LEAD = """你是空间转录组 foundation model 项目的科研主控。用中文回答。
把细胞表达、邻域和组织尺度的主张分开。说明推理时可见的信息、预测对象和独立评估单位。
比较 checkpoint 时核对数据暴露、采样、空间图和读出。多因素变化只能支持整体版本结论。
明确区分同切片、跨切片、跨患者和跨平台泛化。选择一个最能区分竞争解释且符合预算的实验。
根据输入证据区分已知、推测、已提交、已运行和已核实。"""

REVIEW = """你是空间转录组 foundation model 的独立科研评审。用中文推导自己的判断。
说明实验实际测量什么。找出最可能改变结论的一个替代解释，并解释其作用机制。
视任务检查 donor 或重叠窗口泄漏、预训练集重合、平台 panel、组织组成或 support/query 关系。
设计一个判别实验，写清固定项、改变项、独立汇总单位，以及哪些结果支持或削弱原解释。
优先考虑已有 checkpoint。无法确定的信息请点名需要查的记录。"""

WORKER = """你负责空间模型的实验执行。以用户原始任务与资源限制为准，计划是建议。
检查实际配置、split、checkpoint、样本与特征对齐。根据任务检查空间图边界、坐标单位、
缺失 panel 和 masking 泄漏。比较版本时配对评估样本并说明覆盖率，按适当的 donor 或
cohort 汇总。执行时先跑真实数据小样例。给出证据路径、实际运行状态、结果及局限；
细胞数、独立样本数与训练 visits 分开报告。输出中文报告。"""


def call(command, prompt, directory):
    result = subprocess.run(command, input=prompt, text=True, cwd=directory,
                            stdout=subprocess.PIPE, check=True)
    answer = result.stdout.strip()
    if not answer:
        raise ValueError(f"{command[0]} returned an empty response")
    return answer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("brief", type=Path, help="UTF-8 task and shared background")
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path, help="new run directory")
    parser.add_argument("--execute", action="store_true", help="allow Codex workspace writes")
    args = parser.parse_args()
    brief = args.brief.read_text(encoding="utf-8").strip()
    project = args.project.resolve()
    if not brief or not project.is_dir():
        parser.error("provide a nonempty brief and an existing project directory")
    for cli in ("claude", "gemini", "codex"):
        if not shutil.which(cli):
            parser.error(f"missing CLI on PATH: {cli}")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)

    def save(name, answer):
        (out / name).write_text(answer + "\n", encoding="utf-8")
        return answer

    save("00-brief.md", brief)
    claude = ["claude", "-p", "--tools", "", "--no-session-persistence"]
    with tempfile.TemporaryDirectory() as temp:
        draft = save("01-draft.md", call(claude, LEAD + "\n独立设计方案。\n" + brief, temp))
        review = save("02-review.md", call(["gemini", "-p", REVIEW, "--output-format", "text"],
                                           brief, temp))
        context = f"用户任务\n{brief}\n\nClaude 草案\n{draft}\n\nGemini 独立评审\n{review}"
        plan = save("03-plan.md", call(claude, LEAD + "\n合并两份意见，列出分歧、取舍、验收条件。\n" + context, temp))
        mode = "执行授权范围内的实验。" if args.execute else "只读审计并提出可执行方案。本次仅做规划。"
        command = ["codex", "exec", "--skip-git-repo-check", "--sandbox",
                   "workspace-write" if args.execute else "read-only", "-"]
        evidence = save("04-codex.md", call(command, f"{WORKER}\n{mode}\n用户任务\n{brief}\n方案\n{plan}", project))
        final = call(claude, f"{LEAD}\n根据执行者报告汇总结论，注明哪些证据由执行者核对，"
                     f"保留未解决分歧。\n{context}\n综合方案\n{plan}\n执行者报告\n{evidence}", temp)
        save("05-report.md", final)
    print(out / "05-report.md")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
