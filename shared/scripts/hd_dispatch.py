#!/usr/bin/env python3
"""Dispatch Codex helpers through herdr-core (hc) and collect their JSON reports.

usage:
  hd_dispatch.py probe
  hd_dispatch.py run      --run DIR --call ID --mode read|write|net --effort medium|high
                          --dir DIR --prompt FILE --schema FILE [--title WORDS]
  hd_dispatch.py send     --run DIR --call ID --prompt FILE
  hd_dispatch.py wait     --run DIR [--timeout SECONDS] [--stall SECONDS]
  hd_dispatch.py collect  --run DIR [--call ID]
  hd_dispatch.py status   --run DIR
  hd_dispatch.py diagnose --run DIR --call ID
  hd_dispatch.py cleanup  --run DIR [--call ID]
  hd_dispatch.py pause    --run DIR
  hd_dispatch.py resume   --run DIR
  hd_dispatch.py stop     --run DIR [--wait SECONDS]
  hd_dispatch.py freeze   --run DIR --call ID [--ask SECONDS] [--why WORD]
  hd_dispatch.py handover --run DIR --call ID [--to codex|claude] [--effort E] [--ask S] [--why WORD]
                          [--note TEXT] [--notify]
  hd_dispatch.py handoff  --run DIR [--why manual|usage] [--no-notes]
  hd_dispatch.py adopt    --run DIR --from PACKAGE
  hd_dispatch.py recover  --run DIR [--call NAME] [--fresh]

freeze stops a helper and keeps what another agent needs: a progress note it is asked to write (to
$CC_HD_HOME/<tag>/<call>/progress-r<k>.md, up to --ask s), its screen (agents/<call>/screen-r<k>.txt), a
snapshot of its worktree at refs/cc-dispatch/<run>/<call>/r<k> (HEAD, index and files untouched), its
session logs and report; closes its terminal and writes the package agents/<call>/handoff/r<k>/ (see
hd_handoff.py). collect freezes a helper whose conversation is full (context_limit) by itself.
handover freezes (unless frozen this round) and starts --to (AGENTS) as the call's next round in the same
folder, report and schema, its task file pointing at the package. Labels add cc.agent=<agent>.

handoff is the dispatcher's own: it hands the run to the next main agent. It needs <run>/handoff-notes.md
(the dispatcher's account: the user's request, what is done and decided, what is under way, what next),
sets control.json to {"state": "handoff", "prev": <the state before>, "package", "prompt", ...} and writes
<run>/handoff/<seq>/ (hd_handoff.dispatcher_package): the notes, every call, state.json, the repo. Helpers
keep working. Output HANDOFF=, PROMPT= and the prompt between marker lines, for the person to give the next
agent. From then on run and send refuse and wait and collect end at once with RUN_CONTROL=handoff;
resume cancels it (back to the state before).
adopt is the next main agent's first step: it checks the package, records itself as every call's parent
(meta.json; hc's own parent cannot change, so herdr's notes still go to the old terminal), logs an "adopt"
event, and puts the run back in its state before the handoff with control.json "owner" = its terminal.
From then on run, send, wait and collect from any other terminal refuse with RUN_CONTROL=adopted.
A call is lost when its terminal vanished while open (cleanup, stop and freeze close it on purpose) before
a good report for its round: collect / wait report FAILURE=lost and record meta.lost. recover reopens the lost
calls, idle: in their own session when it is found (Codex: its newest thread in a Codex home's sqlite, resumed
in that home with its template's flags; Claude Code: --resume), else (or with --fresh) a new session told to
read its task file, look at its folder and wait. The run is paused with them held, so resume tells them to
carry on. Output RECOVERED= FRESH= FAILED=. When the main agent's terminal is gone too, the run is handed off
(why recover; prev = the paused state) and MAIN=gone HANDOFF= PROMPT= RESUME_MAIN= (how to reopen its own
session) come with the prompt; whoever takes over runs adopt as after any handoff. Else MAIN=live.

--run is the skill's run directory (<repo>/.cc-dispatch/<kind>-<run>); each call keeps its state in
<run>/agents/<call>/ (meta.json, task-<k>.md). Reports live under $CC_HD_HOME (default /tmp/cc-dispatch),
the one place Codex's workspace-write sandbox can write besides its working directory.
A read-mode helper works in its own folder there, so it can read the repo but cannot change it.

Output is KEY=value lines. probe and run end with
FAILURE=none|quota|context_limit|auth|refused|capacity|rate_limit|other. quota is the account's usage
running out (wait for it to reset, or hand the work to another agent); context_limit is one helper's
conversation filling up while the account still has room (hand the work to a fresh session).
Neither is retried.

capacity (server busy, overloaded, dropped stream) and rate_limit clear by themselves, so wait and collect
retry them before reporting: the helper is told to carry on after 30, 60, 120, 300 s (CC_HD_RETRY_DELAYS,
comma-separated seconds), counted per round. Meanwhile the call counts as working and the output adds
RETRYING=<call>(<kind> <n>/<max>),...; it is reported (FAILURE=<kind>, RETRIED=<n>) only once they run out.

The network is checked (a TLS handshake with CC_HD_NET_PROBE's host:port list; CC_HD_NET=up|down forces it)
whenever a helper is at work. While it is down the output adds NET=down and live helpers carry cc.net=down;
a helper that stops on anything but auth, quota, refused or context_limit then waits for the network
(RETRYING=<call>(network)) without using up a retry, and is told to carry on once it is back.

Each helper terminal carries hc labels for herdr's UI (the cc-dispatch panel reads them):
  cc.run=<tag> cc.call=<id> cc.kind=<skill> cc.dir=<run dir> cc.mode=<mode>   set at run
  cc.round=<n>                                                               run, send
  cc.report=ok|bad|missing   cc.failure=<FAILURE word, or removed>           collect / wait
  cc.retry=<kind> <n>/<max>, or removed                                      wait / collect, while retrying
  cc.net=down, or removed                                                    wait / collect, network down
The same verdicts are kept in meta.json (report_check, failure) so finished runs still show them.

Each call also keeps <run>/agents/<call>/events.jsonl, one JSON object per line, appended and never
rewritten: {"t": <epoch s>, "ev": <kind>, "round": <n>, ...}. Kinds:
  dispatch  mode effort dir name title task sent           run
  send      why=rework task sent | why=retry kind n task sent  send / a due retry (kind network: it is back)
  offline   n                                              stopped while the network is down; waits for it
  retry     kind n max at                                  a retry scheduled
  settle    state status turn report failure retried nested  collect / wait reported it
  stall     minutes turn                                   wait
  codex     model tokens{input,cached,cache_write,output} commands files first last sessions rollouts
            (cumulative over the helper's Codex sessions, first/last in epoch ms)  after each settle
  cleanup                                                   cleanup
  lost                                                      collect / wait: its terminal vanished while open, no good report
  recover   how session                                     recover (how: resume = its own session, fresh = a new one)
  pause     interrupted                                     pause (interrupted: the helper was stopped mid-turn)
  resume    sent                                            resume
  stop      asked report                                    stop (asked: told to write what it has)
  freeze    why asked progress snapshot package             freeze / handover / collect on context_limit
  handover  frm to why package name task sent isolation     handover (round is the new one)
  adopt     frm by agent package                            adopt (a new main agent took the run over)
The panel and hd_retro.py read it; a run keeps its history after Codex prunes its own logs.

pause, resume and stop act on the whole run; the cc-dispatch panel runs them after the person confirms.
Their state is <run>/control.json: {"state": "running|paused|stopping|stopped|handoff", "at": <epoch s>,
"held": [calls pause interrupted], "report": <run>/stop.md once stopped}. No file means running.
  pause   presses the stop key of every helper that is working (a pending retry is dropped), keeping its
          Codex session; settled helpers are left alone.
  resume  tells each held helper to carry on with its task file; from stopped it only resets the state.
  stop    stops working helpers and tells every helper without a good report to write what it has done
          so far into its report (waits up to --wait, default 180 s), collects them all, closes their
          terminals (worktrees stay), writes <run>/stop.md and sends the dispatching Claude a message to
          sum up and ask the person.
While a run is not running: run and send refuse (RUN_CONTROL=<state>, exit 3); collect does nothing;
wait reports nothing and retries nothing: it waits while paused or stopping and ends with
RUN_CONTROL=paused (at its timeout) or RUN_CONTROL=stopped STOP_REPORT=<path>.
"""
import argparse
import json
import os
import re
import secrets
import socket
import ssl
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

HOME = Path(os.environ.get("CC_HD_HOME", "/tmp/cc-dispatch"))
CHECK = Path(__file__).with_name("hd_check.py")
SETTLED = {"done", "idle", "error", "blocked"}
FIRST_MSG = "读取任务文件 {task}，按其中要求完成。"
SEND_MSG = "读取任务文件 {task}，按其中要求处理。"

# Error wording seen on a Codex screen; extend a pattern when a real failure is misclassified.
PATTERNS = [
    ("refused", r"cyber_policy|content policy|usage polic|safety (system|filter)|flagged (as|for)"),
    ("auth", r"\b401\b|unauthorized|not logged in|codex login|authentication|invalid api key|token (has )?expired|refresh token"),
    # The helper's own conversation is full: its session cannot go on, but the account still can.
    ("context_limit", r"context window|context_length_exceeded|maximum context length|ran out of room|"
                      r"exceeds? the context|context limit|prompt is too long|too many tokens"),
    ("quota", r"usage limit|quota|insufficient_quota|exceeded your|billing|out of credits|plan limit|upgrade to"),
    ("rate_limit", r"\b429\b|rate limit|rate_limit|ratelimit|too many requests|try again in"),
    ("capacity", r"at capacity|overloaded|high demand|temporarily unavailable|service unavailable|"
                 r"(status|http|error)[^\n]{0,20}\b50[0234]\b|internal server error|bad gateway|stream disconnected|stream error|connection reset|error sending request"),
]
RETRYABLE = ("capacity", "rate_limit")
RETRY_WHY = {"capacity": "服务端繁忙或连接断开", "rate_limit": "请求过快被限流", "network": "网络中断"}
NET_RECHECK = 30  # seconds between network checks while a helper waits for it
_NET: dict = {}


