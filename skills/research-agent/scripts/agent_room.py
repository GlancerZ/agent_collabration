"""Local research activity board maintained by the chair."""
import argparse
from datetime import datetime
from functools import partial
from html import escape
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sqlite3
from urllib.parse import parse_qs, urlsplit

ROLES = ("Claude", "Gemini", "Codex")
STATES = ("进行中", "等待", "完成", "受阻")
STEPS = ("配置", "独立规划", "汇总派工", "执行与检查", "并行核验", "主控决策")


def connect(project):
    db = sqlite3.connect(project / ".agent-room.sqlite3")
    db.row_factory = sqlite3.Row
    db.execute("""CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY, round INTEGER, step INTEGER, role TEXT,
        state TEXT, task TEXT, stamp TEXT)""")
    return db


def render(project, selected):
    with connect(project) as db:
        rounds = {row[0] for row in db.execute("SELECT DISTINCT round FROM events")}
        rounds.update(int(p.name) for p in (project / "轮次").glob("*")
                      if p.is_dir() and p.name.isascii() and p.name.isdigit())
        current = selected if selected in rounds else max(rounds, default=1)
        rows = list(db.execute("SELECT * FROM events WHERE round=? ORDER BY id DESC", (current,)))
    links = ' '.join(f'<a href="/?round={n}">{n:03d}</a>' for n in sorted(rounds))
    cards = []
    for role in ROLES:
        row = next((r for r in rows if r["role"] == role), None)
        status = row["state"] if row else "尚无状态记录"
        task = escape(row["task"]) if row else "—"
        tone = STATES.index(status) if row else 1
        cards.append(f'<article><small class="s{tone}">{status}</small><h2>{role}</h2><p>{task}</p></article>')
    events = ''.join(f'<li><time>{escape(r["stamp"])}</time> <b>{escape(r["role"])}</b>'
                     f' · {STEPS[r["step"]]} · {escape(r["state"])}<p>{escape(r["task"])}</p></li>'
                     for r in rows)
    log = project / "主控日志.md"
    history = escape(log.read_text(encoding="utf-8")[-12000:]) if log.is_file() else ""
    return f"""<!doctype html><html lang="zh"><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Research Agent Room</title>
<style>*{{box-sizing:border-box}}body{{margin:0;background:#f5f5ef;color:#18372d;font:16px Inter,system-ui,sans-serif}}
main{{max-width:1050px;margin:auto;padding:5vh 4vw}}header{{border-bottom:2px solid;padding-bottom:18px}}
h1{{font-size:clamp(32px,6vw,64px);margin:.3em 0}}section{{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}}
article,details{{background:white;border:1px solid #cad4c9;border-radius:10px;padding:18px}}
article p,li p,pre{{overflow-wrap:anywhere}}small{{padding:3px 9px;border-radius:20px;background:#e7e9e5}}.s0{{background:#bcdfed}}.s2{{background:#c1ead1}}.s3{{background:#f2cebd}}
a{{color:#175745;padding:4px}}time,nav{{color:#4e655b}}ul{{padding:0;list-style:none}}li{{border-top:1px solid #cbd4cd;padding:12px 0}}li p{{margin:.35em 0}}pre{{white-space:pre-wrap}}details{{margin-top:24px}}</style>
<main><header>{escape(project.name)}<h1>Research Agent Room</h1><nav>轮次 {links or '—'} · <a href="/">跟随最新轮次</a></nav></header>
<h2>第 {current:03d} 轮</h2><section>{''.join(cards)}</section>
<h2>本轮动态</h2><ul>{events or '<li>此轮尚无结构化状态记录。</li>'}</ul>
<details><summary>项目主控日志（最近记录）</summary><pre>{history}</pre></details></main></html>"""


class Handler(BaseHTTPRequestHandler):
    def __init__(self, *args, project, **kwargs):
        self.project = project
        super().__init__(*args, **kwargs)

    def do_GET(self):
        url = urlsplit(self.path)
        if url.path != "/":
            self.send_error(404)
            return
        try:
            selected = int(parse_qs(url.query).get("round", ["0"])[0])
        except ValueError:
            self.send_error(400)
            return
        data = render(self.project, selected).encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    commands = parser.add_subparsers(dest="action", required=True)
    serve = commands.add_parser("serve")
    serve.add_argument("--port", type=int, default=8765)
    event = commands.add_parser("event")
    event.add_argument("round", type=int)
    event.add_argument("step", type=int, choices=range(len(STEPS)))
    event.add_argument("role", choices=ROLES)
    event.add_argument("state", choices=STATES)
    event.add_argument("task")
    args = parser.parse_args()
    project = args.project.resolve()
    if not project.is_dir():
        parser.error("project directory must exist")
    if args.action == "serve":
        with ThreadingHTTPServer(("127.0.0.1", args.port), partial(Handler, project=project)) as server:
            print(f"http://127.0.0.1:{server.server_port}/", flush=True)
            server.serve_forever()
    else:
        if args.round < 1 or not args.task.strip():
            parser.error("supply a positive round and task description")
        with connect(project) as db:
            db.execute("INSERT INTO events(round,step,role,state,task,stamp) VALUES(?,?,?,?,?,?)",
                       (args.round, args.step, args.role, args.state, args.task,
                        datetime.now().astimezone().isoformat(timespec="seconds")))


if __name__ == "__main__":
    main()
