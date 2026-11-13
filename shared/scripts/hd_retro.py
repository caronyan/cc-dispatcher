#!/usr/bin/env python3
"""Digest finished cc-herdr-dispatch runs for a retrospective, and remember which runs were reviewed.

usage:
  hd_retro.py digest --root REPO [--run DIR ...] [--days N] [--include-reviewed] --out FILE
  hd_retro.py mark   --root REPO --retro RETRO_DIR --run DIR [--run DIR ...]

digest writes one Markdown file with what a retrospective needs from each run, and nothing it can
read cheaply elsewhere:
  - the run's own log.md and the decisions / parked cards / degraded stages in state.json;
  - each helper: mode, effort, rounds, final report check and failure, and the body of every
    follow-up task (task-2.md, ...): what the dispatching Claude had to send back, i.e. rework;
  - what the user typed to the dispatching Claude while the run went on (its Claude Code
    transcript, from meta.json's session), where corrections and preferences show up.
Runs are <REPO>/.cc-dispatch/*/ with an agents/ folder, retro runs excluded, the last N days
(default 14) by modification time, minus the ones a retro already marked (unless
--include-reviewed). --run picks runs explicitly instead.

mark records runs as reviewed in <REPO>/.cc-dispatch/.retro-reviewed.json ({run name: retro name}).

Output is KEY=value lines: RUNS=<n>, OUT=<file>, BYTES=<n>, then RUN=<name> per run.
"""
import argparse
import glob
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

LEDGER = ".retro-reviewed.json"
LOG_MAX = 6000        # chars of a run's log.md
TASK_MAX = 1500       # chars of one follow-up task body
SAY_MAX = 1200        # chars of one user message
SESSION_MAX = 40000   # chars of user messages per session
PAD = 30 * 60         # seconds of transcript taken before a run's first helper and after its last


