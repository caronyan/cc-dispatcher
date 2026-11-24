#!/usr/bin/env python3
"""Dispatch Codex helpers through herdr-core (hc) and collect their JSON reports.

usage:
  hd_dispatch.py probe
  hd_dispatch.py run      --run DIR --call ID --mode read|write|net --effort medium|high
                          --dir DIR --prompt FILE --schema FILE [--title WORDS]
                          [--agent auto|codex|claude|agy] [--model NAME] [--fallback codex|none]
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
  hd_dispatch.py handover --run DIR --call ID [--to codex|claude|agy] [--effort E] [--ask S] [--why WORD]
                          [--note TEXT] [--notify]
  hd_dispatch.py handoff  --run DIR [--why manual|usage] [--no-notes]
  hd_dispatch.py adopt    --run DIR --from PACKAGE
  hd_dispatch.py recover  --run DIR [--call NAME] [--fresh]
  hd_dispatch.py takeover --run DIR [--force]
  hd_dispatch.py runs     [--repo DIR] [--all] [--json]
  hd_dispatch.py retire   --run DIR [--keep] [--force]
  hd_dispatch.py ask      --run DIR (--add FILE | --resolve ID --decision TEXT | --list)

freeze stops a helper and keeps what another agent needs: a progress note it is asked to write (to
$CC_HD_HOME/<tag>/<call>/progress-r<k>.md, up to --ask s), its screen (agents/<call>/screen-r<k>.txt), a
snapshot of its worktree at refs/cc-dispatch/<run>/<call>/r<k> (HEAD, index and files untouched), its
session logs and report; closes its terminal and writes the package agents/<call>/handoff/r<k>/ (see
hd_handoff.py). collect freezes a helper whose conversation is full (context_limit) by itself.
handover freezes (unless frozen this round) and starts --to (AGENTS) as the call's next round in the same
folder, report and schema, its task file pointing at the package. Labels add cc.agent=<agent>.

run starts the helper as --agent; auto (the default) picks by the run's kind (DEFAULT_AGENT): Antigravity
for a research run, Codex for every other. agy runs on --model, else $CC_HD_AGY_MODEL, else
gemini-4-neon-<effort>; Codex and Claude Code on their own default model. Before an agy start run checks it
can: agy on PATH, the model among `agy models` (cached an hour), no Gemini window of its quota (magpie) used
up. If not, with --fallback codex (the default) it starts Codex instead and adds FALLBACK=agy→codex why=<why>;
with --fallback none it fails AGENT_UNAVAILABLE (FAILURE=agent_unavailable, exit 3). run outputs AGENT= and,
for agy, MODEL=. Later, when an agy helper with --fallback codex stops on quota, auth, model_unavailable or by
exiting without a good report, collect / wait hand the call over to Codex (handover --why fallback:<failure>)
and print FALLBACK=<call> agy→codex why= round= name=: the call goes on, keep waiting. FALLBACK_FAILED=<call>
when that handover could not start.

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
takeover is a new main agent's one step onto a run, whatever program either is: a run being handed off is
adopted; else when the main agent is gone (its terminal closed, or back at a bare shell; herdr says what runs
in it) the lost helpers are reopened as recover does, a package is left as handoff would (why takeover or
recover) and adopted. While the old main agent still runs it refuses (MAIN=live), unless --force (the person
said so). Output TAKEOVER=adopted|self|refused VIA= RECOVERED= FRESH= FAILED= RUN_CONTROL= READ=<handoff.md>
and RESUME_MAIN= (the command that reopens the old one's own session, from MAIN_AGENTS).
runs lists the repository's runs left to carry on (not finished, not archived; --all: every one), newest
first: RUN= skill= state= main=live|gone|none(<agent>) helpers= cards= last= open=<why>. A run is finished
when its state.json says so ("finished": <epoch s>) or nothing is open: no paused / stopped / handoff state,
no lost helper, no card left (merged, done or parked other than for the user), no helper at work.

delete removes an archived run for good (the panel's Delete on an archived card): it closes helpers' terminals
still open, removes their reports and progress notes ($CC_HD_HOME/<tag>), worktree snapshots
(refs/cc-dispatch/<run>/*), the panel's cache entries and the retro ledger's entry, then the run folder.
Worktrees, cc/<run>/* branches and Codex's / Claude Code's own session logs stay. NOT_ARCHIVED: archive first.
Output DELETED=<run> HELPERS= CLOSED= REPORTS= SNAPSHOTS=.

retire ends a run nobody will carry on (left handing off with no one adopting it, or its results already taken
by another run): closes its helpers' open terminals (reports stay), restores control.json to the state before
the handoff with a `retired` mark, writes "finished" in state.json and archives it (--keep: not). Dispatching
to it again (run / send) undoes the mark and that finished. HELPERS_AT_WORK / MAIN_LIVE refuse; --force.
Output RETIRED=<run> WAS=<control state> CLOSED=<calls|-> ARCHIVED=yes|no.

ask keeps what the main agent waits on the person for, in <run>/asks.json ({id: item}; the panel lists it
under "Needs you"). An item: kind decision (pick one of 2-4 options: {key, label, detail}, maybe a recommend
key and why) or question (facts or a preference only the person has; options, if any, are suggested answers);
title, context (markdown), card, blocks (cards waiting on it). --add FILE adds or replaces items (a JSON
object {id: item}, or one item with "id"), stamping asked. Besides asks.json, open items include each card
parked for the person (id card:<card>) and the run's older state.json pending_decisions (id pending:<key>).
The person's answers from the panel are appended to <run>/answers.jsonl ({id, at, choice, label, text});
wait returns as soon as one comes, and wait and collect print ANSWERS=<id>,... with each answer while its
item is open. --resolve ID --decision TEXT closes an item: drops it from asks.json (pending:<key> from
pending_decisions) and records state.json decisions[ID] = TEXT; a parked card is closed by its new status.
--list prints the open items and their answers.

--run is the skill's run directory (<repo>/.cc-dispatch/<kind>-<run>); each call keeps its state in
<run>/agents/<call>/ (meta.json, task-<k>.md). Reports live under $CC_HD_HOME (default /tmp/cc-dispatch),
the one place Codex's workspace-write sandbox can write besides its working directory.
A read-mode helper works in its own folder there, so it can read the repo but cannot change it.

Output is KEY=value lines. probe and run end with
FAILURE=none|quota|context_limit|auth|refused|model_unavailable|capacity|rate_limit|other. quota is the account's usage
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
  dispatch  mode effort dir name title task sent agent model fell_back  run
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
import shlex
import shutil
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
# The panel is Chinese, so a report's prose is too; schema keys and enum values, code, commands and paths stay as they are.
REPORT_LANG = "回报里的说明文字用中文写；字段名、schema 规定的取值、代码、命令和路径保持原样。"
FIRST_MSG = "读取任务文件 {task}，按其中要求完成。" + REPORT_LANG
SEND_MSG = "读取任务文件 {task}，按其中要求处理。" + REPORT_LANG

# Error wording seen on a Codex screen; extend a pattern when a real failure is misclassified.
PATTERNS = [
    ("refused", r"cyber_policy|content policy|usage polic|safety (system|filter)|flagged (as|for)"),
    ("auth", r"\b401\b|unauthorized|not logged in|codex login|authentication|invalid api key|token (has )?expired|refresh token"),
    # The helper's own conversation is full: its session cannot go on, but the account still can.
    ("context_limit", r"context window|context_length_exceeded|maximum context length|ran out of room|"
                      r"exceeds? the context|context limit|prompt is too long|too many tokens"),
    # The model it was started with is not one its account may use (agy --model, a Codex model setting).
    ("model_unavailable", r"model[^\n]{0,40}(not found|not available|not supported|does not exist|no access)|"
                          r"unknown model|invalid model"),
    ("quota", r"usage limit|quota|insufficient_quota|exceeded your|billing|out of credits|plan limit|upgrade to|"
              r"resource_exhausted|resource exhausted"),
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

def unarchive(run: Path):
    """A run the user archived in the panel (<run>/archived) shows again once something is dispatched to it;
    one retire ended is carried on again: its retired mark and the finished it wrote go."""
    (run / "archived").unlink(missing_ok=True)
    c = control(run)
    if c.get("retired"):
        at = c.pop("retired").get("at")
        set_control(run, **c)
        st = read_json(run / "state.json", {})
        if st.get("finished") == at:
            st.pop("finished")
            write_json(run / "state.json", st)


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


TRUST_RE = re.compile(r"Trust this (folder|workspace)|Do you trust", re.I)


def trust(name: str, tries: int = 4):
    """Confirm a folder trust question on a just-started helper's screen, if one comes up within a few seconds."""
    for _ in range(tries):
        time.sleep(1.5)
        if TRUST_RE.search(hc("read", name, "--lines", "0").stdout or ""):
            hc("keys", name, "enter")
            return


