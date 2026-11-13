#!/usr/bin/env python3
"""The main agent's subscription quota: read for the cc-dispatch panel's run cards, and a prompt to ask the
user about handing the run off when a window gets close to its limit.

  hd_usage.py quota [AGENT] [--slow]
                         prints what is known of AGENT's quota (claude or codex; default claude) as JSON, or
                         null. The panel runs it for each live run's main agent.
  hd_usage.py hook       Claude Code's PostToolUse hook: once a window of this account passes the threshold
                         while it is the main agent of a running cc-dispatch run, adds a note telling it to
                         ask the user whether to hand off (herdr.md). hd_dispatch.py wait / collect make the
                         same check for any main agent (check()).
  hd_usage.py settings [--remove] [--file F]
                         adds (or removes) the hook in ~/.claude/settings.json, keeping a backup; also takes
                         out the status line earlier versions added (restoring the one it wrapped).

Where the quota comes from, first that answers:
  1. magpie (usemagpie.ai): its gateway http://127.0.0.1:$MAGPIE_PORT/v1/magpie/quotas (default 3425), or,
     with --slow, `magpie quota --json`. Of the provider's accounts, the one magpie served last.
  2. Codex only: rate_limits in its newest session log (~/.codex*/sessions, written in the last 30 min).
  3. Nothing: nothing shown, nothing checked.
Cached for 60 s in $CC_HD_HOME/usage/quota-<agent>.json. CC_HD_QUOTA_JSON=<file> uses that file as
magpie's answer and nothing else (tests).

Threshold: $CC_HD_HANDOFF_AT percent used (default 90), per window; a window prompts once until it resets
($CC_HD_HOME/usage/fired-<terminal>.json). A window for one model ("7 days · Fable") counts only while the
main agent runs that model, when that is known (Claude Code's transcript).
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

HOME = Path(os.environ.get("CC_HD_HOME", "/tmp/cc-dispatch"))
USAGE = HOME / "usage"
TTL = 60
AGENT_LABEL = {"claude": "Claude", "codex": "Codex"}


def threshold() -> float:
    try:
        return float(os.environ.get("CC_HD_HANDOFF_AT", "90"))
    except ValueError:
        return 90.0


def agent_of(program) -> str | None:
    """claude / codex from a program name or path, else None."""
    name = Path(str(program or "")).name.lower()
    return next((a for a in AGENT_LABEL if a in name), None)


def epoch(t) -> int | None:
    if isinstance(t, (int, float)):
        return int(t)
    try:
        return int(datetime.fromisoformat(str(t).replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def short(name: str) -> str:
    """'5 hours' -> 5h, '7 days · Fable' -> 7d Fable."""
    head, _, model = str(name).partition("·")
    words = head.split()
    s = f"{words[0]}{words[1][0]}" if len(words) == 2 and words[0].isdigit() else head.strip()
    return f"{s} {model.strip()}".strip()


def _write(path: Path, data):
    try:
        USAGE.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False))
        tmp.replace(path)
    except OSError:
        pass


def _read(path: Path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError):
        return None


# ---- sources ----

def magpie_entries(slow: bool):
    """magpie's quota list, or None when it does not answer."""
    fixture = os.environ.get("CC_HD_QUOTA_JSON")
    if fixture:
        return _read(Path(fixture))
    try:
        port = os.environ.get("MAGPIE_PORT", "3425")
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/v1/magpie/quotas", timeout=1.5) as r:
            d = json.loads(r.read())
        return d.get("data") if isinstance(d, dict) else d
    except (OSError, ValueError):
        pass
    if not slow:
        return None
    try:
        r = subprocess.run(["magpie", "quota", "--json"], capture_output=True, text=True, timeout=30)
        return json.loads(r.stdout) if r.returncode == 0 else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def from_magpie(entries, agent: str):
    mine = [e for e in entries or [] if isinstance(e, dict) and e.get("provider") == agent
            and e.get("kind", "subscription") == "subscription" and not e.get("error") and e.get("windows")]
    if not mine:
        return None
    e = next((e for e in mine if e.get("last")), None) or max(mine, key=lambda e: e.get("lastServedAt") or "")
    wins = [{"name": w.get("name"), "used": float(w["used"]), "resets": epoch(w.get("resetsAt"))}
            for w in e["windows"] if isinstance(w.get("used"), (int, float)) and not w.get("unlimited")]
    return {"source": "magpie", "account": e.get("user"), "plan": e.get("plan"), "windows": wins} if wins else None


