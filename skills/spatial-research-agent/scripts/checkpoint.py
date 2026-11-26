"""Archive a supervised attempt. Claude supplies the decision after inspecting evidence."""
import argparse
import datetime
import hashlib
import json
from pathlib import Path
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("round", type=int)
    parser.add_argument("attempt", type=int)
    parser.add_argument("action", choices=["init", "check", "freeze"])
    parser.add_argument("--decision", choices=["通过", "返工", "证据不足"])
    parser.add_argument("--reason")
    args = parser.parse_args()
    if min(args.round, args.attempt) < 1:
        parser.error("round and attempt must be positive")
    if args.action == "check" and not (args.decision and (args.reason or "").strip()):
        parser.error("check requires --decision and --reason")
    base = args.project / "轮次" / f"{args.round:03d}"
    attempt = f"尝试-{args.attempt:02d}"
    chair = base / "主控" / attempt
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
        with decision.open("x", encoding="utf-8") as stream:
            json.dump(dict(status=args.decision, reason=args.reason), stream, ensure_ascii=False)
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