def deliver(name: str, msg: str) -> bool:
    """Get a helper that has not taken its first message ready, then send it. Trust dialogs are confirmed."""
    for _ in range(3):
        screen = hc("read", name, "--lines", "0").stdout
        if TRUST_RE.search(screen or ""):
            hc("keys", name, "enter")
            time.sleep(2)
        hc("wait", name, "--timeout", "60")
        r = hc_json("send", name, msg)
        if r and r.get("started"):
            return True
        time.sleep(3)
    return False


# The programs a main agent can be: its name, the environment variable that holds its session id, and how
# the person reopens that session in a new herdr terminal ({session}; resume_any when the id is unknown).
# Another main agent is one entry. Without one it still works (dispatch, hand off, take over); only
# RESUME_MAIN, the command to reopen its own session, is missing. names: what its program, path or herdr
# app id contains (the key itself when not given).
MAIN_AGENTS = {
    "claude": {"label": "Claude Code", "session_env": "CLAUDE_CODE_SESSION_ID",
               "resume": "claude --resume {session}", "resume_any": "claude --continue"},
    "codex": {"label": "Codex", "session_env": "CODEX_THREAD_ID",
              "resume": "codex resume --sandbox danger-full-access {session}",
              "resume_any": "codex resume --sandbox danger-full-access"},
    # Antigravity CLI. Its conversation id reaches its tools as ANTIGRAVITY_CONVERSATION_ID when it does
    # (else it is found by the run folder its conversation names, agy_conversation).
    "agy": {"label": "Antigravity", "names": ("agy", "antigravity"), "session_env": "ANTIGRAVITY_CONVERSATION_ID",
            "resume": "agy --dangerously-skip-permissions --conversation {session}",
            "resume_any": "agy --dangerously-skip-permissions --continue"},
}
SHELLS = {"zsh", "bash", "sh", "fish", "login", "nu", "dash", "tcsh", "csh", "ksh"}


def main_key(program) -> str | None:
    """MAIN_AGENTS' key for a program name, path or herdr app id (claude-code → claude), else None."""
    name = Path(str(program or "")).name.lower()
    return next((k for k, v in MAIN_AGENTS.items() if any(n in name for n in v.get("names", (k,)))), None)


def dispatcher():
    """The main agent that dispatches: its terminal, its herdr space, its program and its own session id
    (Claude Code's session, whose transcript the panel reads for background tasks; Codex's thread; …)."""
    me = os.environ.get("HC_TERMINAL_ID")
    g = hc_json("get", me) if me else None
    g = g if isinstance(g, dict) else {}
    agent = agent_on(g)
    key = main_key(agent)
    envs = [MAIN_AGENTS[key]["session_env"]] if key else [v["session_env"] for v in MAIN_AGENTS.values()]
    return {
        "parent": me,
        "space": (g.get("labels") or {}).get("herdr.space"),
        "session": next((os.environ[e] for e in envs if os.environ.get(e)), None),
        "claude_cwd": (g.get("foreground") or {}).get("cwd") or os.getcwd(),
        "dispatcher_agent": agent,
    }


def program_of(g: dict):
    """The program a terminal runs in front, from `hc get`: its name (claude, codex, …), or None for a shell."""
    argv = (g.get("foreground") or {}).get("argv") or g.get("argv") or []
    name = Path(str(argv[0])).name if argv else ""
    return None if not name or name.lstrip("-") in SHELLS else name


def agent_on(g) -> str | None:
    """The agent a live terminal runs, from `hc get`/`hc ls`: its program in front or the app herdr recognised
    in it (claude-code, codex, …), as MAIN_AGENTS' key when either is one (claude, codex), else as named; None
    when it is a bare shell, gone or finished."""
    if not isinstance(g, dict) or "error" in g or g.get("state") != "live":
        return None
    st = g.get("status") if isinstance(g.get("status"), dict) else {}
    app, prog = st.get("app") or g.get("agent"), program_of(g)
    return main_key(prog) or main_key(app) or app or prog or None


# The agents a helper can run as. Fixed on purpose: each needs its own way to start, isolate and resume.
#   isolation sandbox: Codex's workspace-write sandbox keeps it in its folder (read mode: off the repo).
#   isolation weak:    nothing but the task file's rules keeps it there; the panel marks it.
AGENTS = {
    "codex": {"label": "Codex", "isolation": "sandbox"},
    "claude": {"label": "Claude Code", "isolation": "weak"},
    "agy": {"label": "Antigravity", "isolation": "weak"},
}
# Antigravity's own folder (conversations/<id>.db). Its model: the call's (run --model), else $CC_HD_AGY_MODEL,
# else agy's own default. A call that run sends to agy by default gets AGY_DEFAULT_MODEL at its effort.
AGY_HOME = Path(os.environ.get("CC_HD_AGY_HOME") or Path.home() / ".gemini" / "antigravity-cli")
AGY_DEFAULT_MODEL = "gemini-4-neon-{effort}"
# Which agent run starts when it is not told (--agent auto): by the run's kind (run_kind); anything else is Codex.
DEFAULT_AGENT = {"research": "agy"}
FALLBACK_ON = ("quota", "auth", "model_unavailable", "exited")  # an agy helper that stopped on these goes to Codex
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


