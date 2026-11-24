// The main agent's background work, whatever program it is, read from its own session log by an
// adapter per program (BG_PY's ADAPTERS) and handed to the panel in one task shape, so every main agent's
// tasks are shown the same way. No Herdr imports: herdr/tests/bg.test.mjs runs it under node.
//
// An adapter knows three things about its program:
//   path(session)  the session's log;
//   find(run)      the session when hd_dispatch.py could not record one: the newest log of that program,
//                  in the run's folder, that names the run folder (remembered once found);
//   scan(path)     the log's background tasks, read from where the last read stopped.
// Adapters:
//   claude  Claude Code. hd_dispatch.py run records CLAUDE_CODE_SESSION_ID; the transcript is
//           ~/.claude/projects/<slug>/<session>.jsonl. A tool_use (Bash with run_in_background, Monitor,
//           async Agent) starts a task once its result says it went to the background (a foreground Bash
//           call too, when it outlived its timeout and was moved there); a <task-notification> with a
//           <status> ends it, one with only an <event> (a Monitor's) updates it; a TaskStop kills it.
//   codex   Codex. Its threads are in <CODEX_HOME>/state_*.sqlite (every ~/.codex* home), each with a
//           rollout log. An exec_command that outlives its yield keeps running as a process ("Process
//           running with session ID N"), which write_stdin then polls until "Process exited with code X".
//           Such a process is a background task once the agent makes another tool call while it runs;
//           one it only polled until done was a slow foreground command and is left out.
// Logs are read from where the last read stopped (cache $CC_HD_HOME/.panel-bg.json).

