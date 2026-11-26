#!/usr/bin/env python3
"""Static pipeline progress page for a research project (项目/进度/).

The page (index.html) polls status.js every 5 s by injecting a <script> tag, so it
works when opened straight from disk (file://) — no server, no fetch/CORS.
The chair updates state with this script at every hand-off.

  progress.py 项目 init --title 名称 --limits "≤8 GPU · 2 轮" --max-rounds 2 \
      --model lead="Opus 5.5 · xhigh" --model claude="Fable 5.2 · xhigh" \
      --model gemini="4 Neon · XHigh" --model codex="gpt-6.2-astra · max" --cluster JUPITER
  progress.py 项目 stage 1 3 ["Codex 执行 · 尝试-01 试跑"]
  progress.py 项目 agent codex running "尝试-01 实现与试跑"      # idle|running|waiting|done|failed
  progress.py 项目 call claude "第1轮·规划" --model claude-fable-5-2 --from-claude-json out.json
  progress.py 项目 call codex "第1轮·规划" --model gpt-6.2-astra --from-codex-log codex.log
  progress.py 项目 call gemini "第1轮·规划" --model gemini-4-neon-xhigh --from-agy-json out.json
  progress.py 项目 call gemini "第1轮·规划" --replace 6 --from-agy-transcript ~/.gemini/antigravity-cli/brain/<对话ID>
  progress.py 项目 call gemini "..." --input 1200 --output 800        # or explicit numbers
  progress.py 项目 job 3120310 v19a-eval RUNNING --gpus 8 --note "..."
  progress.py 项目 event "三份首稿封存" [--agent lead]
  progress.py 项目 refresh                                           # recount lead usage only
"""
import fcntl, tempfile
import argparse, datetime as dt, json, os, re, shutil
from pathlib import Path

AGENTS = ["lead", "claude", "gemini", "codex", "jupiter"]
STEPS = ["独立规划", "Claude 汇总派工", "Codex 执行（试跑→检查点→正式）", "三方并行核验", "Claude 总验收与转向"]
TEMPLATE = Path(__file__).resolve().parent.parent / "assets" / "progress.html"


def now():
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def atomic_text(path, text):
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as f:
        try:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        except BaseException:
            os.unlink(f.name)
            raise
    os.replace(f.name, path)


def lead_usage(paths, project):
    seen = {}
    for path in paths:
        with Path(path).open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("type") != "assistant" or not row.get("cwd"):
                    continue
                cwd = Path(row["cwd"]).resolve()
                if cwd != project and project not in cwd.parents:
                    continue
                msg = row.get("message") or {}
                if msg.get("id") and msg.get("usage"):
                    key = (row.get("sessionId") or Path(path).stem, msg["id"])
                    seen[key] = msg["usage"]
    fields = {"input":"input_tokens", "output":"output_tokens",
              "cache_read":"cache_read_input_tokens", "cache_write":"cache_creation_input_tokens"}
    return dict(requests=len(seen), **{k: sum(u.get(v) or 0 for u in seen.values()) for k,v in fields.items()})


def from_claude_json(path):
    o = json.loads(Path(path).read_text(encoding="utf-8"))
    u = o.get("usage") or {}
    return {"input": u.get("input_tokens"), "output": u.get("output_tokens"),
            "cache_read": u.get("cache_read_input_tokens"), "cache_write": u.get("cache_creation_input_tokens"),
            "seconds": (o.get("duration_ms") or 0) / 1000 or None}


def from_codex_log(path):
    text = Path(path).read_text(encoding="utf-8", errors="replace")
    m = re.findall(r"tokens used\s*\n\s*([\d,]+)", text)
    return {"total": int(m[-1].replace(",", ""))} if m else {}


def _agy_usage(u):
    out = {"input": u.get("input_tokens"), "output": u.get("output_tokens"),
           "cache_read": u.get("cache_read_tokens")}
    return {k: v for k, v in out.items() if v is not None}