def agy_argv(meta: dict, msg: str) -> list:
    """Antigravity as a helper: no sandbox and no system-prompt flag, so its standing rules lead its first
    message (-i: that prompt, then the session stays open for send)."""
    argv = ["agy", "--dangerously-skip-permissions", "--effort", meta["effort"]]
    model = meta.get("model") or os.environ.get("CC_HD_AGY_MODEL")
    if model:
        argv += ["--model", model]
    if meta["mode"] == "read":  # the folder it may read
        argv += ["--add-dir", meta["dir"]]
    rules = role_text(meta["mode"], meta["effort"])
    return argv + ["-i", f"{rules}\n\n---\n\n{msg}" if rules and msg else msg]


def agy_conversation(needle: str, since: float = 0):
    """The newest Antigravity conversation (<AGY_HOME>/conversations/<id>.db, with its -wal) changed since
    `since` that names `needle` (a helper's task folder, a main agent's run folder), else None."""
    dbs = [p for p in (AGY_HOME / "conversations").glob("*.db") if p.stat().st_mtime >= since - 600]
    want = needle.encode()
    for db in sorted(dbs, key=lambda p: max(x.stat().st_mtime for x in (p, p.with_name(p.name + "-wal")) if x.exists()), reverse=True):
        for f in (db.with_name(db.name + "-wal"), db):
            try:
                if want in f.read_bytes():
                    return db.stem
            except OSError:
                continue
    return None


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
    if meta.get("agent") == "agy":
        session = meta.get("agent_session") or agy_conversation(str(Path(meta["agent_dir"]) / "task-"), meta.get("started_at") or 0)
        if not session:
            return None, None
        return agy_argv(meta, "")[:-2] + ["--conversation", session], session
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
    elif agent == "agy":  # its conversation id is known only once it starts (agy_conversation)
        meta["agent_session"] = None
        r = hc(*head, "--", *agy_argv(meta, msg))
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
    if agent == "agy":  # the same; a folder trust question in front of it is confirmed
        trust(meta["name"])
        return True
    return bool((launched.get("first_message") or {}).get("sent")) or deliver(meta["name"], msg)


def agy_models():
    """The model names `agy models` lists (cached an hour in CC_HD_HOME), or None when it cannot tell."""
    cache = HOME / "agy-models.json"
    c = read_json(cache, {})
    if time.time() - c.get("at", 0) < 3600 and c.get("models"):
        return c["models"]
    try:
        r = subprocess.run(["agy", "models"], capture_output=True, text=True, timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    models = sorted(set(re.findall(r"\b[a-z][a-z0-9]*(?:[-.][a-z0-9]+)+\b", r.stdout.lower())))
    if r.returncode != 0 or not models:
        return None
    try:
        HOME.mkdir(parents=True, exist_ok=True)
        write_json(cache, {"at": int(time.time()), "models": models})
    except OSError:
        pass
    return models


def agy_ready(model: str) -> str | None:
    """None when Antigravity can take a call on `model`, else why not: not installed, the model not among
    those `agy models` lists, or a Gemini window of its quota (from magpie) used up and not reset yet.
    What it cannot tell (agy models fails, no quota reading) does not count against it: a helper that then
    fails on it falls back at collect."""
    if not shutil.which("agy"):
        return "agy_missing"
    models = agy_models()
    if models is not None and model and model.lower() not in models:
        return "model_unavailable"
    try:
        u = usage_lib()
        spent = [w for w in u.windows_for(u.quota("agy", slow=True), model) if w["used"] >= 100]
    except Exception:  # the quota is a convenience: never let it stop a dispatch
        spent = []
    if spent:
        return "quota:" + "+".join(u.short(w["name"]).replace(" ", "_") for w in spent)
    return None


def cmd_run(a):
    need_env()
    run = Path(a.run).resolve()
    refuse_unless_running(run)
    unarchive(run)
    tag = run_tag(run)
    agent_dir = run / "agents" / a.call
    if meta_path(run, a.call).exists():
        old = json.loads(meta_path(run, a.call).read_text())
        if observe(old)["state"] == "live":
            fail(f"ALREADY_RUNNING: {a.call} is live as {old['name']}; use send, or cleanup first")
    agent = DEFAULT_AGENT.get(run_kind(run), "codex") if a.agent == "auto" else a.agent
    model = None  # Codex and Claude helpers run on their own default model
    if agent == "agy":
        model = a.model or os.environ.get("CC_HD_AGY_MODEL") or AGY_DEFAULT_MODEL.format(effort=a.effort)
    fell_back = None
    if agent == "agy":
        why = agy_ready(model)
        if why and a.fallback == "none":
            fail(f"AGENT_UNAVAILABLE: agy cannot take {a.call} on {model} ({why})", "agent_unavailable", 3)
        if why:
            fell_back, agent, model = why, "codex", None  # Codex on its own default model
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
        "agent": agent, "open": True,  # open: its terminal should be there (closed by cleanup/stop/freeze)
        "model": model, "fallback": a.fallback if agent == "agy" else None,
    }
    if fell_back:
        meta["fell_back"] = {"from": "agy", "to": "codex", "why": fell_back, "at": int(time.time())}
    if a.mode != "read":  # where its work started, for a handoff's "since" diff
        meta["base"] = (subprocess.run(["git", "-C", meta["dir"], "rev-parse", "HEAD"], capture_output=True,
                                       text=True).stdout.strip() or None)
    meta["title"] = a.title
    meta.update(dispatcher())
    Path(meta["report"]).unlink(missing_ok=True)
    task = compose(meta, Path(a.prompt).read_text(), 1)
    sent = launch(run, meta, agent, task)
    event(meta, "dispatch", mode=a.mode, effort=a.effort, dir=meta["dir"], name=name, title=a.title,
          task=str(task), sent=bool(sent), agent=agent, model=model, fell_back=fell_back)
    out(call=a.call, name=name, address=meta["address"], report=meta["report"], agent=agent)
    if model:
        out(model=model)
    if fell_back:
        out(fallback=f"agy→codex why={fell_back}")
    out(first_message="sent" if sent else "failed")
    if not sent:
        print("----- screen -----")
        print(tail(hc("read", name, "--lines", "0").stdout, 20))
    out(failure="none" if sent else "other")


