"""Exercise the installed entry point with isolated clients and scheduler receipts."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "skills/research-agent/scripts/workflow.py"
CACHE_KEYS = ("UV_CACHE_DIR", "MPLCONFIGDIR", "NUMBA_CACHE_DIR", "XDG_CACHE_HOME")
SESSION = "a1234567-1234-4abc-abcd-0123456789ab"
CLIENT = """#!/usr/bin/env python3
import json, os, subprocess, sys
from pathlib import Path
role = Path(sys.argv[0]).name
root = Path(os.environ['FIXTURES'])
args = sys.argv[1:]
prompt = args[-1] if role == 'agy' else sys.stdin.read()
cache_keys = ('UV_CACHE_DIR', 'MPLCONFIGDIR', 'NUMBA_CACHE_DIR', 'XDG_CACHE_HOME')
with (root/(role+'.calls')).open('a') as out:
    print(json.dumps([args, prompt, {'cwd': str(Path.cwd()),
                                    'env': {k: os.environ.get(k) for k in cache_keys}}]), file=out)
def sacct():
    rows = root/'sacct-rows'
    print(rows.read_text() if rows.exists() else '42|' + (root/'scheduler').read_text())
    sys.exit()
if role == 'ssh':
    import shlex, hashlib
    line=args[-1]
    if line.startswith('sha256sum < '):
        print(hashlib.sha256(Path(shlex.split(line)[-1]).read_bytes()).hexdigest(), '-')
    elif line.startswith('python3 -c '):
        sys.exit(subprocess.run([sys.executable, *shlex.split(line)[1:]], input=prompt, text=True).returncode)
    elif line.startswith('sacct '):
        sacct()
    else:
        assert '&& exec codex' in line
        print('mock remote result')
    sys.exit()
if role == 'sacct':
    sacct()
if (root/('fail-'+role)).exists():
    sys.exit(1)
body = root/('reply-'+role)
reply = body.read_text() if body.exists() else role.title() + ' receipt'
if role == 'codex':
    log = root/'codex-stderr'
    if log.exists():
        sys.stderr.write(log.read_text())
    print(reply)
elif 'stream-json' in args:
    print(json.dumps({'type':'assistant','usage':{'input_tokens':999}}))
    print(json.dumps({'type':'result','result':reply,'duration_ms':250,
                      'usage':{'input_tokens':11,'cache_read_input_tokens':7,'output_tokens':3}}))
else:
    print(json.dumps({'result':reply, 'response':reply, 'usage':{'output_tokens':3}}))