def online() -> bool:
    """Whether this machine reaches the internet: a verified TLS handshake with any of CC_HD_NET_PROBE's
    host:port (default chatgpt.com, api.openai.com, one.one.one.one on 443), cached for 10 s. A bare TCP
    connect is not enough: a TUN-mode proxy or VPN accepts every connect itself. CC_HD_NET=up|down forces it."""
    forced = os.environ.get("CC_HD_NET", "")
    if forced in ("up", "down"):
        return forced == "up"
    now = time.time()
    if _NET and now - _NET["t"] < 10:
        return _NET["ok"]
    ok = False
    tls = ssl.create_default_context()
    for hp in (os.environ.get("CC_HD_NET_PROBE") or "chatgpt.com:443,api.openai.com:443,one.one.one.one:443").split(","):
        host, _, port = hp.strip().rpartition(":")
        try:
            with socket.create_connection((host, int(port)), timeout=4) as raw:
                tls.wrap_socket(raw, server_hostname=host).close()
            ok = True
            break
        except (OSError, ValueError):
            continue
    _NET.update(t=now, ok=ok)
    return ok
RETRY_MSG = "上一条请求因{why}没有完成。继续完成任务文件 {task} 的要求：已经做完的不要重做，最后按要求写回报。"


def retry_delays() -> list:
    try:
        d = [int(x) for x in os.environ.get("CC_HD_RETRY_DELAYS", "").split(",") if x.strip()]
    except ValueError:
        d = []
    return d or [30, 60, 120, 300]


def out(**kv):
    for k, v in kv.items():
        print(f"{k.upper()}={v}")


def fail(msg, failure="other", code=2):
    print(msg)
    out(failure=failure)
    sys.exit(code)


def hc(*args, check=False):
    r = subprocess.run(["hc", *args], capture_output=True, text=True)
    if check and r.returncode != 0:
        fail(f"HC_ERROR: hc {' '.join(args[:2])}: {(r.stderr or r.stdout).strip()[:400]}")
    return r


def hc_json(*args):
    r = hc(*args, "--json")
    try:
        return json.loads(r.stdout) if r.stdout.strip() else None
    except json.JSONDecodeError:
        return None


def need_env():
    for prog, tag in (("hc", "HC_NOT_FOUND"), ("codex", "CODEX_NOT_FOUND")):
        if subprocess.run(["sh", "-c", f"command -v {prog}"], capture_output=True).returncode:
            fail(tag)
    if not os.environ.get("HC_TERMINAL_ID"):
        fail("NOT_IN_HERDR: start the main agent (Claude Code, Codex, ...) inside a herdr terminal ($HC_TERMINAL_ID is unset)")
    ensure_home()


def ensure_home():
    HOME.mkdir(parents=True, exist_ok=True)
    if not (HOME / ".git").exists():
        # One git root: Codex's folder trust then covers every helper folder under it with one answer.
        subprocess.run(["git", "init", "-q", str(HOME)], check=False)


# ---- run state -------------------------------------------------------------------------------------

def run_tag(run: Path) -> str:
    f = run / "agents" / "tag"
    if not f.exists():
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("h" + secrets.token_hex(3) + "\n")
    return f.read_text().strip()


def meta_path(run: Path, call: str) -> Path:
    return run / "agents" / call / "meta.json"


def load(run: Path, call: str) -> dict:
    p = meta_path(run, call)
    if not p.exists():
        fail(f"UNKNOWN_CALL: {call} (no {p})")
    return json.loads(p.read_text())


def save(run: Path, meta: dict):
    meta_path(run, meta["call"]).write_text(json.dumps(meta, ensure_ascii=False, indent=1))


def calls(run: Path):
    root = run / "agents"
    return sorted(p.parent.name for p in root.glob("*/meta.json")) if root.exists() else []


def observe(meta: dict) -> dict:
    """The helper's state now: state live|finished|gone, status, turn."""
    g = hc_json("get", meta["name"])
    if not g or "error" in g:
        return {"state": "gone", "status": None, "turn": meta.get("acked_turn", 0)}
    return {"state": g.get("state"), "status": (g.get("status") or {}).get("state"),
            "turn": g.get("turn") or 0, "address": g.get("address")}


def is_lost(meta: dict, o: dict) -> bool:
    """Its terminal vanished without cleanup, stop or freeze closing it (herdr restarted or crashed, the
    terminal was closed by hand) before it handed in a good report for this round."""
    return o["state"] == "gone" and meta.get("open") is True and meta.get("report_check") != "ok"


def news_key(o: dict):
    """A key for a settled state worth reporting once, or None while the helper still works."""
    if o["state"] in ("finished", "gone"):
        return f"{o['state']}"
    if o["status"] in ("error", "blocked"):
        return f"{o['status']}:{o['turn']}"
    if o["status"] in ("done", "idle") and o["turn"] >= 1:
        return f"settled:{o['turn']}"
    return None


def event(meta: dict, ev: str, **kv):
    """Append one line to the call's events.jsonl; None values are left out. Best effort."""
    rec = {"t": int(time.time()), "ev": ev, "round": meta.get("round", 1)}
    rec.update({k: v for k, v in kv.items() if v is not None})
    try:
        with open(Path(meta["agent_dir"]) / "events.jsonl", "a") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except OSError:
        pass



# ---- run control (pause / resume / stop) ------------------------------------------------------------

RESUME_MSG = "刚才用户暂停了这次运行，你的工作被打断。现在继续完成任务文件 {task} 的要求：已经做完的不要重做，最后按要求写回报。"
STOP_MSG = ("用户终止了这次运行。立刻停下手上的工作，不要再修改文件或运行命令。"
            "把到目前为止已经完成的部分如实写进回报文件 {report}（仍须符合 schema：{schema}）："
            "已完成的照常填写，没做完的在相应字段里写明\"未完成\"和做到哪一步。写完就结束。")
STOP_NOTE = ("用户在 cc-dispatch 面板上终止了运行 {run}。子 agent 已经停下、终端已关闭（worktree 保留），"
             "各调用的状态和回报路径见 {report}。请读它和其中列出的回报，向用户汇总：已完成什么、没完成什么、"
             "你建议的下一步，然后用 AskUserQuestion 请用户决定怎么继续。用户决定前不要派发、重跑、合并或清理。")


def control(run: Path) -> dict:
    try:
        c = json.loads((run / "control.json").read_text())
        return c if isinstance(c, dict) and c.get("state") else {"state": "running"}
    except (OSError, json.JSONDecodeError):
        return {"state": "running"}


def set_control(run: Path, **c):
    c.setdefault("at", int(time.time()))
    if "owner" not in c and control(run).get("owner"):  # the main agent that adopted the run stays its owner
        c["owner"] = control(run)["owner"]
    tmp = run / "control.json.tmp"
    tmp.write_text(json.dumps(c, ensure_ascii=False, indent=1))
    tmp.replace(run / "control.json")


def not_mine(c: dict) -> bool:
    """True when another main agent adopted the run and this one is not it (the panel has no terminal: never)."""
    me = os.environ.get("HC_TERMINAL_ID")
    return bool(c.get("owner") and me and c["owner"] != me)


ADOPTED = ("RUN_ADOPTED: another main agent ({owner}) took this run over; leave it alone: "
           "do not dispatch, send, collect, wait on or clean up anything in it")


def refuse_unless_running(run: Path):
    c = control(run)
    st = c["state"]
    if not_mine(c):
        print(ADOPTED.format(owner=c["owner"]))
        out(run_control="adopted")
        sys.exit(3)
    if st == "handoff":
        print("RUN_HANDOFF: this run is being handed to another main agent; dispatch nothing more "
              "(the next one adopts it; `resume` cancels the handoff)")
        out(run_control=st, handoff=c.get("package"))
        sys.exit(3)
    if st != "running":
        print(f"RUN_{st.upper()}: the person {'paused' if st == 'paused' else 'stopped'} this run in the cc-dispatch panel; "
              "do not dispatch until it is resumed" + (" (or they decide what to do next)" if st != "paused" else ""))
        out(run_control=st)
        sys.exit(3)


def interrupt(meta: dict) -> bool:
    r = hc_json("interrupt", meta.get("address") or meta["name"], "--timeout", "10")
    return bool(r) and "error" not in r

# ---- the helper's Codex session --------------------------------------------------------------------
# Its threads are the ones whose first message names <agent_dir>/task-<k>.md (task-1.md, and the round a handover started) (FIRST_MSG), found in any
# Codex home's state_*.sqlite; its rollout logs give tokens, commands and patched files. The panel's
# stats.js reads the same logs while a helper is live, and the codex event once it settled.

CODEX_KEYS = (b'"token_count"', b'"function_call"', b'"custom_tool_call"', b'"local_shell_call"', b'"turn_context"')


def codex_rollouts(meta: dict) -> list:
    import glob
    import sqlite3
    needle = str(Path(meta["agent_dir"]) / "task-")  # task-1.md, or task-<k>.md after a handover
    homes, seen, found = [], set(), []
    for h in [os.environ.get("CODEX_HOME")] + sorted(glob.glob(os.path.expanduser("~/.codex*"))):
        if h and os.path.isdir(h) and os.path.realpath(h) not in seen:
            seen.add(os.path.realpath(h))
            homes.append(h)
    for h in homes:
        for db in sorted(glob.glob(os.path.join(h, "state_*.sqlite"))):
            try:
                con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
                for (path,) in con.execute("select rollout_path from threads where instr(first_user_message, ?) > 0 "
                                           "order by created_at", (needle,)):
                    if path and path not in found:
                        found.append(path)
                con.close()
            except sqlite3.Error:
                pass
    return found


def _patched(text, files):
    for line in (text or "").splitlines():
        for head in ("*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "):
            if line.startswith(head):
                files.add(line[len(head):].strip())


def _epoch_ms(s):
    try:
        return int(datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000)
    except ValueError:
        return None


