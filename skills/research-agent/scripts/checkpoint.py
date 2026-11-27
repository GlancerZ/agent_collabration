"""Archive a supervised attempt. Claude supplies the decision after inspecting evidence."""
import argparse
import datetime
import fcntl
import os
import hashlib
import json
from pathlib import Path
import tempfile


def fingerprint(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def approved(chair, hashes):
    path = chair / "核对.json"
    if not path.is_file():
        return False
    record = json.loads(path.read_text())
    return record.get("status") == "通过" and record.get("inputs") == hashes


def sealed_draft_path(chair, tag):
    return chair / "封存首稿" / (hashlib.sha256(tag.encode()).hexdigest() + ".md")


def seal_draft(chair, tag, source):
    path = sealed_draft_path(chair, tag)
    folder = path.parent
    folder.mkdir(mode=0o700, exist_ok=True)
    data = source.read_bytes()
    if not data.strip():
        raise ValueError("empty draft")
    if path.exists():
        if path.read_bytes() != data:
            raise ValueError("sealed draft differs")
    else:
        with tempfile.NamedTemporaryFile(dir=folder, delete=False) as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(stream.name, path)
    return path


def resume_action(step, item, chair):
    for name, digest in item["inputs"].items():
        path = Path(name)
        if not path.is_file() or fingerprint(path) != digest:
            return "暂停：输入版本已变化，重新核对派工与放行记录"
    receipt = item.get("receipt")
    if receipt:
        path = Path(receipt["path"])
        if not path.is_file() or fingerprint(path) != receipt["sha256"]:
            return "暂停：回执缺失或内容已变化，先核对"
        if step == 3 and item.get("phase") == "pilot":
            if approved(chair, item["inputs"]):
                return "试跑已放行，核对是否已有正式执行意图"
            return "暂停：回到试跑检查点，请主控核对放行记录"
        return {1: "保留规划首稿", 2: "沿用派工回执，核对执行进度",
                3: "核对同一作业状态及实际产物", 4: "保留核验首稿",
                5: "沿用主控决定，核对下一交接"}[step]
    if step == 3 and item.get("phase") == "pilot":
        return "核查试跑是否结束及局部产物，停在检查点"
    if step in (1, 4) and item.get("ended"):
        return "补发此角色，沿用相同冻结输入"
    return {1: "核查原规划调用是否结束", 2: "核查派工是否送达，勿重复派工",
            3: "暂停提交：按任务标记查队列、历史记录、远端回执及代码放行记录",
            4: "核查原核验调用是否结束", 5: "从已封存报告恢复主控决策"}[step]


def recovery(args, chair, parser):
    state_path = chair / "恢复索引.json"
    if not chair.is_dir(): parser.error("initialize this attempt first")
    with (chair / ".recovery.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        entries = json.loads(state_path.read_text()) if state_path.exists() else []
        if args.action == "resume":
            if not entries: parser.error("no recorded intent; reconcile the project log first")
            step = max(i["step"] for i in entries)
            for item in entries:
                if item["step"] == step:
                    print(item["role"], item["tag"], resume_action(step, item, chair))
            return
        if not args.tag: parser.error("supply the stable task tag")
        item = next((i for i in entries if i["tag"] == args.tag), None)
        if args.action == "intent":
            if not args.step or not args.role or not args.input: parser.error("intent needs step, role and input files")
            hashes = {str(p.resolve()): fingerprint(p) for p in args.input}
            fields = dict(tag=args.tag, step=args.step, role=args.role, inputs=hashes)
            if args.step == 3:
                if not args.phase: parser.error("step 3 requires --phase pilot or formal")
                fields["phase"] = args.phase
                if args.phase == "formal" and not approved(chair, hashes):
                    parser.error("formal intent requires approval for these exact inputs")
            if item and any(item.get(k) != v for k,v in fields.items()):
                parser.error("recorded intent differs; reconcile before proceeding")
            if item is None:
                entries.append(fields)
            elif item.get("ended") and not item.get("receipt"):
                item.pop("ended")
                item["retry"] = item.get("retry", 0) + 1
        else:
            if item is None: parser.error("unknown task tag")
            if args.receipt:
                path = args.receipt.resolve()
                if item["step"] in (1,4):
                    path = seal_draft(chair, item["tag"], path)
                rec = dict(path=str(path), sha256=fingerprint(path))
                if item.get("receipt", rec) != rec: parser.error("receipt already sealed")
                item["receipt"] = rec
            elif args.ended and not item.get("receipt"): item["ended"] = True
            else: parser.error("supply a completed receipt or confirm the prior call ended without one")
        with tempfile.NamedTemporaryFile("w", dir=chair, delete=False, encoding="utf-8") as f:
            json.dump(entries, f, ensure_ascii=False, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(f.name, state_path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("round", type=int)
    parser.add_argument("attempt", type=int)
    parser.add_argument("action", choices=["init", "check", "freeze", "intent", "receipt", "resume"])
    parser.add_argument("--decision", choices=["通过", "返工", "证据不足"])
    parser.add_argument("--reason")
    parser.add_argument("--step", type=int, choices=range(1,6))
    parser.add_argument("--role", choices=["Claude","Gemini","Codex","主控"])
    parser.add_argument("--phase", choices=["pilot","formal"])
    parser.add_argument("--tag")
    parser.add_argument("--input", type=Path, action="append")
    parser.add_argument("--receipt", type=Path)
    parser.add_argument("--ended", action="store_true")
    args = parser.parse_args()
    if min(args.round, args.attempt) < 1:
        parser.error("round and attempt must be positive")
    if args.action == "check" and not (args.decision and (args.reason or "").strip()):
        parser.error("check requires --decision and --reason")
    base = args.project / "轮次" / f"{args.round:03d}"
    attempt = f"尝试-{args.attempt:02d}"
    chair = base / "主控" / attempt
    if args.action in ("intent","receipt","resume"):
        recovery(args, chair, parser)
        return
    worker = base / "Codex" / attempt
    facts = worker / "事实材料"
    decision = chair / "核对.json"
    target = base / "验收证据" / attempt
    status = args.action
    if args.action == "init":
        for role in ("Claude", "Gemini", "Codex", "主控"):
            (base / role / attempt).mkdir(parents=True, exist_ok=True)
        facts.mkdir(exist_ok=True)
        for path in (worker / "自检.md", worker / "执行者意见.md"):
            path.touch(exist_ok=True)
        output = worker
    elif args.action == "check":
        hashes = {str(p.resolve()): fingerprint(p) for p in args.input or []}
        with decision.open("x", encoding="utf-8") as stream:
            json.dump(dict(status=args.decision, reason=args.reason, inputs=hashes), stream, ensure_ascii=False)
        output, status = decision, args.decision
    else:
        if not decision.exists() or json.loads(decision.read_text())["status"] != "通过":
            parser.error("Claude must pass this attempt before freeze")
        if target.exists():
            parser.error("sealed evidence exists; use the existing packet")
        files = sorted(facts.iterdir())
        if not files:
            parser.error("add raw evidence before freeze")
        target.parent.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(dir=target.parent) as stage:
            packet = Path(stage) / "packet"
            packet.mkdir()
            hashes = {}
            for path in files:
                if path.is_symlink() or not path.is_file() or path.name in {
                    "自检.md", "执行者意见.md", "manifest.json"
                }:
                    parser.error("facts must contain only approved regular evidence files")
                data = path.read_bytes()
                (packet / path.name).write_bytes(data)
                hashes[path.name] = hashlib.sha256(data).hexdigest()
            (packet / "manifest.json").write_text(json.dumps(hashes, ensure_ascii=False, indent=2))
            packet.rename(target)
        output = target
    now = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    with (args.project / "主控日志.md").open("a", encoding="utf-8") as log:
        print(now, args.action, status, output.relative_to(args.project), file=log)


if __name__ == "__main__":
    main()