def cmd_send(a):
    run = Path(a.run).resolve()
    refuse_unless_running(run)
    unarchive(run)
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
    elif (meta.get("agent") == "agy" and meta.get("fallback") == "codex" and meta["failure"] in FALLBACK_ON
          and meta["report_check"] != "ok"):
        fall_back(run, meta)


def fall_back(run: Path, meta: dict):
    """An agy helper that stopped on its quota, its sign-in, its model or by exiting, without a good report:
    hand the call over to Codex on its default model (handover: freeze, then the next round), and say so."""
    import argparse as ap
    import contextlib
    import io
    why = meta["failure"]
    buf = io.StringIO()
    try:
        with contextlib.redirect_stdout(buf):
            cmd_handover(ap.Namespace(run=str(run), call=meta["call"], to="codex", effort=None, ask=0,
                                      why=f"fallback:{why}", note=None, notify=False))
        code = 0
    except SystemExit as e:
        code = e.code
    kv = dict(l.split("=", 1) for l in buf.getvalue().splitlines() if "=" in l and l.split("=", 1)[0].isupper())
    if code == 0 and kv.get("FIRST_MESSAGE") == "sent":
        print(f"FALLBACK={meta['call']} agy→codex why={why} round={kv.get('ROUND')} name={kv.get('NAME')}"
              " (Codex carries on with the same task and report: keep waiting)")
    else:
        print(f"FALLBACK_FAILED={meta['call']} why={why}")
        print(tail(buf.getvalue(), 6))


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
    heard = answers_size(run)
    while True:
        if answers_size(run) > heard and open_answers(run):
            out(wait="answer")  # the person answered in the panel; main() prints ANSWERS=
            return
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
        hc("wait", "--children", "any", "--timeout", str(int(max(5, min(30, deadline - now, *due)))))
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
NO_ASK = ("context_limit", "quota", "auth", "refused", "model_unavailable")  # it cannot answer: freeze without asking


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
        agent = u.agent_of(agent_on(g))
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
    if meta.get("agent") == "agy":  # its conversation is not readable here: the screen and its note carry it
        return {"plan": None, "commands": [], "files": [], "messages": [], "asked": []}
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


def reopen_lost(run: Path, only=None, fresh=False):
    """Reopen the lost calls (or `only`), idle, in their own sessions when found (else a new one on the same
    task and folder); the run is paused with them held. → (reopened, fresh, failed) call names."""
    c = control(run)
    held = list(c.get("held") or []) if c["state"] == "paused" else []
    if c["state"] != "paused":
        set_control(run, state="paused", held=held)  # first, so no wait or retry acts on half-recovered calls
    back, new, failed = [], [], []
    for call in [only] if only else calls(run):
        meta = load(run, call)
        o = observe(meta)
        if not (meta.get("lost") or is_lost(meta, o)):
            continue
        for d in (meta["workdir"], Path(meta["report"]).parent):  # /tmp does not survive a reboot
            Path(d).mkdir(parents=True, exist_ok=True)
        agent = meta.get("agent") or "codex"
        argv, session = (None, None) if fresh else resume_argv(meta)
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
            (back if how == "resume" else new).append(call)
            if call not in held:
                held.append(call)
        else:
            failed.append(call)
    set_control(run, state="paused", held=held)
    return back, new, failed


def lost_calls(run: Path) -> list:
    return [c for c in calls(run) if (lambda m: m.get("lost") or is_lost(m, observe(m)))(load(run, c))]


def main_of(run: Path, c: dict = None) -> dict:
    """The run's main agent: {terminal, agent, session, space, cwd} as the newest dispatch or adopt recorded
    them, `live` (its terminal still runs an agent, not a bare shell) and `now` (what it runs)."""
    c = c or control(run)
    metas = [load(run, x) for x in calls(run)]
    newest = max(metas, key=lambda m: max((m.get("adopted") or {}).get("at") or 0, m.get("started_at") or 0),
                 default={})
    term = c.get("owner") or newest.get("parent")
    now = agent_on(hc_json("get", term)) if term else None
    session = newest.get("session")
    if not session and main_key(newest.get("dispatcher_agent")) == "agy":  # its id may not reach its tools
        session = agy_conversation(str(run), newest.get("started_at") or 0)
    return {"terminal": term, "agent": newest.get("dispatcher_agent"), "session": session,
            "space": newest.get("space"), "cwd": newest.get("claude_cwd") or str(run.parent.parent),
            "live": bool(now), "now": now}


def resume_main(m: dict):
    """The command that reopens the main agent's own session in a new terminal, or None (unknown program)."""
    spec = MAIN_AGENTS.get(main_key(m.get("agent")) or "")
    if not spec:
        return None
    cmd = spec["resume"].format(session=shlex.quote(m["session"])) if m.get("session") else spec.get("resume_any")
    return cmd and f"cd {shlex.quote(m['cwd'])} && {cmd}"


def leave_package(run: Path, why: str, m: dict, prev: dict) -> Path:
    """Put the run in handoff and write the next main agent's package (as handoff does, for a main agent
    that cannot write one itself). → the package folder."""
    seq = 1 + max([int(p.name) for p in (run / "handoff").glob("*") if p.name.isdigit()] or [0])
    pkg = run / "handoff" / str(seq)
    set_control(run, state="handoff", prev=prev, seq=seq, why=why, by=None, package=str(pkg),
                prompt=str(pkg / "prompt.md"))
    try:
        children = json.loads((run / "state.json").read_text()).get("children") or []
    except (OSError, ValueError, AttributeError):
        children = []
    notes = run / "handoff-notes.md"
    frm = {k: m.get(k) for k in ("terminal", "agent", "session", "space")}
    handoff_lib().dispatcher_package(run, pkg, why, frm, call_rows(run),
                                     notes.read_text() if notes.exists() else None,
                                     str(Path(__file__).resolve()), prev, children)
    return pkg


def print_prompt(pkg: Path):
    print("----- prompt for the next main agent -----")
    print((pkg / "prompt.md").read_text().rstrip())
    print("----- end -----")


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
    back, fresh, failed = reopen_lost(run, a.call, a.fresh)
    out(recovered=",".join(back) or "none", fresh=",".join(fresh) or "none", failed=",".join(failed) or "none",
        run_control="paused")
    m = main_of(run, c)
    if m["live"]:
        out(main="live")
        return
    pkg = leave_package(run, "recover", m, control(run))
    out(main="gone", handoff=pkg, prompt=pkg / "prompt.md")
    rm = resume_main(m)
    if rm:
        out(resume_main=rm)
    print_prompt(pkg)


