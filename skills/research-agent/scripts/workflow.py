#!/usr/bin/env python3
"""Run one mechanical hand-off of the light or standard research workflow."""
import argparse
import concurrent.futures
import contextlib
import fcntl
import hashlib
from itertools import islice
import json
import math
import os
from pathlib import Path
import re
import shlex
import subprocess
import sys
import tempfile
import time

from checkpoint import fingerprint, seal_draft, sealed_draft_path
from progress import CODEX_UUID, atomic_text, claude_usage, codex_log_usage, from_codex_session, now
from product_probe import resolve_outdir
from research import agy_reader, codex_worker_env, ssh_command

HERE = Path(__file__).resolve().parent
ROLES = ("Claude", "Gemini", "Codex")  # Default standard-tier planners and reviewers.
DEFAULT_WORKER = "Codex"
ADJUDICATOR = "Adjudicator"
PROBE = "Probe"
CLIENTS = ("claude", "agy", "codex")
AGENT_NAME = r"[A-Za-z][A-Za-z0-9_-]{0,23}"  # Used in archive paths and board keys.
RESERVED = {"adjudicator", "probe", "lead", "jupiter"}
WORKER_TOOLS = "Bash,Read,Edit,Write,Glob,Grep"
PLAN_MAX_CHARS = 1500
REVIEW_MAX_CHARS = 1200
WORKER_MAX_CHARS = 1500
PLAN = f"""只读以下任务材料，独立规划。全稿 ≤ {PLAN_MAX_CHARS:,} 字，按以下小节写。
1. 要解决的问题
2. 要实现的功能或交付物
3. 方法与关键取舍
4. 验收条件（可逐条核对）
5. 主要风险与检验
不调用工具，不执行任务。"""
REVIEW = f"""只审阅以下冻结交付，独立填写。全稿 ≤ {REVIEW_MAX_CHARS:,} 字，按以下小节写。
1. 逐条验收表（每条标达标、未达标或证据不足，附证据位置）
2. 发现的问题及影响
3. 下一轮建议
不调用工具，不运行命令、补算、补测或改文件。"""
WORKER = f"""事实回执正文 ≤ {WORKER_MAX_CHARS:,} 字，末尾另附「## 证据路径索引」。
尽量把多条命令写进一个脚本一次执行，减少逐条小调用。
每项已提交的 Slurm 作业另起一行写 JOB_ID=数字（数组任务可用 数字_数字）。"""
GATE_EXCLUDES = {".git", ".venv", ".cache", "__pycache__", ".pytest_cache", "node_modules", ".DS_Store"}
GATE_ROOT_EXCLUDES = {"runs", "data"}  # Skipped only at the top of a gated directory.
JOB = r"[0-9]+(?:_[0-9]+)?"
WAITING = ("RUNNING", "PENDING", "CONFIGURING", "COMPLETING")
TERMINAL = ("COMPLETED", "FAILED", "CANCELLED", "TIMEOUT", "OUT_OF_MEMORY", "NODE_FAIL", "PREEMPTED",
            "DEADLINE", "BOOT_FAIL", "REVOKED", "SPECIAL_EXIT")
SSH_ALIAS = r"[A-Za-z0-9][A-Za-z0-9_.@-]*"
SSH_COMMAND_MAX = 120_000
LABEL_MAX = 40  # Card label under the agent name on the progress page.
FOLLOWUP_STEPS = {("plan", "dispatch"), ("gate", "formal"), ("review", "decide")}


def read(path):
    return Path(path).read_text(encoding="utf-8")


def dump(path, obj):
    atomic_text(path, json.dumps(obj, ensure_ascii=False, indent=2))


def load(path):
    return json.loads(read(path))


def require(condition, message):
    if not condition:
        raise ValueError(message)


def tool(name, *args):
    subprocess.run([sys.executable, str(HERE / name), *map(str, args)], check=True)