"""


class WorkflowTest(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.project = self.root / "archive"
        self.workspace = self.root / "work tree"
        self.workspace.mkdir()
        self.routes = self.root / "routes.json"
        self.file = self.root / "brief.txt"
        self.file.write_text("frozen evidence")
        bindir = self.root / "bin"
        bindir.mkdir()
        for cli in ("claude", "agy", "codex", "sacct", "ssh"):
            path = bindir / cli
            path.write_text(CLIENT)
            path.chmod(0o755)
        self.config = {role: dict(client=cli, model="mock", effort="high")
                       for role, cli in [("Claude", "claude"), ("Gemini", "agy"), ("Codex", "codex")]}
        self.routes.write_text(json.dumps(self.config))
        self.home = self.root / "home"
        self.home.mkdir()
        self.env = dict(os.environ, PATH=str(bindir)+os.pathsep+os.environ["PATH"], FIXTURES=str(self.root),
                        HOME=str(self.home), PYTHONDONTWRITEBYTECODE="1")
        self.env.pop("CODEX_HOME", None)
        self.round = self.attempt = 1

    def cli(self, *words, ok=True, stdin=None):
        cmd = [sys.executable, str(SCRIPT), str(self.project), str(self.round), str(self.attempt), *map(str, words)]
        source = {"stdin": subprocess.DEVNULL} if stdin is None else {"input": stdin}
        out = subprocess.run(cmd, text=True, capture_output=True, env=self.env, **source)
        self.assertEqual(out.returncode == 0, ok, (cmd,out.stdout,out.stderr))
        return out.stdout + out.stderr

    def calls(self, cli):
        path = self.root / (cli + ".calls")
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    @property
    def chair(self):
        return self.project / "轮次" / f"{self.round:03d}" / "主控" / f"尝试-{self.attempt:02d}"

    def state(self):
        return json.loads((self.chair / "workflow.json").read_text())

    def board(self):
        return json.loads((self.project / "进度/status.json").read_text())

    def init_light(self):
        self.routes.write_text(json.dumps({role: self.config[role] for role in ("Claude", "Codex")}))
        self.cli("init", "--routes", self.routes, "--tier", "light")

    def gate_workspace(self):
        self.init_light()
        (self.workspace / "model.py").write_text("seed = 3\n")
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.cli("pilot", "--receipt", self.file)
        self.cli("gate", "pass", self.file, "--input-dir", self.workspace)

    def write_rollout(self, codex_home=None):
        folder = (codex_home or self.home / ".codex") / "sessions/2026/11/26"
        folder.mkdir(parents=True, exist_ok=True)
        path = folder / f"rollout-mock-{SESSION}.jsonl"
        totals = [(120, 100, 5), (131, 105, 9), (157, 125, 11)]
        events = [{"timestamp": f"2026-11-26T00:0{minute}:00Z", "type": "event_msg",
                   "payload": {"type": "token_count", "info": {"total_token_usage":
                               dict(zip(("input_tokens", "cached_input_tokens", "output_tokens"), counts))}}}
                  for minute, counts in enumerate(totals)]
        path.write_text("\n".join(map(json.dumps, events)) + "\n")
        return path

    def probe(self, request, outdir, *options, ok=True):
        return self.cli("probe", "--request", request, "--outdir", outdir, "--model", "probe-mock", *options, ok=ok)

    def probe_calls(self):
        return [call for call in self.board()["calls"] if call["phase"] == "probe"]

    def test_failure_recovery_budget_gate_jobs_and_next_round(self):
        self.cli("init", "--routes", self.routes)
        fail = self.root / "fail-agy"
        fail.touch()
        self.cli("plan","--input",self.file,ok=False)
        fail.unlink()
        self.cli("plan",ok=False)
        self.assertEqual(len(self.calls("claude")),1)
        self.cli("reconcile","Gemini","--ended")
        self.cli("plan")
        self.assertEqual(len(self.calls("codex")),1)
        self.cli("dispatch",self.file,"--workspace",self.root,"--nodes",1,"--hours",2,
                 "--cards-per-node",4,"--max-cards",2,ok=False)
        self.cli("dispatch",self.file,"--workspace",self.root,"--nodes",1,"--hours",2,
                 "--cards-per-node",4,"--remaining-gpu-hours",8)
        self.cli("pilot")
        self.cli("formal",ok=False)
        self.cli("gate","pass",self.file,"--input",self.file)
        self.file.write_text("changed")
        self.cli("formal",ok=False)
        self.file.write_text("frozen evidence")
        job = self.root / "result.txt"
        job.write_text("already submitted\nJOB_ID=42")
        self.cli("formal","--receipt",job)
        self.cli("review","--input",self.file,ok=False)
        scheduler=self.root/"scheduler"
        scheduler.write_text("RUNNING")
        self.assertIn("RUNNING",self.cli("watch"))
        scheduler.write_text("COMPLETED")
        self.cli("watch")
        self.cli("pause")
        self.cli("review","--input",self.file,ok=False)
        self.cli("resume")
        self.cli("review","--input",self.file)
        self.assertEqual(self.calls("claude")[-1][1],self.calls("agy")[-1][1])
        self.assertEqual(self.calls("agy")[-1][1],self.calls("codex")[-1][1])
        self.assertIn("features.shell_tool=false",self.calls("codex")[-1][0])
        self.assertIn("command(*)",str(self.calls("agy")[-1][0]))
        self.assertIn("read_file(*)",str(self.calls("agy")[-1][0]))
        self.cli("decide","next",self.file)
        board=json.loads((self.project/"进度/status.json").read_text())
        self.assertEqual(len(board["calls"]),8)
        self.round=2
        self.cli("init")
        self.cli("plan","--input",self.file)
        self.assertIn("上一轮主控决定",self.calls("claude")[-1][1])

    def test_remote_version_binding_and_retry_guard(self):
        self.cli("init", "--routes", self.routes)
        self.cli("plan","--input",self.file)
        self.cli("dispatch",self.file,"--workspace","/remote/work with spaces","--ssh","JUPITER","--network")
        self.cli("pilot")
        args, _, context = self.calls("ssh")[-1]
        self.assertNotIn("sandbox_workspace_write.network_access", args[-1])
        self.assertEqual(context["env"], {key: self.env.get(key) for key in CACHE_KEYS})
        remote = self.root / "remote code"
        remote.write_text("v1")
        self.cli("gate","pass",self.file,"--input",self.file,ok=False)
        self.cli("gate","pass",self.file,"--input",self.file,"--remote-input",remote)
        remote.write_text("v2")
        self.assertIn("remote inputs changed",self.cli("formal",ok=False))
        self.cli("revise",self.file)
        self.attempt=2
        self.cli("init")
        self.cli("pilot")
        self.cli("job","42")
        self.cli("gate","revise",self.file,"--input",self.file,ok=False)

    def test_text_round_and_revised_attempt(self):
        self.cli("init", "--routes", self.routes)
        self.cli("plan","--input",self.file)
        self.cli("dispatch",self.file,"--workspace",self.root)
        self.cli("pilot","--receipt",self.file)
        self.cli("gate","revise",self.file,"--input",self.file)
        self.attempt=2
        self.cli("init")
        self.cli("pilot")
        self.cli("gate","pass",self.file,"--input",self.file)
        self.cli("formal")
        self.cli("review","--input",self.file)
        self.cli("decide","next",self.file)
        self.round,self.attempt=2,1
        self.cli("init")
        self.cli("plan","--input",self.file)
        self.cli("dispatch",self.file,"--workspace",self.root,"--mode","text")
        self.cli("review","--input",self.file)
        self.cli("decide","done",self.file)
        self.assertTrue((self.project/"恢复点.md").exists())

    def test_light_flow_and_inheritance(self):
        self.init_light()
        self.assertEqual((self.state()["tier"], self.state()["next"]), ("light", "dispatch"))
        self.assertIn("light tier does not run plan", self.cli("plan", "--input", self.file, ok=False))
        code = self.workspace / "model.py"
        code.write_text("seed = 3\n")
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.cli("pilot")
        self.assertIn("handoff", self.cli("gate", "pass", self.file, "--input-dir", self.workspace))
        self.cli("formal")
        self.assertIn("handoff", self.cli("review", "--input", self.file))
        self.assertEqual(len(self.calls("claude")), 1)
        self.assertIn("≤ 1,200 字", self.calls("claude")[0][1])
        self.assertEqual(len(self.calls("codex")), 2)
        self.assertFalse(self.calls("agy"))
        self.assertEqual(len(list((self.chair / "封存首稿").glob("*.md"))), 1)
        for args, prompt, context in self.calls("codex"):
            self.assertNotIn("sandbox_workspace_write.network_access=true", args)
            self.assertTrue(all(Path(context["env"][key]).parent == self.workspace.resolve() / ".cache"
                                for key in CACHE_KEYS))
            self.assertIn("≤ 1,500 字", prompt)
            self.assertIn("证据路径索引", prompt)
            self.assertIn("一个脚本一次执行", prompt)
        self.cli("decide", "next", self.file)
        self.round = 2
        self.cli("init")
        self.assertEqual((self.state()["tier"], self.state()["reviewers"], self.state()["next"]),
                         ("light", ["Claude"], "dispatch"))

    def test_explicit_reviewers_and_new_round_tier_override(self):
        self.assertIn("standard tier always", self.cli("init", "--routes", self.routes,
                                                       "--reviewers", "Claude", ok=False))
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--mode", "text")
        self.cli("review", "--input", self.file)
        self.cli("decide", "next", self.file)
        self.round = 2
        self.assertIn("Gemini", self.cli("init", "--reviewers", "Claude,Gemini", ok=False))
        self.cli("init", "--routes", self.routes, "--reviewers", "Claude,Codex")
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--mode", "text")
        self.cli("review", "--input", self.file)
        self.assertEqual(len(self.calls("claude")), 2)
        self.assertEqual(len(self.calls("codex")), 1)
        self.assertFalse(self.calls("agy"))
        self.cli("decide", "next", self.file)
        self.round = 3
        self.assertIn("Gemini", self.cli("init", "--tier", "standard", ok=False))
        self.routes.write_text(json.dumps(self.config))
        self.cli("init", "--tier", "standard", "--routes", self.routes)
        self.assertEqual(self.state()["reviewers"], ["Claude", "Gemini", "Codex"])
        self.assertEqual(self.state()["next"], "plan")

    def test_gate_directory_rejects_additions_removals_and_edits(self):
        self.init_light()
        src = self.workspace / "src"
        src.mkdir()
        code = src / "model.py"
        code.write_text("seed = 3\n")
        config = self.workspace / "config"
        config.mkdir()
        (config / "parameters.json").write_text("{}")
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.cli("pilot", "--receipt", self.file)
        self.assertIn("at least one --input", self.cli("gate", "pass", self.file, ok=False))
        self.cli("gate", "pass", self.file, "--input", self.file, "--input-dir", src, "--input-dir", config)
        addition = src / "added.py"
        addition.write_text("new = 1\n")
        self.assertIn("approved input directory changed", self.cli("formal", ok=False))
        addition.unlink()
        code.write_text("seed = 4\n")
        self.assertIn("approved input directory changed", self.cli("formal", ok=False))
        code.unlink()
        self.assertIn("approved input directory changed", self.cli("formal", ok=False))
        code.write_text("seed = 3\n")
        for name in (".git", ".venv", ".cache", "__pycache__", ".pytest_cache", "runs", "data", "node_modules"):
            excluded = src / name
            excluded.mkdir()
            (excluded / "ignored").write_text(name)
        self.assertFalse(self.calls("codex"))
        self.cli("formal")
        self.assertEqual(len(self.calls("codex")), 1)

    def test_local_network_cache_and_persistent_session_usage(self):
        self.init_light()
        rollout = self.write_rollout()
        (self.root / "codex-stderr").write_text(f"session id: {SESSION}\ntokens used\n9,999\n")
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--network")
        self.assertTrue(self.state()["network"])
        self.cli("pilot")
        args, _, context = self.calls("codex")[0]
        self.assertIn("sandbox_workspace_write.network_access=true", args)
        self.assertNotIn("--ephemeral", args)
        caches = dict(zip(CACHE_KEYS, ("uv", "matplotlib", "numba", "xdg")))
        self.assertEqual(context["env"], {key: str(self.workspace.resolve() / ".cache" / name)
                                         for key, name in caches.items()})
        call = self.board()["calls"][0]
        self.assertEqual((call["input"], call["cache_read"], call["output"]), (32, 125, 11))
        self.assertNotIn("total", call)
        rollout.unlink()
        self.cli("gate", "pass", self.file, "--input", self.file)
        self.cli("formal")
        self.assertEqual(self.board()["calls"][-1]["total"], 9999)

    def test_external_receipts_register_codex_session_deltas(self):
        self.init_light()
        self.write_rollout()
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.assertIn("--codex-session requires --receipt", self.cli("pilot", "--codex-session", SESSION, ok=False))
        self.assertIn("--since requires --codex-session", self.cli("pilot", "--receipt", self.file,
                                                                   "--since", "2026-11-26T00:00:00Z", ok=False))
        self.cli("pilot", "--receipt", self.file, "--codex-session", SESSION, "--since", "2026-11-26T00:01:00Z")
        self.cli("gate", "pass", self.file, "--input", self.file)
        self.cli("formal", "--receipt", self.file, "--codex-session", SESSION, "--since", "2026-11-26T00:02:00Z")
        self.assertFalse(self.calls("codex"))
        calls = self.board()["calls"]
        self.assertEqual([(c["phase"], c["input"], c["cache_read"], c["output"]) for c in calls],
                         [("pilot", 12, 25, 6), ("formal", 6, 20, 2)])

    def test_handoff_keeps_paths_intents_jobs_and_pause(self):
        self.cli("init", "--routes", self.routes)
        lines = [f"项目目标第 {i:02d} 行" for i in range(1, 24)]
        (self.project / "项目说明.md").write_text("\n".join(lines))
        self.assertIn("handoff", self.cli("plan", "--input", self.file))
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        job = self.root / "job-receipt.md"
        job.write_text("试跑完成\nJOB_ID=42\n")
        (self.root / "scheduler").write_text("COMPLETED")
        self.cli("pilot", "--receipt", job)
        self.cli("watch")
        self.cli("gate", "pass", self.file, "--input", self.file)
        fail = self.root / "fail-codex"
        fail.touch()
        self.cli("formal", ok=False)
        self.cli("pause")
        self.cli("handoff")
        path = self.chair / "交接单.md"
        handoff = path.read_text()
        self.assertLessEqual(len(handoff.splitlines()), 40)
        self.assertEqual(handoff.splitlines()[3:18], lines[:15])
        for expected in ("standard", "Claude=claude/mock/high", "formal", "派工.md", "放行意见.md",
                         "封存首稿", "formal/intent-Codex.json", "42=COMPLETED", "已暂停",
                         "/research-agent 从这个项目的恢复点继续"):
            self.assertIn(expected, handoff)
        self.assertIn(str(path.relative_to(self.project)), (self.project / "恢复点.md").read_text())
        fail.unlink()
        self.cli("resume")
        self.cli("reconcile", "Codex", "--ended")
        self.cli("formal", "--receipt", self.file)
        self.cli("review", "--input", self.file)
        self.cli("decide", "done", self.file)
        self.cli("handoff")
        handoff = path.read_text()
        self.assertIn("决定.md", handoff)
        self.assertIn("无回执的调用意图｜无", handoff)

    def test_adjudicate_requires_review_and_a_confirmed_route(self):
        self.init_light()
        self.assertIn("requires sealed reviews", self.cli("adjudicate", "--input", self.file, ok=False))
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--mode", "text")
        self.cli("review", "--input", self.file)
        self.assertIn("no Adjudicator route", self.cli("adjudicate", "--input", self.file, ok=False))
        self.cli("decide", "done", self.file)
        self.assertIn("before decide", self.cli("adjudicate", "--input", self.file, ok=False))

    def test_adjudicate_uses_the_frozen_review_and_calls_only_once(self):
        self.config["Adjudicator"] = {"client": "codex", "model": "judge-mock", "effort": "max"}
        self.routes.write_text(json.dumps(self.config))
        self.cli("init", "--routes", self.routes, "--tier", "light")
        evidence = self.root / "evidence.md"
        evidence.write_text("冻结交付内容")
        dispute = self.root / "dispute.md"
        dispute.write_text("争议原文")
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--mode", "text")
        self.cli("review", "--input", evidence)
        published = self.chair.parents[1] / "Claude/尝试-01/review.md"
        published.write_text("后改的公开副本")
        self.cli("adjudicate", "--input", dispute)
        self.cli("adjudicate", "--input", dispute)
        self.assertEqual(len(self.calls("codex")), 1)
        args, prompt, _ = self.calls("codex")[0]
        self.assertEqual(args[args.index("-m") + 1], "judge-mock")
        self.assertIn("read-only", args)
        for expected in ("冻结交付内容", "frozen evidence", "Claude receipt", "争议原文"):
            self.assertIn(expected, prompt)
        self.assertNotIn("后改的公开副本", prompt)
        self.assertTrue((self.chair / "adjudicate/Adjudicator.md").is_file())
        self.assertEqual([c["model"] for c in self.board()["calls"] if c["phase"] == "adjudicate"], ["judge-mock"])

    def test_probe_window_and_outdir_guards(self):
        self.init_light()
        request = self.root / "request.md"
        request.write_text("试用产品")
        (self.workspace / "model.py").write_text("seed = 3\n")
        window = "only after gate pass and before formal"
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.assertIn(window, self.probe(request, "runs/early", ok=False))
        self.cli("pilot")
        self.assertIn(window, self.probe(request, "runs/early", ok=False))
        self.cli("gate", "pass", self.file, "--input-dir", self.workspace)
        runs = self.workspace / "runs"
        runs.mkdir()
        outside = self.root / "outside"
        outside.mkdir()
        (runs / "link").symlink_to(outside, target_is_directory=True)
        for outdir in ("../outside", outside):
            self.assertIn("--outdir must be relative to the workspace", self.probe(request, outdir, ok=False))
        self.assertIn("--outdir must stay inside the workspace", self.probe(request, "runs/link/probe", ok=False))
        self.assertFalse((self.chair / "probe").exists())
        self.assertFalse(list(outside.iterdir()))
        used = runs / "used"
        used.mkdir()
        (used / "transcript.jsonl").write_text("earlier session")
        self.assertIn("product probe failed", self.probe(request, "runs/used", ok=False))
        self.assertIn("already exist", next(self.chair.glob("probe/*/stderr.log")).read_text())
        self.assertEqual((used / "transcript.jsonl").read_text(), "earlier session")
        self.assertFalse((used / "request.txt").exists())
        self.assertEqual([call["status"] for call in self.probe_calls()], ["failed"])
        self.assertFalse(self.calls("claude"))
        (self.root / "fail-codex").touch()
        self.cli("formal", ok=False)
        self.assertIn("before any formal invocation", self.probe(request, "runs/late", ok=False))
        self.assertFalse(self.calls("claude"))

    def test_probe_runs_in_workspace_and_feeds_formal_audit(self):
        self.init_light()
        (self.workspace / "model.py").write_text("seed = 3\n")
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.cli("pilot")
        self.cli("gate", "pass", self.file, "--input-dir", self.workspace)
        request = self.root / "probe request.md"
        request.write_text("像新用户一样运行 model.py 并记录决策理由")
        hidden = self.workspace / "answers.json"
        options = ("--effort", "low", "--allow", "Read,Bash(python3 *)", "--deny-read", hidden, "data/labels.csv")
        target = self.workspace.resolve() / "runs/probe-01"
        out = self.probe(request, "runs/probe-01", *options)
        self.assertIn(str(target / "transcript.jsonl"), out)
        self.assertIn("Bash 可绕过 Read 禁读规则", out)
        [(args, prompt, context)] = self.calls("claude")
        self.assertEqual((context["cwd"], prompt), (str(self.workspace.resolve()), request.read_text()))
        flag = lambda name: args[args.index(name) + 1]
        self.assertEqual([flag(name) for name in ("--model", "--effort", "--allowedTools", "--output-format")],
                         ["probe-mock", "low", "Read,Bash(python3 *)", "stream-json"])
        # Claude Code reads Read(/x) as project-relative, so an absolute path is passed as Read(//x).
        self.assertEqual(args[args.index("--disallowedTools") + 1:], [f"Read(/{hidden})", "Read(data/labels.csv)"])
        self.assertEqual((target / "request.txt").read_text(), request.read_text())
        saved = (target / "transcript.jsonl").read_bytes()
        self.assertEqual([json.loads(line)["type"] for line in saved.splitlines()], ["assistant", "result"])
        self.assertEqual(next(self.chair.glob("probe/*/transcript.jsonl")).read_bytes(), saved)
        [call] = self.probe_calls()
        self.assertEqual([call[k] for k in ("agent", "model", "status", "input", "cache_read", "output", "seconds")],
                         ["claude", "probe-mock", "ok", 11, 7, 3, 0.25])
        self.probe(request, "runs/probe-01", *options)
        self.assertEqual((len(self.calls("claude")), len(self.probe_calls())), (1, 1))
        self.assertIn("already used", self.cli("probe", "--request", request, "--outdir", "runs/probe-01",
                                               "--model", "other-mock", ok=False))
        self.cli("formal")
        _, prompt, _ = self.calls("codex")[-1]
        for expected in ("产品检验记录", str(target / "transcript.jsonl"), str(hidden), "禁读路径"):
            self.assertIn(expected, prompt)
        self.assertIn("only after gate pass and before formal", self.probe(request, "runs/probe-02", ok=False))

    def test_remote_probe_ships_runner_and_rechecks_gate(self):
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--ssh", "JUPITER")
        self.cli("pilot")
        remote = self.root / "remote code"
        remote.write_text("v1")
        self.cli("gate", "pass", self.file, "--input", self.file, "--remote-input", remote)
        request = self.root / "request.md"
        request.write_text("远端试用")
        self.probe(request, "runs/remote")
        self.assertTrue(self.calls("ssh")[-1][0][-1].startswith("python3 -c "))
        [(args, prompt, context)] = self.calls("claude")
        self.assertEqual((context["cwd"], prompt), (str(self.workspace.resolve()), "远端试用"))
        target = self.workspace / "runs/remote"
        self.assertEqual((target / "request.txt").read_text(), "远端试用")
        self.assertEqual(json.loads((target / "transcript.jsonl").read_text().splitlines()[-1])["type"], "result")
        self.assertEqual([(c["status"], c["input"]) for c in self.probe_calls()], [("ok", 11)])
        remote.write_text("v2")
        self.assertIn("remote inputs changed", self.probe(request, "runs/again", ok=False))

    def test_lead_usage_counts_project_and_alias_roots_once(self):
        lab = self.root / "lab"
        self.project = lab / "archive"
        self.project.mkdir(parents=True)
        elsewhere = self.root / "elsewhere"
        elsewhere.mkdir()

        def row(cwd, message_id, **usage):
            return json.dumps({"type": "assistant", "cwd": str(cwd), "sessionId": "lead",
                               "message": {"id": message_id, "usage": usage}})

        own = row(self.project, "msg-project", input_tokens=100, output_tokens=10,
                  cache_read_input_tokens=1000, cache_creation_input_tokens=5)
        transcript = self.root / "lead.jsonl"
        transcript.write_text("\n".join([own, row(lab, "msg-alias", input_tokens=20, output_tokens=2),
                                         row(elsewhere, "msg-other", input_tokens=7000, output_tokens=700),
                                         own]) + "\n")
        subprocess.run([sys.executable, str(SCRIPT.with_name("progress.py")), str(self.project), "init",
                        "--lead-transcript", str(transcript)], check=True, capture_output=True, env=self.env)
        self.assertEqual(self.board()["lead_usage"],
                         dict(requests=1, input=100, output=10, cache_read=1000, cache_write=5))
        self.cli("init", "--routes", self.routes, "--lead-root", lab)
        self.assertEqual(self.board()["lead_roots"], [str(lab.resolve())])
        self.assertEqual(self.board()["lead_usage"],
                         dict(requests=2, input=120, output=12, cache_read=1000, cache_write=5))

    def test_terminal_states_array_parent_and_chair_confirmed_job(self):
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        receipt = self.root / "jobs.md"
        receipt.write_text("试跑\nJOB_ID=123\nJOB_ID=77\n")
        self.cli("pilot", "--receipt", receipt)
        rows = self.root / "sacct-rows"
        rows.write_text("123_1|COMPLETED\n123_1.batch|COMPLETED\n123_[2-3]|PENDING\n")
        self.assertIn("数组父作业", self.cli("watch", ok=False))
        self.assertEqual(self.state()["job_states"], {"123": "PENDING", "77": "UNKNOWN"})
        self.cli("job", "77", "--state", "CANCELLED")
        self.assertIn("job 77 CANCELLED 主控确认", (self.project / "主控日志.md").read_text())
        rows.write_text("123_1|COMPLETED\n123_2|DEADLINE\n123_3|COMPLETED\n")
        self.assertIn("'123': 'DEADLINE', '77': 'CANCELLED'", self.cli("watch", ok=False))
        self.cli("revise", self.file)

    def test_watch_uses_the_scheduler_host_for_a_local_worker(self):
        (self.root / "bin" / "sacct").unlink()
        self.init_light()
        self.assertIn("invalid SSH alias", self.cli("dispatch", self.file, "--workspace", self.workspace,
                                                    "--scheduler-ssh", "bad alias", ok=False))
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--network", "--scheduler-ssh", "JUPITER")
        receipt = self.root / "jobs.md"
        receipt.write_text("JOB_ID=42\n")
        self.cli("pilot", "--receipt", receipt)
        (self.root / "scheduler").write_text("COMPLETED")
        self.cli("watch", stdin="typed ahead")
        args, stdin, _ = self.calls("ssh")[-1]
        self.assertEqual((args[-2:], stdin), (["JUPITER", "sacct -n -P -j 42 --format=JobID,State"], ""))
        self.assertEqual(self.state()["job_states"], {"42": "COMPLETED"})

    def test_remote_checksums_do_not_consume_local_stdin(self):
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", "/remote/work", "--ssh", "JUPITER")
        self.cli("pilot", "--receipt", self.file)
        remote = self.root / "remote code"
        remote.write_text("v1")
        self.cli("gate", "pass", self.file, "--input", self.file, "--remote-input", remote, stdin="typed ahead")
        self.assertEqual(self.calls("ssh")[-1][1], "")

    def test_failed_init_leaves_the_attempt_free(self):
        self.assertIn("lead root must be an existing directory",
                      self.cli("init", "--routes", self.routes, "--lead-root", self.root / "missing", ok=False))
        self.cli("init", "--routes", self.routes)
        self.assertEqual(self.state()["next"], "plan")

    def test_worker_failure_keeps_output_and_codex_session(self):
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        (self.root / "reply-codex").write_text("")
        (self.root / "codex-stderr").write_text(f"session id: {SESSION}\nSubmitted batch job 991\n")
        self.assertIn(SESSION, self.cli("pilot", ok=False))
        [err] = (self.chair / "pilot").glob("Codex.failed-*.err")
        self.assertIn("Submitted batch job 991", err.read_text())
        self.assertTrue(Path(str(err)[:-len(".err")] + ".out").is_file())

    def test_formal_rerun_after_its_call_skips_the_gate(self):
        self.gate_workspace()
        (self.workspace / "metrics.json").write_text("{}")
        self.assertIn("metrics.json", self.cli("formal", ok=False))
        # The call finished before a crash; its outputs changed the gated directory.
        (self.chair / "formal/Codex.json").write_text(json.dumps({"text": "正式完成", "usage": {}, "seconds": 1}))
        self.cli("formal")
        self.assertFalse(self.calls("codex"))
        self.assertEqual(self.state()["next"], "review")

    def test_external_formal_receipt_warns_about_gate_changes(self):
        self.gate_workspace()
        (self.workspace / "metrics.json").write_text("{}")
        out = self.cli("formal", "--receipt", self.file)
        self.assertIn("警告", out)
        self.assertIn("metrics.json", out)
        self.assertIn("metrics.json", (self.project / "主控日志.md").read_text())

    def test_gate_refuses_the_archive_and_skips_probe_files(self):
        self.project = self.workspace / "archive"
        self.init_light()
        src = self.workspace / "src"
        src.mkdir()
        (src / "model.py").write_text("seed = 3\n")
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.cli("pilot", "--receipt", self.file)
        self.assertIn("contains the project archive",
                      self.cli("gate", "pass", self.file, "--input-dir", self.workspace, ok=False))
        self.cli("gate", "pass", self.file, "--input-dir", src)
        request = self.root / "request.md"
        request.write_text("试用产品")
        self.probe(request, "src/probe-01")
        self.probe(request, "src/probe-02")
        self.cli("formal")
        self.assertEqual(len(self.calls("codex")), 1)

    def test_external_formal_receipt_refuses_edited_approved_code(self):
        self.gate_workspace()
        (self.workspace / "model.py").write_text("seed = 4\n")
        self.assertIn("model.py", self.cli("formal", "--receipt", self.file, ok=False))
        self.assertFalse((self.chair / "formal/Codex.json").exists())

    def test_gate_allows_symlinked_directories_inside_the_gated_root(self):
        site = self.workspace / "venv/lib/site.py"
        site.parent.mkdir(parents=True)
        site.write_text("A = 1\n")
        (self.workspace / "venv/lib64").symlink_to("lib", target_is_directory=True)
        self.gate_workspace()
        site.write_text("A = 2\n")
        self.assertIn("venv/lib/site.py", self.cli("formal", ok=False))

    def test_watch_keeps_polling_after_a_failed_job(self):
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        receipt = self.root / "jobs.md"
        receipt.write_text("JOB_ID=123\nJOB_ID=77\n")
        self.cli("pilot", "--receipt", receipt)
        self.cli("job", "77", "--state", "FAILED")
        rows = self.root / "sacct-rows"
        rows.write_text("123|RUNNING\n")
        self.assertIn("needs reconciliation", self.cli("watch", "--wait", 2, "--interval", 1, ok=False))
        self.assertGreaterEqual(len(self.calls("sacct")), 2)
        rows.write_text("123|COMPLETED\n")
        self.assertIn("{'123': 'COMPLETED', '77': 'FAILED'}", self.cli("watch", ok=False))

    def test_gate_checks_nested_data_and_refuses_symlinked_directories(self):
        self.init_light()
        src = self.workspace / "src"
        loader = src / "pkg/data/loader.py"
        loader.parent.mkdir(parents=True)
        loader.write_text("SPLIT = 0.8\n")
        finder = src / "pkg/.DS_Store"
        finder.write_text("icons")
        shared = self.root / "shared"
        shared.mkdir()
        (src / "vendor").symlink_to(shared, target_is_directory=True)
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.cli("pilot", "--receipt", self.file)
        self.assertIn("symlinked directory", self.cli("gate", "pass", self.file, "--input-dir", src, ok=False))
        (src / "vendor").unlink()
        self.cli("gate", "pass", self.file, "--input-dir", src)
        finder.write_text("moved icons")
        loader.write_text("SPLIT = 0.99\n")
        out = self.cli("formal", ok=False)
        self.assertIn("pkg/data/loader.py", out)
        self.assertNotIn(".DS_Store", out)

    def test_text_round_cannot_be_revised_into_a_worker_run(self):
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--mode", "text")
        self.assertIn("text round", self.cli("revise", self.file, ok=False))
        self.cli("review", "--input", self.file)
        self.assertFalse(self.calls("codex"))

    def test_init_refuses_changed_flags_for_an_existing_or_retried_attempt(self):
        self.init_light()
        self.assertIn("existing attempt keeps", self.cli("init", "--tier", "standard", ok=False))
        self.cli("init", "--tier", "light", "--routes", self.routes, "--reviewers", "Claude")
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--nodes", 1, "--cards-per-node", 4,
                 "--hours", 2)
        self.cli("pilot", "--receipt", self.file)
        self.cli("gate", "revise", self.file, "--input", self.file)
        self.attempt = 2
        self.routes.write_text(json.dumps({role: dict(self.config[role], effort="max") for role in ("Claude", "Codex")}))
        self.assertIn("routes in a new round", self.cli("init", "--routes", self.routes, ok=False))
        self.cli("init")
        self.assertEqual(self.state()["next"], "pilot")

    def test_malformed_job_lines_are_reported(self):
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        receipt = self.root / "jobs.md"
        receipt.write_text("JOB_ID=42\nJOB_ID: 43\n")
        self.assertIn("JOB_ID: 43", self.cli("pilot", "--receipt", receipt))
        self.assertEqual(self.state()["jobs"], ["42"])

    def test_codex_sessions_follow_codex_home(self):
        codex_home = self.root / "codex-home"
        self.env["CODEX_HOME"] = str(codex_home)
        self.write_rollout(codex_home)
        self.init_light()
        self.cli("dispatch", self.file, "--workspace", self.workspace)
        self.cli("pilot", "--receipt", self.file, "--codex-session", SESSION)
        call = self.board()["calls"][0]
        self.assertEqual((call["input"], call["cache_read"], call["output"]), (32, 125, 11))

    def test_recovery_point_marks_an_earlier_handoff_stale(self):
        self.init_light()
        self.cli("handoff")
        self.assertIn("先读最近生成的交接单", (self.project / "恢复点.md").read_text())
        self.cli("dispatch", self.file, "--workspace", self.workspace, "--mode", "text")
        recovery = (self.project / "恢复点.md").read_text()
        self.assertIn("交接单已过期", recovery)
        self.assertNotIn("先读最近生成的交接单", recovery)


if __name__=="__main__":
    unittest.main()