// argv[1]: {"runs": [{"dir", "agent": "claude"|"codex", "session", "cwd", "since", "adopted"}]}
//          one entry per main agent of a run; session null: find it. adopted: also the main agents named
//          in the run's handoff packages (runs adopted before meta.json kept them, hd_dispatch.py earlier_mains).
// stdout:  {"runs": {dir: [session]}, "sessions": {session: [task]}}
//          task: {id, use, agent, kind, title, command, started, ended, status, summary, event, output, log, tail}
//          output: a file holding the task's output (claude); log: the output's end as text (codex).
import { fmtDur } from "./stats.js";
export const BG_PY = String.raw`
import glob, json, os, re, sqlite3, sys
from datetime import datetime

req = json.loads(sys.argv[1])
home = os.path.expanduser("~")
claude = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")
projects = os.path.join(claude, "projects")
cache_dir = os.environ.get("CC_HD_HOME") or "/tmp/cc-dispatch"
cache_path = os.path.join(cache_dir, ".panel-bg.json")
try:
    cache = json.load(open(cache_path))
except Exception:
    cache = {}
resolved = cache.get("resolved") if isinstance(cache.get("resolved"), dict) else {}
# v4: adapters (resolved keys are "<agent>|<dir>"); older caches are read again.
fresh = cache.get("v") == 4
logs = cache.get("logs") if isinstance(cache.get("logs"), dict) and fresh else {}
resolved = resolved if fresh else {}
missed = cache.get("missed") if isinstance(cache.get("missed"), dict) and fresh else {}
now_s = int(datetime.now().timestamp())

slug = lambda p: re.sub(r"[^A-Za-z0-9]", "-", p or "")

def epoch_ms(s):
    try:
        return int(datetime.fromisoformat(str(s).replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None

def mentions(path, needle):
    """Whether a file contains the bytes, read in chunks."""
    b, tail = needle.encode(), b""
    try:
        with open(path, "rb") as f:
            while True:
                chunk = f.read(1 << 23)
                if not chunk:
                    return False
                if b in tail + chunk:
                    return True
                tail = chunk[-len(b):]
    except OSError:
        return False

# ---- claude: Claude Code transcripts ----

def claude_find(r):
    folder = os.path.join(projects, slug(r.get("cwd")))
    since = (r.get("since") or 0) / 1000 - 600
    files = [p for p in glob.glob(os.path.join(folder, "*.jsonl")) if os.path.getmtime(p) >= since]
    for p in sorted(files, key=os.path.getmtime, reverse=True):
        if mentions(p, r["dir"]):
            return os.path.basename(p)[:-6]
    return None

def claude_path(sid):
    found = glob.glob(os.path.join(projects, "*", sid + ".jsonl"))
    return found[0] if found else None

TAG = lambda block, name: (re.search("<%s>(.*?)</%s>" % (name, name), block, re.S) or [None, None])[1]
OUT_RE = re.compile(r"Output is being written to: (\S+?\.output)")

def notices(text):
    for block in re.findall(r"<task-notification>(.*?)</task-notification>", text or "", re.S):
        yield {k: (TAG(block, k) or "").strip() or None for k in ("task-id", "tool-use-id", "output-file", "status", "summary", "event")}

def texts(content):
    if isinstance(content, str):
        yield content
    elif isinstance(content, list):
        for b in content:
            if isinstance(b, dict) and b.get("type") == "text":
                yield b.get("text") or ""

KEYS = (b'"tool_use"', b'"tool_result"', b"task-notification")

def claude_scan(path, sid):
    """A transcript's background tasks, reading only what was appended since last time."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return logs.get(path, {}).get("tasks", {})
    e = logs.get(path)
    if not isinstance(e, dict) or size < e.get("off", 0) or "ids" not in e:
        e = {"off": 0, "tasks": {}, "pending": {}, "ids": {}}
    tasks, pending, ids = e["tasks"], e["pending"], e["ids"]
    tasks_dir = os.path.join("/tmp", "claude-%d" % os.getuid(), os.path.basename(os.path.dirname(path)), sid, "tasks")
    if size > e["off"]:
        with open(path, "rb") as f:
            f.seek(e["off"])
            data = f.read()
        end = data.rfind(b"\n")
        if end >= 0:
            for line in data[:end].splitlines():
                if not any(k in line for k in KEYS):
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                kind = ev.get("type")
                if kind not in ("assistant", "user", "attachment", "queue-operation"):
                    continue
                ts = epoch_ms(ev.get("timestamp"))
                content = (ev.get("message") or {}).get("content")
                if kind == "assistant" and isinstance(content, list):
                    for b in content:
                        if not isinstance(b, dict) or b.get("type") != "tool_use":
                            continue
                        i, name = b.get("input") or {}, b.get("name")
                        # A stop (TaskStop; KillShell / KillBash before it) ends its task when it succeeds:
                        # no <task-notification> follows one.
                        if name in ("TaskStop", "KillShell", "KillBash"):
                            target = i.get("task_id") or i.get("shell_id")
                            if target:
                                pending[b.get("id")] = {"stop": target}
                            continue
                        # Every Bash call: one run in the foreground that outlives its timeout is moved to
                        # the background, and only its result says so (backgroundTaskId).
                        if name == "Bash":
                            k = "shell"
                        elif name == "Monitor":
                            k = "monitor"
                        elif name in ("Agent", "Task"):
                            k = "agent"
                        else:
                            continue
                        cmd = i.get("command") or ""
                        if k == "shell" and re.search(r"hd_dispatch\.py[\"']?\s+wait\b", cmd):
                            k = "wait"
                        title = i.get("description") or (cmd.strip().splitlines() or [""])[0][:120] or name
                        pending[b.get("id")] = {"use": b.get("id"), "kind": k, "title": title, "command": cmd[:2000] or None,
                                                "agent": i.get("subagent_type"), "started": ts}
                if kind == "user" and isinstance(content, list):
                    res = ev.get("toolUseResult") if isinstance(ev.get("toolUseResult"), dict) else {}
                    for b in content:
                        if not isinstance(b, dict) or b.get("type") != "tool_result" or b.get("tool_use_id") not in pending:
                            continue
                        t = pending.pop(b["tool_use_id"])
                        if "stop" in t:
                            s = tasks.get(ids.get(t["stop"]))
                            if s and s.get("status") == "running" and not b.get("is_error"):
                                s.update({"status": "killed", "ended": ts, "summary": None})
                            continue
                        tid = res.get("backgroundTaskId") or res.get("taskId") or (res.get("agentId") if res.get("isAsync") else None)
                        if not tid:
                            continue
                        out = None
                        for x in texts(b.get("content")):
                            m = OUT_RE.search(x)
                            out = out or (m and m.group(1))
                        if not out and t["kind"] != "agent":
                            out = os.path.join(tasks_dir, tid + ".output")
                        t.update({"id": tid, "ended": None, "status": "running", "summary": None, "event": None, "output": out})
                        tasks[t["use"]] = t
                        ids[tid] = t["use"]
                # Notifications reach the transcript as a user message, a queued attachment or a queue
                # operation; applying one twice changes nothing.
                bodies = list(texts(content)) if kind == "user" else []
                if kind == "attachment":
                    bodies.append((ev.get("attachment") or {}).get("prompt") or "")
                if kind == "queue-operation":
                    bodies.append(ev.get("content") or "")
                for body in bodies:
                    if not isinstance(body, str):
                        continue
                    for n in notices(body):
                        t = tasks.get(n["tool-use-id"]) or tasks.get(ids.get(n["task-id"]))
                        if not t:
                            continue
                        if n["output-file"] and not t.get("output"):
                            t["output"] = n["output-file"]
                        if n["event"]:
                            t["event"] = n["event"].strip().splitlines()[-1][:300]
                        if n["status"]:
                            t["status"] = n["status"]
                            t["ended"] = t.get("ended") or ts
                            t["summary"] = n["summary"]
            e["off"] += end + 1
    logs[path] = e
    return tasks

ANSI = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]")

END_RE = re.compile(r"^\[(?:exited with code (-?\d+)|killed)\]$")

def ending(path):
    """How a shell's output file says it ended ("completed" / "failed" / "killed", at its mtime), else None.
    Covers ends the transcript never got (a stop it did not record, a lost notification)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 256))
            last = [l.strip() for l in f.read().decode("utf-8", "replace").split("\n") if l.strip()]
        m = END_RE.match(last[-1]) if last else None
        if not m:
            return None
        status = "killed" if m.group(1) is None else "completed" if m.group(1) == "0" else "failed"
        return status, int(os.path.getmtime(path) * 1000)
    except OSError:
        return None

def tail(path, n=2):
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            f.seek(max(0, f.tell() - 4096))
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return []
    return tail_text(text, n)

def tail_text(text, n=2):
    """The last lines of some output, without colours, carriage-return redraws or an end marker."""
    lines = []
    for l in ANSI.sub("", text or "").split("\n"):
        parts = [p for p in l.split("\r") if p.strip()]
        if parts and not END_RE.match(parts[-1].strip()):
            lines.append(parts[-1].rstrip()[:200])
    return lines[-n:]

# ---- codex: Codex rollout logs ----

codex_homes, seen_homes = [], set()
for h in [os.environ.get("CODEX_HOME")] + sorted(glob.glob(os.path.join(home, ".codex*"))):
    if h and os.path.isdir(h) and os.path.realpath(h) not in seen_homes:
        seen_homes.add(os.path.realpath(h)); codex_homes.append(h)

def codex_threads(sql, args):
    rows = []
    for h in codex_homes:
        for db in sorted(glob.glob(os.path.join(h, "state_*.sqlite"))):
            try:
                con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=1)
                rows += con.execute(sql, args).fetchall()
                con.close()
            except sqlite3.Error:
                pass
    return rows

def codex_path(sid):
    for (path,) in codex_threads("select rollout_path from threads where id = ?", (sid,)):
        if path and os.path.exists(path):
            return path
    return None

def codex_find(r):
    # The main agent's thread, not a helper's: helpers' threads start with herdr's <hc …> envelope.
    since = int((r.get("since") or 0) / 1000) - 600
    rows = codex_threads("select id, rollout_path, updated_at from threads where cwd = ? and updated_at >= ? "
                         "and first_user_message not like '<hc %' order by updated_at desc limit 20", (r.get("cwd") or "", since))
    for sid, path, _ in sorted(rows, key=lambda x: -x[2]):
        if path and mentions(path, r["dir"]):
            return sid
    return None

CODEX_RUNNING = re.compile(r"^Process running with session ID (\d+)", re.M)
CODEX_EXITED = re.compile(r"^Process exited with code (-?\d+)", re.M)
CODEX_UNKNOWN = re.compile(r"write_stdin failed: Unknown process id (\d+)")
WAIT_RE = re.compile(r"hd_dispatch\.py[\"']?\s+wait\b")
HEREDOC = re.compile(r"<<-?\s*['\"]?\w+['\"]?\s*$")

def codex_body(o):
    i = o.find("\nOutput:\n")
    return o[i + 9:] if i >= 0 else ""

def command_title(cmd):
    """A command's first line; for a heredoc (python3 - <<'PY'), with its first line that says something."""
    lines = [l.strip() for l in (cmd or "").strip().splitlines() if l.strip()]
    if not lines:
        return "command"
    first = lines[0]
    if HEREDOC.search(first):
        said = next((l for l in lines[1:] if not re.match(r"^(import|from)\s|^#", l)), None)
        if said:
            first = "%s · %s" % (first, said)
    return first[:120]

def codex_scan(path, sid):
    """A rollout's background processes, reading only what was appended since last time."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return logs.get(path, {}).get("tasks", {})
    e = logs.get(path)
    if not isinstance(e, dict) or size < e.get("off", 0) or "procs" not in e:
        e = {"off": 0, "tasks": {}, "pending": {}, "procs": {}}
    tasks, pending, procs = e["tasks"], e["pending"], e["procs"]
    if size > e["off"]:
        with open(path, "rb") as f:
            f.seek(e["off"])
            data = f.read()
        end = data.rfind(b"\n")
        if end >= 0:
            for line in data[:end].splitlines():
                if b'"function_call' not in line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                p = ev.get("payload") or {}
                ts = epoch_ms(ev.get("timestamp"))
                if p.get("type") == "function_call":
                    try:
                        a = json.loads(p.get("arguments") or "{}")
                    except ValueError:
                        a = {}
                    a = a if isinstance(a, dict) else {}
                    poll = a.get("session_id") if p.get("name") == "write_stdin" else None
                    # Any other call while a process runs: the agent went on with it in the background.
                    for t in tasks.values():
                        if t["status"] == "running" and t["proc"] != poll:
                            t["bg"] = True
                    if p.get("name") == "exec_command":
                        cmd = a.get("cmd") or ""
                        pending[p.get("call_id")] = {"use": p.get("call_id"), "kind": "wait" if WAIT_RE.search(cmd) else "shell",
                                                     "title": command_title(cmd), "command": cmd[:2000] or None, "started": ts}
                    elif poll is not None:
                        pending[p.get("call_id")] = {"poll": poll, "kill": "\x03" in str(a.get("chars") or "")}
                elif p.get("type") == "function_call_output":
                    t = pending.pop(p.get("call_id"), None)
                    if not t:
                        continue
                    o = p.get("output")
                    o = o if isinstance(o, str) else json.dumps(o, ensure_ascii=False)
                    if "poll" in t:
                        s = tasks.get(procs.get(str(t["poll"])))
                        if not s or s["status"] != "running":
                            continue
                        s["log"] = (s["log"] + codex_body(o))[-6000:]
                        m = CODEX_EXITED.search(o)
                        if m:
                            code = int(m.group(1))
                            s.update({"status": "killed" if t["kill"] else "completed" if code == 0 else "failed", "ended": ts,
                                      "summary": None if code == 0 else "退出码 %d" % code})
                        elif CODEX_UNKNOWN.search(o):
                            s.update({"status": "lost", "ended": ts})
                        if s["status"] != "running" and not s["bg"]:
                            tasks.pop(s["use"], None)   # a slow foreground command, not background work
                        continue
                    m = CODEX_RUNNING.search(o)
                    if not m:
                        continue
                    t.update({"id": "codex-" + str(t["use"]), "proc": int(m.group(1)), "status": "running", "ended": None,
                              "summary": None, "event": None, "output": None, "log": codex_body(o)[-6000:], "bg": t["kind"] == "wait"})
                    tasks[t["use"]] = t
                    procs[str(t["proc"])] = t["use"]
            # Keep the newest 120 tasks (and their process ids).
            if len(tasks) > 120:
                for k in sorted(tasks, key=lambda k: tasks[k].get("started") or 0)[:-120]:
                    tasks.pop(k)
                live = set(tasks)
                for k in [k for k, v in procs.items() if v not in live]:
                    procs.pop(k)
            e["off"] += end + 1
    logs[path] = e
    return {k: t for k, t in tasks.items() if t.get("bg")}

# ---- one shape for every main agent ----

ADAPTERS = {
    "claude": {"path": claude_path, "find": claude_find, "scan": claude_scan},
    "codex": {"path": codex_path, "find": codex_find, "scan": codex_scan},
}

def agent_key(name):
    """ADAPTERS' key for a program name (claude-code → claude), else None."""
    name = str(name or "").lower()
    return next((k for k in ADAPTERS if k in name), None)

def find(agent, r):
    """The session hd_dispatch.py did not record, remembered once found; a miss is retried after 2 minutes."""
    key = "%s|%s" % (agent, r["dir"])
    if resolved.get(key):
        return resolved[key]
    if now_s - (missed.get(key) or 0) < 120:
        return None
    sid = ADAPTERS[agent]["find"](r)
    if sid:
        resolved[key] = sid
        missed.pop(key, None)
    else:
        missed[key] = now_s
    return sid

packages = cache.get("packages") if isinstance(cache.get("packages"), dict) and fresh else {}

def package_mains(d):
    """[(agent, session)] of the main agents an adopted run's handoff packages name. Each is read once."""
    found = []
    for p in sorted(glob.glob(os.path.join(d, "handoff", "*", "handoff.json"))):
        if p not in packages:
            try:
                frm = json.load(open(p)).get("from") or {}
            except Exception:
                frm = {}
            packages[p] = [agent_key(frm.get("agent")), frm.get("session")]
        agent, sid = packages[p]
        if agent and sid and (agent, sid) not in found:
            found.append((agent, sid))
    return found

out = {"runs": {}, "sessions": {}}
want = {}  # session -> [agent, earliest run start]

def add(d, agent, sid, start):
    if not sid:
        return
    if sid not in out["runs"][d]:
        out["runs"][d].append(sid)
    w = want.setdefault(sid, [agent, start])
    w[1] = min(w[1], start)

for r in req.get("runs", []):
    out["runs"].setdefault(r["dir"], [])
    agent, start = agent_key(r.get("agent")), r.get("since") or 0
    if agent:
        add(r["dir"], agent, r.get("session") or find(agent, r), start)
    if r.get("adopted"):
        for a, sid in package_mains(r["dir"]):
            add(r["dir"], a, sid, start)
for sid, (agent, start) in want.items():
    path = ADAPTERS[agent]["path"](sid)
    if not path:
        continue
    tasks = sorted(ADAPTERS[agent]["scan"](path, sid).values(), key=lambda t: t.get("started") or 0)
    tasks = [dict(t, agent=agent) for t in tasks if (t.get("started") or 0) >= start - 600000][-60:]
    for t in tasks:
        t.pop("bg", None); t.pop("proc", None)
        if t["kind"] in ("shell", "monitor"):
            t["tail"] = tail(t["output"]) if t.get("output") else tail_text(t.get("log"))
        else:
            t["tail"] = []
        end = ending(t["output"]) if t["status"] == "running" and t["kind"] in ("shell", "wait") and t.get("output") else None
        if end:
            t["status"], t["ended"] = end
    out["sessions"][sid] = tasks

# Keep the cache to the transcripts that still exist, at most 40.
keep = sorted(((p, e) for p, e in logs.items() if os.path.exists(p)), key=lambda x: -os.path.getmtime(x[0]))[:40]
try:
    os.makedirs(cache_dir, exist_ok=True)
    tmp = cache_path + ".%d" % os.getpid()
    with open(tmp, "w") as f:
        json.dump({"v": 4, "resolved": resolved, "missed": missed, "logs": dict(keep),
                   "packages": {p: s for p, s in packages.items() if os.path.exists(p)}}, f)
    os.replace(tmp, cache_path)
except OSError:
    pass
print(json.dumps(out))
`;