ADOPT_NOTE_LIVE = ("herdr 仍把这些子 agent 的通知（<hc>…</hc>）发给原来的终端 {old}（终端的父级在启动时就定了），"
                   "所以你只靠 wait/collect 获知它们的状态。")


def earlier_mains(meta: dict, frm, me: dict) -> list:
    """The main agents this call had before the one adopting it, oldest first: [{terminal, agent, session}].
    Their sessions stay readable after adopt rewrites parent / dispatcher_agent / session (the panel reads
    an earlier Claude Code main agent's transcript for its background tasks)."""
    mains = [m for m in meta.get("mains") or [] if isinstance(m, dict)]
    for m in ({"terminal": meta.get("parent"), "agent": meta.get("dispatcher_agent"), "session": meta.get("session")},
              {k: (frm or {}).get(k) for k in ("terminal", "agent", "session")}):
        if m["session"] and m["session"] != me.get("session") and all(x.get("session") != m["session"] for x in mains):
            mains.append(m)
    return mains


def adopt_package(run: Path, data: dict, me: dict, c: dict) -> dict:
    """Record this main agent as every call's parent and put the run back in its state before the handoff,
    owned by this terminal. → what to print (KEY=value)."""
    old = (data.get("from") or {}).get("terminal")
    moved, live = [], []
    for call in calls(run):
        meta = load(run, call)
        meta["adopted"] = {"from": meta.get("parent"), "by": me["parent"], "at": int(time.time()),
                           "package": data["_dir"]}
        meta["mains"] = earlier_mains(meta, data.get("from"), me)
        meta.update(me)
        save(run, meta)
        event(meta, "adopt", frm=old, by=me["parent"], agent=me["dispatcher_agent"], package=data["_dir"])
        moved.append(call)
        if observe(meta)["state"] == "live":
            live.append(call)
    prev = c.get("prev") or {"state": "running"}
    set_control(run, **{**prev, "owner": me["parent"], "adopted": {"from": old, "at": int(time.time()), "package": data["_dir"]},
                        "at": prev.get("at") or int(time.time())})
    if live and old and old != me["parent"]:
        print(ADOPT_NOTE_LIVE.format(old=old))
    return {"adopted": run.name, "calls": ",".join(moved) or "none", "live": ",".join(live) or "none",
            "run_control": prev.get("state", "running"), "skill": data.get("skill"), "handoff": data["_dir"],
            "agent": me["dispatcher_agent"] or "unknown"}


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
    out(**adopt_package(run, data, me, c))


# ---- taking a run over -----------------------------------------------------------------------------

MAIN_LIVE = ("MAIN_LIVE: this run's main agent ({agent}, terminal {term}) is still running. Do not take the run "
             "from it on your own. Tell the user and stop: they can tell that agent \"准备交接\" (it hands the run "
             "off; then run takeover again), close it, or, if they say so, let you take over anyway with --force "
             "(from then on the old one is refused).")


def cmd_takeover(a):
    """One step for a new main agent to carry on a run: adopt it when it is being handed off; else, when its
    main agent is gone (or --force), reopen its lost helpers (recover), leave a package as handoff would and
    adopt it. Refuses while the old main agent still runs, unless --force."""
    run = Path(a.run).resolve()
    if not run.is_dir() or not ((run / "agents").is_dir() or (run / "state.json").exists()):
        fail(f"NO_RUN: {run} is not a cc-dispatch run folder (<repo>/.cc-dispatch/<run>)", code=2)
    me = dispatcher()
    if not me["parent"]:
        fail("NOT_IN_HERDR: take over from the herdr terminal the new main agent runs in (HC_TERMINAL_ID is empty)", code=2)
    ensure_home()
    c = control(run)
    skill = skill_of(run)
    if c["state"] == "stopping":
        print("RUN_STOPPING: the run is being stopped; take it over once that is done")
        out(takeover="refused", run_control="stopping", skill=skill)
        sys.exit(3)
    if c["state"] == "handoff" and c.get("package"):
        data = handoff_lib().read(c["package"])
        out(takeover="adopted", via="handoff", **adopt_package(run, data, me, c))
        out(read=f"{c['package']}/handoff.md")
        print("Read it: the previous main agent's account (its adopt step is done).")
        return
    m = main_of(run, c)
    mine = m["terminal"] == me["parent"]
    if m["live"] and not mine and not a.force:
        print(MAIN_LIVE.format(agent=m["now"], term=m["terminal"]))
        out(takeover="refused", main="live", main_terminal=m["terminal"], main_agent=m["now"], skill=skill)
        sys.exit(3)
    lost = lost_calls(run) if c["state"] in ("running", "paused") else []
    back, fresh, failed = reopen_lost(run) if lost else ([], [], [])
    rec = {"recovered": ",".join(back) or "none", "fresh": ",".join(fresh) or "none", "failed": ",".join(failed) or "none"}
    if mine:  # this terminal dispatched it (the main agent restarted in place): nothing to adopt
        out(takeover="self", run_control=control(run)["state"], skill=skill, **rec)
        return
    why = "forced" if m["live"] else "recover" if lost else "takeover"
    pkg = leave_package(run, why, m, control(run))
    data = handoff_lib().read(pkg)
    out(takeover="adopted", via=why, **rec, **adopt_package(run, data, me, control(run)))
    rm = resume_main(m)
    if rm and not m["live"]:
        out(resume_main=rm)
    out(read=pkg / "handoff.md", notes="yes" if (run / "handoff-notes.md").exists() else "no")
    print("Read it: what is known of the run (its adopt step is done).")


def skill_of(run: Path) -> str:
    return f"cc-herdr-dispatch-{run_kind(run) if run_kind(run) != 'probe' else 'dev'}"


CARD_DONE = {"merged", "done"}


def parked_why(card: dict) -> str:
    """user / superseded / dropped: the card's parked_why, else read from its note (as the panel's parkedWhy)."""
    if card.get("parked_why") in ("user", "superseded", "dropped"):
        return card["parked_why"]
    note = f"{card.get('note') or ''} {card.get('result') or ''}"
    if re.search(r"supersed|replaced by|取代|替代", note, re.I):
        return "superseded"
    if re.search(r"dropped|abandon|不做|放弃", note, re.I):
        return "dropped"
    return "user"


# ---- asks: what the main agent waits on the person for, and the person's answers from the panel ----------

ASK_KINDS = ("decision", "question")


def read_json(path: Path, default):
    try:
        v = json.loads(path.read_text())
        return v if isinstance(v, type(default)) else default
    except (OSError, ValueError):
        return default


def write_json(path: Path, value):
    tmp = path.with_name(path.name + f".{os.getpid()}")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")
    os.replace(tmp, path)


