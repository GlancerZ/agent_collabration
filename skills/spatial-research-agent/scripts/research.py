"""Run a research workflow with Claude, Gemini and Codex."""
import argparse
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path, PurePosixPath

LEAD = """你是跨学科科研项目的主控，用中文回答。围绕研究者要作出的决定，明确问题、假设、证据与验收标准。
按项目选择合适的方法，例如原文查证、证明、观察比较、计算实验或复现。只有材料支持时才作因果或推广判断。
沿用用户设定的资源与轮数限制；未设的数值留空。区分已有事实、推测、下一步和已验收成果。"""

REVIEW = """你是独立科研评审。根据收到的共同材料独立推理，不调用工具，直接用中文回答。
给出自己的方案、最重要的替代解释或反例，以及什么证据可以区分它们。指出影响决策的假设和缺失材料。
按问题类型检查来源、推导、实验设计或评价方法。说明怎样判断研究目标达成。"""

WORKER = """你负责科研执行与自检。以用户原始任务、授权范围和实际设定的限制为准，用中文报告。
先核对材料来源与版本，复用已有成果。按任务实际完成检索整理、推导核对、分析、代码实现或实验评估。
记录方法、关键假设、可核验产物和自检结果。数值比较说明评价口径、单位、基线和不确定性；
文献结论指向原始证据；理论结论明确成立条件。外部实验与调度任务区分已计划、已提交、已完成和已核实。
每轮结果就绪后，另列「执行者意见」，引用证据解释结果，指出局限或替代解释，并建议下一步。"""


def call(command, prompt, directory):
    result = subprocess.run(command, input=prompt, text=True, cwd=directory,
                            stdout=subprocess.PIPE, check=True)
    answer = result.stdout.strip()
    if not answer:
        raise ValueError(f"{command[0]} returned an empty response")
    return answer


def ssh_command(host, socket):
    command = ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10"]
    if socket:
        command.extend(["-S", str(socket)])
    return command + [host]


def collect_evidence(host, paths, socket, directory):
    directory.mkdir()
    command = ssh_command(host, socket)
    for path in paths:
        target = directory / path.name
        with tempfile.NamedTemporaryFile(dir=directory, delete=False) as staged:
            try:
                subprocess.run(command + ["cat " + shlex.quote(str(path))],
                               stdin=subprocess.DEVNULL, stdout=staged, check=True)
            except BaseException:
                Path(staged.name).unlink()
                raise
        Path(staged.name).replace(target)
    return directory