/**
 * The script's request: one entry per main agent of each run (model.js runMains), with where to look
 * for a session not recorded and when the run began. A program without an adapter is skipped by the script.
 */
export function bgRequest(runs) {
  return {
    runs: runs.flatMap((r) => {
      const mains = r.mains?.length ? r.mains : (r.adopted ? [{ agent: null, session: null }] : []);
      return mains.map((m, i) => ({ dir: r.dir, agent: m.agent, session: m.session, cwd: r.claudeCwd || r.repo || null,
        since: r.startedAt || 0, adopted: Boolean(r.adopted) && i === 0 }));
    }),
  };
}

// A task started a little before its run's first helper (a survey, a build) still belongs to it.
export const BG_GRACE = 5 * 60_000;
export const BG_ENDED_KEPT = 3; // tasks shown at first, running ones included
export const BG_MORE = 5;       // each "earlier" click shows this many more

/**
 * Each run's tasks: a task whose command names one of its session's run folders (hd_dispatch.py
 * wait --run …) belongs to that run; any other to the latest run of the session that started before
 * it (less BG_GRACE). A run's sessions are the ones the script gave for it (`found`: recorded, found or
 * named by a handoff package), else its recorded ones. → { dir: [task] }.
 */
export function assignTasks(runs, found, sessions) {
  const out = {}, bySession = new Map();
  for (const r of runs) {
    const own = found?.[r.dir] ?? (r.mains ?? []).map((m) => m.session);
    for (const sid of new Set(own)) {
      if (!sid) continue;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(r);
    }
  }
  for (const [sid, list] of bySession) {
    list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (const t of sessions?.[sid] ?? []) {
      const cmd = t.command ?? "";
      const named = list.filter((r) => r.dir && cmd.includes(r.dir)).sort((a, b) => b.dir.length - a.dir.length)[0];
      const owner = named ?? [...list].reverse().find((r) => (t.started || 0) >= (r.startedAt || 0) - BG_GRACE);
      if (owner) (out[owner.dir] ??= []).push(t);
    }
  }
  return out;
}