def check_ask(i: str, item) -> str | None:
    """Why an asks.json item is malformed, or None."""
    if not isinstance(item, dict):
        return f"{i}: not an object"
    if item.get("kind") not in ASK_KINDS:
        return f"{i}: kind must be decision or question"
    if not isinstance(item.get("title"), str) or not item["title"].strip():
        return f"{i}: title is required"
    opts = item.get("options") or []
    if not isinstance(opts, list) or any(not isinstance(o, dict) or not o.get("key") or not o.get("label") for o in opts):
        return f"{i}: options are [{{key, label, detail}}]"
    if len({o["key"] for o in opts}) != len(opts):
        return f"{i}: option keys repeat"
    if item["kind"] == "decision" and len(opts) < 2:
        return f"{i}: a decision needs at least 2 options"
    if item.get("recommend") and item["recommend"] not in {o["key"] for o in opts}:
        return f"{i}: recommend is not an option key"
    return None


def open_items(run: Path) -> dict:
    """id -> item: asks.json, cards parked for the person (card:<id>) and state.json pending_decisions
    (pending:<key>), as the panel's pendingItems lists them."""
    items = {k: v for k, v in read_json(run / "asks.json", {}).items() if isinstance(v, dict)}
    st = read_json(run / "state.json", {})
    tasks = st.get("tasks") if isinstance(st.get("tasks"), dict) else {}
    asked_cards = {v.get("card") for v in items.values()}
    parked = [k for k, v in tasks.items() if isinstance(v, dict) and v.get("status") == "parked" and parked_why(v) == "user"]
    for k in parked:
        if k not in asked_cards:
            items[f"card:{k}"] = {"kind": "decision", "title": f"搁置的卡 {k}：继续还是不做", "card": k}
    for k, v in pending_decisions(st).items():
        text = v if isinstance(v, str) else json.dumps(v, ensure_ascii=False)
        card = legacy_card(k, parked)
        if card and f"card:{card}" in items:  # the same matter as a parked card: one item
            items[f"card:{card}"].setdefault("pending", []).append(k)
            items[f"card:{card}"]["context"] = text
        elif not card or card not in asked_cards:
            items[f"pending:{k}"] = {"kind": "question", "title": k, "context": text}
    return items


def pending_decisions(st: dict) -> dict:
    """Older runs' own list of what waits on the person: state.json pending_decisions {key: text}."""
    v = st.get("pending_decisions")
    return v if isinstance(v, dict) else {}


def legacy_card(key: str, cards: list) -> str | None:
    """The parked card a pending_decisions key is about: the card id itself or <card>-<what>, longest first."""
    for c in sorted(cards, key=len, reverse=True):
        if key == c or key.startswith(c + "-"):
            return c
    return None


def answers(run: Path) -> list:
    out = []
    try:
        for line in (run / "answers.jsonl").read_text().splitlines():
            try:
                a = json.loads(line)
            except ValueError:
                continue
            if isinstance(a, dict) and a.get("id"):
                out.append(a)
    except OSError:
        pass
    return out


def open_answers(run: Path) -> list:
    """The newest answer to each item still open, given since it was (last) asked."""
    items, last = open_items(run), {}
    for a in answers(run):
        if a["id"] in items and (a.get("at") or 0) >= (items[a["id"]].get("asked") or 0):
            last[a["id"]] = a
    return list(last.values())


def answer_words(a: dict) -> str:
    pick = f"{a.get('choice')}. {a.get('label')}" if a.get("choice") else ""
    return "；".join(x for x in (pick, (a.get("text") or "").strip()) if x) or "(empty)"


def answers_check(run: Path):
    """After wait / collect: the person's answers from the panel that the main agent has not acted on."""
    got = open_answers(run)
    if not got:
        return
    out(answers=",".join(a["id"] for a in got))
    for a in got:
        print(f"ANSWER {a['id']}: {answer_words(a)}")
    print("NOTE: the person answered in the panel; act on it as shared/herdr.md 待决项 says, then ask --resolve.")


def answers_size(run: Path) -> int:
    try:
        return (run / "answers.jsonl").stat().st_size
    except OSError:
        return 0


def cmd_ask(a):
    run = Path(a.run).resolve()
    if not run.is_dir():
        fail(f"no run folder {run}", code=2)
    path = run / "asks.json"
    if a.add:
        try:
            got = json.loads(Path(a.add).read_text())
        except (OSError, ValueError) as e:
            fail(f"cannot read {a.add}: {e}", code=2)
        if isinstance(got, dict) and "id" in got and "kind" in got:
            got = {got.pop("id"): got}
        if not isinstance(got, dict) or not got:
            fail("--add wants {id: item} or one item with id", code=2)
        bad = [x for x in (check_ask(i, v) for i, v in got.items()) if x]
        if bad:
            fail("ASK_INVALID " + "; ".join(bad), code=2)
        asks = read_json(path, {})
        now = int(time.time())
        for i, v in got.items():
            v["asked"] = now  # asked again: an earlier answer no longer counts
            asks[i] = v
        write_json(path, asks)
        out(asked=",".join(got))
        return
    if a.resolve:
        if not a.decision:
            fail("--resolve needs --decision TEXT", code=2)
        asks = read_json(path, {})
        found = asks.pop(a.resolve, None) is not None
        if found:
            write_json(path, asks)
        stp = run / "state.json"
        st = read_json(stp, {})
        pend = pending_decisions(st)
        if a.resolve.startswith("pending:"):
            found = pend.pop(a.resolve[len("pending:"):], None) is not None or found
        elif a.resolve.startswith("card:"):  # an older run's pending_decisions about the card go with it
            for k in [k for k in pend if legacy_card(k, [a.resolve[len("card:"):]])]:
                pend.pop(k)
        found = found or a.resolve.startswith("card:")
        if not isinstance(st.get("decisions"), dict):
            st["decisions"] = {}
        st["decisions"][a.resolve] = a.decision
        write_json(stp, st)
        out(resolved=a.resolve, found="yes" if found else "no")
        return
    items, got = open_items(run), {x["id"]: x for x in open_answers(run)}
    out(open=len(items))
    for i, v in items.items():
        print(f"ASK {i}\t{v.get('kind')}\t{v.get('title')}" + (f"\tcard={v['card']}" if v.get("card") else "")
              + (f"\tANSWERED: {answer_words(got[i])}" if i in got else ""))