@contextlib.contextmanager
def exclusive(directory):
    directory.mkdir(parents=True, exist_ok=True)
    with (directory / ".workflow.lock").open("a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("another workflow command is active; use status")
        yield


def packet(paths):
    """Read once so all three clients receive identical UTF-8 bytes."""
    require(paths, "supply at least one approved text file")
    items = []
    for path in paths:
        data = path.read_bytes()
        body = data.decode("utf-8")
        require(body.strip(), f"empty input: {path}")
        items.append({"name": path.name, "sha256": hashlib.sha256(data).hexdigest(), "text": body})
    return items


def contents(items):
    return "\n\n".join(f"{item['name']} [{item['sha256']}]\n{item['text']}" for item in items)


def frozen_packet(folder, paths):
    manifest = folder / "输入.json"
    if paths:
        items = packet(paths)
        if manifest.exists():
            require(load(manifest) == items, "frozen packet differs; resume with the existing packet")
        else:
            dump(manifest, items)
    require(manifest.exists(), "supply --input for the first invocation")
    return contents(load(manifest))


def agent_names(value, flag):
    """Parse a comma-separated team list; names become archive folders and board keys."""
    if value is None:
        return None
    names = [name.strip() for name in value.split(",")]
    require(all(re.fullmatch(AGENT_NAME, name) for name in names)
            and len({name.lower() for name in names}) == len(names),
            f"{flag} requires a comma-separated list of distinct agent names (letters, digits, _ or -)")
    reserved = [name for name in names if name.lower() in RESERVED or name.lower().startswith("intent-")]
    require(not reserved, f"{flag}: reserved name {', '.join(reserved)}")
    return names


def team_members(planners, worker, reviewers):
    return list(dict.fromkeys((*planners, worker, *reviewers)))


def validate_routes(routes, team):
    require(isinstance(routes, dict), "routes must be a JSON object")
    required = [*team, *([ADJUDICATOR] if ADJUDICATOR in routes else [])]
    for role in required:
        route = routes.get(role)
        require(role in routes, f"routes has no agent {role}; add it to routes or choose the team with "
                                "--planners, --worker and --reviewers")
        require(isinstance(route, dict) and route.get("client") in CLIENTS
                and all(isinstance(route.get(k), str) and route[k].strip() for k in ("model", "effort")),
                f"missing or invalid confirmed client/model/effort for {role}")
        label = route.get("label")
        require(label is None or isinstance(label, str) and 0 < len(label.strip()) <= LABEL_MAX,
                f"{role}: label must be a non-empty string of at most {LABEL_MAX} characters")
    return routes


DISPATCH_SECTIONS = ("目标｜要解决的问题（采纳哪份方案、分歧与取舍）｜要实现的功能｜输入｜默认方法与参数｜"
                     "验收条件｜试跑范围｜回执格式｜计算资源（不用集群写“无”）")


def own_transcript():
    """This Claude Code session's transcript and working directory, when the chair runs inside one."""
    sid = os.environ.get("CLAUDE_CODE_SESSION_ID", "")
    if not re.fullmatch(r"[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}", sid):
        return None, None
    home = Path(os.environ.get("CLAUDE_CONFIG_DIR") or "~/.claude").expanduser()
    found = list((home / "projects").glob(f"*/{sid}.jsonl"))
    if len(found) != 1:
        return None, None
    with found[0].open(encoding="utf-8") as stream:
        for line in islice(stream, 50):
            with contextlib.suppress(ValueError):
                cwd = json.loads(line).get("cwd")
                if cwd and Path(cwd).is_dir():
                    return found[0], cwd
    return found[0], None


def card_label(route):
    """Line under an agent's card: the route's own label, else model and effort."""
    return (route.get("label") or "").strip() or f"{route['model']} · {route['effort']}"


def client(route, prompt, worker=False, network=False):
    model, effort = route["model"], route["effort"]
    if route["client"] == "claude":
        tools = ["--permission-mode", "acceptEdits", "--allowedTools", WORKER_TOOLS] if worker else ["--tools", ""]
        persistence = [] if worker else ["--no-session-persistence"]
        return ["claude", "-p", "--model", model, "--effort", effort, *tools,
                "--strict-mcp-config", *persistence, "--output-format", "json"], prompt
    if route["client"] == "agy":
        if worker:  # Headless agy auto-denies anything not allowed in settings.
            permissions = {"allow": ["command(*)", "write_file(*)", "read_file(*)"], "deny": ["mcp(*)"]}
            return ["agy", "--disable-slash-commands", "--effort", effort, "--output-format", "json",
                    "--mode", "accept-edits", "--settings", json.dumps({"permissions": permissions}),
                    "--model", model, "-p", prompt], ""
        command = agy_reader(model, prompt, read=False)
        return command[:1] + ["--effort", effort, "--output-format", "json"] + command[1:], ""
    command = ["codex", "exec", "-m", model, "-c", "model_reasoning_effort=" + json.dumps(effort),
               "--skip-git-repo-check", "--sandbox", "workspace-write" if worker else "read-only"]
    if worker and network:
        command += ["-c", "sandbox_workspace_write.network_access=true"]
    if not worker:
        command += ["--ignore-user-config", "--ignore-rules", "-c", "features.shell_tool=false",
                    "-c", "features.unified_exec=false", "-c", "features.multi_agent=false",
                    "-c", "features.multi_agent_v2=false"]
    return command + ["-"], prompt


def codex_session(stderr):
    match = re.search(rf"^\s*session id:[ \t]*({CODEX_UUID})[ \t]*$", stderr, re.MULTILINE)
    return match[1] if match else None


def codex_usage(stderr):
    session = codex_session(stderr)
    if session:
        try:
            return from_codex_session(session)
        except FileNotFoundError:
            pass  # The session may be on a remote host.
        except (OSError, ValueError) as error:
            print(f"警告：Codex 会话用量无法核对（{error}）", file=sys.stderr)
    return codex_log_usage(stderr)


def board_agent(role):
    return role.lower()


def directory_hashes(directory, skip=()):
    """Hash regular files and symlink entries; leave out `skip` paths.

    A symlinked directory is recorded by its link text only, so its target must be a hashed part of the tree.
    """
    require(directory.is_dir(), f"missing input directory: {directory}")
    base = directory.resolve()
    skip = {path.relative_to(base).as_posix() for path in skip if base in path.parents}

    def walk_error(error):
        raise error

    def hashed(target):
        if target != base and base not in target.parents:
            return False
        parts = target.relative_to(base).parts
        return not (GATE_EXCLUDES.intersection(parts) or parts[:1] and parts[0] in GATE_ROOT_EXCLUDES)

    hashes = {}
    for root, dirs, files in os.walk(directory, onerror=walk_error):
        root = Path(root)
        excluded = GATE_EXCLUDES | (GATE_ROOT_EXCLUDES if root == directory else set())
        keys = {name: (root / name).relative_to(directory).as_posix() for name in dirs + files}
        dirs[:] = sorted(name for name in dirs if name not in excluded and keys[name] not in skip)
        links = [name for name in dirs if (root / name).is_symlink()]
        outside = [str(root / name) for name in links if not hashed((root / name).resolve())]
        require(not outside, f"symlinked directory points outside the approved input directory: "
                             f"{', '.join(outside)}; bind its target with its own --input-dir")
        for name in sorted(set(files + links) - excluded):
            path, key = root / name, keys[name]
            if key in skip:
                continue
            if path.is_symlink():
                target = os.fsencode(os.readlink(path))
                payload = fingerprint(path).encode() if path.is_file() else b""
                hashes[key] = hashlib.sha256(target + b"\0" + payload).hexdigest()
            elif path.is_file():
                hashes[key] = fingerprint(path)
    return hashes


def probe_usage(transcript):
    result = None
    with transcript.open(encoding="utf-8", errors="replace") as stream:
        for line in stream:
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if isinstance(event, dict) and event.get("type") == "result":
                result = event
    return result


class Run:
    def __init__(self, args):
        self.a = args
        self.project = args.project.expanduser().resolve()
        self.base = self.project / "轮次" / f"{args.round:03d}"
        self.attempt = f"尝试-{args.attempt:02d}"
        self.chair = self.base / "主控" / self.attempt
        self.path = self.chair / "workflow.json"
        self.state = load(self.path) if self.path.exists() else {}
        self.lockdir = self.project / "进度"
        self.pause_file = self.project / "进度/暂停派工"

    def board(self, *args):
        tool("progress.py", self.project, *args)

    def run_line(self, *words, round_=None, attempt=None):
        """Runs from the project directory, so relative paths in a card work as written."""
        return " ".join(["cd", shlex.quote(str(self.project)), "&&", "python3", shlex.quote(str(HERE / "workflow.py")),
                         '"$PWD"', str(round_ or self.a.round), str(attempt or self.a.attempt), *words])

    def rel(self, path):
        return str(path.relative_to(self.project))

    def sized(self, paths):
        return "；".join(f"{self.rel(p)}（{len(read(p)):,} 字）" if p.is_file() else f"{self.rel(p)}（缺）"
                        for p in paths)

    def card(self):
        """Everything the chair needs for the next step, so it reads no script source or reference."""
        step, chair, light = self.state["next"], self.rel(self.chair), self.tier == "light"
        own = self.base / self.worker / self.attempt
        lines = [f"下一步｜{self.next_action(step)}"]
        if step == "plan":
            goal = f"轮次/{self.a.round:03d}/共同输入/本轮目标.md"
            lines += [f"  写｜{goal}：这轮要解决什么、为什么现在做、做到什么就结束（一两句）",
                      f"  运行｜{self.run_line('plan --input 项目说明.md --input', goal)}",
                      "  注意｜各方并发，全部封存才返回；等待时不打开任何草稿"]
        elif step == "dispatch":
            if light:
                lines.append(f"  写｜{chair}/派工单.md：先按计划五节（问题｜交付物｜方法与取舍｜验收条件｜风险与检验）写计划，"
                             f"再写派工九节：{DISPATCH_SECTIONS}")
            else:
                lines += [f"  读｜{self.sized([self.base / r / self.attempt / 'plan.md' for r in self.planners])}",
                          f"  写｜{chair}/派工单.md，九节：{DISPATCH_SECTIONS}"]
            lines += [f"  运行｜{self.run_line('dispatch', chair + '/派工单.md', '--workspace 工作目录')}",
                      "  注意｜本机 codex 执行者要联网加 --network；远程加 --ssh 别名；用集群加预算参数"]
        elif step in ("pilot", "formal"):
            lines.append(f"  运行｜{self.run_line(step)}")
            if step == "formal":
                lines.append(f"  之后｜回执里有 JOB_ID 时 {self.run_line('watch --wait 1800')}")
        elif step == "gate":
            workspace = shlex.quote(str(self.state.get("workspace")))
            lines += [f"  读｜{self.sized([own / 'pilot.md'])}；工作目录 {workspace} 的实际改动"
                      "（代码长时交给子代理或 /code-review，只取结论）",
                      f"  写｜{chair}/放行核对.md：通过或返工，逐条对照派工单验收条件写依据",
                      f"  运行｜{self.run_line('gate pass', chair + '/放行核对.md', '--input-dir', workspace)}",
                      f"  注意｜远程执行改用 --remote-input；返工用 gate revise 加同样参数，再以尝试号 {self.a.attempt + 1} init"]
        elif step == "review":
            pending = [job for job, state in self.state.get("job_states", {}).items() if state != "COMPLETED"]
            lines += [f"  读｜{self.sized([own / 'formal.md'])}",
                      *([f"  先｜作业未全部 COMPLETED（{', '.join(pending)}）：{self.run_line('watch --wait 1800')}"]
                        if pending else []),
                      f"  写｜{chair}/结果摘要.md：实际产物、关键数字和来源索引；大文件只放摘录和路径",
                      f"  运行｜{self.run_line('review --input', chair + '/结果摘要.md')}",
                      "  注意｜可再加同版材料 --input；全部封存才返回，等待时不打开任何草稿"]
        elif step == "decide":
            reviews = [self.base / r / self.attempt / "review.md" for r in self.reviewers]
            lines += [f"  读｜{self.sized(reviews + [own / '执行者意见.md'])}",
                      f"  写｜{chair}/决定稿.md：证据版本、共识与分歧、逐项采纳／暂缓／驳回及理由、待确认结论、下一步、实际用掉的计算",
                      f"  运行｜{self.run_line('decide done|next|hold', chair + '/决定稿.md')}",
                      "  注意｜分歧足以改变结论时先 adjudicate --input 争议点.md（routes 须有 Adjudicator）"]
        elif step == "next":
            lines += [f"  运行｜{self.run_line('handoff')}",
                      f"  然后｜{self.run_line('guide', round_=self.a.round + 1, attempt=1)}"]
        elif step == "revise":
            lines += [f"  运行｜{self.run_line('init', attempt=self.a.attempt + 1)}",
                      "  注意｜沿用派工单和团队，从试跑开始"]
        if step in ("plan", "pilot", "formal", "review"):
            lines.append("  等待｜要几分钟：放后台运行，等进程退出后看它打印的下一张卡片；等待期间不轮询、不读草稿或日志")
        return lines

    def startup_card(self):
        first = not any(self.project.glob("轮次/*/主控/尝试-*/workflow.json"))
        flags = (("--routes 路由.json " if first else "[--routes 路由.json] ") + "--tier standard|light "
                 "[--planners A,B] [--worker W] [--reviewers X,Y] --title 项目名 [--limits 限制] [--max-rounds N]")
        return ["开轮卡片",
                *(["  写｜项目说明.md：研究问题、可共享材料、交付物与验收、完成标准、授权与限制、档位及理由、已确认的团队与路由；"
                   "重要目标和限制写在前 15 行",
                   '  写｜路由.json：{"名称":{"client":"claude|agy|codex","model":"…","effort":"…","label":"可选"}}，'
                   "团队每人都要有"] if first else []),
                "  运行｜" + self.run_line("init", flags),
                "  注意｜init 同时初始化进度页并绑定本主控会话的用量，把它打印的页面路径告诉用户；"
                "后续每条命令都会打印下一步卡片，不必读 scripts/ 源码或预读 references。"]

    @property
    def tier(self):
        return self.state.get("tier", "standard")

    @property
    def reviewers(self):
        return self.state.get("reviewers", ["Claude"] if self.tier == "light" else list(ROLES))

    @property
    def planners(self):
        return [] if self.tier == "light" else self.state.get("planners", list(ROLES))

    @property
    def worker(self):
        return self.state.get("worker", DEFAULT_WORKER)

    def next_action(self, step):
        light = self.tier == "light"
        planners = "、".join(self.planners)
        return {"plan": f"{len(self.planners)} 方独立规划（{planners}）",
                "dispatch": "主控写计划与派工单" if light else "主控读取各份规划并派工",
                "pilot": f"{self.worker} 执行派工单中的试跑", "gate": "主控核对试跑并记录放行决定",
                "formal": f"{self.worker} 执行已放行的正式任务",
                "review": f"冻结交付，{'、'.join(self.reviewers)} 独立书面审阅",
                "decide": "主控读取已封存审阅并裁决",
                "next": "新一轮由主控写计划与派工单" if light else "下一轮从独立规划开始",
                "done": "已交付", "hold": "已暂停", "revise": "新尝试，从试跑开始"}[step]

    def intents(self):
        paths = [*self.chair.glob("*/intent-*.json"), *self.chair.glob("probe/*/intent-*.json")]
        for path in sorted(paths):
            role = path.stem.removeprefix("intent-")
            if re.fullmatch(AGENT_NAME, role):  # Skips intents already closed as *.ended-<ns>.json.
                yield path, role, (path.parent / (role + ".json")).exists()

    def unresolved(self, role):
        return any(actor == role and not received for _, actor, received in self.intents())

    def probe_files(self):
        """Request and transcript files written by probes; gated directory manifests skip them."""
        specs = [load(path)["spec"] for path in self.chair.glob("probe/*/intent-Probe*.json")]
        return [Path(spec[key]) for spec in specs for key in ("request", "transcript")]

    def write_recovery(self):
        handoff = self.chair / "交接单.md"
        lines = [f"第 {self.a.round} 轮，{self.attempt}。下一步｜{self.next_action(self.state['next'])}。",
                 f"工作流台账｜{self.path.relative_to(self.project)}"]
        if handoff.exists():
            fresh = f"当前步骤｜{self.state['next']}。" in read(handoff)
            label = "先读最近生成的交接单" if fresh else "交接单已过期（生成于更早步骤），以台账为准"
            lines.append(f"{label}｜{handoff.relative_to(self.project)}")
        atomic_text(self.project / "恢复点.md", "\n".join(lines) + "\n")

    def log(self, *words):
        with (self.project / "主控日志.md").open("a", encoding="utf-8") as log:
            print(now(), self.a.round, self.attempt, *words, file=log)

    def save(self, step):
        previous = self.state.get("next", "init")
        self.state["next"] = step
        self.state.setdefault("events", []).append({"time": now(), "from": previous, "to": step})
        dump(self.path, self.state)
        self.write_recovery()
        chair_state = "done" if step in ("done", "next") else "waiting"
        self.board("agent", "lead", chair_state, self.next_action(step))
        self.log(self.tier, previous, "→", step, self.path.relative_to(self.project))
        self.status()
        if (previous, step) in FOLLOWUP_STEPS:
            print("建议运行 handoff 后开启新的主控会话。")

    def status(self):
        require(self.state, "no workflow record for this attempt")
        print("已暂停" if self.pause_file.exists() else "当前", self.next_action(self.state["next"]), self.chair)
        print(f"档位 {self.tier}｜规划 {'、'.join(self.planners) or '主控'}｜执行 {self.worker}｜"
              f"审阅 {'、'.join(self.reviewers)}")
        for path, role, received in self.intents():
            print(path.parent.relative_to(self.chair), role, "已收件" if received else "待对账")
        if self.state.get("jobs"):
            print("作业", self.state.get("job_states", {}))
        print("\n".join(self.card()))

    def handoff(self):
        require(self.state, "no existing workflow")
        output = self.chair / "交接单.md"
        step = self.state["next"]
        lines = [f"# 第 {self.a.round} 轮 · {self.attempt} 交接单", f"记录时间 {now()}"]
        brief = self.project / "项目说明.md"
        if brief.is_file():
            lines.append("## 项目说明（前 15 行）")
            with brief.open(encoding="utf-8") as stream:
                lines.extend(line.rstrip("\r\n") for line in islice(stream, 15))
        routes = "；".join(f"{role}={route['client']}/{route['model']}/{route['effort']}"
                         for role, route in self.state["routes"].items() if isinstance(route, dict)
                         and {"client", "model", "effort"} <= route.keys())
        lines.extend(["## 当前交接", f"- 档位｜{self.tier}。规划｜{'、'.join(self.planners) or '主控'}。"
                                    f"执行｜{self.worker}。审阅｜{'、'.join(self.reviewers)}",
                      f"- 路由｜{routes}", f"- 当前步骤｜{step}。下一步｜{self.next_action(step)}"])
        for name in ("派工", "放行意见", "决定", "返工意见"):
            path = self.chair / (name + ".md")
            lines.append(f"- {name}｜{path.relative_to(self.project) if path.is_file() else '待归档'}")
        sealed = self.chair / "封存首稿"
        lines.append(f"- 封存首稿｜{sealed.relative_to(self.project) if sealed.is_dir() else '待归档'}")
        manifests = [str(path.relative_to(self.project)) for path in (self.chair / "plan/输入.json",
                     self.chair / "review/输入.json") if path.is_file()]
        lines.append(f"- 冻结输入索引（含 SHA-256）｜{'；'.join(manifests) or '见台账'}")
        adjudication = self.chair / "adjudicate/Adjudicator.md"
        if adjudication.is_file():
            lines.append(f"- 争议裁决回执｜{adjudication.relative_to(self.project)}")
        pending = [str(path.relative_to(self.project)) for path, _, received in self.intents() if not received]
        states = self.state.get("job_states", {})
        jobs = [f"{job}={states.get(job, 'UNKNOWN')}" for job in self.state.get("jobs", [])]
        lines.extend([f"- 无回执的调用意图｜{'；'.join(pending) or '无'}",
                      f"- 已登记作业及状态｜{'；'.join(jobs) or '无'}",
                      f"- 派工状态｜{'已暂停' if self.pause_file.exists() else '未暂停'}",
                      f"- 恢复台账｜{self.path.relative_to(self.project)}",
                      "- 恢复时先核对台账和无回执意图，再按下一步推进。",
                      "新会话输入 `/research-agent 从这个项目的恢复点继续`，先读本交接单，"
                      f"再运行 `{self.run_line('init')}` 把新会话补绑为主控用量来源（已有尝试只补绑定），然后按卡片推进。"])
        atomic_text(output, "\n".join(" ".join(line.splitlines()) for line in lines) + "\n")
        self.write_recovery()
        print(output)

    def init(self):
        a = self.a
        transcript, cwd = (a.lead_transcript, None) if a.lead_transcript else own_transcript()
        lead_roots = [word for root in [*a.lead_root, *([cwd] if cwd else [])] for word in ("--lead-root", root)]
        lead_roots += ["--lead-transcript", transcript] if transcript else []
        page = [word for flag, value in (("--title", a.title), ("--limits", a.limits), ("--max-rounds", a.max_rounds),
                                         ("--cluster", a.cluster)) if value is not None for word in (flag, value)]
        requested_reviewers = agent_names(a.reviewers, "--reviewers")
        requested_planners = agent_names(a.planners, "--planners")
        requested_worker = agent_names(a.worker, "--worker")
        require(requested_worker is None or len(requested_worker) == 1, "--worker takes one agent name")
        requested_worker = requested_worker and requested_worker[0]
        if self.state:
            require(a.tier in (None, self.tier) and (a.routes is None or load(a.routes) == self.state["routes"])
                    and (requested_reviewers is None or sorted(requested_reviewers) == sorted(self.reviewers))
                    and (requested_planners is None or sorted(requested_planners) == sorted(self.planners))
                    and requested_worker in (None, self.worker),
                    "existing attempt keeps its tier, routes and team; change them in a new round")
            if lead_roots or page:
                self.board("init", *lead_roots, *page)
            self.status()
            return
        prior = sorted(self.project.glob("轮次/*/主控/尝试-*/workflow.json"))
        previous = {}
        inherited = {}
        retry = False
        if prior:
            last = max(prior, key=lambda p: (int(p.parents[2].name), int(p.parent.name.split("-")[-1])))
            previous = load(last)
            old_round = int(last.parents[2].name)
            old_attempt = int(last.parent.name.split("-")[-1])
            retry = previous["next"] == "revise"
            if retry:
                require((a.round, a.attempt) == (old_round, old_attempt + 1), "use next attempt")
                inherited = {k: previous[k] for k in ("dispatch", "workspace", "ssh", "resources")}
                inherited.update(network=previous.get("network", False), scheduler_ssh=previous.get("scheduler_ssh"))
                require(previous.get("revision") or previous.get("gate_reason"), "missing revision instructions")
                inherited["dispatch"] += "\n主控返工意见\n" + previous.get("revision", previous.get("gate_reason", ""))
            else:
                require(previous["next"] in ("next", "done", "hold") and a.round == old_round + 1
                        and a.attempt == 1, "finish the current round or use its existing attempt")
                inherited["previous_decision"] = previous["decision"]
        old_tier = previous.get("tier", "standard")
        old_reviewers = list(previous.get("reviewers", ["Claude"] if old_tier == "light" else ROLES))
        old_planners = list(previous.get("planners", [] if old_tier == "light" else ROLES))
        old_worker = previous.get("worker", DEFAULT_WORKER)
        tier = a.tier or old_tier
        worker = requested_worker or old_worker
        if tier == "standard":
            planners = requested_planners or old_planners or list(ROLES)
            reviewers = requested_reviewers or (old_reviewers if old_tier == "standard" else list(ROLES))
            if min(len(planners), len(reviewers)) < 2:
                print("提示：标准档少于两方规划或审阅，失去独立对照；只在用户同意时这样配置。", file=sys.stderr)
        else:
            require(requested_planners is None, "light tier has no planners; the chair writes the plan")
            planners = []
            reviewers = requested_reviewers or (old_reviewers if old_tier == "light" else ["Claude"])
        routes = load(a.routes) if a.routes else previous.get("routes")
        require(routes is not None, "supply a JSON file with the confirmed routes")
        if retry:
            require(tier == old_tier and worker == old_worker and sorted(planners) == sorted(old_planners)
                    and sorted(reviewers) == sorted(old_reviewers) and routes == previous["routes"],
                    "change tier, team or routes in a new round")
            planners, reviewers = old_planners, old_reviewers
        team = team_members(planners, worker, reviewers)
        require(len({role.lower() for role in team}) == len(team), "agent names must differ beyond letter case")
        validate_routes(routes, team)
        expected = "pilot" if retry else "dispatch" if tier == "light" else "plan"
        occupied = any((self.base / role / self.attempt).is_dir() and any((self.base / role / self.attempt).iterdir())
                       for role in dict.fromkeys((*ROLES, *team, "主控")))
        require(not occupied, "existing attempt: use its original recovery ledger or choose a new round")
        board = self.project / "进度/status.json"
        if board.exists():
            board_state = load(board)
            require(self.a.round >= board_state.get("round", 1), "cannot start an earlier round")
            limit = board_state.get("max_rounds")
            require(not limit or self.a.round <= limit, "round exceeds project limit")
        cards = [word for role in team for word in
                 ("--agent", f"{board_agent(role)}={role}",
                  "--model", f"{board_agent(role)}={card_label(routes[role])}")]
        if ADJUDICATOR in routes:  # Its card appears on its first call, already labelled.
            cards += ["--model", f"{board_agent(ADJUDICATOR)}={card_label(routes[ADJUDICATOR])}"]
        # Before the skeleton, so a bad --lead-root leaves the attempt free.
        self.board("init", *lead_roots, *page, *cards, "--worker", board_agent(worker))
        tool("checkpoint.py", self.project, self.a.round, self.a.attempt, "init",
             "--worker", worker, "--agents", ",".join(team))
        self.state = dict(tier=tier, planners=planners, worker=worker, reviewers=reviewers, routes=routes,
                          jobs=[], **inherited)
        if routes[worker]["client"] != "codex":
            print(f"提示：执行者 {worker} 用 {routes[worker]['client']}，没有 Codex 沙箱；"
                  "网络和工作区外写入不受 workflow.py 限制。", file=sys.stderr)
        if retry:
            atomic_text(self.chair / "派工.md", self.state["dispatch"])
        self.board("stage", a.round, {"pilot": 3, "dispatch": 2, "plan": 1}[expected], self.next_action(expected))
        self.save(expected)

    def record_call(self, stage, role, route, receipt, suffix=""):
        agent = board_agent(role)
        usage_args = [word for key, value in receipt["usage"].items() if value is not None
                      for word in ("--" + key.replace("_", "-"), value)]
        call_id = f"{self.a.round}/{self.a.attempt}/{stage}/{role}{suffix}"
        status = receipt.get("status", "ok")
        self.board("call", agent, stage, "--key", call_id, "--model", route["model"], "--status", status,
                   *(["--note", f"{role} · {route['client']}"] if role in (ADJUDICATOR, PROBE) else []),
                   *(["--seconds", receipt["seconds"]] if receipt["seconds"] is not None else []), *usage_args)
        self.board("agent", agent, "done" if status == "ok" else "failed", stage)

    def call(self, stage, role, prompt, folder, worker=False):
        answer = folder / (role + ".json")
        intent = folder / ("intent-" + role + ".json")
        route = self.state["routes"][role]
        if not answer.exists():
            require(not intent.exists(), f"{stage}/{role}: unresolved previous call; reconcile first")
            require(not self.pause_file.exists(), "dispatch paused")
            ssh = self.state.get("ssh") if worker else None
            command, stdin = client(route, prompt, worker, worker and not ssh and self.state.get("network", False))
            if ssh:
                remote = "cd " + shlex.quote(self.state["workspace"]) + " && exec " + shlex.join(command)
                # The remote shell gets this as one argument, and Linux caps one argument at 128 KiB.
                require(len(remote.encode()) < SSH_COMMAND_MAX,
                        f"{role}: prompt too large for one SSH command ({len(remote.encode()):,} bytes); "
                        "shorten the inputs or use a worker whose client reads the prompt from stdin")
                command = ssh_command(ssh, None) + [remote]
            dump(intent, {"role": role, "stage": stage, "started": now(), "route": route})
            agent = board_agent(role)
            self.board("agent", agent, "running", stage)
            start = time.monotonic()
            res = None
            try:
                with tempfile.TemporaryDirectory() as temp:
                    cwd = temp
                    env = None
                    if worker and not ssh:
                        cwd = self.state["workspace"]
                        env = codex_worker_env(cwd)
                    res = subprocess.run(command, input=stdin, cwd=cwd, env=env, capture_output=True, text=True)
                elapsed = time.monotonic() - start
                require(res.returncode == 0, f"{role} exited {res.returncode}: {res.stderr[-350:]}")
                usage = {}
                if route["client"] in ("claude", "agy"):
                    obj = json.loads(res.stdout)
                    require(not obj.get("is_error"), f"{role} reported an error")
                    text = obj.get("response") if route["client"] == "agy" else obj.get("result")
                    if route["client"] == "claude":
                        usage = {key: value for key, value in claude_usage(obj).items() if type(value) is int}
                    else:
                        u = obj.get("usage") or {}
                        keys = {"input": "input_tokens", "output": "output_tokens", "cache_read": "cache_read_tokens",
                                "cache_write": "cache_creation_input_tokens", "total": "total_tokens"}
                        usage = {key: u[field] for key, field in keys.items() if type(u.get(field)) is int}
                else:
                    text, usage = res.stdout, codex_usage(res.stderr)
                require(isinstance(text, str) and text.strip(), f"{role}: empty receipt")
                dump(answer, {"text": text, "usage": usage, "seconds": round(elapsed, 2)})
            except Exception:
                if res is not None:  # Keep the evidence so the chair can reconcile the intent.
                    kept = folder / f"{role}.failed-{time.time_ns()}"
                    atomic_text(Path(f"{kept}.out"), res.stdout)
                    atomic_text(Path(f"{kept}.err"), res.stderr)
                    session = codex_session(res.stderr)
                    print(f"{role} 输出已保存：{kept}.out / .err" + (f"；Codex 会话 {session}" if session else ""),
                          file=sys.stderr)
                self.board("agent", agent, "failed", stage + "，请核对回执")
                raise
        rec = load(answer)
        limit = {"plan": PLAN_MAX_CHARS, "review": REVIEW_MAX_CHARS,
                 "pilot": WORKER_MAX_CHARS, "formal": WORKER_MAX_CHARS}.get(stage)
        body = rec["text"].split("\n## 证据路径索引", 1)[0] if worker else rec["text"]
        if limit is not None and len(body) > 2 * limit:
            print(f"警告：{stage}/{role} 回执 {len(body)} 字，超过 {limit:,} 字上限的两倍。", file=sys.stderr)
        self.record_call(stage, role, route, rec)
        return rec["text"]

    def batch(self, stage):
        a = self.a
        folder = self.chair / stage
        folder.mkdir(exist_ok=True)
        if stage == "review":
            self.ready_jobs()
        prompt = (PLAN if stage == "plan" else REVIEW) + "\n" + frozen_packet(folder, a.input)
        if stage == "plan" and "previous_decision" in self.state:
            prompt += "\n上一轮主控决定\n" + self.state["previous_decision"]
        if stage == "review":
            prompt += "\n本轮派工与验收标准\n" + self.state["dispatch"]
        roles = self.planners if stage == "plan" else self.reviewers
        label = ("独立规划" if stage == "plan" else "独立核验") + " · " + "、".join(roles)
        self.board("stage", a.round, 1 if stage == "plan" else 4, label)
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(roles)) as pool:
            replies = {role: pool.submit(self.call, stage, role, prompt, folder) for role in roles}
            answers = {role: result.result() for role, result in replies.items()}
        with tempfile.TemporaryDirectory(dir=self.chair) as temp:
            draft = Path(temp) / "首稿.md"
            sealed = {}
            for role, report in answers.items():
                draft.write_text(report, encoding="utf-8")
                sealed[role] = seal_draft(self.chair, stage + "-" + role, draft)
        for role, path in sealed.items():
            atomic_text(self.base / role / self.attempt / (stage + ".md"), read(path))
        step = 2 if stage == "plan" else 5
        self.board("stage", a.round, step)
        self.save("dispatch" if stage == "plan" else "decide")

    def dispatch(self):
        a = self.a
        require(all(not alias or re.fullmatch(SSH_ALIAS, alias) for alias in (a.ssh, a.scheduler_ssh)),
                "invalid SSH alias")
        workspace = str(a.workspace) if a.ssh else str(a.workspace.resolve())
        require(Path(workspace).is_absolute(), "use an absolute remote workspace")
        if not a.ssh:
            require(Path(workspace).is_dir(), "local workspace missing")
        check_budget(a)
        require(a.mode != "text" or (not a.ssh and not any(getattr(a, k) for k in RESOURCE_FIELDS[:3])), "text delivery uses local evidence only")
        require(not self.state.get("jobs"), "reconcile current jobs before dispatch")
        self.state.update(dispatch=contents(packet([a.file])), workspace=workspace, ssh=a.ssh,
                          scheduler_ssh=a.scheduler_ssh, network=a.network, mode=a.mode,
                          resources={k: getattr(a, k) for k in RESOURCE_FIELDS})
        atomic_text(self.chair / "派工.md", self.state["dispatch"])
        self.board("stage", a.round, 3)
        self.save("review" if a.mode == "text" else "pilot")

    def remote_hashes(self, paths):
        checked = {}
        for path in paths:
            require(Path(path).is_absolute(), "remote gate inputs must be absolute paths")
            cmd = ssh_command(self.state["ssh"], None) + ["sha256sum < " + shlex.quote(path)]
            output = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True,
                                    check=True).stdout.split()
            require(output and re.fullmatch(r"[0-9a-f]{64}", output[0]), "invalid remote checksum")
            checked[path] = output[0]
        return checked

    def gate_changes(self):
        """Return (approved inputs edited or removed, files added inside approved directories)."""
        changed, added = [], []
        remote = self.state.get("remote_gate", {})
        if remote:
            current = self.remote_hashes(remote)
            changed += [f"approved remote inputs changed: {path}" for path in remote if current[path] != remote[path]]
        changed += [f"approved inputs changed: {path}" for path, digest in self.state["gate"].items()
                    if not Path(path).is_file() or fingerprint(Path(path)) != digest]
        skip = self.probe_files()
        for root, approved in self.state.get("gate_dirs", {}).items():
            try:
                present = directory_hashes(Path(root), skip)
            except (OSError, ValueError) as error:
                changed.append(f"approved input directory changed: {root} ({error})")
                continue
            for found, label, paths in ((changed, "", [key for key in approved if approved[key] != present.get(key)]),
                                        (added, "added ", list(present.keys() - approved.keys()))):
                if paths:
                    paths.sort()
                    found.append(f"approved input directory changed: {root} ({label}{len(paths)}: "
                                 + ", ".join(paths[:10]) + ")")
        return changed, added

    def verify_gate(self):
        changes = sum(self.gate_changes(), [])
        require(not changes, "; ".join(changes) + "; reconcile with chair")

    def execute(self, stage):
        folder = self.chair / stage
        folder.mkdir(exist_ok=True)
        worker = self.worker
        result_path = folder / (worker + ".json")
        require(not self.a.receipt or not (folder / f"intent-{worker}.json").exists(),
                "use reconcile for an already dispatched call")
        require(not self.a.codex_session or self.state["routes"][worker]["client"] == "codex",
                f"--codex-session needs a Codex-client worker; {worker} uses {self.state['routes'][worker]['client']}")
        if stage == "formal":
            self.ready_jobs()
            if self.a.receipt and not result_path.exists():
                # The external run already happened: approved inputs must be intact, but it may add outputs.
                changed, added = self.gate_changes()
                require(not changed, "; ".join(changed) + "; reconcile with chair")
                for change in added:
                    print("警告：外部正式运行在已放行目录中新增文件，请主控核对：" + change, file=sys.stderr)
                    self.log("formal --receipt", change)
            elif not result_path.exists():  # A rerun after the call already happened keeps its receipt.
                self.verify_gate()
            require(not self.unresolved(PROBE), "unresolved product probe; reconcile first")
        instruction = ("只做派工单中的试跑；若为短盘点或纯文字任务只整理获准的材料。"
                       if stage == "pilot" else "只执行已放行的正式任务。")
        prompt = instruction + "\n" + WORKER + "\n" + self.state["dispatch"]
        resource_plan = {k: v for k, v in self.state.get("resources", {}).items() if v is not None}
        if resource_plan:
            prompt += "\n已核对的资源限制\n" + json.dumps(resource_plan, ensure_ascii=False)
        if stage == "formal":
            prompt += "\n试跑回执\n" + read(self.base / worker / self.attempt / "pilot.md")
            prompt += "\n主控放行意见\n" + self.state["gate_reason"]
            probes = [load(path)["evidence"] for path in sorted(self.chair.glob("probe/*/Probe.json"))]
            if probes:
                prompt += ("\n产品检验记录\n" + json.dumps(probes, ensure_ascii=False) +
                           "\n在改动前审计各产品检验会话，引用证据说明是否读取禁读路径、"
                           "决策理由能否在产物中回查、是否改动代码。缺少直接证据时标明无法核实。")
        self.board("stage", self.a.round, 3, stage)
        if self.a.receipt:
            text = read(self.a.receipt)
            require(text.strip(), "empty external worker receipt")
            if result_path.exists():
                require(load(result_path)["text"] == text, "receipt already exists")
            else:
                usage = from_codex_session(self.a.codex_session, self.a.since) if self.a.codex_session else {}
                dump(result_path, {"text": text, "usage": usage, "seconds": None})
        report = self.call(stage, worker, prompt, folder, worker=True)
        for line in report.splitlines():
            match = re.fullmatch(rf"JOB_ID=({JOB})\s*", line)
            if not match:
                if "JOB_ID" in line:
                    print(f"警告：未按 JOB_ID=数字 登记，请核对或用 job 补登：{line.strip()}", file=sys.stderr)
                continue
            if match[1] not in self.state["jobs"]:
                self.state["jobs"].append(match[1])
                self.state.setdefault("job_states", {})[match[1]] = "UNKNOWN"
            self.board("job", match[1], worker, "UNKNOWN")
        atomic_text(self.base / worker / self.attempt / (stage + ".md"), report)
        self.save("gate" if stage == "pilot" else "review")

    def ready_jobs(self):
        outstanding = [job for job, status in self.state.get("job_states", {}).items() if status != "COMPLETED"]
        require(not outstanding, "reconcile scheduler jobs before proceeding: " + ", ".join(outstanding))

    def job(self):
        job_id, status = self.a.job_id, self.a.state or "UNKNOWN"
        require(re.fullmatch(JOB, job_id), "expected Slurm job or array-task ID")
        if job_id not in self.state["jobs"]:
            self.state["jobs"].append(job_id)
        self.state.setdefault("job_states", {})[job_id] = status
        note = ["--note", "主控确认"] if self.a.state else []
        if note:
            self.log("job", job_id, status, "主控确认")
        self.save(self.state["next"])
        self.board("job", job_id, self.worker, status, *note)

    def watch(self):
        require(self.state["jobs"], "no registered Slurm jobs")
        deadline = time.monotonic() + self.a.wait
        host = self.state.get("scheduler_ssh") or self.state.get("ssh")
        while True:
            states = self.state.setdefault("job_states", {})
            for job in self.state["jobs"]:
                if states.get(job) in TERMINAL:
                    continue  # Final, including chair-confirmed, states stay as recorded.
                cmd = ["sacct", "-n", "-P", "-j", job, "--format=JobID,State"]
                if host:
                    cmd = ssh_command(host, None) + [shlex.join(cmd)]
                rows = subprocess.run(cmd, stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30,
                                      check=True).stdout.splitlines()
                found = {}
                for name, _, status in (line.partition("|") for line in rows):
                    if status.split() and (name == job or name.startswith(job + "_") and "." not in name):
                        found[name] = status.split()[0].rstrip("+")
                if found and job not in found:
                    print(f"作业 {job} 为数组父作业，按 {len(found)} 行子任务汇总：{found}")
                # Any failure first, then any waiting task; COMPLETED only when every row completed.
                states[job] = min(found.values(), key=lambda v: (v == "COMPLETED", v in WAITING), default="UNKNOWN")
                self.board("job", job, self.worker, states[job])
            dump(self.path, self.state)
            remaining = deadline - time.monotonic()
            # Wait while any job is unfinished; reconcile once all are final or the wait ends on an odd state.
            if all(v in TERMINAL for v in states.values()) or remaining <= 0:
                require(all(v in (*WAITING, "COMPLETED") for v in states.values()),
                        f"scheduler status needs reconciliation: {states}")
                if any(v in WAITING for v in states.values()):
                    print("仍在队列中", states)
                return
            time.sleep(min(self.a.interval, remaining))

    def gate(self):
        a = self.a
        require(a.input or a.input_dir, "gate requires at least one --input or --input-dir")
        if a.result == "revise":
            self.revise()
            return
        self.ready_jobs()
        if a.result == "pass" and self.state.get("ssh"):
            require(a.remote_input, "remote execution requires at least one --remote-input")
            self.state["remote_gate"] = self.remote_hashes(a.remote_input)
        self.state["gate_reason"] = contents(packet([a.file]))
        self.state["gate"] = {str(path.expanduser().absolute()): fingerprint(path.expanduser()) for path in a.input}
        roots = dict.fromkeys(path.expanduser().absolute() for path in a.input_dir)
        archive = [str(root) for root in roots if root.resolve() in (self.project, *self.project.parents)]
        require(not archive, f"--input-dir contains the project archive: {', '.join(archive)}; "
                             "bind narrower directories")
        self.state["gate_dirs"] = {str(root): directory_hashes(root, self.probe_files()) for root in roots}
        atomic_text(self.chair / "放行意见.md", self.state["gate_reason"])
        self.save("formal")

    def adjudicate(self):
        require(ADJUDICATOR in self.state["routes"], "no Adjudicator route configured in routes")
        self.ready_jobs()
        folder = self.chair / "adjudicate"
        folder.mkdir(exist_ok=True)
        dispute = frozen_packet(folder, [self.a.input])
        reports = []
        for role in self.reviewers:
            path = sealed_draft_path(self.chair, "review-" + role)
            require(path.is_file(), f"missing sealed review for {role}")
            reports.append(f"{role} 封存审阅\n" + contents(packet([path])))
        evidence = frozen_packet(self.chair / "review", None)
        prompt = ("只读本轮冻结材料与已封存的独立审阅。针对争议给出裁决建议、证据和未决项。"
                  "不调用工具。最终决定由主控作出。\n冻结材料\n" + evidence
                  + "\n本轮派工与验收标准\n" + self.state["dispatch"] + "\n"
                  + "\n\n".join(reports) + "\n争议点\n" + dispute)
        report = self.call("adjudicate", ADJUDICATOR, prompt, folder)
        path = folder / "Adjudicator.md"
        atomic_text(path, report)
        print(path)

    def probe(self):
        a = self.a
        formal = self.chair / "formal"
        require(not any((formal / name).exists() for name in (f"intent-{self.worker}.json", f"{self.worker}.json")),
                "probe must run before any formal invocation or receipt")
        require(not self.unresolved(PROBE), "unresolved product probe; reconcile first")
        self.verify_gate()
        workspace = Path(self.state["workspace"])
        require(not a.outdir.is_absolute() and ".." not in a.outdir.parts, "--outdir must be relative to the workspace")
        ssh = self.state.get("ssh")
        target = workspace / a.outdir if ssh else resolve_outdir(workspace, a.outdir)
        request = a.request.read_bytes()
        require(request.decode("utf-8").strip(), "empty product probe request")
        route = {"client": "claude", "model": a.model, "effort": a.effort}
        spec = {"route": route, "request_sha256": hashlib.sha256(request).hexdigest(), "allow": a.allow,
                "deny_read": a.deny_read, "request": str(target / "request.txt"),
                "transcript": str(target / "transcript.jsonl")}
        tag = hashlib.sha256(os.fsencode(target)).hexdigest()[:16]
        folder = self.chair / "probe" / tag
        folder.mkdir(parents=True, exist_ok=True)
        intent, receipt = folder / "intent-Probe.json", folder / "Probe.json"
        transcript, stderr = folder / "transcript.jsonl", folder / "stderr.log"
        if receipt.exists():
            require(load(intent)["spec"] == spec, "probe output directory already used; choose a new --outdir")
        else:
            require(not transcript.exists(), "probe archive already exists; choose a new --outdir")
            command = ["claude", "-p", "--model", a.model, "--strict-mcp-config",
                       "--output-format", "stream-json", "--verbose"]
            if a.effort:
                command += ["--effort", a.effort]
            if a.allow is not None:
                command += ["--allowedTools", a.allow]
            if a.deny_read:
                if "Bash" in (a.allow or ""):
                    print("警告：--allow 含 Bash，Bash 可绕过 Read 禁读规则。", file=sys.stderr)
                # Claude Code reads Read(/x) as project-relative; an absolute path needs Read(//x).
                command += ["--disallowedTools",
                            *(f"Read(/{path})" if os.path.isabs(path) else f"Read({path})" for path in a.deny_read)]
            runner = HERE / "product_probe.py"
            target_args = [str(workspace), str(a.outdir), *command]
            if ssh:
                command = ssh_command(ssh, None) + [shlex.join(["python3", "-c", read(runner), *target_args])]
            else:
                command = [sys.executable, str(runner), *target_args]
            dump(intent, {"role": PROBE, "stage": "probe", "started": now(), "spec": spec})
            self.board("agent", board_agent(PROBE), "running", "probe")
            start = time.monotonic()
            with transcript.open("xb") as out, stderr.open("xb") as err:
                proc = subprocess.run(command, input=request, stdout=out, stderr=err)
            result = probe_usage(transcript)
            status = "ok" if proc.returncode == 0 and result is not None and not result.get("is_error") else "failed"
            usage = claude_usage(result or {})
            seconds = usage.pop("seconds") or round(time.monotonic() - start, 2)
            dump(receipt, {"usage": usage, "seconds": seconds, "status": status,
                           "evidence": {**spec, "status": status}})
        record = load(receipt)
        self.record_call("probe", PROBE, route, record, "/" + tag)
        require(record["status"] == "ok", f"product probe failed; see {transcript} and {stderr}")
        print(spec["transcript"])

    def decide(self):
        require(not self.unresolved(ADJUDICATOR), "unresolved Adjudicator call; reconcile first")
        self.state["decision"] = contents(packet([self.a.file]))
        atomic_text(self.chair / "决定.md", self.state["decision"])
        self.save(self.a.result)

    def revise(self):
        require(self.state.get("next") in ("gate", "formal", "review"), "no execution to revise")
        require(self.state.get("mode") != "text", "a text round has no execution to revise; review, then decide next")
        require(all(v in TERMINAL for v in self.state.get("job_states", {}).values()),
                "reconcile outstanding scheduler jobs first (job ID --state for unresolvable ones)")
        formal = self.chair / "formal"
        require(not (formal / f"intent-{self.worker}.json").exists() or (formal / f"{self.worker}.json").exists(),
                "reconcile the existing formal intent before starting another attempt")
        require(not self.unresolved(PROBE), "unresolved product probe; reconcile first")
        self.state["revision"] = contents(packet([self.a.file]))
        atomic_text(self.chair / "返工意见.md", self.state["revision"])
        self.save("revise")

    def reconcile(self):
        stage = self.state["next"]
        role = self.a.role
        known = (*team_members(self.planners, self.worker, self.reviewers), ADJUDICATOR, PROBE)
        require(role in known, f"unknown role {role}; expected one of {', '.join(known)}")
        if role == PROBE:
            require(stage == "formal" and self.a.ended, "confirm an interrupted probe with reconcile Probe --ended")
            pending = [path for path, actor, received in self.intents() if actor == role and not received]
            require(len(pending) == 1, "expected one unresolved probe")
            intent = pending[0]
        else:
            if role == ADJUDICATOR:
                require(stage == "decide", "no Adjudicator call to reconcile at this step")
                stage = "adjudicate"
            require(stage in ("pilot", "formal", "review", "plan", "adjudicate"), "no calls to reconcile at this step")
            intent = self.chair / stage / ("intent-" + role + ".json")
        folder = intent.parent
        receipt = folder / (role + ".json")
        require(intent.exists() and not receipt.exists(), "no unresolved call for role")
        if self.a.receipt:
            report = contents(packet([self.a.receipt]))
            dump(receipt, {"text": report, "usage": {}, "seconds": None})
        else:
            # The chair has checked the original process, queue and receipts.
            intent.rename(folder / (intent.stem + f".ended-{time.time_ns()}.json"))
        self.status()