def from_codex_logs() -> dict | None:
    """rate_limits in the newest Codex session log written in the last 30 minutes."""
    now = time.time()
    logs = []
    for home in Path.home().glob(".codex*"):
        for day in (0, 1):
            d = time.localtime(now - day * 86400)
            logs += (home / "sessions" / f"{d.tm_year:04d}" / f"{d.tm_mon:02d}" / f"{d.tm_mday:02d}").glob("*.jsonl")
    logs = [p for p in logs if now - p.stat().st_mtime < 1800]
    for p in sorted(logs, key=lambda p: p.stat().st_mtime, reverse=True)[:3]:
        with open(p, "rb") as f:
            f.seek(max(0, p.stat().st_size - 400_000))
            lines = f.read().decode("utf8", "replace").splitlines()
        for line in reversed(lines):
            if '"rate_limits"' not in line:
                continue
            try:
                rl = json.loads(line)["payload"]["rate_limits"]
            except (ValueError, KeyError, TypeError):
                continue
            wins = []
            for k in ("primary", "secondary"):
                w = rl.get(k) or {}
                if isinstance(w.get("used_percent"), (int, float)) and (w.get("resets_at") or now + 1) > now:
                    m = w.get("window_minutes") or 0
                    name = f"{m // 1440} days" if m >= 1440 else f"{m // 60} hours" if m >= 60 else f"{m} minutes"
                    wins.append({"name": name, "used": float(w["used_percent"]), "resets": w.get("resets_at")})
            if wins:
                return {"source": "codex", "plan": rl.get("plan_type"), "windows": wins}
            break
    return None


def quota(agent: str, slow: bool = False) -> dict | None:
    """What is known of AGENT's quota: {source, account, plan, windows: [{name, used, resets}], at}, or None."""
    path = USAGE / f"quota-{agent}.json"
    c = _read(path)
    now = int(time.time())
    if c and now - c.get("at", 0) < TTL:
        return c.get("q")
    q = from_magpie(magpie_entries(slow), agent)
    if not q and not os.environ.get("CC_HD_QUOTA_JSON"):
        q = from_codex_logs() if agent == "codex" else None
        if not q and c and c.get("q") and now - c.get("at", 0) < 15 * 60:
            q = c["q"]  # keep the last reading a while rather than flicker
    if q:
        q["at"] = now
    _write(path, {"at": now, "q": q})
    return q


def windows_for(q: dict | None, model: str | None = None) -> list:
    """q's windows that have not reset since, without those for another model than `model` (when known)."""
    out = []
    for w in (q or {}).get("windows", []):
        _, _, only = str(w.get("name")).partition("·")
        if only.strip() and model and only.strip().lower() not in model.lower():
            continue
        if w.get("resets") and w["resets"] < time.time():
            continue
        out.append(w)
    return out


def cmd_quota(a):
    print(json.dumps(quota(a.agent, slow=a.slow), ensure_ascii=False))


# ---- the check ----

def check(agent: str, term: str, model: str | None = None, slow: bool = False) -> list:
    """Windows of AGENT's quota past the threshold that have not prompted this terminal yet since they last
    reset; marks them as prompted. [] when none, or nothing is known."""
    if not agent or not term:
        return []
    at = threshold()
    over = [w for w in windows_for(quota(agent, slow=slow), model) if w["used"] >= at]
    if not over:
        return []
    path = USAGE / f"fired-{term}.json"
    now = int(time.time())
    fired = {k: v for k, v in (_read(path) or {}).items() if v > now}  # drop windows that have reset
    new = [w for w in over if f"{agent}:{w['name']}:{w.get('resets')}" not in fired]
    for w in new:
        fired[f"{agent}:{w['name']}:{w.get('resets')}"] = w.get("resets") or now + 5 * 3600
    _write(path, fired)
    return new


def note(agent: str, over: list, runs: list) -> str:
    def when(w):
        return time.strftime(" %m-%d %H:%M 重置", time.localtime(w["resets"])) if w.get("resets") else ""
    what = "、".join(f"{short(w['name'])} 窗口已用 {w['used']:.0f}%{when(w)}" for w in over)
    usage = ",".join(f"{agent}:{short(w['name']).replace(' ', '_')}:{w['used']:.0f}" for w in over)
    return (f"CC_HANDOFF=usage USAGE={usage} RUNS={' '.join(str(r) for r in runs)}\n"
            f"你作为主 agent 所用的 {AGENT_LABEL.get(agent, agent)} 账号额度快用完了（{what}，阈值 {threshold():.0f}%）。"
            f"先问用户要不要现在交接给别的主 agent：Claude Code 用 AskUserQuestion，其他 agent 直接在对话里问，然后停下等回答。"
            f"问之前不要开始交接，也不要开始新的派发。用户同意：按 herdr.md「主 agent 交接」做（--why usage）。"
            f"用户不同意：照常继续，这个窗口重置前不会再提示。")