def run_summary(run: Path, terms: dict) -> dict:
    """What `runs` shows of one run; `terms` maps terminal addresses and names to `hc ls` entries."""
    c = control(run)
    try:
        st = json.loads((run / "state.json").read_text())
        st = st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        st = {}
    metas = []
    for x in calls(run):
        try:
            metas.append(load(run, x))
        except SystemExit:
            pass
    live = lost = ok = 0
    for meta in metas:
        t = terms.get(meta.get("address")) or terms.get(meta.get("name"))
        alive = bool(t) and t.get("state") == "live"
        live += alive
        ok += meta.get("report_check") == "ok"
        lost += (not alive) and (bool(meta.get("lost")) or (meta.get("open") is True and meta.get("report_check") != "ok"))
    newest = max(metas, key=lambda m: max((m.get("adopted") or {}).get("at") or 0, m.get("started_at") or 0), default={})
    term = c.get("owner") or newest.get("parent")
    main_now = agent_on(terms.get(term)) if term else None
    tasks = {k: v for k, v in (st.get("tasks") or {}).items()
             if isinstance(v, dict) and not re.search(r"-check-r\d+$", k) and k != "survey" and not v.get("check")}
    cards = None
    if tasks:
        status = [str(v.get("status") or "") for v in tasks.values()]
        parked = [v for v in tasks.values() if v.get("status") == "parked"]
        cards = {"done": sum(s in CARD_DONE for s in status), "goal": len(status) - len(parked),
                 "open": sum(s not in CARD_DONE | {"parked"} for s in status),
                 "decide": sum(parked_why(v) == "user" for v in parked)}
    why = []
    if c["state"] in ("paused", "stopped", "handoff", "stopping"):
        why.append(c["state"])
    if lost:
        why.append(f"{lost} lost")
    if cards and cards["open"]:
        why.append(f"{cards['open']} cards open")
    asks = open_items(run)
    if asks:
        why.append(f"{len(asks)} waiting on you")
    if not cards and live > ok and live:
        why.append("helpers at work")
    finished = bool(st.get("finished")) or not why
    times = [p.stat().st_mtime for p in [run / "state.json", run / "control.json", *run.glob("agents/*/events.jsonl")] if p.exists()]
    return {"run": str(run), "name": run.name, "skill": skill_of(run), "state": c["state"],
            "main": "live" if main_now else "gone" if term else "none", "main_agent": main_now or newest.get("dispatcher_agent"),
            "main_terminal": term, "calls": len(metas), "live": live, "lost": lost, "cards": cards,
            "finished": finished, "why": why, "archived": (run / "archived").exists(),
            "last": int(max(times)) if times else 0, "parent": st.get("parent"), "asks": len(asks)}


def cmd_runs(a):
    """The runs of a repository a new main agent might carry on, newest first."""
    top = subprocess.run(["git", "-C", a.repo or ".", "rev-parse", "--show-toplevel"], capture_output=True, text=True)
    base = Path(top.stdout.strip() if top.returncode == 0 else (a.repo or ".")).resolve()
    ls = hc_json("ls") or {}
    terms = {}
    for t in (ls.get("terminals") if isinstance(ls, dict) else ls) or []:
        for k in (t.get("address"), t.get("name")):
            if k:
                terms[k] = t
    rows = [run_summary(d, terms) for d in sorted((base / ".cc-dispatch").glob("*/"))
            if (d / "agents").is_dir() or (d / "state.json").exists()]
    if not a.all:
        rows = [r for r in rows if not r["finished"] and not r["archived"]]
    rows.sort(key=lambda r: r["last"], reverse=True)
    if a.json:
        print(json.dumps(rows, ensure_ascii=False, indent=1))
        return
    out(repo=base, runs=len(rows))
    for r in rows:
        cards = f"{r['cards']['done']}/{r['cards']['goal']} merged" if r["cards"] else "-"
        last = time.strftime("%m-%d %H:%M", time.localtime(r["last"])) if r["last"] else "-"
        print("\t".join([f"RUN={r['run']}", f"skill={r['skill']}", f"state={r['state']}",
                         f"main={r['main']}" + (f"({r['main_agent']})" if r["main_agent"] else ""),
                         f"helpers={r['calls']} live={r['live']} lost={r['lost']}", f"cards={cards}",
                         f"last={last}", "open=" + (", ".join(r["why"]) or ("finished" if r["finished"] else "-")),
                         *([f"parent={r['parent']}"] if r["parent"] else [])]))


def drop_cache_keys(path: Path, drop):
    """Remove the entries `drop(section, key)` names from one of the panel's JSON caches, if it is there."""
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError):
        return
    if not isinstance(data, dict):
        return
    for name, section in data.items():
        if isinstance(section, dict):
            for k in [k for k in section if drop(name, k)]:
                section.pop(k)
    tmp = path.with_name(path.name + f".{os.getpid()}")
    tmp.write_text(json.dumps(data))
    tmp.replace(path)


def cmd_delete(a):
    """Delete an archived run and what this script and the panel keep of it: its helpers' terminals (still
    open ones), reports and progress notes ($CC_HD_HOME/<tag>), worktree snapshots (refs/cc-dispatch/<run>/*),
    the panel's cache entries, the retro ledger's entry, then the run folder itself (meta.json, events,
    screens, tasks, control, asks, handoff packages). Code is not touched: worktrees and cc/<run>/* branches
    stay, and so do Codex's and Claude Code's own session logs."""
    run = Path(a.run).resolve()
    if not run.is_dir() or run.parent.name != ".cc-dispatch" or not ((run / "agents").is_dir() or (run / "state.json").exists()):
        fail(f"NO_RUN: {run} is not a cc-dispatch run folder (<repo>/.cc-dispatch/<run>)", code=2)
    if not (run / "archived").exists():
        fail(f"NOT_ARCHIVED: archive {run.name} first; only an archived run is deleted", code=2)
    state = control(run)["state"]
    if state in ("paused", "stopping", "handoff"):
        fail(f"RUN_BUSY: {run.name} is {state}", code=2)
    repo = run.parent.parent
    metas = []
    for c in calls(run):
        try:
            metas.append(json.loads(meta_path(run, c).read_text()))
        except (OSError, ValueError):
            pass
    closed = 0
    for meta in metas:
        if meta.get("open") and observe(meta)["state"] != "gone":
            hc("kill", meta.get("address") or meta["name"])
            hc("rm", meta.get("address") or meta["name"])
            closed += 1
    # Reports: $CC_HD_HOME/<tag>/<call>/ (only ever below HOME).
    tags = {(run / "agents" / "tag").read_text().strip()} if (run / "agents" / "tag").exists() else set()
    tags |= {Path(m["report"]).parent.parent.name for m in metas if m.get("report")}
    home = HOME.resolve()
    for tag in tags:
        d = (HOME / tag).resolve()
        if tag and d.parent == home and d.is_dir():
            shutil.rmtree(d, ignore_errors=True)
    # Worktree snapshots.
    refs = subprocess.run(["git", "-C", str(repo), "for-each-ref", "--format=%(refname)", f"refs/cc-dispatch/{run.name}/"],
                          capture_output=True, text=True).stdout.split()
    for ref in refs:
        subprocess.run(["git", "-C", str(repo), "update-ref", "-d", ref], capture_output=True)
    # The panel's caches: helpers' session logs (spend), the run's main-agent lookups and handoff packages.
    rollouts = {p for m in metas for p in (m.get("rollouts") or [])}
    drop_cache_keys(HOME / ".panel-stats.json", lambda _s, k: k in rollouts)
    drop_cache_keys(HOME / ".panel-bg.json", lambda s, k: (s in ("resolved", "missed") and k.endswith("|" + str(run)))
                    or (s == "packages" and k.startswith(str(run) + os.sep)))
    ledger = repo / ".cc-dispatch" / ".retro-reviewed.json"
    try:
        led = json.loads(ledger.read_text())
        if isinstance(led, dict) and led.pop(run.name, None) is not None:
            ledger.write_text(json.dumps(led, ensure_ascii=False, indent=1))
    except (OSError, ValueError):
        pass
    shutil.rmtree(run)
    out(deleted=run, helpers=len(metas), closed=closed, reports=len(tags), snapshots=len(refs))