def select_models(args, parser):
    if (not args.claude_model and not args.claude_agy_model and not args.use_defaults
            and sys.stdin.isatty()):
        print("先选客户端来源：Gemini 评审走 Antigravity，执行走 Codex。")
        choice = input("Claude 主控与独审用哪个入口？1 自己的 Claude Code；"
                       "2 Antigravity 的 Claude [1]：").strip() or "1"
        if choice == "2":
            args.claude_agy_model = input("输入 agy models 中的 Claude 型号：").strip()
            if not args.claude_agy_model:
                parser.error("选择 Antigravity 时需要指定 Claude 型号")
        elif choice != "1":
            parser.error("Claude 来源须选 1 或 2")
    roles = [
        ("claude_model", "Claude 主控（Claude Code）", "default"),
        ("gemini_model", "Gemini 独立评审（Antigravity）", "gemini-4-neon-high"),
        ("codex_model", "Codex 执行", "default"),
    ]
    for field, label, default in roles:
        if field == "claude_model" and args.claude_agy_model:
            continue
        value = getattr(args, field)
        if value is None:
            if args.use_defaults:
                value = default
            elif sys.stdin.isatty():
                hint = "使用 CLI 当前配置" if default == "default" else default
                value = input(f"{label}：输入型号，回车选择 {hint}：").strip() or default
            else:
                parser.error("请先选择三方模型；通过 --claude-model（或 --claude-agy-model）、"
                             "--gemini-model、--codex-model 指定，或用 --use-defaults 接受其余默认值")
        if not value.strip():
            parser.error(f"{label}: empty model")
        setattr(args, field, value.strip())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--show-routing", action="store_true", help="select and print requested routes without contacting providers")
    parser.add_argument("brief", nargs="?", type=Path, help="UTF-8 task and shared background")
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--project", type=Path)
    source.add_argument("--ssh-host", help="configured SSH alias for review or execution")
    parser.add_argument("--remote-file", action="append", default=[], type=PurePosixPath,
                        help="absolute path of a remote evidence file; repeat as needed")
    parser.add_argument("--control-socket", type=Path, help="existing SSH ControlPath")
    parser.add_argument("--remote-project", type=PurePosixPath, help="run Codex in this absolute directory on the SSH host")
    lead_models = parser.add_mutually_exclusive_group()
    lead_models.add_argument("--claude-model", help="Claude Code model or default")
    lead_models.add_argument("--claude-agy-model", help="use the specified Claude model via agy")
    parser.add_argument("--out", type=Path, help="new run directory")
    parser.add_argument("--gemini-model", help="Antigravity model slug (see agy models)")
    parser.add_argument("--codex-model", help="Codex model or default")
    parser.add_argument("--use-defaults", action="store_true", help="accept defaults for unspecified roles")
    parser.add_argument("--execute", action="store_true", help="execute in the selected local or remote workspace")
    args = parser.parse_args()
    select_models(args, parser)
    selection = {
        "lead": {"cli": "agy" if args.claude_agy_model else "claude",
                 "requested_model": args.claude_agy_model or args.claude_model},
        "review": {"cli": "agy", "requested_model": args.gemini_model},
        "worker": {"cli": "codex", "requested_model": args.codex_model},
    }
    if args.show_routing:
        print(json.dumps(selection, indent=2))
        return
    if not args.brief or not args.out or not (args.project or args.ssh_host):
        parser.error("a run requires a brief, --out, and either --project or --ssh-host")
    brief = args.brief.read_text(encoding="utf-8").strip()
    if not brief:
        parser.error("empty brief")
    if args.project and not args.project.is_dir():
        parser.error("project directory does not exist")
    if args.ssh_host is not None:
        if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", args.ssh_host):
            parser.error("use a configured SSH host alias")
        if args.execute:
            if args.remote_file:
                parser.error("use remote project paths in the execution brief; --remote-file is for review")
            if not args.remote_project or not args.remote_project.is_absolute():
                parser.error("remote execution requires an absolute --remote-project")
        elif not args.remote_file or args.remote_project:
            parser.error("remote review requires --remote-file; use --execute with --remote-project")
        if any(not p.is_absolute() or p.name in ("", "..") for p in args.remote_file):
            parser.error("remote files must have absolute paths and filenames")
        if len({p.name for p in args.remote_file}) != len(args.remote_file):
            parser.error("remote filenames must be distinct")
    elif args.remote_file or args.control_socket or args.remote_project:
        parser.error("remote options require --ssh-host")
    required = ["agy"]
    if not args.remote_project:
        required.append("codex")
    if not args.claude_agy_model:
        required.append("claude")
    if args.ssh_host:
        required.append("ssh")
    for cli in required:
        if not shutil.which(cli):
            parser.error(f"missing CLI on PATH: {cli}")
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=False)

    def save(name, answer):
        (out / name).write_text(answer + "\n", encoding="utf-8")
        return answer

    save("models.json", json.dumps(selection, indent=2))
    save("00-brief.md", brief)
    if args.remote_project:
        project = out
        remote_dir = shlex.quote(str(args.remote_project))
        remote = ssh_command(args.ssh_host, args.control_socket)
        subprocess.run(remote + [f"cd {remote_dir} && test -w . && codex --version"], check=True)
        save("execution-target.txt", f"{args.ssh_host}:{args.remote_project}")
    elif args.ssh_host:
        project = collect_evidence(args.ssh_host, args.remote_file, args.control_socket,
                                   out / "evidence")
        save("sources.txt", "\n".join(f"{args.ssh_host}:{p}" for p in args.remote_file))
    else:
        project = args.project.resolve()
    claude = ["claude", "-p", "--tools", "", "--no-session-persistence"]
    if args.claude_model and args.claude_model != "default":
        claude.extend(["--model", args.claude_model])
    with tempfile.TemporaryDirectory() as temp:
        def lead(prompt):
            if args.claude_agy_model:
                return call(["agy", "--model", args.claude_agy_model, "-p", prompt], "", temp)
            return call(claude, prompt, temp)

        draft = save("01-draft.md", lead(LEAD + "\n独立设计方案。\n" + brief))
        review_command = ["agy", "--model", args.gemini_model,
                          "-p", REVIEW + "\n用户任务\n" + brief]
        review = save("02-review.md", call(review_command, "", temp))
        context = f"用户任务\n{brief}\n\nClaude 草案\n{draft}\n\nGemini 独立评审\n{review}"
        plan = save("03-plan.md", lead(LEAD + "\n合并两份意见，列出分歧、取舍、验收条件。\n" + context))
        mode = "执行授权范围内的实验。" if args.execute else "只读审计并提出可执行方案。本次仅做规划。"
        command = ["codex", "exec", "--skip-git-repo-check", "--sandbox",
                   "workspace-write" if args.execute else "read-only"]
        if args.codex_model != "default":
            command.extend(["--model", args.codex_model])
        command.append("-")
        if args.remote_project:
            command = remote + [f"cd {remote_dir} && exec " + shlex.join(command)]
            mode += " 工作目录位于远程服务器。只执行原任务授权的工作，按集群规定提交计算作业，区分已提交与已核实的产物。"
        evidence = save("04-codex.md", call(command, f"{WORKER}\n{mode}\n用户任务\n{brief}\n方案\n{plan}", project))
        final = lead(f"{LEAD}\n根据执行者报告汇总结论，注明哪些证据由执行者核对，"
                     f"说明是否采纳 Codex 的结果解读和建议、证据理由，并保留未解决分歧。\n{context}\n综合方案\n{plan}\n执行者报告\n{evidence}")
        save("05-report.md", final)
    print(out / "05-report.md")


if __name__ == "__main__":
    try:
        main()
    except (EOFError, OSError, ValueError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