def from_agy_json(path):
    """agy -p --output-format json →
    {"response": "...", "duration_seconds": 2.8, "usage": {"input_tokens", "output_tokens",
     "thinking_tokens", "cache_read_tokens", "total_tokens"}}  (reply text is in "response")."""
    o = json.loads(Path(path).read_text(encoding="utf-8"))
    r = _agy_usage(o.get("usage") or {})
    if (o.get("usage") or {}).get("total_tokens") is not None:
        r["total"] = o["usage"]["total_tokens"]
    if o.get("duration_seconds"):
        r["seconds"] = round(o["duration_seconds"], 1)
    return r


def from_agy_transcript(path):
    """Backfill for calls made in text mode: sum the per-step usage that agy keeps in
    ~/.gemini/antigravity-cli/brain/<conversation_id>/.system_generated/logs/transcript_full.jsonl
    (pass that file or the <conversation_id> directory)."""
    p = Path(path).expanduser()
    if p.is_dir():
        p = p / ".system_generated/logs/transcript_full.jsonl"
    t = {"input": 0, "output": 0, "cache_read": 0}
    def walk(x):
        if isinstance(x, dict):
            if "input_tokens" in x or "output_tokens" in x:
                for k, v in _agy_usage(x).items():
                    t[k] += v or 0
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
    for line in p.open(encoding="utf-8"):
        try:
            walk(json.loads(line))
        except ValueError:
            continue
    return t