RESOURCE_FIELDS = ("nodes", "cards_per_node", "hours", "remaining_gpu_hours", "max_cards")


def check_budget(a):
    values = [getattr(a, k) for k in RESOURCE_FIELDS]
    if all(v is None for v in values):
        return
    require(all(v is not None for v in values[:3]), "provide nodes, cards per node and requested hours")
    require(all(math.isfinite(v) and v >= 0 for v in values if v is not None), "invalid resource estimate")
    cards = a.nodes * a.cards_per_node
    require(a.max_cards is None or cards <= a.max_cards, "allocation exceeds concurrent card budget")
    require(a.remaining_gpu_hours is None or cards * a.hours <= a.remaining_gpu_hours,
            "allocation exceeds remaining GPU hours after in-flight commitments")
    print(f"分配 {cards} 卡；上界 {a.nodes*a.hours:g} 节点小时，{cards*a.hours:g} GPU 小时")


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("project", type=Path)
    p.add_argument("round", type=int)
    p.add_argument("attempt", type=int)
    sub = p.add_subparsers(dest="cmd", required=True)
    init = sub.add_parser("init")
    init.add_argument("--routes", type=Path)
    init.add_argument("--tier", choices=("light", "standard"), help="default: previous tier, or standard on first init")
    init.add_argument("--planners", help="standard tier: comma-separated agent names from routes "
                                         "(default: previous round, else Claude,Gemini,Codex)")
    init.add_argument("--worker", help="agent from routes that implements and runs (default: previous round, else Codex)")
    init.add_argument("--reviewers", help="comma-separated agent names from routes (default: previous round of the "
                                          "same tier, else Claude for light and Claude,Gemini,Codex for standard)")
    init.add_argument("--lead-root", type=Path, action="append", default=[], help="additional lead transcript cwd root")
    init.add_argument("--lead-transcript", type=Path, help="chair transcript (default: this Claude Code session's)")
    init.add_argument("--title", help="progress page title")
    init.add_argument("--limits", help="progress page limits line, e.g. '≤8 GPU · 最多 2 轮'")
    init.add_argument("--max-rounds", type=int, help="progress page round limit")
    init.add_argument("--cluster", help="progress page cluster card name")
    sub.add_parser("guide", help="print the card for the next step (or for init) without changing anything")
    sub.add_parser("status")
    sub.add_parser("handoff")
    sub.add_parser("revise").add_argument("file", type=Path)
    sub.add_parser("pause")
    sub.add_parser("resume")
    job = sub.add_parser("job")
    job.add_argument("job_id")
    job.add_argument("--state", choices=TERMINAL, help="chair-confirmed final state for an unknown, purged or array job")
    watch = sub.add_parser("watch")
    watch.add_argument("--wait", type=int, default=0)
    watch.add_argument("--interval", type=int, default=30)
    for name in ("plan", "review"):
        sub.add_parser(name).add_argument("--input", type=Path, action="append")
    d = sub.add_parser("dispatch")
    d.add_argument("file", type=Path)
    d.add_argument("--workspace", type=Path, required=True)
    d.add_argument("--ssh")
    d.add_argument("--scheduler-ssh", help="SSH alias where watch runs sacct (default: --ssh, else local)")
    d.add_argument("--network", action="store_true", help="enable network access for a local Codex-client worker")
    d.add_argument("--mode", choices=["execute","text"], default="execute", help="text: assemble approved inputs only")
    for field in RESOURCE_FIELDS:
        d.add_argument("--"+field.replace("_","-"), type=int if field in ("nodes","cards_per_node","max_cards") else float)
    for name in ("pilot", "formal"):
        execution = sub.add_parser(name)
        execution.add_argument("--receipt", type=Path, help="record an existing worker delivery instead of invoking it")
        execution.add_argument("--codex-session", help="full Codex session UUID or rollout file for the existing receipt")
        execution.add_argument("--since", help="ISO-8601 time with timezone for usage deltas in a resumed session")
    g = sub.add_parser("gate")
    g.add_argument("result", choices=["pass","revise"])
    g.add_argument("file", type=Path)
    g.add_argument("--remote-input", action="append", help="absolute approved code/config file on remote host")
    g.add_argument("--input", type=Path, action="append", default=[])
    g.add_argument("--input-dir", type=Path, action="append", default=[], help="bind a recursive local file manifest")
    sub.add_parser("adjudicate").add_argument("--input", type=Path, required=True)
    probe = sub.add_parser("probe")
    probe.add_argument("--request", type=Path, required=True)
    probe.add_argument("--outdir", type=Path, required=True)
    probe.add_argument("--model", required=True)
    probe.add_argument("--effort")
    probe.add_argument("--allow", help="comma-separated Claude tool permissions")
    probe.add_argument("--deny-read", nargs="+", action="extend", default=[], metavar="PATH")
    d = sub.add_parser("decide")
    d.add_argument("result", choices=["done","next","hold"])
    d.add_argument("file", type=Path)
    d = sub.add_parser("reconcile")
    d.add_argument("role", help="team member, Adjudicator or Probe")
    group = d.add_mutually_exclusive_group(required=True)
    group.add_argument("--ended", action="store_true")
    group.add_argument("--receipt", type=Path)
    args = p.parse_args()
    try:
        require(min(args.round,args.attempt)>0, "invalid round or attempt")
        if args.cmd in ("pilot", "formal"):
            require(args.since is None or args.codex_session, "--since requires --codex-session")
            require(args.codex_session is None or args.receipt, "--codex-session requires --receipt")
        run = Run(args)
        if args.cmd == "pause":
            require(run.state, "no existing workflow")
            atomic_text(run.pause_file, now())
            print("暂停后续派工；已发出的调用或作业继续对账")
            return
        if args.cmd == "status":
            run.status()
            return
        if args.cmd == "guide":
            print("\n".join(run.card() if run.state else run.startup_card()))
            return
        with exclusive(run.lockdir):
            run.state = load(run.path) if run.path.exists() else {}
            if args.cmd == "resume":
                require(run.state, "no existing workflow")
                run.pause_file.unlink(missing_ok=True)
                run.status()
                return
            if args.cmd not in ("watch", "job", "reconcile", "handoff"):
                require(not run.pause_file.exists(), "dispatch paused; resume first")
            if args.cmd == "init":
                run.init()
            elif args.cmd == "revise":
                run.revise()
            elif args.cmd in ("job", "watch"):
                require(run.state.get("next") in ("pilot","gate","formal","review"), "no active execution")
                if args.cmd == "watch":
                    require(args.wait >= 0 and args.interval > 0, "invalid wait interval")
                getattr(run,args.cmd)()
            elif args.cmd == "reconcile":
                run.reconcile()
            elif args.cmd == "handoff":
                run.handoff()
            else:
                step = run.state.get("next")
                if args.cmd == "plan":
                    require(run.tier != "light", "light tier does not run plan; the chair writes the plan and uses dispatch")
                elif args.cmd == "adjudicate":
                    require(step == "decide", "adjudicate requires sealed reviews and must run before decide")
                elif args.cmd == "probe":
                    require(step == "formal", "probe is allowed only after gate pass and before formal")
                required_step = {"adjudicate": "decide", "probe": "formal"}.get(args.cmd, args.cmd)
                require(step == required_step, f"unexpected step; expected {step}")
                if args.cmd in ("plan","review"):
                    run.batch(args.cmd)
                elif args.cmd in ("pilot","formal"):
                    run.execute(args.cmd)
                else:
                    getattr(run,args.cmd)()
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as e:
        p.exit(1, str(e)+"\n")

if __name__ == "__main__":
    main()
