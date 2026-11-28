"""Named-team support in progress.py and its static page, run through the CLI in temp projects."""
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1] / "skills/research-agent"
SCRIPT = ROOT / "scripts/progress.py"
PAGE = ROOT / "assets/progress.html"
OLD_STEPS = ["独立规划", "Claude 汇总派工", "Codex 执行（试跑→检查点→正式）", "三方并行核验", "Claude 总验收与转向"]


class ProgressTeam(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.project = Path(self.tmp.name) / "项目"
        self.project.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def run_cli(self, *args, ok=True):
        done = subprocess.run([sys.executable, str(SCRIPT), str(self.project), *map(str, args)],
                              stdin=subprocess.DEVNULL, capture_output=True, text=True)
        if ok:
            self.assertEqual(done.returncode, 0, done.stderr)
        return done

    def board(self):
        return json.loads((self.project / "进度/status.json").read_text(encoding="utf-8"))

    def test_init_sets_team_labels_and_worker(self):
        self.run_cli("init", "--agent", "opus=Claude Opus", "--agent", "gemini=Gemini", "--agent", "codex",
                     "--worker", "codex", "--model", "opus=Opus 5.5 · max", "--model", "lead=Opus 5.5 · xhigh")
        s = self.board()
        self.assertEqual(s["team"], ["opus", "gemini", "codex"])
        self.assertEqual(s["labels"], {"opus": "Claude Opus", "gemini": "Gemini"})
        self.assertEqual(s["worker"], "codex")
        self.assertEqual(s["agents"]["opus"], {"state": "idle", "task": ""})
        self.assertEqual(s["models"], {"opus": "Opus 5.5 · max", "lead": "Opus 5.5 · xhigh"})
        self.assertEqual(s["steps"][1], "主控汇总派工")
        self.assertTrue((self.project / "进度/index.html").is_file())
        self.assertIn('"team": ["opus", "gemini", "codex"]', (self.project / "进度/status.js").read_text(encoding="utf-8"))

        self.run_cli("init", "--agent", "sonnet=Claude Sonnet", "--agent", "gpt=GPT")
        s = self.board()
        self.assertEqual(s["team"], ["sonnet", "gpt"])  # replaced, not merged
        self.assertEqual(s["worker"], "codex")          # untouched without --worker
        self.assertEqual(s["labels"]["gpt"], "GPT")
        self.run_cli("init", "--title", "名称")           # no --agent keeps the team
        self.assertEqual(self.board()["team"], ["sonnet", "gpt"])

    def test_agent_call_and_event_accept_custom_keys(self):
        self.run_cli("agent", "adjudicator", "running", "仲裁分歧")
        self.run_cli("call", "probe", "探针", "--input", 5, "--output", 2)
        self.run_cli("event", "探针完成", "--agent", "probe")
        longest = "a" + "b-_9" * 5 + "zzz"
        self.assertEqual(len(longest), 24)
        self.run_cli("agent", longest, "done")
        s = self.board()
        self.assertEqual(s["agents"]["adjudicator"]["state"], "running")
        self.assertEqual(s["agents"]["adjudicator"]["task"], "仲裁分歧")
        self.assertEqual(s["agents"]["probe"], {"state": "idle", "task": ""})
        self.assertEqual(s["agents"][longest]["task"], "")
        self.assertEqual((s["calls"][-1]["agent"], s["calls"][-1]["input"]), ("probe", 5))
        self.assertEqual(s["events"][-1]["agent"], "probe")
        self.assertNotIn("team", s)

    def test_legacy_board_without_team_still_updates(self):
        legacy = {"project": "旧项目", "max_rounds": 2, "round": 1, "step": 1, "step_label": OLD_STEPS[0],
                  "steps": OLD_STEPS, "limits": "", "models": {"codex": "gpt-6.2-astra · max"},
                  "cluster_name": "JUPITER", "lead_transcripts": [], "lead_roots": [],
                  "agents": {a: {"state": "idle", "task": ""} for a in ("lead", "claude", "gemini", "codex", "jupiter")},
                  "calls": [], "jobs": [], "events": [], "lead_usage": {}, "updated": "2026-11-26T10:00:00+00:00"}
        (self.project / "进度").mkdir()
        (self.project / "进度/status.json").write_text(json.dumps(legacy, ensure_ascii=False), encoding="utf-8")
        self.run_cli("agent", "codex", "running", "尝试-01 试跑")
        self.run_cli("call", "claude", "第1轮·规划", "--input", 10, "--output", 3)
        self.run_cli("stage", 1, 2)
        s = self.board()
        for key in ("team", "worker", "labels"):
            self.assertNotIn(key, s)
        self.assertEqual(s["steps"], OLD_STEPS)
        self.assertEqual(s["step_label"], "Claude 汇总派工")  # the board's own step names, not the new defaults
        self.assertEqual(list(s["agents"]), ["lead", "claude", "gemini", "codex", "jupiter"])
        self.assertEqual(s["agents"]["codex"]["state"], "running")
        self.assertEqual(s["calls"][-1]["agent"], "claude")

    def test_invalid_keys_are_rejected(self):
        for bad in ("Codex", "1abc", "a b", "a.b", "_x", "", "x" * 25, "codex\n"):
            for args in (("agent", bad, "running"), ("call", bad, "phase", "--input", 1),
                         ("event", "text", "--agent", bad), ("init", "--model", f"{bad}=label"),
                         ("init", "--agent", f"{bad}=名字"), ("init", "--worker", bad)):
                with self.subTest(key=bad, cmd=args[0]):
                    done = self.run_cli(*args, ok=False)
                    self.assertEqual(done.returncode, 2, done.stderr)
                    self.assertIn("invalid agent key", done.stderr)
        self.assertFalse((self.project / "进度/status.json").exists())

    def test_chair_and_cluster_cannot_join_the_team(self):
        for args in (("--agent", "lead=主控"), ("--agent", "jupiter=集群"), ("--worker", "lead"), ("--worker", "jupiter")):
            with self.subTest(args=args):
                done = self.run_cli("init", *args, ok=False)
                self.assertEqual(done.returncode, 2, done.stderr)
                self.assertIn("not a team agent", done.stderr)
        done = self.run_cli("init", "--agent", "opus=A", "--agent", "opus=B", ok=False)
        self.assertEqual(done.returncode, 2)
        self.assertIn("duplicate", done.stderr)
        self.assertFalse((self.project / "进度/status.json").exists())
        self.run_cli("init", "--model", "lead=Opus", "--model", "jupiter=Slurm")  # still valid for labels
        self.assertEqual(self.board()["models"], {"lead": "Opus", "jupiter": "Slurm"})

    def test_page_script_parses(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("node is not installed")
        scripts = re.findall(r"<script>(.*?)</script>", PAGE.read_text(encoding="utf-8"), re.S)
        self.assertEqual(len(scripts), 1)
        js = Path(self.tmp.name) / "page.js"
        js.write_text(scripts[0], encoding="utf-8")
        done = subprocess.run([node, "--check", str(js)], stdin=subprocess.DEVNULL, capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)


if __name__ == "__main__":
    unittest.main()