def codex_usage(meta: dict):
    """Cumulative totals over the helper's Codex sessions, or None when none is found."""
    paths = [p for p in (meta.get("rollouts") or []) if os.path.exists(p)] or codex_rollouts(meta)
    if not paths:
        return None
    meta["rollouts"] = paths
    tot = {"input": 0, "cached": 0, "cache_write": 0, "output": 0}
    u = {"model": None, "tokens": None, "commands": 0, "files": 0, "first": None, "last": None,
         "sessions": 0, "rollouts": paths}
    files = set()
    for path in paths:
        try:
            f = open(path, "rb")
        except OSError:
            continue
        u["sessions"] += 1
        last_total = None
        with f:
            for line in f:
                if not any(k in line for k in CODEX_KEYS):
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                ts = _epoch_ms(ev.get("timestamp"))
                if ts:
                    u["first"] = min(u["first"] or ts, ts)
                    u["last"] = max(u["last"] or 0, ts)
                pl = ev.get("payload") or {}
                kind, name = pl.get("type"), pl.get("name")
                if ev.get("type") == "turn_context":
                    u["model"] = pl.get("model") or u["model"]
                elif kind == "token_count":
                    last_total = (pl.get("info") or {}).get("total_token_usage") or last_total
                elif kind == "local_shell_call" or (kind == "function_call" and name in ("exec_command", "shell", "container.exec")):
                    u["commands"] += 1
                elif kind == "custom_tool_call" and name == "apply_patch":
                    _patched(pl.get("input"), files)
                elif kind == "function_call" and name == "apply_patch":
                    try:
                        _patched(json.loads(pl.get("arguments") or "{}").get("input"), files)
                    except (ValueError, AttributeError):
                        pass
        if last_total:
            for k, src in (("input", "input_tokens"), ("cached", "cached_input_tokens"),
                           ("cache_write", "cache_write_input_tokens"), ("output", "output_tokens")):
                tot[k] += last_total.get(src) or 0
            u["tokens"] = tot
    u["files"] = len(files)
    return u


CLAUDE_WRITES = ("Edit", "Write", "MultiEdit", "NotebookEdit")


def claude_usage(meta: dict):
    """Totals over the helper's Claude Code sessions (meta claude_sessions), or None. Tokens in Codex's
    terms: input counts cache reads and writes, cached = cache reads. A message is logged once per content
    block with the same usage, so each message id counts once."""
    lib = handoff_lib()
    paths = [p for p in (lib.claude_transcript(s, meta.get("workdir")) for s in meta.get("claude_sessions") or []) if p]
    if not paths:
        return None
    tot = {"input": 0, "cached": 0, "cache_write": 0, "output": 0}
    u = {"model": None, "tokens": tot, "commands": 0, "files": 0, "first": None, "last": None,
         "sessions": len(paths), "transcripts": paths}
    files = set()
    for path in paths:
        usage = {}
        try:
            f = open(path, "rb")
        except OSError:
            continue
        with f:
            for line in f:
                if b'"assistant"' not in line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                m = ev.get("message") or {}
                if ev.get("type") != "assistant" or not isinstance(m, dict):
                    continue
                ts = _epoch_ms(ev.get("timestamp"))
                if ts:
                    u["first"] = min(u["first"] or ts, ts)
                    u["last"] = max(u["last"] or 0, ts)
                u["model"] = m.get("model") or u["model"]
                if m.get("usage"):
                    usage[m.get("id") or len(usage)] = m["usage"]
                for b in m.get("content") or []:
                    if not isinstance(b, dict) or b.get("type") != "tool_use":
                        continue
                    if b.get("name") == "Bash":
                        u["commands"] += 1
                    elif b.get("name") in CLAUDE_WRITES:
                        p = (b.get("input") or {}).get("file_path") or (b.get("input") or {}).get("notebook_path")
                        if p:
                            files.add(p)
        for x in usage.values():
            read, write = x.get("cache_read_input_tokens") or 0, x.get("cache_creation_input_tokens") or 0
            tot["input"] += (x.get("input_tokens") or 0) + read + write
            tot["cached"] += read
            tot["cache_write"] += write
            tot["output"] += x.get("output_tokens") or 0
    u["files"] = len(files)
    return u


def helper_usage(meta: dict):
    """The call's spend over every session it ran, Codex and Claude Code (a handover adds one), or None.
    Logged as the "codex" event (its name from before other agents), which the panel's stats.js reads."""
    parts = [u for u in (codex_usage(meta), claude_usage(meta)) if u]
    if len(parts) < 2:
        return parts[0] if parts else None
    a, b = parts
    u = {"commands": a["commands"] + b["commands"],
         "files": a["files"] + b["files"], "sessions": a["sessions"] + b["sessions"],
         "first": min(x for x in (a["first"], b["first"]) if x) if (a["first"] or b["first"]) else None,
         "last": max(a["last"] or 0, b["last"] or 0) or None,
         "rollouts": a.get("rollouts"), "transcripts": b.get("transcripts")}
    if a["tokens"] or b["tokens"]:
        z = {"input": 0, "cached": 0, "cache_write": 0, "output": 0}
        u["tokens"] = {k: (a["tokens"] or z)[k] + (b["tokens"] or z)[k] for k in z}
    else:
        u["tokens"] = None
    if (meta.get("agent") or "codex") == "claude":  # the model it runs as now
        u["model"] = b["model"] or a["model"]
    else:
        u["model"] = a["model"] or b["model"]
    return u


def run_kind(run: Path) -> str:
    kind = run.name.split("-", 1)[0]
    return kind if kind in ("research", "review", "fix", "test", "probe", "retro") else "dev"


def relabel(meta: dict, **labels):
    """Set cc.<key>=<value> labels on a helper's terminal; an empty value removes one. Best effort:
    a helper that is gone has no labels to keep, and the UI then reads meta.json."""
    target = meta.get("address") or meta["name"]
    hc("label", target, *(f"cc.{k}={'' if v is None else v}" for k, v in labels.items()))


def slug(text: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9_-]", "-", text.lower())).strip("-")


def display_name(run: Path, call: str, title) -> str:
    """The name herdr's agent list shows: <skill>-<call>[-<title>], unique among live terminals."""
    kind = run_kind(run)
    parts = (kind,) if slug(call) == kind else (kind, call)
    base = slug("-".join(x for x in (*parts, title or "") if x))
    if len(base) > 32:  # drop whole words from the end, keeping at least <skill>-<call>
        head = slug("-".join(parts))[:32]
        base = base[:33].rsplit("-", 1)[0] if "-" in base[len(head):33] else head
    live = {t.get("name") for t in (hc_json("ls") or {}).get("terminals", [])}
    name, n = base, 2
    while name in live:
        suffix = f"-{n}"
        name, n = base[:32 - len(suffix)].rstrip("-") + suffix, n + 1
    return name


# ---- dispatch --------------------------------------------------------------------------------------

def compose(meta: dict, prompt: str, round_no: int) -> Path:
    head = [f"# 任务 {meta['call']}（第 {round_no} 轮）" if round_no > 1 else f"# 任务 {meta['call']}"]
    if meta["mode"] == "read":
        head.append(f"工作目录：{meta['dir']}（只读：先 cd 到这里再读代码、跑只读命令；这里的文件不要修改）")
    else:
        head.append(f"工作目录：{meta['dir']}（你的改动只落在这里）")
    head.append(f"回报文件：{meta['report']}（覆盖写入；JSON 必须符合 schema：{meta['schema']}）")
    task = Path(meta["agent_dir"]) / f"task-{round_no}.md"
    task.write_text("\n".join(head) + "\n\n" + prompt.rstrip() + "\n")
    return task


def deliver(name: str, msg: str) -> bool:
    """Get a helper that has not taken its first message ready, then send it. Trust dialogs are confirmed."""
    for _ in range(3):
        screen = hc("read", name, "--lines", "0").stdout
        if "Trust this folder" in screen or "Do you trust" in screen:
            hc("keys", name, "enter")
            time.sleep(2)
        hc("wait", name, "--timeout", "60")
        r = hc_json("send", name, msg)
        if r and r.get("started"):
            return True
        time.sleep(3)
    return False


def dispatcher():
    """The Claude that dispatches: its terminal, its herdr space, and its Claude Code session (whose
    transcript lists its background tasks), for the cc-dispatch panel."""
    me = os.environ.get("HC_TERMINAL_ID")
    g = hc_json("get", me) if me else None
    g = g if isinstance(g, dict) else {}
    return {
        "parent": me,
        "space": (g.get("labels") or {}).get("herdr.space"),
        "session": os.environ.get("CLAUDE_CODE_SESSION_ID"),
        "claude_cwd": (g.get("foreground") or {}).get("cwd") or os.getcwd(),
        "dispatcher_agent": program_of(g),
    }


def program_of(g: dict):
    """The agent a terminal runs, from `hc get`: its foreground program's name (claude, codex, …), or None."""
    argv = (g.get("foreground") or {}).get("argv") or g.get("argv") or []
    name = Path(str(argv[0])).name if argv else ""
    return None if not name or name in ("zsh", "bash", "sh", "fish", "login") else name


# The agents a helper can run as. Fixed on purpose: each needs its own way to start, isolate and resume.
#   isolation sandbox: Codex's workspace-write sandbox keeps it in its folder (read mode: off the repo).
#   isolation weak:    nothing but the task file's rules keeps it there; the panel marks it.
AGENTS = {
    "codex": {"label": "Codex", "isolation": "sandbox"},
    "claude": {"label": "Claude Code", "isolation": "weak"},
}
TEMPLATES = Path(__file__).resolve().parent.parent / "templates"


def role_text(mode: str, effort: str) -> str:
    """The helper's standing rules: the body of its cc-hd template (shared/templates)."""
    f = TEMPLATES / f"cc-hd-{mode}-{effort}.md"
    try:
        return f.read_text().split("\n---\n", 1)[1].strip()
    except (OSError, IndexError):
        return ""