/**
 * What a run shows of its tasks: the running ones (oldest first, always all of them), then the
 * ended ones newest first, filling up to BG_ENDED_KEPT rows in all, plus `more` earlier ones.
 * `waiting`: hd_dispatch.py wait is running (the helper rows already say what it waits on). With
 * the dispatching Claude gone, a task that never reported its end is "lost".
 */
export function bgView(tasks, mainLive, more = 0) {
  const list = (tasks ?? []).map((t) => (t.status === "running" && !mainLive ? { ...t, status: "lost" } : t));
  const waiting = list.some((t) => t.kind === "wait" && t.status === "running");
  const shown = list.filter((t) => t.kind !== "wait");
  const running = shown.filter((t) => t.status === "running");
  const ended = shown.filter((t) => t.status !== "running").sort((a, b) => (b.ended || b.started || 0) - (a.ended || a.started || 0));
  const base = Math.max(0, BG_ENDED_KEPT - running.length), n = base + Math.max(0, more);
  return { waiting, running, ended: ended.slice(0, n), hidden: Math.max(0, ended.length - n), more: Math.min(Math.max(0, more), Math.max(0, ended.length - base)) };
}

export const BG_KIND = { shell: "shell", monitor: "monitor", agent: "agent", wait: "wait" };

/** A notification's summary without the task's title the row already shows. */
export function bgSummary(t) {
  const rest = String(t.summary ?? "").replace(/^(Background command|Agent|Monitor|Task)\s+"[^"]*"\s*/i, "").trim();
  return rest && !/^(completed|failed|killed|stopped)\.?$/i.test(rest) ? rest : "";
}

