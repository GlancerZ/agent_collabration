#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""local-agent-room 的回归测试。

用假的 codex / claude 可执行文件代替真实 CLI：不调用模型，不联网，不消耗额度。
这些测试证明聊天室和调用流程的逻辑正确，不证明真实 CLI 在你的机器上可用。

运行：python3 tests/test_room.py
"""
import json
import os
import stat
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "skills" / "local-agent-room" / "scripts"
ROOM_PY = SCRIPTS / "room.py"
LANDLOCK = sys.platform.startswith("linux") and subprocess.run(
    [sys.executable, str(SCRIPTS / "ro_exec.py"), "--probe"], stdout=subprocess.DEVNULL).returncode == 0

FAKE_CODEX = r'''#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
if argv[:1] == ["sandbox"]:  # room.py 用它探测 Codex 自带沙箱能不能用
    sys.exit(0 if os.environ.get("FAKE_SANDBOX", "ok") == "ok" else 1)
prompt = sys.stdin.read()
log = os.environ.get("FAKE_LOG")
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": argv, "prompt": prompt, "env": sorted(os.environ)}, ensure_ascii=False) + "\n")
if os.environ.get("FAKE_FAIL") and not (os.environ.get("FAKE_FAIL") == "resume" and "resume" not in argv):
    print(json.dumps({"type": "error", "message": "simulated failure"}))
    sys.exit(1)
if os.environ.get("FAKE_TAMPER"):
    with open(os.environ["FAKE_TAMPER"], "a", encoding="utf-8") as f:
        f.write("\nchanged while the peer was answering\n")
reply = os.environ.get("FAKE_REPLY", "收到。\nVERDICT: none")
if os.environ.get("FAKE_TRY_WRITE"):
    try:
        with open(os.environ["FAKE_TRY_WRITE"], "w", encoding="utf-8") as f:
            f.write("the peer wrote this")
        reply = "WRITE_OK\n" + reply
    except OSError as e:
        reply = "WRITE_DENIED %s\n%s" % (e.strerror, reply)
out = argv[argv.index("-o") + 1]
with open(out, "w", encoding="utf-8") as f:
    f.write(reply)
print(json.dumps({"type": "thread.started", "thread_id": "fake-thread-1"}))
print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": reply}}))
print(json.dumps({"type": "turn.completed"}))
'''

FAKE_CLAUDE = r'''#!/usr/bin/env python3
import json, os, sys
prompt = sys.stdin.read()
log = os.environ.get("FAKE_LOG")
if log:
    with open(log, "a", encoding="utf-8") as f:
        f.write(json.dumps({"argv": sys.argv[1:], "prompt": prompt, "env": sorted(os.environ)}, ensure_ascii=False) + "\n")
print(json.dumps({"type": "result", "subtype": "success", "is_error": False,
                  "result": os.environ.get("FAKE_REPLY", "看过了。\nVERDICT: none"), "session_id": "fake-claude-1"}))
'''


class RoomTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.room = self.dir / "room"
        self.bin = self.dir / "bin"
        self.bin.mkdir()
        for name, src in (("codex", FAKE_CODEX), ("claude", FAKE_CLAUDE)):
            p = self.bin / name
            p.write_text(src, encoding="utf-8")
            p.chmod(p.stat().st_mode | stat.S_IEXEC)
        self.log = self.dir / "fake.log"
        self.run_room("init", "--topic", "测试", "--rule", "不提交作业")

    def tearDown(self):
        self.tmp.cleanup()

    def env(self, role=None, **extra):
        # 干净的环境：去掉宿主 agent 的标记，避免身份检查受测试运行环境影响
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(("CLAUDE", "ANTHROPIC", "CODEX", "OPENAI", "AGENT_ROOM", "FAKE_"))}
        env["PATH"] = str(self.bin) + os.pathsep + env.get("PATH", "")
        env["FAKE_LOG"] = str(self.log)
        if role:
            env["AGENT_ROOM_ROLE"] = role
        env.update(extra)
        return env

    def run_room(self, *args, role=None, stdin=None, **extra):
        r = subprocess.run([sys.executable, str(ROOM_PY), "--room", str(self.room)] + list(args),
                           input=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                           env=self.env(role, **extra), cwd=str(self.dir), universal_newlines=True, timeout=60)
        return r

    def ok(self, *args, **kw):
        r = self.run_room(*args, **kw)
        self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        return r.stdout

    def msgs(self):
        return json.loads(self.ok("read", "--all", "--json") or "[]")

    def calls(self):
        return [json.loads(line) for line in self.log.read_text(encoding="utf-8").splitlines()]

    # ------------------------------------------------------------ 基础

    def test_post_read_cursor(self):
        self.ok("post", "--as", "claude", "--to", "codex", "第一条")
        self.ok("post", "--as", "claude", stdin="第二条，从标准输入\n")
        out = self.ok("read", "--as", "codex")
        self.assertIn("#1 claude → codex · msg", out)
        self.assertIn("第二条，从标准输入", out)
        self.assertIn("没有新消息", self.ok("read", "--as", "codex"))
        self.assertIn("没有新消息", self.ok("read", "--as", "claude"))  # 自己发的不算未读
        self.ok("post", "--as", "codex", "回复", "--reply-to", "1")
        self.assertIn("回复 #1", self.ok("read", "--as", "claude", "--peek"))
        self.assertIn("回复 #1", self.ok("read", "--as", "claude"))  # peek 不前移游标

    def test_concurrent_posts_get_distinct_sequence_numbers(self):
        def post(i):
            return self.run_room("post", "--as", "user", "并发 %d" % i).returncode
        with ThreadPoolExecutor(max_workers=12) as ex:
            codes = list(ex.map(post, range(40)))
        self.assertEqual(codes, [0] * 40)
        ms = self.msgs()
        self.assertEqual([m["seq"] for m in ms], list(range(1, 41)))
        self.assertEqual(len({m["body"] for m in ms}), 40)

    def test_identity_guard(self):
        r = self.run_room("post", "--as", "codex", "冒充", CLAUDECODE="1")
        self.assertEqual(r.returncode, 2)
        self.assertIn("不能以 codex 的身份发言", r.stderr)
        self.assertEqual(self.run_room("post", "--as", "user", "冒充用户", CLAUDECODE="1").returncode, 2)
        self.assertEqual(self.run_room("post", "--as", "claude", "冒充", role="codex").returncode, 2)
        self.ok("post", "--as", "claude", "本人", CLAUDECODE="1")
        self.assertEqual(len(self.msgs()), 1)

    def test_validation(self):
        self.assertEqual(self.run_room("post", "--as", "claude", "   ").returncode, 2)
        self.assertEqual(self.run_room("post", "--as", "claude", "x", "--reply-to", "9").returncode, 2)
        self.assertEqual(self.run_room("post", "--as", "claude", "--kind", "agree", "x").returncode, 2)
        self.ok("post", "--as", "claude", "--kind", "proposal", "方案 A")
        self.assertEqual(self.run_room("post", "--as", "claude", "--kind", "agree", "--reply-to", "1", "x").returncode, 2)
        self.ok("post", "--as", "claude", "普通消息")
        self.assertEqual(self.run_room("post", "--as", "codex", "--kind", "agree", "--reply-to", "2", "x").returncode, 2)

    def test_proposal_states(self):
        self.ok("post", "--as", "claude", "--kind", "proposal", "方案 A")
        st = json.loads(self.ok("status", "--json"))["proposals"]
        self.assertEqual((st[0]["state"], st[0]["waiting"]), ("pending", ["codex"]))
        self.ok("post", "--as", "codex", "--kind", "disagree", "--reply-to", "1", "缺少对照")
        self.assertEqual(json.loads(self.ok("status", "--json"))["proposals"][0]["state"], "disputed")
        self.ok("post", "--as", "claude", "--kind", "proposal", "--reply-to", "1", "方案 A，加上对照")
        self.ok("post", "--as", "codex", "--kind", "agree", "--reply-to", "3", "同意这一版")
        st = json.loads(self.ok("status", "--json"))["proposals"]
        self.assertEqual([p["state"] for p in st], ["superseded", "agreed"])
        self.assertEqual(self.msgs()[-1]["meta"]["target_sha256"], self.msgs()[2]["sha256"])
        self.assertIn("已达成一致", self.ok("status"))

    def test_wait(self):
        self.assertEqual(self.run_room("wait", "--as", "codex", "--timeout", "1").returncode, 3)
        self.ok("post", "--as", "claude", "在吗")
        self.assertIn("在吗", self.ok("wait", "--as", "codex", "--timeout", "5"))

    def test_rules_and_log(self):
        self.ok("rules", "--add", "不删除 checkpoint")
        out = self.ok("rules")
        self.assertIn("1. 不提交作业", out)
        self.assertIn("2. 不删除 checkpoint", out)
        self.ok("rules", "--remove", "1")
        self.assertNotIn("不提交作业", self.ok("rules"))
        self.ok("post", "--as", "claude", "--ref", "a/b.py", "看这个文件")
        md = self.ok("log")
        self.assertIn("## #1 claude · msg", md)
        self.assertIn("`a/b.py`", md)

    # ------------------------------------------------------------ ask

    def test_ask_review_is_read_only_scrubs_env_and_resumes(self):
        out = self.ok("ask", "--as", "claude", "--peer", "codex", "--mode", "review", "帮我检查方案", role="claude",
                      CLAUDE_CODE_MESSAGING_TOKEN="secret", ANTHROPIC_BASE_URL="x", GITHUB_TOKEN="t", OPENAI_API_KEY="k")
        self.assertIn("codex → claude · review · 回复 #1", out)
        call = self.calls()[0]
        self.assertEqual(call["argv"][0], "exec")
        self.assertNotIn("resume", call["argv"])
        self.assertIn('sandbox_mode="read-only"', call["argv"])
        self.assertIn("只读：不要创建、修改或删除任何文件", call["prompt"])
        self.assertIn("- 不提交作业", call["prompt"])
        self.assertIn("帮我检查方案", call["prompt"])
        for leaked in ("CLAUDE_CODE_MESSAGING_TOKEN", "ANTHROPIC_BASE_URL", "GITHUB_TOKEN", "CLAUDECODE"):
            self.assertNotIn(leaked, call["env"])
        self.assertIn("OPENAI_API_KEY", call["env"])  # 对方自己的凭据要保留
        self.assertEqual(call["env"].count("AGENT_ROOM_ROLE"), 1)

        self.ok("post", "--as", "user", "补充：只看第 2 步")
        self.ok("ask", "--as", "claude", "--peer", "codex", "第二个问题", role="claude")
        call = self.calls()[1]
        self.assertEqual(call["argv"][:2], ["exec", "resume"])
        self.assertIn("fake-thread-1", call["argv"])
        self.assertIn("只含你上次发言之后的新消息", call["prompt"])
        self.assertIn("补充：只看第 2 步", call["prompt"])
        self.assertNotIn("帮我检查方案", call["prompt"])  # 续接会话时不重复发旧消息
        self.assertIn("没有新消息", self.ok("read", "--as", "claude"))  # ask 的回复已经看过

    def test_ask_write_flag_and_dry_run(self):
        out = self.ok("ask", "--as", "claude", "--peer", "codex", "--dry-run", "只是看看", role="claude")
        self.assertIn("只是看看", out)
        self.assertEqual(self.msgs(), [])
        self.assertFalse(self.log.exists())
        self.ok("ask", "--as", "claude", "--peer", "codex", "--write", "改 a.py", role="claude")
        self.assertIn('sandbox_mode="workspace-write"', self.calls()[0]["argv"])
        self.assertIn("可写", self.calls()[0]["prompt"])

    def test_ask_propose_records_agreement_bound_to_version(self):
        self.ok("ask", "--as", "claude", "--peer", "codex", "--mode", "propose", "先做评估升级", role="claude",
                FAKE_REPLY="理由充分。\nVERDICT: agree #1")
        ms = self.msgs()
        self.assertEqual((ms[1]["kind"], ms[1]["reply_to"], ms[1]["meta"]["target_sha256"]), ("agree", 1, ms[0]["sha256"]))
        self.assertEqual(json.loads(self.ok("status", "--json"))["proposals"][0]["state"], "agreed")
        r = self.run_room("ask", "--as", "claude", "--peer", "codex", "--mode", "propose", "再定一条", role="claude",
                          FAKE_REPLY="有道理。\nVERDICT: none")
        self.assertEqual(r.returncode, 0)
        self.assertIn("仍然待表态", r.stderr)
        self.assertEqual(json.loads(self.ok("status", "--json"))["proposals"][1]["state"], "pending")

    def test_outcome_requires_explicit_agreement_on_the_final_version(self):
        r = self.run_room("outcome")
        self.assertEqual(r.returncode, 3)
        self.assertIn("没有可表态的结论", r.stdout)
        r = self.run_room("ask", "--as", "claude", "--peer", "codex", "--mode", "propose", "结论一", role="claude",
                          FAKE_REPLY="第 2 条的数字不对，应为 512。\nVERDICT: disagree #1")
        self.assertEqual(r.returncode, 0)
        self.assertIn("未达成一致", r.stderr)
        self.assertIn("--reply-to 1", r.stderr)
        r = self.run_room("outcome")
        self.assertEqual(r.returncode, 1)
        self.assertIn("一致性：未达成一致", r.stdout)
        self.assertIn("第 2 条的数字不对，应为 512。", r.stdout)  # 对方的原话，不是主持人的转述
        # 主持人自己改好并记一条 decision，不算对方同意
        self.ok("post", "--as", "claude", "--kind", "decision", "按对方意见改成 512", role="claude")
        self.assertEqual(self.run_room("outcome").returncode, 1)
        self.assertIn("未达成一致", self.ok("status"))
        # 改好的版本发回去，对方明确同意，才算一致
        r = self.run_room("ask", "--as", "claude", "--peer", "codex", "--mode", "propose", "--reply-to", "1",
                          "结论一，数字改为 512", role="claude", FAKE_REPLY="可以。\nVERDICT: agree #4")
        self.assertEqual(r.returncode, 0)
        self.assertIn("#4 已达成一致（第 2 版）", r.stderr)
        r = self.run_room("outcome")
        self.assertEqual(r.returncode, 0)
        self.assertIn("一致性：已达成一致", r.stdout)
        out = json.loads(self.ok("outcome", "--json"))
        self.assertEqual((out["state"], out["proposals"][0]["version"], out["objections"]), ("agreed", 2, []))
        # 另一条还没表态的结论会让整体回到未一致
        self.ok("post", "--as", "claude", "--kind", "proposal", "结论二", role="claude")
        r = self.run_room("outcome")
        self.assertEqual(r.returncode, 1)
        self.assertIn("待表态，等 codex", r.stdout)
        self.assertEqual(json.loads(self.ok("status", "--json"))["outcome"], "open")

    def test_proposal_revisions_are_capped(self):
        self.ok("post", "--as", "claude", "--kind", "proposal", "第 1 版")
        for n in range(1, 6):
            self.ok("post", "--as", "claude", "--kind", "proposal", "--reply-to", str(n), "第 %d 版" % (n + 1))
        st = json.loads(self.ok("status", "--json"))["proposals"]
        self.assertEqual([p["version"] for p in st], [1, 2, 3, 4, 5, 6])
        r = self.run_room("post", "--as", "claude", "--kind", "proposal", "--reply-to", "6", "第 7 版")
        self.assertEqual(r.returncode, 2)
        self.assertIn("上限 6", r.stderr)
        r = self.run_room("ask", "--as", "claude", "--peer", "codex", "--mode", "propose", "--reply-to", "6",
                          "第 7 版", role="claude")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(len(self.msgs()), 6)  # 被拒绝的消息没有发出，也没有调用对方
        self.assertFalse(self.log.exists() and self.log.read_text(encoding="utf-8").strip())

    def test_propose_prompt_asks_for_all_objections_at_once(self):
        out = self.ok("ask", "--as", "claude", "--peer", "codex", "--mode", "propose", "--dry-run", "结论", role="claude")
        self.assertIn("一次把所有意见提完", out)
        self.assertIn("你能同意的确切文字", out)

    def test_ask_independent_seals_then_reveals(self):
        draft = self.dir / "mine.md"
        draft.write_text("我的独立答案：选方案 B", encoding="utf-8")
        self.ok("ask", "--as", "claude", "--peer", "codex", "--mode", "independent", "--seal", str(draft),
                "任务：A 和 B 选哪个", role="claude", FAKE_REPLY="我选 A。\nVERDICT: none")
        call = self.calls()[0]
        self.assertNotIn("选方案 B", call["prompt"])  # 对方作答时看不到我的草稿
        self.assertNotIn("resume", call["argv"])
        ms = self.msgs()
        self.assertEqual([(m["from"], m["kind"]) for m in ms], [("claude", "task"), ("codex", "draft"), ("claude", "draft")])
        self.assertTrue(ms[2]["meta"]["matches_seal"])
        self.assertEqual(ms[0]["meta"]["sealed"]["sha256"], ms[2]["meta"]["sealed_sha256"])
        r = self.run_room("ask", "--as", "claude", "--peer", "codex", "--mode", "independent", "没封存", role="claude")
        self.assertEqual(r.returncode, 2)

    def test_ask_independent_detects_tampered_draft(self):
        draft = self.dir / "mine.md"
        draft.write_text("原始草稿", encoding="utf-8")
        r = self.run_room("ask", "--as", "claude", "--peer", "codex", "--mode", "independent", "--seal", str(draft),
                          "任务", role="claude", FAKE_TAMPER=str(draft))
        self.assertEqual(r.returncode, 0)
        self.assertIn("独立性无法确认", r.stderr)
        ms = self.msgs()
        self.assertFalse(ms[2]["meta"]["matches_seal"])
        self.assertEqual((ms[3]["from"], ms[3]["kind"]), ("system", "note"))

    def test_ask_failure_is_recorded_not_faked(self):
        r = self.run_room("ask", "--as", "claude", "--peer", "codex", "你好", role="claude", FAKE_FAIL="1")
        self.assertEqual(r.returncode, 2)
        ms = self.msgs()
        self.assertEqual([(m["from"], m["kind"]) for m in ms], [("claude", "msg"), ("system", "note")])
        self.assertIn("simulated failure", ms[1]["body"])

    def test_ask_retries_fresh_when_resume_fails(self):
        self.ok("ask", "--as", "claude", "--peer", "codex", "第一问", role="claude")
        self.ok("ask", "--as", "claude", "--peer", "codex", "第二问", role="claude", FAKE_FAIL="resume")
        calls = self.calls()
        self.assertIn("resume", calls[1]["argv"])
        self.assertNotIn("resume", calls[2]["argv"])
        self.assertIn("第一问", calls[2]["prompt"])  # 新会话带完整记录
        self.assertEqual(self.msgs()[-1]["from"], "codex")

    def test_ask_claude_peer_and_missing_cli(self):
        out = self.ok("ask", "--as", "codex", "--peer", "claude", "--mode", "review", "帮我看看", role="codex")
        self.assertIn("claude → codex · review", out)
        call = self.calls()[0]
        self.assertIn("-p", call["argv"])
        self.assertEqual(call["argv"][call["argv"].index("--allowedTools") + 1], "Read,Grep,Glob")
        r = self.run_room("ask", "--as", "codex", "--peer", "claude", "再问", role="codex",
                          AGENT_ROOM_CLAUDE_BIN="no-such-claude-binary")
        self.assertEqual(r.returncode, 2)
        self.assertIn("双开模式", r.stderr)

    # ------------------------------------------------------------ 写入限制

    def test_isolation_uses_codex_sandbox_when_it_works(self):
        self.ok("ask", "--as", "claude", "--peer", "codex", "你好", role="claude")
        self.assertIn('sandbox_mode="read-only"', self.calls()[0]["argv"])
        self.assertEqual(self.msgs()[1]["meta"]["isolation"], "sandbox")
        self.assertIn("写操作会被系统拦截", self.calls()[0]["prompt"])

    @unittest.skipUnless(LANDLOCK, "这台机器的内核不支持 Landlock")
    def test_landlock_fallback_blocks_writes_outside_allowed_dirs(self):
        # Codex 自带沙箱起不来（HPC 登录节点常见）：改用 Landlock，由内核拒绝写入
        target = Path(__file__).resolve().parent / (".landlock-probe-%d" % os.getpid())
        self.addCleanup(lambda: target.exists() and target.unlink())
        out = self.ok("ask", "--as", "claude", "--peer", "codex", "读一下文件", role="claude",
                      FAKE_SANDBOX="broken", FAKE_TRY_WRITE=str(target))
        self.assertIn("WRITE_DENIED", out)
        self.assertFalse(target.exists())
        self.assertEqual(self.msgs()[1]["meta"]["isolation"], "landlock")
        self.assertIn('sandbox_mode="danger-full-access"', self.calls()[0]["argv"])
        call = json.loads((self.room / "calls" / "000001-codex.json").read_text(encoding="utf-8"))
        self.assertTrue(call["cmd"][1].endswith("ro_exec.py"))
        self.assertEqual(call["isolation"], "landlock")

    @unittest.skipUnless(LANDLOCK, "这台机器的内核不支持 Landlock")
    def test_landlock_write_mode_allows_only_the_working_directory(self):
        work = Path(__file__).resolve().parent / (".landlock-work-%d" % os.getpid())
        work.mkdir()
        inside, outside = work / "edited.txt", Path(__file__).resolve().parent / (".landlock-outside-%d" % os.getpid())
        self.addCleanup(lambda: [f.unlink() for f in (inside, outside) if f.exists()] and None or work.rmdir())
        out = self.ok("ask", "--as", "claude", "--peer", "codex", "--write", "--cd", str(work), "改文件", role="claude",
                      FAKE_SANDBOX="broken", FAKE_TRY_WRITE=str(inside))
        self.assertIn("WRITE_OK", out)
        out = self.ok("ask", "--as", "claude", "--peer", "codex", "--write", "--cd", str(work), "改外面", role="claude",
                      FAKE_SANDBOX="broken", FAKE_TRY_WRITE=str(outside))
        self.assertIn("WRITE_DENIED", out)
        self.assertFalse(outside.exists())

    def test_refuses_without_isolation_unless_user_opted_in(self):
        r = self.run_room("ask", "--as", "claude", "--peer", "codex", "你好", role="claude",
                          AGENT_ROOM_ISOLATION="unavailable")
        self.assertEqual(r.returncode, 2)
        self.assertIn("--unsandboxed", r.stderr)
        self.assertEqual(self.msgs(), [])  # 拒绝时不留下半截消息
        self.assertFalse(self.log.exists())
        self.ok("ask", "--as", "claude", "--peer", "codex", "--unsandboxed", "你好", role="claude",
                AGENT_ROOM_ISOLATION="unavailable")
        self.assertEqual(self.msgs()[1]["meta"]["isolation"], "none")
        self.assertIn('sandbox_mode="danger-full-access"', self.calls()[0]["argv"])
        self.assertIn("这次没有系统级的拦截", self.calls()[0]["prompt"])

    def test_user_can_ask_from_terminal(self):
        out = self.ok("ask", "--as", "user", "--peer", "codex", "你怎么看")
        self.assertIn("codex → user", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