def claude_argv(meta: dict, session: str, msg: str) -> list:
    argv = ["claude", "--session-id", session, "--effort", meta["effort"], "--dangerously-skip-permissions"]
    if meta["mode"] == "read":  # the folder it may read; its own tools for writing are off
        argv += ["--add-dir", meta["dir"], "--disallowedTools", "Edit", "Write", "MultiEdit", "NotebookEdit"]
    rules = role_text(meta["mode"], meta["effort"])
    if rules:
        argv += ["--append-system-prompt", rules]
    return argv + ["--", msg]


def codex_thread(meta: dict):
    """The helper's newest Codex thread: (id, its Codex home), or (None, None)."""
    import glob
    import sqlite3
    needle = str(Path(meta["agent_dir"]) / "task-")
    best, seen = None, set()
    for h in [os.environ.get("CODEX_HOME")] + sorted(glob.glob(os.path.expanduser("~/.codex*"))):
        if not h or not os.path.isdir(h) or os.path.realpath(h) in seen:
            continue
        seen.add(os.path.realpath(h))
        for db in sorted(glob.glob(os.path.join(h, "state_*.sqlite"))):
            try:
                con = sqlite3.connect(f"file:{db}?mode=ro", uri=True, timeout=1)
                for tid, path, at in con.execute("select id, rollout_path, created_at from threads "
                                                 "where instr(first_user_message, ?) > 0", (needle,)):
                    if path and os.path.exists(path) and (best is None or at > best[2]):
                        best = (tid, h, at)
                con.close()
            except sqlite3.Error:
                pass
    return (best[0], best[1]) if best else (None, None)


def template_argv(mode: str, effort: str) -> list:
    """The command line of the helper's cc-hd template (shared/templates), split."""
    import shlex
    for line in (TEMPLATES / f"cc-hd-{mode}-{effort}.md").read_text().splitlines():
        if line.startswith("command:"):
            return shlex.split(line[len("command:"):].strip())
    return ["codex"]


def resume_argv(meta: dict):
    """How to reopen the helper's own session, idle: (argv, session) or (None, None) when it has none."""
    if (meta.get("agent") or "codex") == "claude":
        session = meta.get("agent_session")
        if not session:
            return None, None
        argv = claude_argv(meta, session, "")[:-2]  # without "--" and the message
        i = argv.index("--session-id")
        argv[i] = "--resume"
        return argv, session
    tid, home = codex_thread(meta)
    if not tid:
        return None, None
    words = template_argv(meta["mode"], meta["effort"])
    return ["env", f"CODEX_HOME={home}", words[0], "resume", *words[1:], tid], tid


def head_for(run: Path, meta: dict, agent: str) -> list:
    labels = [f"cc.run={run_tag(run)}", f"cc.call={meta['call']}", f"cc.kind={run_kind(run)}", f"cc.dir={run}",
              f"cc.mode={meta['mode']}", f"cc.round={meta['round']}", f"cc.agent={agent}"]
    head = ["run", "--bg", "--json", "--name", meta["name"], "--cwd", meta["workdir"]]
    for l in labels:
        head += ["--label", l]
    return head


def launch(run: Path, meta: dict, agent: str, task: Path) -> bool:
    """Start the helper's terminal as `agent` with its first message naming `task`; records name, address
    and (Claude) its session in meta and saves it. True once the first message is in."""
    return start(run, meta, agent, FIRST_MSG.format(task=task))


def start(run: Path, meta: dict, agent: str, msg: str) -> bool:
    """launch() with any first message: a new session of `agent` for the call."""
    head = head_for(run, meta, agent)
    if agent == "claude":
        import uuid
        meta["agent_session"] = str(uuid.uuid4())
        meta.setdefault("claude_sessions", []).append(meta["agent_session"])  # every one, for its spend
        r = hc(*head, "--", *claude_argv(meta, meta["agent_session"], msg))
    else:
        meta["agent_session"] = None
        r = hc(*head, f"cc-hd-{meta['mode']}-{meta['effort']}", msg)
    try:
        launched = json.loads(r.stdout)
    except json.JSONDecodeError:
        fail(f"LAUNCH_FAILED: {(r.stderr or r.stdout).strip()[:400]}")
    meta["address"] = launched.get("address")
    meta["agent"], meta["open"] = agent, True
    meta.pop("lost", None)  # a new terminal for it: no longer lost
    save(run, meta)
    if agent == "claude":  # the message is its command-line prompt
        return True
    return bool((launched.get("first_message") or {}).get("sent")) or deliver(meta["name"], msg)


def cmd_run(a):
    need_env()
    run = Path(a.run).resolve()
    refuse_unless_running(run)
    tag = run_tag(run)
    agent_dir = run / "agents" / a.call
    if meta_path(run, a.call).exists():
        old = json.loads(meta_path(run, a.call).read_text())
        if observe(old)["state"] == "live":
            fail(f"ALREADY_RUNNING: {a.call} is live as {old['name']}; use send, or cleanup first")
    agent_dir.mkdir(parents=True, exist_ok=True)
    report_dir = HOME / tag / a.call
    report_dir.mkdir(parents=True, exist_ok=True)
    name = display_name(run, a.call, a.title)
    meta = {
        "call": a.call, "name": name, "mode": a.mode, "effort": a.effort,
        "dir": str(Path(a.dir).resolve()), "workdir": str(report_dir if a.mode == "read" else Path(a.dir).resolve()),
        "report": str(report_dir / "report.json"), "schema": str(Path(a.schema).resolve()),
        "agent_dir": str(agent_dir), "round": 1, "acked": None, "started_at": int(time.time()),
        "hd": str(Path(__file__).resolve()),  # the panel runs pause/resume/stop with it
        "agent": "codex", "open": True,  # open: its terminal should be there (closed by cleanup/stop/freeze)
    }
    if a.mode != "read":  # where its work started, for a handoff's "since" diff
        meta["base"] = (subprocess.run(["git", "-C", meta["dir"], "rev-parse", "HEAD"], capture_output=True,
                                       text=True).stdout.strip() or None)
    meta["title"] = a.title
    meta.update(dispatcher())
    Path(meta["report"]).unlink(missing_ok=True)
    task = compose(meta, Path(a.prompt).read_text(), 1)
    sent = launch(run, meta, "codex", task)
    event(meta, "dispatch", mode=a.mode, effort=a.effort, dir=meta["dir"], name=name, title=a.title,
          task=str(task), sent=bool(sent))
    out(call=a.call, name=name, address=meta["address"], report=meta["report"],
        first_message="sent" if sent else "failed")
    if not sent:
        print("----- screen -----")
        print(tail(hc("read", name, "--lines", "0").stdout, 20))
    out(failure="none" if sent else "other")


def cmd_send(a):
    run = Path(a.run).resolve()
    refuse_unless_running(run)
    meta = load(run, a.call)
    o = observe(meta)
    if o["state"] != "live":
        fail(f"NOT_LIVE: {a.call} is {o['state']}; start a new call with run")
    if o["status"] == "blocked":
        fail(f"BLOCKED: {a.call} is waiting on a person; diagnose it first")
    backup_report(meta)
    meta["round"] += 1
    rep = Path(meta["report"])
    if rep.exists():
        rep.rename(rep.with_name(f"report.r{meta['round'] - 1}.json"))
    task = compose(meta, Path(a.prompt).read_text(), meta["round"])
    r = hc_json("send", meta["name"], SEND_MSG.format(task=task))
    meta["report_check"] = meta["failure"] = meta["retry"] = None
    save(run, meta)
    relabel(meta, round=meta["round"], report=None, failure=None, retry=None)
    ok = bool(r and r.get("started"))
    event(meta, "send", why="rework", task=str(task), sent=ok)
    out(call=a.call, round=meta["round"], sent="yes" if ok else "no")
    if not ok:
        print(json.dumps(r, ensure_ascii=False) if r else "no reply from hc send")


# ---- results ---------------------------------------------------------------------------------------

def tail(text: str, n: int) -> str:
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    return "\n".join(lines[-n:])


def classify(screen: str) -> str:
    low = screen.lower()
    for name, pat in PATTERNS:
        if re.search(pat, low):
            return name
    return "other"


def report_line(meta: dict) -> str:
    r = subprocess.run([sys.executable, "-I", str(CHECK), meta["schema"], meta["report"]],
                       capture_output=True, text=True)
    return r.stdout.strip()


def backup_report(meta: dict, round_no=None):
    """Copy the round's report into the run folder (agents/<call>/report-r<k>.json): /tmp does not
    survive a reboot, the run folder does. Returns the copy's path, or None when there is no report."""
    k = round_no or meta["round"]
    src = Path(meta["report"])
    if not src.is_file():
        return None
    dst = Path(meta["agent_dir"]) / f"report-r{k}.json"
    try:
        dst.write_bytes(src.read_bytes())
    except OSError:
        return None
    return dst


def grandchildren(meta: dict) -> list:
    """Terminals a helper started itself: helpers are not to start agents."""
    if not meta.get("address"):
        return []
    ls = hc_json("ls") or {}
    found = []
    for t in ls.get("terminals", []):
        g = hc_json("get", t["address"]) or {}
        if g.get("parent") == meta["address"]:
            found.append(f"{t['address']}({' '.join(g.get('argv', [])[:2])})")
    return found