def my_runs(cwd: str, sid: str, term: str) -> list:
    """Running cc-dispatch runs in cwd's repository whose main agent is this session or terminal."""
    top = subprocess.run(["git", "-C", cwd or ".", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    base = Path(top.stdout.strip() if top.returncode == 0 else (cwd or "."))
    runs = []
    for run in sorted((base / ".cc-dispatch").glob("*/")):
        c = _read(run / "control.json") or {"state": "running"}
        if c.get("state", "running") not in ("running", "paused"):
            continue
        if c.get("owner") and c["owner"] != term:
            continue
        for m in (run / "agents").glob("*/meta.json"):
            meta = _read(m) or {}
            if (sid and meta.get("session") == sid) or (term and meta.get("parent") == term):
                runs.append(run)
                break
    return runs


def transcript_model(path) -> str | None:
    """The model of the last assistant message in a Claude Code transcript, or None."""
    try:
        p = Path(path)
        with open(p, "rb") as f:
            f.seek(max(0, p.stat().st_size - 200_000))
            text = f.read().decode("utf8", "replace")
    except (OSError, TypeError):
        return None
    found = re.findall(r'"model"\s*:\s*"([^"]+)"', text)
    return found[-1] if found else None


def cmd_hook(a):
    try:
        data = json.loads(sys.stdin.read() or "{}")
    except ValueError:
        return
    term = os.environ.get("HC_TERMINAL_ID", "")
    if not term:
        return
    runs = my_runs(data.get("cwd") or os.getcwd(), data.get("session_id"), term)
    if not runs:
        return
    over = check("claude", term, transcript_model(data.get("transcript_path")))
    if over:
        print(json.dumps({"hookSpecificOutput": {"hookEventName": "PostToolUse",
                                                 "additionalContext": note("claude", over, runs)}}, ensure_ascii=False))


# ---- settings ----

def ours(cmd: str) -> bool:
    return "hd_usage.py" in (cmd or "")


def inner_of(cmd: str):
    """The status line command an earlier version of ours wrapped (its --inner argument), or None."""
    try:
        words = shlex.split(cmd)
    except ValueError:
        return None
    return words[words.index("--inner") + 1] if "--inner" in words[:-1] else None


def cmd_settings(a):
    path = Path(a.file or Path.home() / ".claude" / "settings.json")
    s = json.loads(path.read_text()) if path.exists() else {}
    before = json.dumps(s, sort_keys=True)
    me = shlex.quote(str(Path(__file__).resolve()))
    sl = s.get("statusLine")
    if sl and ours(sl.get("command")):  # earlier versions added a status line: put back what was there
        inner = inner_of(sl["command"])
        if inner:
            rest = {**sl, "command": inner}
            if "--refresh-added" in sl["command"]:
                rest.pop("refreshInterval", None)
            s["statusLine"] = rest
        else:
            s.pop("statusLine")
    hooks = s.setdefault("hooks", {})
    post = hooks.setdefault("PostToolUse", [])
    mine = [g for g in post if any(ours(h.get("command")) for h in g.get("hooks", []))]
    if a.remove:
        hooks["PostToolUse"] = [g for g in post if g not in mine]
    elif not mine:
        post.append({"matcher": "*", "hooks": [{"type": "command", "command": f"python3 {me} hook", "timeout": 10}]})
    if not hooks["PostToolUse"]:
        hooks.pop("PostToolUse")
    if not hooks:
        s.pop("hooks")
    if json.dumps(s, sort_keys=True) == before:
        print(f"SETTINGS=unchanged {path}")
        return
    if path.exists():
        bak = path.with_name(f"{path.name}.bak-cc-dispatch-{time.strftime('%Y%m%d-%H%M%S')}")
        bak.write_text(path.read_text())
        print(f"BACKUP={bak}")
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(json.dumps(s, indent=2, ensure_ascii=False) + "\n")
    tmp.replace(path)
    print(f"SETTINGS={'removed' if a.remove else 'added'} {path}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    qu = sub.add_parser("quota")
    qu.add_argument("agent", nargs="?", default="claude", choices=sorted(AGENT_LABEL))
    qu.add_argument("--slow", action="store_true", help="also ask `magpie quota` when its gateway does not answer")
    sub.add_parser("hook")
    se = sub.add_parser("settings")
    se.add_argument("--remove", action="store_true")
    se.add_argument("--file", help="settings.json to edit (default ~/.claude/settings.json)")
    a = p.parse_args()
    {"hook": cmd_hook, "quota": cmd_quota, "settings": cmd_settings}[a.cmd](a)


if __name__ == "__main__":
    main()