// ---- A running task, live ----
// Most commands print nothing until they end (or their output is captured by $(...) or | tail), so
// a running task's output file is often empty. What it is doing shows in its processes: the shell
// Claude Code started holds the output file open (lsof), and its descendants are the work.

/** argv: the output file. Prints SIZE/MTIME/NOW/PIDS, the whole process table, then the file's end. */
export const LIVE_SCRIPT = `f="$1"
if [ -f "$f" ]; then echo "SIZE=$(wc -c < "$f" | tr -d ' ')"; echo "MTIME=$(date -r "$f" +%s 2>/dev/null)"; else echo "SIZE=-1"; fi
echo "NOW=$(date +%s)"
echo "PIDS=$(lsof -t -- "$f" 2>/dev/null | tr '\\n' ' ')"
echo "--PS--"
ps -Ao pid=,ppid=,stat=,etime=,time=,%cpu=,command= 2>/dev/null
echo "--TAIL--"
[ -f "$f" ] && tail -c 24000 "$f"
exit 0`;

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** LIVE_SCRIPT's output → { size, mtime, now, procs: [{pid, ppid, stat, etime, time, cpu, command, depth}], tail }. */
export function parseLive(text) {
  const s = String(text ?? "");
  const ps = s.indexOf("\n--PS--\n"), tl = s.indexOf("\n--TAIL--\n");
  const head = s.slice(0, ps < 0 ? s.length : ps);
  const kv = Object.fromEntries(head.split("\n").map((l) => l.match(/^([A-Z]+)=(.*)$/)).filter(Boolean).map((m) => [m[1], m[2].trim()]));
  const num = (v) => (v === undefined || v === "" ? null : Number(v));
  const table = ps < 0 ? "" : s.slice(ps + 8, tl < 0 ? s.length : tl);
  const all = [];
  for (const l of table.split("\n")) {
    const m = l.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+([\d.]+)\s+(.*)$/);
    if (m) all.push({ pid: +m[1], ppid: +m[2], stat: m[3], etime: m[4], time: m[5], cpu: +m[6], command: m[7].trim() });
  }
  const held = new Set(String(kv.PIDS ?? "").split(/\s+/).filter(Boolean).map(Number));
  const kids = new Map();
  for (const p of all) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
  const procs = [], seen = new Set();
  const walk = (p, depth) => {
    if (seen.has(p.pid)) return;
    seen.add(p.pid); procs.push({ ...p, depth });
    for (const c of kids.get(p.pid) ?? []) walk(c, depth + 1);
  };
  for (const p of all) if (held.has(p.pid) && !held.has(p.ppid)) walk(p, 0);
  const tail = tl < 0 ? "" : s.slice(tl + 10).replace(ANSI_RE, "");
  return { size: num(kv.SIZE), mtime: num(kv.MTIME), now: num(kv.NOW), procs, tail };
}