def collect_one(run: Path, meta: dict, o: dict):
    key = news_key(o)
    print(f"== CALL={meta['call']} NAME={meta['name']} STATE={o['state']} STATUS={o['status']} "
          f"TURN={o['turn']} ROUND={meta['round']}")
    print(f"REPORT={meta['report']}")
    line = report_line(meta)
    print(line)
    first = line.splitlines()[0] if line else ""
    meta["report_check"] = {"REPORT_OK": "ok", "REPORT_BAD": "bad"}.get(first, "missing")
    backup_report(meta)
    meta["failure"] = None
    if o["status"] in ("error", "blocked") or o["state"] in ("finished", "gone"):
        screen = hc("read", meta["name"], "--lines", "60").stdout if o["state"] != "gone" else ""
        meta["failure"] = classify(screen) if o["status"] == "error" else ("blocked" if o["status"] == "blocked" else "exited")
        if is_lost(meta, o):
            meta["failure"] = "lost"
            meta["lost"] = {"round": meta["round"], "at": int(time.time())}
            event(meta, "lost")
        out(failure=meta["failure"])
        if screen:
            print("----- screen tail -----")
            print(tail(screen, 15))
    r = meta.get("retry") or {}
    retried = r.get("n") if r.get("round") == meta["round"] and r.get("n") else None
    if retried:
        out(retried=f"{r['n']}({r.get('kind')})")
    if r:
        r["key"] = None
    extra = grandchildren(meta)
    if extra:
        out(nested=",".join(extra))
    meta["acked"] = key
    event(meta, "settle", state=o["state"], status=o["status"], turn=o["turn"], report=meta["report_check"],
          failure=meta["failure"], retried=retried, nested=extra or None)
    usage = helper_usage(meta)
    if usage:
        event(meta, "codex", **usage)
    save(run, meta)
    if o["state"] != "gone":
        relabel(meta, report=meta["report_check"], failure=meta["failure"], retry=None)
    if meta["failure"] == "context_limit" and meta.get("open", True):
        # Its session cannot go on: keep what it did now, while the terminal and logs are there.
        out(handoff=freeze(run, meta, 0, "context_limit"))


def retry_kind(meta: dict, o: dict):
    """capacity or rate_limit when a live helper stopped on one: an error, or a settled turn with no good report
    and the error on the last lines of its screen. None otherwise."""
    if o["state"] != "live":
        return None
    if o["status"] != "error":
        if o["status"] not in ("done", "idle") or report_line(meta).startswith("REPORT_OK"):
            return None
    kind = classify(tail(hc("read", meta["name"], "--lines", "40").stdout, 20))
    if kind not in ("auth", "quota", "refused", "context_limit") and not online():
        return "network"  # nothing can get through; it waits for the network without using up a retry
    return kind if kind in RETRYABLE else None


def retry_step(run: Path, meta: dict, o: dict, key: str) -> bool:
    """Handle a settled state `key` the dispatching Claude has not seen. True while it is being retried
    (scheduled, or just told to carry on), so it is not reported; False to report it."""
    delays = retry_delays()
    r = meta.get("retry") or {}
    if r.get("round") != meta["round"]:
        r = {"round": meta["round"], "n": 0}
    now = int(time.time())
    if r.get("key") == key:  # scheduled for this very state
        if now < r["at"]:
            return True
        if r["kind"] == "network" and not online():
            r["at"] = now + NET_RECHECK
            meta["retry"] = r
            save(run, meta)
            return True
        task = Path(meta["agent_dir"]) / f"task-{meta['round']}.md"
        res = hc_json("send", meta["name"], RETRY_MSG.format(why=RETRY_WHY[r["kind"]], task=task))
        event(meta, "send", why="retry", kind=r["kind"], n=r["n"], task=str(task), sent=bool(res and res.get("started")))
        if res and res.get("started"):
            r["key"], r["sent_at"] = None, now
        elif r.get("send_fails", 0) < 2:
            r["send_fails"], r["at"] = r.get("send_fails", 0) + 1, now + 15
        else:
            return False
        meta["retry"] = r
        save(run, meta)
        return True
    kind = retry_kind(meta, o)
    if kind == "network":
        r.update(kind=kind, key=key, at=now + NET_RECHECK, send_fails=0)
        meta["retry"] = r
        event(meta, "offline", n=r["n"])
        save(run, meta)
        relabel(meta, retry=None, net="down", failure=None)
        return True
    if not kind or r["n"] >= len(delays):
        return False
    r.update(n=r["n"] + 1, kind=kind, key=key, at=now + delays[r["n"]], send_fails=0)
    meta["retry"] = r
    event(meta, "retry", kind=kind, n=r["n"], max=len(delays), at=r["at"])
    save(run, meta)
    relabel(meta, retry=f"{kind} {r['n']}/{len(delays)}", failure=None)
    return True


def retrying_line(retrying: list) -> str:
    n = len(retry_delays())
    return ",".join(f"{m['call']}(network)" if m["retry"]["kind"] == "network" and m["retry"].get("key")
                    else f"{m['call']}({m['retry']['kind']} {m['retry']['n']}/{n})" for m in retrying) or "none"


NET_DOWN = [False]  # what the last pending() found


def net_kv() -> dict:
    return {"net": "down"} if NET_DOWN[0] else {}


def mark_net(run: Path, working: list) -> bool:
    """Label the live helpers cc.net=down while the network is down (removed once it is back); True when down.
    Only checks the network when some helper is at work."""
    if not working:
        return False
    down = not online()
    for meta, o in working:
        if o["state"] == "live" and bool(meta.get("net_down")) != down:
            meta["net_down"] = int(time.time()) if down else None
            save(run, meta)
            relabel(meta, net="down" if down else None)
    return down


def pending(run: Path):
    """(news, working, retrying): calls with unreported settled states, calls still at work (retried ones
    included), and the retried ones' meta. Nothing while the run is paused or stopped."""
    news, working, retrying = [], [], []
    if control(run)["state"] != "running":
        return news, working, retrying
    for c in calls(run):
        meta = load(run, c)
        o = observe(meta)
        key = news_key(o)
        if key and key != meta.get("acked"):
            if retry_step(run, meta, o, key):
                working.append((meta, o))
                retrying.append(meta)
            else:
                news.append((meta, o))
        elif key is None:
            working.append((meta, o))
            if (meta.get("retry") or {}).get("round") == meta["round"] and meta["retry"].get("n"):
                retrying.append(meta)
    NET_DOWN[0] = mark_net(run, working)
    return news, working, retrying


def held_line(run: Path):
    """Print RUN_CONTROL (and STOP_REPORT) and return True when the run is not running."""
    c = control(run)
    if not_mine(c):
        print(ADOPTED.format(owner=c["owner"]))
        out(run_control="adopted")
        return True
    if c["state"] == "running":
        return False
    out(run_control=c["state"])
    if c["state"] == "stopped" and c.get("report"):
        out(stop_report=c["report"])
    if c["state"] == "handoff":
        out(handoff=c.get("package"), prompt=c.get("prompt"))
    return True


def cmd_collect(a):
    run = Path(a.run).resolve()
    if held_line(run):
        return
    if a.call:
        meta = load(run, a.call)
        collect_one(run, meta, observe(meta))
    news, working, retrying = pending(run)
    for meta, o in news:
        collect_one(run, meta, o)
    out(working=",".join(m["call"] for m, _ in working) or "none", retrying=retrying_line(retrying), **net_kv())


def cmd_wait(a):
    run = Path(a.run).resolve()
    deadline = time.time() + a.timeout
    while True:
        c = control(run)
        state = "adopted" if not_mine(c) else c["state"]
        if state in ("stopped", "handoff", "adopted") or (state != "running" and time.time() >= deadline):
            if state not in ("stopped", "handoff", "adopted"):
                out(wait="timeout")
            held_line(run)
            return
        if state != "running":  # paused or stopping: report nothing, retry nothing, keep waiting
            time.sleep(max(1, min(10, deadline - time.time())))
            continue
        news, working, retrying = pending(run)
        if news:
            for meta, o in news:
                collect_one(run, meta, o)
            out(working=",".join(m["call"] for m, _ in working) or "none", retrying=retrying_line(retrying), **net_kv())
            return
        now = time.time()
        for meta, o in working:
            seen = meta.get("working_since")
            if not seen or seen[0] != o["turn"]:
                meta["working_since"] = [o["turn"], int(now)]
                save(run, meta)
            elif now - seen[1] > a.stall and meta.get("stall_reported") != o["turn"]:
                meta["stall_reported"] = o["turn"]
                event(meta, "stall", minutes=int((now - seen[1]) / 60), turn=o["turn"])
                save(run, meta)
                print(f"STALL CALL={meta['call']} NAME={meta['name']} working {int((now - seen[1]) / 60)} min "
                      f"in turn {o['turn']}")
                print(tail(hc("read", meta["name"], "--lines", "0").stdout, 8))
                out(working=",".join(m["call"] for m, _ in working), retrying=retrying_line(retrying), **net_kv())
                return
        if not working:
            out(wait="nothing_running")
            return
        if now >= deadline:
            out(wait="timeout", working=",".join(m["call"] for m, _ in working), retrying=retrying_line(retrying), **net_kv())
            return
        due = [m["retry"]["at"] - now for m in retrying if m["retry"].get("key")]
        hc("wait", "--children", "any", "--timeout", str(int(max(5, min(60, deadline - now, *due)))))
        time.sleep(1)


def cmd_status(a):
    run = Path(a.run).resolve()
    for c in calls(run):
        meta = load(run, c)
        o = observe(meta)
        state = "lost" if meta.get("lost") or is_lost(meta, o) else o["state"]
        print(f"{c}\t{meta['name']}\t{state}\t{o['status']}\tturn={o['turn']}\tround={meta['round']}\t"
              f"{report_line(meta).splitlines()[0]}")


def cmd_diagnose(a):
    meta = load(Path(a.run).resolve(), a.call)
    screen = hc("read", meta["name"], "--lines", "80").stdout
    out(call=a.call, failure=classify(screen))
    print("----- screen tail -----")
    print(tail(screen, 25))


def cmd_cleanup(a):
    run = Path(a.run).resolve()
    for c in ([a.call] if a.call else calls(run)):
        meta = load(run, c)
        backup_report(meta)
        hc("kill", meta.get("address") or meta["name"])
        hc("rm", meta.get("address") or meta["name"])
        meta["open"] = False
        meta.pop("lost", None)  # dealt with
        save(run, meta)
        event(meta, "cleanup")
        out(removed=c)


# ---- freeze: stop a helper and keep everything another agent needs to carry on -------------------------

FREEZE_MSG = ("负责人要把你手上的工作移交给另一个 agent。立刻停下手上的工作，不要再修改工作区的文件或运行命令。"
              "把交接说明写进 {progress}（Markdown，只写这一个文件）：已完成什么（文件、要点）；正在做什么、做到哪一步；"
              "还剩什么；试过但走不通的路；验收命令最近一次的结果；接手的人要注意的坑。写完就结束这一轮。")