class Board:
    def __init__(self, project):
        self.dir = Path(project).expanduser().resolve() / "进度"
        self.state = self.dir / "status.json"

    def load(self):
        if self.state.exists():
            return json.loads(self.state.read_text(encoding="utf-8"))
        return {"project": Path(self.dir.parent).name, "max_rounds": None, "round": 1, "step": 1,
                "step_label": STEPS[0], "steps": STEPS, "limits": "", "models": {}, "cluster_name": "集群",
                "lead_transcripts": [],
                "agents": {a: {"state": "idle", "task": ""} for a in AGENTS},
                "calls": [], "jobs": [], "events": [], "lead_usage": {}}

    def save(self, s):
        self.dir.mkdir(parents=True, exist_ok=True)
        s.pop("lead_transcript", None)  # Older versions could select another project's transcript.
        paths = s.setdefault("lead_transcripts", [])
        s["lead_usage"] = lead_usage(paths, self.dir.parent) if paths else {}
        s["updated"] = now()
        atomic_text(self.state, json.dumps(s, ensure_ascii=False, indent=1))
        atomic_text(self.dir / "status.js", "window.PIPELINE_STATUS = " + json.dumps(s, ensure_ascii=False) + ";\n")
        if not (self.dir / "index.html").exists():
            shutil.copy(TEMPLATE, self.dir / "index.html")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("project")
    sub = p.add_subparsers(dest="cmd", required=True)
    a = sub.add_parser("init")
    a.add_argument("--title"); a.add_argument("--limits"); a.add_argument("--max-rounds", type=int)
    a.add_argument("--model", action="append", default=[], help="role=label, role in " + ",".join(AGENTS))
    a.add_argument("--cluster"); a.add_argument("--lead-transcript")
    a.add_argument("--refresh-template", action="store_true", help="overwrite index.html with the skill template")
    a = sub.add_parser("stage"); a.add_argument("round", type=int); a.add_argument("step", type=int); a.add_argument("label", nargs="?")
    a = sub.add_parser("agent"); a.add_argument("name", choices=AGENTS)
    a.add_argument("state", choices=["idle", "running", "waiting", "done", "failed"]); a.add_argument("task", nargs="?")
    a = sub.add_parser("call"); a.add_argument("agent", choices=AGENTS); a.add_argument("phase")
    a.add_argument("--model", default=""); a.add_argument("--status", default="ok"); a.add_argument("--note", default="")
    for k in ("input", "output", "cache-read", "cache-write", "total"):
        a.add_argument("--" + k, type=int)
    a.add_argument("--seconds", type=float)
    a.add_argument("--from-claude-json"); a.add_argument("--from-codex-log"); a.add_argument("--from-agy-json")
    a.add_argument("--from-agy-transcript", help="agy brain/<conversation_id> dir or its transcript_full.jsonl")
    a.add_argument("--replace", type=int, metavar="N", help="overwrite the N-th call (1-based, as listed in status.json) instead of appending")
    a = sub.add_parser("job"); a.add_argument("id"); a.add_argument("name"); a.add_argument("state")
    a.add_argument("--gpus", type=int); a.add_argument("--note", default="")
    a = sub.add_parser("event"); a.add_argument("text"); a.add_argument("--agent", default="lead", choices=AGENTS)
    sub.add_parser("refresh")
    x = p.parse_args()

    b = Board(x.project)
    b.dir.mkdir(parents=True, exist_ok=True)
    with (b.dir / ".lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        update(b, x, p)


def update(b, x, p):
    s = b.load()
    if x.cmd == "init":
        if x.title: s["project"] = x.title
        if x.limits is not None: s["limits"] = x.limits
        if x.max_rounds is not None:
            if x.max_rounds < s["round"]: p.error("round limit below current round")
            s["max_rounds"] = x.max_rounds
        if x.cluster: s["cluster_name"] = x.cluster
        if x.lead_transcript:
            path = Path(x.lead_transcript).expanduser().resolve()
            if not path.is_file(): p.error("lead transcript must be an existing file")
            paths = s.setdefault("lead_transcripts", [])
            if str(path) not in paths: paths.append(str(path))
        for kv in x.model:
            role, _, label = kv.partition("=")
            if role not in AGENTS:
                p.error(f"unknown role {role}")
            s.setdefault("models", {})[role] = label
        if x.refresh_template:
            b.dir.mkdir(parents=True, exist_ok=True)
            shutil.copy(TEMPLATE, b.dir / "index.html")
        print("lead transcript:", s.get("lead_transcripts") or "(none)")
        print("page:", b.dir / "index.html")
    elif x.cmd == "stage":
        if x.round < 1 or (s.get("max_rounds") and x.round > s["max_rounds"]) or not 1 <= x.step <= len(STEPS):
            p.error("round or step outside project limits")
        s["round"], s["step"] = x.round, x.step
        s["step_label"] = x.label or STEPS[x.step - 1]
        s["events"].append({"t": now(), "agent": "lead", "text": f"第 {x.round} 轮 · 第 {x.step} 步：{s['step_label']}"})
    elif x.cmd == "agent":
        ag = s["agents"].setdefault(x.name, {})
        ag["state"] = x.state
        if x.task is not None:
            ag["task"] = x.task
        ag["since"] = now()
    elif x.cmd == "call":
        c = {"t": now(), "agent": x.agent, "phase": x.phase, "model": x.model, "status": x.status, "note": x.note}
        parsed = {}
        try:
            if x.from_claude_json: parsed = from_claude_json(x.from_claude_json)
            elif x.from_codex_log: parsed = from_codex_log(x.from_codex_log)
            elif x.from_agy_json: parsed = from_agy_json(x.from_agy_json)
            elif x.from_agy_transcript: parsed = from_agy_transcript(x.from_agy_transcript)
        except (OSError, ValueError) as e:
            c["note"] = (c["note"] + f" · 用量解析失败：{e}").strip(" ·")
        explicit = {"input": x.input, "output": x.output, "cache_read": x.cache_read,
                    "cache_write": x.cache_write, "total": x.total, "seconds": x.seconds}
        for k, v in {**parsed, **{k: v for k, v in explicit.items() if v is not None}}.items():
            if v is not None:
                c[k] = v
        if not any(k in c for k in ("input", "output", "total")):
            c["note"] = (c["note"] + " · token 未记录").strip(" ·")
        if x.replace:
            c["t"] = s["calls"][x.replace - 1].get("t", c["t"])   # keep original call time
            s["calls"][x.replace - 1] = c
        else:
            s["calls"].append(c)
    elif x.cmd == "job":
        s["jobs"] = [j for j in s["jobs"] if j["id"] != x.id]
        j = {"id": x.id, "name": x.name, "state": x.state, "t": now(), "note": x.note}
        if x.gpus:
            j["gpus"] = x.gpus
        s["jobs"].append(j)
    elif x.cmd == "event":
        s["events"].append({"t": now(), "agent": x.agent, "text": x.text})
    b.save(s)


if __name__ == "__main__":
    main()