def cmd_retire(a):
    """End a run nobody will carry on: one left handing off that no main agent adopted, or one whose results
    another run already took. Closes its helpers' terminals still open (reports stay, as cleanup does), puts
    control.json back to the state before a handoff (or pause / stop) with `retired`, writes "finished" in
    state.json, and archives it unless --keep. Refuses while a helper is at work or a live main agent other
    than the caller still has the run (not handing off), unless --force."""
    run = Path(a.run).resolve()
    if not run.is_dir() or run.parent.name != ".cc-dispatch" or not ((run / "agents").is_dir() or (run / "state.json").exists()):
        fail(f"NO_RUN: {run} is not a cc-dispatch run folder (<repo>/.cc-dispatch/<run>)", code=2)
    c = control(run)
    if c["state"] == "stopping":
        fail(f"RUN_BUSY: {run.name} is stopping; retire it once that is done", code=2)
    metas = [load(run, k) for k in calls(run)]
    seen = {m["call"]: observe(m) for m in metas if m.get("open")}
    if not a.force:
        working = [k for k, o in seen.items() if o["state"] == "live" and o["status"] == "working"]
        if working:
            fail(f"HELPERS_AT_WORK: {', '.join(working)} still working; wait, stop the run, or --force", code=3)
        if c["state"] != "handoff":
            newest = max(metas, key=lambda m: m.get("started_at") or 0, default={})
            term = c.get("owner") or newest.get("parent")
            if term and term != os.environ.get("HC_TERMINAL_ID") and agent_on(hc_json("get", term)):
                fail(f"MAIN_LIVE: its main agent ({term}) still has the run; ask it, or --force", code=3)
    closed = []
    for m in metas:
        if m["call"] not in seen:
            continue
        backup_report(m)
        if seen[m["call"]]["state"] != "gone":
            hc("kill", m.get("address") or m["name"])
            hc("rm", m.get("address") or m["name"])
            closed.append(m["call"])
        m["open"] = False
        m.pop("lost", None)
        save(run, m)
        event(m, "cleanup", why="retire")
    now = int(time.time())
    before = (c.get("prev") if c["state"] == "handoff" else None) or {"state": "running"}
    if before.get("state") not in ("running", "stopped"):
        before = {"state": "running"}  # nothing is held or stopping any more
    keep = {k: c[k] for k in ("owner", "adopted") if k in c}
    set_control(run, **{k: v for k, v in before.items() if k not in ("at",)}, **keep,
                retired={"at": now, "from": c["state"], "by": os.environ.get("HC_TERMINAL_ID") or "panel",
                         **({"package": c["package"]} if c.get("package") else {})})
    st = read_json(run / "state.json", {})
    st["finished"] = now
    write_json(run / "state.json", st)
    if not a.keep:
        (run / "archived").write_text(f"{now}\n")
    out(retired=run, was=c["state"], closed=",".join(closed) or "-", archived="no" if a.keep else "yes")


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
    r.add_argument("--title", help="a short Chinese title for the task, shown on its row in the panel")
    r.add_argument("--agent", default="auto", choices=["auto", *AGENTS],
                   help="auto: agy for a research run, Codex for every other kind")
    r.add_argument("--model", help="agy's model (default $CC_HD_AGY_MODEL, else gemini-4-neon-<effort>)")
    r.add_argument("--fallback", default="codex", choices=["codex", "none"],
                   help="when agy cannot take the call or stops on its quota, sign-in or model: Codex, or fail")
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
    tk = sub.add_parser("takeover")
    tk.add_argument("--run", required=True)
    tk.add_argument("--force", action="store_true", help="even while the old main agent still runs (the user said so)")
    dl = sub.add_parser("delete")
    dl.add_argument("--run", required=True)
    rt = sub.add_parser("retire")
    rt.add_argument("--run", required=True)
    rt.add_argument("--keep", action="store_true", help="do not archive it")
    rt.add_argument("--force", action="store_true", help="even with a helper at work or its main agent live")
    rs = sub.add_parser("runs")
    rs.add_argument("--repo", help="a folder in the repository (default: here)")
    rs.add_argument("--all", action="store_true", help="also finished and archived runs")
    rs.add_argument("--json", action="store_true")
    ak = sub.add_parser("ask")
    ak.add_argument("--run", required=True)
    g = ak.add_mutually_exclusive_group(required=True)
    g.add_argument("--add", metavar="FILE", help="JSON: {id: item} or one item with id")
    g.add_argument("--resolve", metavar="ID")
    g.add_argument("--list", action="store_true")
    ak.add_argument("--decision", help="with --resolve: what was decided, recorded in state.json decisions")
    hf = sub.add_parser("handoff")
    hf.add_argument("--run", required=True)
    hf.add_argument("--why", default="manual", help="manual (the user asked) or usage (this agent is near its limit)")
    hf.add_argument("--no-notes", action="store_true", help="hand off without <run>/handoff-notes.md")
    a = p.parse_args()
    {"recover": cmd_recover, "adopt": cmd_adopt, "takeover": cmd_takeover, "runs": cmd_runs, "delete": cmd_delete, "retire": cmd_retire, "ask": cmd_ask, "handoff": cmd_handoff, "handover": cmd_handover, "probe": cmd_probe, "run": cmd_run, "send": cmd_send, "wait": cmd_wait, "collect": cmd_collect,
     "status": cmd_status, "diagnose": cmd_diagnose, "cleanup": cmd_cleanup, "freeze": cmd_freeze,
     "pause": cmd_pause, "resume": cmd_resume, "stop": cmd_stop}[a.cmd](a)
    if a.cmd in ("wait", "collect"):
        usage_check(Path(a.run).resolve())
        answers_check(Path(a.run).resolve())


if __name__ == "__main__":
    main()