NO_ASK = ("context_limit", "quota", "auth", "refused")  # it cannot answer: freeze without asking


def usage_lib():
    """hd_usage.py beside this script, loaded by path like hd_handoff.py."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("hd_usage", Path(__file__).with_name("hd_usage.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def usage_check(run: Path):
    """After wait / collect: when the account this main agent runs on is past the handoff threshold in a
    window that has not prompted it yet, print hd_usage's note (CC_HANDOFF=usage ...): ask the user first."""
    me = os.environ.get("HC_TERMINAL_ID")
    c = control(run)
    if not me or not_mine(c) or c["state"] not in ("running", "paused"):
        return
    try:
        u = usage_lib()
        g = hc_json("get", me)
        agent = u.agent_of(program_of(g if isinstance(g, dict) else {}))
        over = u.check(agent, me, slow=True)
    except Exception:  # the quota is a convenience: never let it break wait or collect
        return
    if over:
        print(u.note(agent, over, [run]))


def handoff_lib():
    """hd_handoff.py beside this script (loaded by path: python3 -I leaves this folder off sys.path)."""
    import importlib.util
    spec = importlib.util.spec_from_file_location("hd_handoff", Path(__file__).with_name("hd_handoff.py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def helper_digest(meta: dict) -> dict:
    lib = handoff_lib()
    if (meta.get("agent") or "codex") == "claude":
        return lib.claude_digest(lib.claude_transcript(meta.get("agent_session"), meta.get("workdir")))
    paths = [p for p in (meta.get("rollouts") or []) if os.path.exists(p)] or codex_rollouts(meta)
    meta["rollouts"] = paths
    return lib.codex_digest(paths)


def freeze(run: Path, meta: dict, ask: int, why: str) -> Path:
    """Stop the helper and keep its state: a progress note it writes (asked, up to `ask` s), its screen,
    a snapshot of its worktree, its session logs and report; close its terminal; write its handoff
    package. Returns the package folder. Idempotent per round."""
    k = meta["round"]
    fz = meta.get("frozen") or {}
    pkg = Path(meta["agent_dir"]) / "handoff" / f"r{k}"
    if fz.get("round") == k and (pkg / "handoff.json").exists():
        return pkg
    lib = handoff_lib()
    o = observe(meta)
    progress = Path(meta["report"]).parent / f"progress-r{k}.md"
    progress.parent.mkdir(parents=True, exist_ok=True)
    progress.unlink(missing_ok=True)
    screen, asked = "", False
    if o["state"] == "live":
        target = meta.get("address") or meta["name"]
        kind = classify(hc("read", target, "--lines", "60").stdout) if o["status"] == "error" else None
        if o["status"] == "working":
            interrupt(meta)
            time.sleep(1)
            o = observe(meta)
        if ask > 0 and o["status"] != "blocked" and kind not in NO_ASK and meta.get("failure") not in NO_ASK:
            res = hc_json("send", target, FREEZE_MSG.format(progress=progress))
            asked = bool(res and res.get("started"))
            turn, deadline = o["turn"], time.time() + ask
            while asked and time.time() < deadline:
                hc("wait", target, "--timeout", str(int(min(15, max(1, deadline - time.time())))))
                o = observe(meta)
                if o["state"] != "live" or (o["status"] != "working" and o["turn"] > turn):
                    break
                time.sleep(2)
            if observe(meta).get("status") == "working":
                interrupt(meta)
        screen = hc("read", target, "--lines", "200").stdout
        (Path(meta["agent_dir"]) / f"screen-r{k}.txt").write_text(screen)
    note = progress.read_text() if progress.exists() else None
    ref = commit = None
    if meta["mode"] != "read":
        ref = f"refs/cc-dispatch/{run.name}/{meta['call']}/r{k}"
        commit = lib.snapshot(meta["dir"], ref, f"cc-dispatch freeze {run.name} {meta['call']} r{k}: {why}")
    digest = helper_digest(meta)
    backup_report(meta)
    meta["frozen"] = {"round": k, "why": why, "at": int(time.time()), "asked": asked, "progress": bool(note),
                      "snapshot": commit, "snapshot_ref": ref if commit else None,
                      "screen": bool(screen), "package": str(pkg)}
    if o["state"] != "gone":
        hc("kill", meta.get("address") or meta["name"])
        hc("rm", meta.get("address") or meta["name"])
    meta["open"] = False
    meta["acked"] = "gone"  # the closed terminal is not news for wait
    save(run, meta)
    lib.helper_package(meta, run, why, digest, screen=screen, progress=note)
    event(meta, "freeze", why=why, asked=asked, progress=bool(note), snapshot=commit, package=str(pkg))
    return pkg


def cmd_freeze(a):
    run = Path(a.run).resolve()
    meta = load(run, a.call)
    pkg = freeze(run, meta, a.ask, a.why)
    fz = load(run, a.call)["frozen"]
    out(frozen=a.call, round=fz["round"], progress="yes" if fz["progress"] else "no",
        snapshot=fz.get("snapshot_ref") or "none", handoff=pkg)


HANDOVER_NOTE = ("用户在 cc-dispatch 面板上把调用 {call} 从 {old} 移交给了 {new}（第 {round} 轮，终端 {name}），"
                 "交接包 {pkg}。新的子 agent 接着原任务做，回报路径不变；照常 wait 收它的回报。")


def cmd_handover(a):
    """Freeze a helper (unless it is already) and start `--to` on the same task, worktree and report,
    as the call's next round, its first message the package's prompt."""
    run = Path(a.run).resolve()
    refuse_unless_running(run)
    if a.to not in AGENTS:
        fail(f"UNKNOWN_AGENT: {a.to} (one of {', '.join(AGENTS)})")
    meta = load(run, a.call)
    old = meta.get("agent") or "codex"
    if observe(meta)["state"] == "live":  # the panel shows it as being handed over while freeze runs
        relabel(meta, handover=a.to)
    pkg = freeze(run, meta, a.ask, a.why)
    meta = load(run, a.call)
    try:
        data = handoff_lib().read(pkg)
    except ValueError as e:
        fail(f"BAD_HANDOFF: {e}")
    k = meta["round"]
    meta["round"] = k + 1
    rep = Path(meta["report"])
    if rep.exists():
        rep.rename(rep.with_name(f"report.r{k}.json"))
    if a.effort:
        meta["effort"] = a.effort
    prompt = (Path(pkg) / "prompt.md").read_text()
    if a.note:
        prompt += f"\n负责人补充：{a.note}\n"
    task = compose(meta, prompt, meta["round"])
    if observe(meta)["state"] != "gone":  # its name is still taken
        meta["name"] = display_name(run, meta["call"], meta.get("title"))
    meta.update(report_check=None, failure=None, retry=None, acked=None, working_since=None, rollouts=[])
    meta.setdefault("handovers", []).append({"round": meta["round"], "from": old, "to": a.to, "why": a.why,
                                             "at": int(time.time()), "package": str(pkg)})
    sent = launch(run, meta, a.to, task)
    event(meta, "handover", frm=old, to=a.to, why=a.why, package=str(pkg), name=meta["name"],
          task=str(task), sent=sent, isolation=AGENTS[a.to]["isolation"])
    notified = "no"
    if a.notify and meta.get("parent"):
        g = hc_json("get", meta["parent"])
        if g and "error" not in g and g.get("state") == "live":
            ok = hc("send", meta["parent"], HANDOVER_NOTE.format(
                call=a.call, old=AGENTS.get(old, {}).get("label", old), new=AGENTS[a.to]["label"],
                round=meta["round"], name=meta["name"], pkg=pkg)).returncode == 0
            notified = "yes" if ok else "no"
    out(call=a.call, round=meta["round"], agent=a.to, isolation=AGENTS[a.to]["isolation"], name=meta["name"],
        address=meta["address"], handoff=pkg, first_message="sent" if sent else "failed", notified=notified,
        failure="none" if sent else "other")


# ---- handoff: the dispatcher (main agent) hands the run to another one --------------------------------

def call_rows(run: Path) -> list:
    """Every call as the next dispatcher needs to see it."""
    rows = []
    for c in calls(run):
        meta = load(run, c)
        o = observe(meta)
        fz = meta.get("frozen") or {}
        rows.append({
            "call": c, "name": meta.get("name"), "address": meta.get("address"),
            "agent": meta.get("agent") or "codex", "round": meta.get("round", 1), "mode": meta.get("mode"),
            "state": o["state"], "status": o["status"], "report": meta.get("report_check"),
            "failure": meta.get("failure"), "report_path": meta.get("report"),
            "task": str(Path(meta["agent_dir"]) / f"task-{meta.get('round', 1)}.md"),
            "frozen": fz.get("package") if fz.get("round") == meta.get("round") else None,
            "parent": meta.get("parent"),
        })
    return rows


def cmd_handoff(a):
    """Stop this dispatcher's new work on the run and leave a package for the next main agent."""
    run = Path(a.run).resolve()
    if not run.is_dir():
        fail(f"NO_RUN: {run}")
    c = control(run)
    if c["state"] == "stopping":
        print("RUN_STOPPING: the run is being stopped; hand it off once that is done")
        out(run_control="stopping")
        sys.exit(3)
    notes = run / "handoff-notes.md"
    if not notes.exists() and not a.no_notes:
        fail(f"NOTES_MISSING: write {notes} first (what the user asked for, what is done and decided, "
             "what is under way, what comes next, what to watch out for)", code=2)
    prev = c.get("prev") if c["state"] == "handoff" else c
    me = dispatcher()
    seq = 1 + max([int(p.name) for p in (run / "handoff").glob("*") if p.name.isdigit()] or [0])
    pkg = run / "handoff" / str(seq)
    # First, so a wait still running for the old dispatcher ends and run/send refuse from here on.
    set_control(run, state="handoff", prev=prev, seq=seq, why=a.why, by=me["parent"],
                package=str(pkg), prompt=str(pkg / "prompt.md"))
    try:
        children = json.loads((run / "state.json").read_text()).get("children") or []
    except (OSError, ValueError, AttributeError):
        children = []
    frm = {"terminal": me["parent"], "agent": me["dispatcher_agent"], "session": me["session"], "space": me["space"]}
    handoff_lib().dispatcher_package(run, pkg, a.why, frm, call_rows(run),
                                     notes.read_text() if notes.exists() else None,
                                     str(Path(__file__).resolve()), prev, children)
    out(handoff=pkg, prompt=pkg / "prompt.md", notes="yes" if notes.exists() else "no", seq=seq)
    print("----- prompt for the next main agent -----")
    print((pkg / "prompt.md").read_text().rstrip())
    print("----- end -----")


RECOVER_FRESH_MSG = ("你接手的是一个被意外中断的子 agent 任务（上一个会话的终端消失了，找不到可以接回的会话）。"
                     "先读任务文件 {task}，再看工作目录的现状：上一个会话做到一半的改动可能还在。"
                     "然后回一句你看到的进度就停下，等负责人的下一条消息再开始，现在不要改动文件。")


def cmd_recover(a):
    """Reopen the helpers whose terminals vanished, in their own sessions when those can be found (else a new
    one on the same task and folder), all idle, with the run paused and them held; if the main agent's terminal
    is gone too, leave a package for whoever takes over (the main agent's own session reopened, or another)."""
    run = Path(a.run).resolve()
    if not run.is_dir():
        fail(f"NO_RUN: {run}")
    c = control(run)
    if c["state"] in ("stopping", "stopped", "handoff"):
        out(run_control=c["state"])
        print(f"RUN_{c['state'].upper()}: recover only a running or paused run")
        sys.exit(3)
    ensure_home()
    targets = [a.call] if a.call else calls(run)
    held = list(c.get("held") or []) if c["state"] == "paused" else []
    if c["state"] != "paused":
        set_control(run, state="paused", held=held)  # first, so no wait or retry acts on half-recovered calls
    back, fresh, failed, parent = [], [], [], None
    for call in targets:
        meta = load(run, call)
        parent = parent or meta.get("parent")
        o = observe(meta)
        if not (meta.get("lost") or is_lost(meta, o)):
            continue
        for d in (meta["workdir"], Path(meta["report"]).parent):  # /tmp does not survive a reboot
            Path(d).mkdir(parents=True, exist_ok=True)
        agent = meta.get("agent") or "codex"
        argv, session = (None, None) if a.fresh else resume_argv(meta)
        how = "resume"
        if argv:
            r = hc(*head_for(run, meta, agent), "--", *argv)
            try:
                meta["address"] = json.loads(r.stdout).get("address")
                ok = True
            except json.JSONDecodeError:
                ok = False
                print(f"RESUME_FAILED {call}: {(r.stderr or r.stdout).strip()[:300]}")
        else:
            ok = False
        if not ok:  # a new session on the same task, folder and report
            how = "fresh"
            task = Path(meta["agent_dir"]) / f"task-{meta['round']}.md"
            ok = start(run, meta, agent, RECOVER_FRESH_MSG.format(task=task))
            session = meta.get("agent_session")
        if ok:
            meta["open"] = True
            meta.pop("lost", None)
            meta.update(failure=None, acked=None, working_since=None)
            meta.setdefault("recovered", []).append({"round": meta["round"], "how": how, "session": session,
                                                     "at": int(time.time())})
            save(run, meta)
            event(meta, "recover", how=how, session=session)
            (back if how == "resume" else fresh).append(call)
            if call not in held:
                held.append(call)
        else:
            failed.append(call)
    set_control(run, state="paused", held=held)
    out(recovered=",".join(back) or "none", fresh=",".join(fresh) or "none", failed=",".join(failed) or "none",
        run_control="paused")
    # The main agent: still there, or gone with them?
    owner = c.get("owner") or parent
    g = hc_json("get", owner) if owner else None
    if g and "error" not in g and g.get("state") == "live":
        out(main="live")
        return
    any_meta = load(run, calls(run)[0]) if calls(run) else {}
    frm = {"terminal": owner, "agent": any_meta.get("dispatcher_agent"), "session": any_meta.get("session"),
           "space": any_meta.get("space")}
    seq = 1 + max([int(p.name) for p in (run / "handoff").glob("*") if p.name.isdigit()] or [0])
    pkg = run / "handoff" / str(seq)
    prev = control(run)
    set_control(run, state="handoff", prev=prev, seq=seq, why="recover", by=None, package=str(pkg),
                prompt=str(pkg / "prompt.md"))
    try:
        children = json.loads((run / "state.json").read_text()).get("children") or []
    except (OSError, ValueError, AttributeError):
        children = []
    notes = run / "handoff-notes.md"
    handoff_lib().dispatcher_package(run, pkg, "recover", frm, call_rows(run),
                                     notes.read_text() if notes.exists() else None,
                                     str(Path(__file__).resolve()), prev, children)
    out(main="gone", handoff=pkg, prompt=pkg / "prompt.md")
    cwd = any_meta.get("claude_cwd") or str(run.parent.parent)
    if frm["agent"] == "claude" and frm["session"]:
        out(resume_main=f"cd {cwd} && claude --resume {frm['session']}")
    elif frm["agent"] == "codex":
        out(resume_main=f"cd {cwd} && codex resume")
    print("----- prompt for the next main agent -----")
    print((pkg / "prompt.md").read_text().rstrip())
    print("----- end -----")


ADOPT_NOTE_LIVE = ("herdr 仍把这些子 agent 的通知（<hc>…</hc>）发给原来的终端 {old}（终端的父级在启动时就定了），"
                   "所以你只靠 wait/collect 获知它们的状态。")


def cmd_adopt(a):
    """The next main agent takes a handed-off run over: its calls are recorded as dispatched by this terminal,
    and the run goes back to the state it had before the handoff."""
    run = Path(a.run).resolve()
    me = dispatcher()
    if not me["parent"]:
        fail("NOT_IN_HERDR: adopt from the herdr terminal the new main agent runs in (HC_TERMINAL_ID is empty)", code=2)
    try:
        data = handoff_lib().read(a.frm)
    except ValueError as e:
        fail(f"BAD_HANDOFF: {e}", code=2)
    if data.get("level") != "dispatcher":
        fail(f"BAD_HANDOFF: {a.frm} is a helper's package (adopt takes a main agent's)", code=2)
    if Path(data["run"]).resolve() != run:
        fail(f"BAD_HANDOFF: {a.frm} is for {data['run']}, not {run}", code=2)
    c = control(run)
    if c["state"] != "handoff" and c.get("owner") != me["parent"]:
        fail(f"NOT_HANDED_OFF: {run.name} is {c['state']}; its main agent has not run handoff (or cancelled it)", code=3)
    if c["state"] != "handoff":  # adopted already by this terminal: say so again
        out(adopted=run.name, already="yes", run_control=c["state"], skill=data.get("skill"))
        return
    if c.get("package") and Path(c["package"]).resolve() != Path(data["_dir"]).resolve():
        print(f"NOTE: the newest package is {c['package']}; read that one if it differs")
    old = (data.get("from") or {}).get("terminal")
    moved, live = [], []
    for call in calls(run):
        meta = load(run, call)
        meta["adopted"] = {"from": meta.get("parent"), "by": me["parent"], "at": int(time.time()),
                           "package": data["_dir"]}
        meta.update(me)
        save(run, meta)
        event(meta, "adopt", frm=old, by=me["parent"], agent=me["dispatcher_agent"], package=data["_dir"])
        moved.append(call)
        if observe(meta)["state"] == "live":
            live.append(call)
    prev = c.get("prev") or {"state": "running"}
    set_control(run, **{**prev, "owner": me["parent"], "adopted": {"from": old, "at": int(time.time()), "package": data["_dir"]},
                        "at": prev.get("at") or int(time.time())})
    out(adopted=run.name, calls=",".join(moved) or "none", live=",".join(live) or "none",
        run_control=prev.get("state", "running"), skill=data.get("skill"), handoff=data["_dir"],
        agent=me["dispatcher_agent"] or "unknown")
    if live and old and old != me["parent"]:
        print(ADOPT_NOTE_LIVE.format(old=old))


# ---- run control commands --------------------------------------------------------------------------

def cmd_pause(a):
    run = Path(a.run).resolve()
    c = control(run)
    if c["state"] != "running":
        out(run_control=c["state"])
        return
    set_control(run, state="paused", held=[])  # first, so a running wait reports nothing from here on
    held, failed = [], []
    for call in calls(run):
        meta = load(run, call)
        o = observe(meta)
        if o["state"] != "live":
            continue
        r = meta.get("retry") or {}
        due = bool(r.get("key")) and r.get("round") == meta["round"]
        if o["status"] != "working" and not due:
            continue
        ok = interrupt(meta) if o["status"] == "working" else True
        if due:  # the retry is dropped; resume tells it to carry on instead
            r["key"] = None
            meta["retry"] = r
            relabel(meta, retry=None)
        event(meta, "pause", interrupted=o["status"] == "working")
        save(run, meta)
        held.append(call)
        if not ok:
            failed.append(call)
    set_control(run, state="paused", held=held)
    out(paused=",".join(held) or "none", interrupt_failed=",".join(failed) or "none")


def cmd_resume(a):
    run = Path(a.run).resolve()
    c = control(run)
    if c["state"] == "stopping":
        print("RUN_STOPPING: the run is being stopped; wait for it to finish")
        out(run_control="stopping")
        sys.exit(3)
    if c["state"] == "handoff":  # cancelled: back to where it was
        prev = c.get("prev") or {"state": "running"}
        set_control(run, **{**prev, "at": prev.get("at") or int(time.time())})
        out(resumed="none", handoff="cancelled", run_control=prev.get("state", "running"))
        return
    if c["state"] != "paused":  # running already, or stopped: only reset the state
        set_control(run, state="running")
        out(resumed="none")
        return
    sent = []
    for call in c.get("held") or []:
        try:
            meta = load(run, call)
        except SystemExit:
            continue
        o = observe(meta)
        if o["state"] != "live" or o["status"] in ("working", "blocked"):
            continue  # gone, never stopped, or waiting on a person: wait reports it as usual
        if o["status"] in ("done", "idle") and report_line(meta).startswith("REPORT_OK"):
            continue  # it finished before the stop key landed: wait reports it
        key = news_key(o)
        if key:
            meta["acked"] = key  # the interrupted turn is not news
        meta["working_since"] = None
        task = Path(meta["agent_dir"]) / f"task-{meta['round']}.md"
        r = hc_json("send", meta["name"], RESUME_MSG.format(task=task))
        ok = bool(r and r.get("started"))
        event(meta, "resume", sent=ok)
        save(run, meta)
        sent.append(call if ok else f"{call}(send failed)")
    set_control(run, state="running")
    out(resumed=",".join(sent) or "none")


def cmd_stop(a):
    run = Path(a.run).resolve()
    c = control(run)
    if c["state"] in ("stopping", "stopped"):
        held_line(run)
        return
    set_control(run, state="stopping", held=c.get("held") or [])
    print(f"stopping {run} at {datetime.now():%Y-%m-%d %H:%M:%S}")
    asked, parent = {}, None
    for call in calls(run):
        meta = load(run, call)
        parent = parent or meta.get("parent")
        o = observe(meta)
        if o["state"] != "live":
            continue
        r = meta.get("retry") or {}
        if r.get("key"):
            r["key"] = None
            meta["retry"] = r
        if o["status"] == "blocked" or (o["status"] in ("done", "idle") and report_line(meta).startswith("REPORT_OK")):
            event(meta, "stop", asked=False)
            save(run, meta)
            continue
        if o["status"] == "working":
            interrupt(meta)
            time.sleep(1)
            o = observe(meta)
        res = hc_json("send", meta["name"], STOP_MSG.format(report=meta["report"], schema=meta["schema"]))
        ok = bool(res and res.get("started"))
        event(meta, "stop", asked=ok)
        save(run, meta)
        print(f"asked {call} to report: {'sent' if ok else 'send failed'}")
        if ok:
            asked[call] = o["turn"]
    partial = set(asked)
    deadline = time.time() + a.wait
    while asked and time.time() < deadline:
        time.sleep(5)
        for call, turn in list(asked.items()):
            o = observe(load(run, call))
            if o["state"] != "live" or (o["status"] != "working" and o["turn"] > turn):
                del asked[call]
    if asked:
        print(f"still writing after {a.wait}s: {','.join(asked)}")
    rows, tails = [], []
    for call in calls(run):
        meta = load(run, call)
        o = observe(meta)
        if o["state"] == "live" or news_key(o) != meta.get("acked"):
            collect_one(run, meta, o)
            meta = load(run, call)
        if o["state"] == "live":
            if meta.get("report_check") != "ok":
                tails.append(f"### {call}\n\n```\n{tail(hc('read', meta['name'], '--lines', '40').stdout, 12)}\n```")
            hc("kill", meta["name"])
            hc("rm", meta["name"])
            meta["open"] = False
            save(run, meta)
            event(meta, "cleanup")
        note ="仍在写回报时被关闭" if call in asked else "按终止要求写的部分回报" if call in partial else ""
        rows.append(f"| {call} | {meta['name']} | {meta['round']} | {o['state']}/{o['status'] or '-'} | "
                    f"{meta.get('report_check') or 'missing'} | {meta.get('failure') or ''} {note} | {meta['report']} |")
    report = run / "stop.md"
    report.write_text("\n".join([
        f"# 运行已终止：{run.name}", "",
        f"用户于 {datetime.now():%Y-%m-%d %H:%M} 在 cc-dispatch 面板上终止了这次运行。"
        "所有子 agent 先被要求把已完成的部分写进回报，然后终端被关闭；worktree 和运行目录保留。", "",
        "| 调用 | 终端 | 轮次 | 终端状态 | 回报 | 备注 | 回报文件 |",
        "|---|---|---|---|---|---|---|", *rows, "",
        *(["## 回报不合格或缺失的调用：屏幕最后几行", "", *tails, ""] if tails else []),
        "回报是 JSON；`report_check` 为 ok 的可以直接读，bad 或 missing 的只能参考屏幕和 worktree。",
        "要在这个运行目录里接着派发，先由用户决定，再运行 `hd_dispatch.py resume --run <运行目录>`。", ""]))
    set_control(run, state="stopped", report=str(report))
    notified = False
    if parent:
        g = hc_json("get", parent)
        if g and "error" not in g and g.get("state") == "live":
            notified = hc("send", parent, STOP_NOTE.format(run=run.name, report=report)).returncode == 0
    out(stopped=run.name, stop_report=report, notified="yes" if notified else "no")


def cmd_probe(_):
    need_env()
    run = HOME / f"probe-{secrets.token_hex(3)}"
    (run / "agents").mkdir(parents=True)
    schema = run / "probe.schema.json"
    schema.write_text('{"type":"object","required":["status"],"properties":{"status":{"enum":["ok"]}}}')
    prompt = run / "probe.md"
    prompt.write_text('这是一次可用性探测。不读其他文件、不运行其他命令，只把 {"status": "ok"} 写进回报文件。\n')
    ns = argparse.Namespace(run=str(run), call="probe", mode="read", effort="medium", dir=str(run), title=None,
                            prompt=str(prompt), schema=str(schema))
    import contextlib
    import io
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            cmd_run(ns)
    except SystemExit:
        print(buf.getvalue().strip())
        return
    meta = load(run, "probe")
    deadline = time.time() + 180
    o = observe(meta)
    while news_key(o) is None and time.time() < deadline:
        hc("wait", meta["name"], "--timeout", "30")
        o = observe(meta)
    verdict = report_line(meta).splitlines()[0]
    screen = hc("read", meta["name"], "--lines", "60").stdout
    hc("kill", meta["name"])
    hc("rm", meta["name"])
    import shutil
    shutil.rmtree(HOME / run_tag(run), ignore_errors=True)
    shutil.rmtree(run, ignore_errors=True)
    if verdict == "REPORT_OK":
        out(probe="ok", failure="none")
    else:
        print(tail(screen, 15))
        out(probe="failed", failure=classify(screen) if o["status"] == "error" else "other")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("probe")
    r = sub.add_parser("run")
    for flag in ("--run", "--call", "--dir", "--prompt", "--schema"):
        r.add_argument(flag, required=True)
    r.add_argument("--mode", required=True, choices=["read", "write", "net"])
    r.add_argument("--effort", default="high", choices=["medium", "high"])
    r.add_argument("--title", help="a few English words on the task, shown in herdr's agent list")
    s = sub.add_parser("send")
    for flag in ("--run", "--call", "--prompt"):
        s.add_argument(flag, required=True)
    w = sub.add_parser("wait")
    w.add_argument("--run", required=True)
    w.add_argument("--timeout", type=int, default=1740)
    w.add_argument("--stall", type=int, default=int(os.environ.get("CC_HD_STALL", 2700)))
    for name in ("collect", "cleanup"):
        c = sub.add_parser(name)
        c.add_argument("--run", required=True)
        c.add_argument("--call")
    for name in ("pause", "resume"):
        sub.add_parser(name).add_argument("--run", required=True)
    sp = sub.add_parser("stop")
    sp.add_argument("--run", required=True)
    sp.add_argument("--wait", type=int, default=180, help="seconds helpers get to write what they have")
    st = sub.add_parser("status")
    st.add_argument("--run", required=True)
    d = sub.add_parser("diagnose")
    d.add_argument("--run", required=True)
    d.add_argument("--call", required=True)
    fr = sub.add_parser("freeze")
    fr.add_argument("--run", required=True)
    fr.add_argument("--call", required=True)
    fr.add_argument("--ask", type=int, default=180, help="seconds the helper gets to write a progress note; 0 skips it")
    fr.add_argument("--why", default="manual", help="why it is stopped, shown to whoever takes it over")
    ho = sub.add_parser("handover")
    ho.add_argument("--run", required=True)
    ho.add_argument("--call", required=True)
    ho.add_argument("--to", default="codex", choices=list(AGENTS), help="the agent that carries on (a new session)")
    ho.add_argument("--effort", choices=["medium", "high"], help="default: the call's")
    ho.add_argument("--ask", type=int, default=180, help="seconds a live helper gets to write a progress note")
    ho.add_argument("--why", default="manual")
    ho.add_argument("--note", help="a line for the receiver from the dispatcher")
    ho.add_argument("--notify", action="store_true", help="tell the dispatching agent (the panel sets it)")
    rc = sub.add_parser("recover")
    rc.add_argument("--run", required=True)
    rc.add_argument("--call", help="only this call (default: every lost one)")
    rc.add_argument("--fresh", action="store_true", help="new sessions, not the old ones")
    ad = sub.add_parser("adopt")
    ad.add_argument("--run", required=True)
    ad.add_argument("--from", dest="frm", required=True, help="the package: <run>/handoff/<seq>")
    hf = sub.add_parser("handoff")
    hf.add_argument("--run", required=True)
    hf.add_argument("--why", default="manual", help="manual (the user asked) or usage (this agent is near its limit)")
    hf.add_argument("--no-notes", action="store_true", help="hand off without <run>/handoff-notes.md")
    a = p.parse_args()
    {"recover": cmd_recover, "adopt": cmd_adopt, "handoff": cmd_handoff, "handover": cmd_handover, "probe": cmd_probe, "run": cmd_run, "send": cmd_send, "wait": cmd_wait, "collect": cmd_collect,
     "status": cmd_status, "diagnose": cmd_diagnose, "cleanup": cmd_cleanup, "freeze": cmd_freeze,
     "pause": cmd_pause, "resume": cmd_resume, "stop": cmd_stop}[a.cmd](a)
    if a.cmd in ("wait", "collect"):
        usage_check(Path(a.run).resolve())


if __name__ == "__main__":
    main()