const STATE_WORDS = { R: "运行", S: "休眠", I: "空闲", D: "等磁盘", U: "等磁盘", T: "已停止", Z: "僵尸" };
/** Pads to a display width: CJK characters take two columns in a monospace block. */
const width = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0);
const padW = (s, n) => String(s) + " ".repeat(Math.max(0, n - width(s)));
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
// Claude Code's shell runs `source <snapshot> && … && eval '<command>'`: show the command.
// Executables lose their folder (/…/bin/node → node).
const shortCommand = (cmd, task) => (/shell-snapshots\//.test(cmd) ? `sh: ${task?.command ?? "（命令）"}` : cmd.replace(/^\S*\/(\S+)/, "$1")).replace(/\s+/g, " ");

/** The live dialog's markdown: a verdict line, the process tree, then the output's end. */
export function liveMarkdown(task, live) {
  const now = (live.now ?? Date.now() / 1000) * 1000;
  const out = [];
  const age = task.started ? fmtDur(now - task.started) : "";
  const quiet = live.mtime != null ? now - live.mtime * 1000 : null;
  const written = live.size < 0 ? "没有输出文件" : live.size === 0 ? "暂时没有输出" : `输出 ${fmtBytes(live.size)}，${fmtDur(quiet)} 前最后写入`;
  out.push(`**已运行 ${age}** · ${written}`);
  const procs = live.procs;
  if (!procs.length) {
    out.push("", "没有进程占着输出文件：任务可能刚结束（面板几秒内会更新），也可能在别的机器上运行。");
  } else {
    const busy = procs.filter((p) => p.stat[0] === "R" || p.cpu >= 20).sort((a, b) => b.cpu - a.cpu);
    const top = busy[0];
    const hint = top
      ? `在忙：\`${shortCommand(top.command, task).slice(0, 80)}\` 占用 ${top.cpu.toFixed(0)}% CPU，正在计算；如果比平时久很多，可能陷入了死循环。`
      : procs.some((p) => /^[DU]/.test(p.stat)) ? "在等磁盘。"
      : quiet != null && quiet > 300_000 ? `${procs.length} 个进程都空闲，${fmtDur(quiet)} 没有写入：在等什么（网络、锁、服务、输入），或者卡住了。`
      : `${procs.length} 个进程都空闲：在等什么（子进程、网络、定时器）。`;
    out.push("", hint, "", "~~~~");
    const w = { pid: Math.max(3, ...procs.map((p) => String(p.pid).length)), etime: Math.max(7, ...procs.map((p) => p.etime.length)), time: Math.max(8, ...procs.map((p) => p.time.length)) };
    out.push(`${"PID".padEnd(w.pid)}  ${padW("状态", 9)}  ${"CPU%".padStart(5)}  ${"CPU TIME".padStart(w.time)}  ${"ELAPSED".padStart(w.etime)}  COMMAND`);
    for (const p of procs) {
      const cmd = `${"  ".repeat(p.depth)}${p.depth ? "└ " : ""}${shortCommand(p.command, task)}`;
      out.push(`${String(p.pid).padEnd(w.pid)}  ${padW(STATE_WORDS[p.stat[0]] ?? p.stat, 9)}  ${p.cpu.toFixed(1).padStart(5)}  ${p.time.padStart(w.time)}  ${p.etime.padStart(w.etime)}  ${cmd.slice(0, 160)}`);
    }
    out.push("~~~~");
  }
  const lines = live.tail.replace(/\r(?!\n)/g, "\n").split("\n");
  const tail = lines.slice(-120).join("\n").replace(/\s+$/, "");
  out.push("", "**输出**", "");
  out.push(tail ? `~~~~\n${tail}\n~~~~` : "_还没有输出。很多命令要结束时才打印，或者输出被 `$(...)`、`| tail` 截走了；上面的进程能看出它在做什么。_");
  return out.join("\n");
}