def load(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        return default


def clip(text, n):
    text = (text or "").strip()
    return text if len(text) <= n else text[:n].rstrip() + f"\n…（截断，原文 {len(text)} 字）"


def ledger(root):
    return load(Path(root) / ".cc-dispatch" / LEDGER, {}) or {}


def runs_of(root, days, include_reviewed):
    base = Path(root) / ".cc-dispatch"
    done = ledger(root)
    since = time.time() - days * 86400
    out = []
    for d in sorted(base.glob("*/")):
        if not (d / "agents").is_dir() or d.name.startswith("retro-"):
            continue
        if d.name in done and not include_reviewed:
            continue
        if newest(d) < since:
            continue
        out.append(d)
    return out


def newest(d):
    times = [p.stat().st_mtime for p in [d, *d.glob("*"), *d.glob("agents/*/*")] if p.exists()]
    return max(times) if times else 0


def follow_ups(agent_dir):
    """Bodies of task-2.md, task-3.md, ...: the file header (title, folders, report path) dropped."""
    out = []
    for p in sorted(agent_dir.glob("task-*.md"), key=lambda p: int(re.sub(r"\D", "", p.stem) or 0)):
        k = int(re.sub(r"\D", "", p.stem) or 0)
        if k < 2:
            continue
        text = p.read_text(errors="replace")
        body = text.split("\n\n", 1)[1] if text.startswith("#") and "\n\n" in text else text
        out.append((k, body))
    return out


def events_of(agent_dir):
    """The call's events.jsonl (hd_dispatch.py), oldest first; [] for calls dispatched before it existed."""
    out = []
    try:
        for line in (agent_dir / "events.jsonl").read_text(errors="replace").splitlines():
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if isinstance(e, dict):
                out.append(e)
    except OSError:
        pass
    return out


def history(evs):
    """What meta.json overwrites and events.jsonl keeps: every failure, retry, stall and lost message."""
    fails = [e["failure"] for e in evs if e.get("ev") == "settle" and e.get("failure") not in (None, "exited")]
    bad = sum(1 for e in evs if e.get("ev") == "settle" and e.get("report") in ("bad", "missing") and e.get("state") == "live")
    retries = {}
    for e in evs:
        if e.get("ev") == "retry":
            retries[e.get("kind")] = retries.get(e.get("kind"), 0) + 1
    parts = [
        f"历次失败 {','.join(fails)}" if fails else "",
        f"{bad} 次交回时回报不合格" if bad else "",
        "自动重试 " + "、".join(f"{k}×{n}" for k, n in retries.items()) if retries else "",
        f"卡住 {sum(1 for e in evs if e.get('ev') == 'stall')} 次" if any(e.get("ev") == "stall" for e in evs) else "",
        "消息未送达" if any(e.get("sent") is False for e in evs) else "",
        "自己启动过终端" if any(e.get("ev") == "settle" and e.get("nested") for e in evs) else "",
    ]
    return [x for x in parts if x]


def run_section(d):
    lines = [f"## 运行 {d.name}", ""]
    st = load(d / "state.json", {}) or {}
    calls = []
    for a in sorted((d / "agents").glob("*/")):
        m = load(a / "meta.json")
        if isinstance(m, dict):
            calls.append((a, m))
    starts = [m.get("started_at") for _, m in calls if m.get("started_at")]
    when = datetime.fromtimestamp(min(starts)).strftime("%Y-%m-%d %H:%M") if starts else "?"
    reworked = sum(1 for _, m in calls if (m.get("round") or 1) > 1)
    failed = [m for _, m in calls if m.get("failure") and m.get("failure") not in ("exited",)]
    bad = [m for _, m in calls if m.get("report_check") not in (None, "ok")]
    lines.append(f"开始 {when} · {len(calls)} 个调用 · {reworked} 个有返工 · {len(failed)} 个以失败告终 · {len(bad)} 个回报未通过检查")
    for key in ("codex", "degraded_stages", "mode", "question"):
        if st.get(key):
            lines.append(f"- state.{key}: {json.dumps(st[key], ensure_ascii=False)}")
    lines.append("")

    if isinstance(st.get("decisions"), dict) and st["decisions"]:
        lines += ["### 决定（state.json decisions）", ""]
        lines += [f"- {k}: {v}" for k, v in st["decisions"].items()]
        lines.append("")
    tasks = st.get("tasks") if isinstance(st.get("tasks"), dict) else {}
    odd = {k: v for k, v in tasks.items() if isinstance(v, dict) and v.get("status") not in ("merged", "done")}
    if odd:
        lines += ["### 未合入的卡片", ""]
        for k, v in odd.items():
            extra = {x: v[x] for x in v if x not in ("title", "status", "repo", "worktree", "NAME") and not x.startswith("commit")}
            lines.append(f"- {k} [{v.get('status')}] {v.get('title', '')} {json.dumps(extra, ensure_ascii=False) if extra else ''}".rstrip())
        lines.append("")

    log = (d / "log.md")
    if log.exists():
        lines += ["### log.md", "", clip(log.read_text(errors="replace"), LOG_MAX), ""]

    lines += ["### 调用", ""]
    for a, m in calls:
        tag = " · ".join(x for x in [
            f"{m.get('mode')}/{m.get('effort')}", f"{m.get('round') or 1} 轮",
            f"回报 {m.get('report_check')}" if m.get("report_check") else "无回报检查",
            f"失败 {m['failure']}" if m.get("failure") else "",
            *history(events_of(a)),
        ] if x)
        lines.append(f"- **{m.get('call', a.name)}** {m.get('name', '')}：{tag}")
    lines.append("")
    for a, m in calls:
        for k, body in follow_ups(a):
            lines += [f"### {m.get('call', a.name)} 第 {k} 轮任务（派发方发回的话）", "", clip(body, TASK_MAX), ""]
    window = (min(starts) - PAD, newest(d) + PAD) if starts else None
    sessions = {m.get("session") for _, m in calls if m.get("session")}
    cwd = next((m.get("claude_cwd") for _, m in calls if m.get("claude_cwd")), None)
    return "\n".join(lines), window, sessions, cwd


def transcript(sid):
    home = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    found = glob.glob(os.path.join(home, "projects", "*", sid + ".jsonl"))
    return found[0] if found else None


NOISE = re.compile(r"^\s*(This session is being continued from a previous conversation|<task-notification>|<hc>|<local-command|<command-name>|<command-message>|<system-reminder>|Caveat:)")


def said(path, windows):
    """The user's own messages in the transcript inside any of the windows: (time, text)."""
    out, seen = [], set()

    def add(ts, text):
        if text and text not in seen:
            seen.add(text)
            out.append((ts, text))

    try:
        f = open(path, "rb")
    except OSError:
        return out
    with f:
        for raw in f:
            if b'"type":"user"' not in raw and b'"queued_command"' not in raw:
                continue
            try:
                ev = json.loads(raw)
            except ValueError:
                continue
            try:
                ts = datetime.fromisoformat(str(ev.get("timestamp")).replace("Z", "+00:00")).timestamp()
            except ValueError:
                continue
            if not any(lo <= ts <= hi for lo, hi in windows):
                continue
            att = ev.get("attachment")
            if ev.get("type") == "attachment" and isinstance(att, dict) and att.get("type") == "queued_command":
                # Typed while Claude was busy: delivered mid-turn as an attachment, not a user event.
                prompt = att.get("prompt")
                parts = [prompt] if isinstance(prompt, str) else [
                    b.get("text") or "" for b in prompt or [] if isinstance(b, dict) and b.get("type") == "text"]
                add(ts, "\n".join(p for p in parts if p and not NOISE.match(p)).strip())
                continue
            if ev.get("type") != "user" or ev.get("isMeta") or ev.get("isCompactSummary"):
                continue
            res = ev.get("toolUseResult")
            if res is not None:
                # The user's picks in an AskUserQuestion: decisions made in the user's own words.
                answers = res.get("answers") if isinstance(res, dict) else None
                if isinstance(answers, dict) and answers:
                    add(ts, "（选择）" + "；".join(f"{q} → {v}" for q, v in answers.items()))
                continue
            content = (ev.get("message") or {}).get("content")
            parts = [content] if isinstance(content, str) else [
                b.get("text") or "" for b in content or [] if isinstance(b, dict) and b.get("type") == "text"]
            add(ts, "\n".join(p for p in parts if p and not NOISE.match(p)).strip())
    return sorted(out, key=lambda x: x[0])


def cmd_digest(a):
    root = Path(a.root).resolve()
    runs = [Path(r).resolve() for r in a.run] if a.run else runs_of(root, a.days, a.include_reviewed)
    parts = [f"# 复盘材料：{root.name}", "",
             f"生成于 {datetime.now().strftime('%Y-%m-%d %H:%M')}，共 {len(runs)} 个运行。",
             "每个运行：state.json 的决定与未合入卡片、log.md、各调用的结果，以及返工时派发方发回的任务正文；"
             "最后是派发方 Claude 在这些运行期间收到的用户原话。", ""]
    by_session = {}
    for d in runs:
        text, window, sessions, cwd = run_section(d)
        parts += [text, ""]
        for sid in sessions:
            s = by_session.setdefault(sid, {"windows": [], "runs": []})
            s["runs"].append(d.name)
            if window:
                s["windows"].append(window)
    if by_session:
        parts += ["## 用户原话（派发方 Claude 的会话）", ""]
    for sid, s in by_session.items():
        path = transcript(sid)
        parts += [f"### 会话 {sid}（运行：{', '.join(s['runs'])}）", ""]
        if not path:
            parts += ["（找不到会话记录）", ""]
            continue
        used = 0
        for ts, text in said(path, s["windows"]):
            line = f"- [{datetime.fromtimestamp(ts).strftime('%m-%d %H:%M')}] {clip(text, SAY_MAX)}"
            if used + len(line) > SESSION_MAX:
                parts.append("- …（其余省略）")
                break
            parts.append(line)
            used += len(line)
        parts += [f"", f"完整记录：{path}", ""]
    out = Path(a.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(parts))
    print(f"RUNS={len(runs)}")
    print(f"OUT={out}")
    print(f"BYTES={out.stat().st_size}")
    for d in runs:
        print(f"RUN={d.name}")


def cmd_mark(a):
    root = Path(a.root).resolve()
    path = root / ".cc-dispatch" / LEDGER
    done = ledger(root)
    for r in a.run:
        done[Path(r).name] = Path(a.retro).name
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(done, ensure_ascii=False, indent=1) + "\n")
    tmp.replace(path)
    print(f"MARKED={len(a.run)}")
    print(f"LEDGER={path}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    d = sub.add_parser("digest")
    d.add_argument("--root", required=True)
    d.add_argument("--run", action="append", default=[])
    d.add_argument("--days", type=float, default=14)
    d.add_argument("--include-reviewed", action="store_true")
    d.add_argument("--out", required=True)
    m = sub.add_parser("mark")
    m.add_argument("--root", required=True)
    m.add_argument("--retro", required=True)
    m.add_argument("--run", action="append", required=True)
    a = p.parse_args()
    {"digest": cmd_digest, "mark": cmd_mark}[a.cmd](a)


if __name__ == "__main__":
    sys.exit(main())
