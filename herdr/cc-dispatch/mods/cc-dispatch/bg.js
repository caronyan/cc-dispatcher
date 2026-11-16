// The dispatching Claude's background tasks: shells started with run_in_background, Monitors and
// async Agents, read from its Claude Code transcript. No Herdr imports: herdr/tests/bg.test.mjs
// runs it under node.
//
// hd_dispatch.py run records the dispatching Claude's session (CLAUDE_CODE_SESSION_ID) in each
// helper's meta.json; the transcript is ~/.claude/projects/<slug>/<session>.jsonl. Runs from before
// that have no session: the newest transcript under the Claude's folder that names the run folder
// is taken. A tool_use starts a task once its result says it went to the background (a foreground
// Bash call too, when it outlived its timeout and was moved there); a <task-notification> with a
// <status> ends it, one with only an <event> (a Monitor's) updates it.
// Transcripts are read from where the last read stopped (cache $CC_HD_HOME/.panel-bg.json).

// argv[1]: {"runs": [{"dir", "session", "cwd", "since"}]}
// stdout:  {"resolved": {dir: session}, "sessions": {session: [task]}}
//          task: {id, use, kind, title, command, started, ended, status, summary, event, output, tail}
import { fmtDur } from "./stats.js";
export const BG_PY = String.raw`
import glob, json, os, re, sys
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
# v3 also takes foreground shells moved to the background, and stops: older caches read past them.
logs = cache.get("logs") if isinstance(cache.get("logs"), dict) and cache.get("v") == 3 else {}

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

def find_session(r):
    if r.get("session"):
        return r["session"]
    if resolved.get(r["dir"]):
        return resolved[r["dir"]]
    folder = os.path.join(projects, slug(r.get("cwd")))
    since = (r.get("since") or 0) / 1000 - 600
    files = [p for p in glob.glob(os.path.join(folder, "*.jsonl")) if os.path.getmtime(p) >= since]
    for p in sorted(files, key=os.path.getmtime, reverse=True):
        if mentions(p, r["dir"]):
            sid = os.path.basename(p)[:-6]
            resolved[r["dir"]] = sid
            return sid
    return None

def transcript(sid):
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

def scan(path, sid):
    """A transcript's background tasks, reading only what was appended since last time."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return logs.get(path, {}).get("tasks", {})
    e = logs.get(path)
    if not isinstance(e, dict) or size < e.get("off", 0):
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
    lines = []
    for l in ANSI.sub("", text).split("\n"):
        parts = [p for p in l.split("\r") if p.strip()]
        if parts and not END_RE.match(parts[-1].strip()):
            lines.append(parts[-1].rstrip()[:200])
    return lines[-n:]

out = {"resolved": {}, "sessions": {}}
since = {}
for r in req.get("runs", []):
    sid = find_session(r)
    out["resolved"][r["dir"]] = sid
    if sid:
        since[sid] = min(since.get(sid, r.get("since") or 0), r.get("since") or 0)
for sid, start in since.items():
    path = transcript(sid)
    if not path:
        continue
    tasks = sorted(scan(path, sid).values(), key=lambda t: t.get("started") or 0)
    tasks = [dict(t) for t in tasks if (t.get("started") or 0) >= start - 600000][-60:]
    for t in tasks:
        t["tail"] = tail(t["output"]) if t.get("output") and t["kind"] in ("shell", "monitor") else []
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
        json.dump({"v": 3, "resolved": resolved, "logs": dict(keep)}, f)
    os.replace(tmp, cache_path)
except OSError:
    pass
print(json.dumps(out))
`;

/** The script's request: each run's dispatching Claude Code session, where to look for it, and when it began. */
export function bgRequest(runs) {
  return {
    // A run whose main agents were all something else (Codex, …) has no Claude transcript to look for.
    runs: runs.filter((r) => r.sessions?.length || r.session || !r.mainAgent || /claude/i.test(r.mainAgent))
      .flatMap((r) => (r.sessions?.length ? r.sessions : [r.session || null])
      .map((session) => ({ dir: r.dir, session, cwd: r.claudeCwd || r.repo || null, since: r.startedAt || 0 }))),
  };
}

// A task started a little before its run's first helper (a survey, a build) still belongs to it.
export const BG_GRACE = 5 * 60_000;
export const BG_ENDED_KEPT = 3; // tasks shown at first, running ones included
export const BG_MORE = 5;       // each "earlier" click shows this many more

/**
 * Each run's tasks: a task belongs to the latest run of the same session that started before it
 * (less BG_GRACE). A run's sessions are all its main agents' (`sessions`), else the one the script
 * found for it. → { dir: [task] }.
 */
export function assignTasks(runs, resolved, sessions) {
  const out = {}, bySession = new Map();
  for (const r of runs) {
    for (const sid of r.sessions?.length ? r.sessions : [resolved?.[r.dir]]) {
      if (!sid) continue;
      if (!bySession.has(sid)) bySession.set(sid, []);
      bySession.get(sid).push(r);
    }
  }
  for (const [sid, list] of bySession) {
    list.sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
    for (const t of sessions?.[sid] ?? []) {
      const owner = [...list].reverse().find((r) => (t.started || 0) >= (r.startedAt || 0) - BG_GRACE);
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
export function bgView(tasks, claudeLive, more = 0) {
  const list = (tasks ?? []).map((t) => (t.status === "running" && !claudeLive ? { ...t, status: "lost" } : t));
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

const STATE_WORDS = { R: "running", S: "sleeping", I: "idle", D: "disk wait", U: "disk wait", T: "stopped", Z: "zombie" };
const fmtBytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);
// Claude Code's shell runs `source <snapshot> && … && eval '<command>'`: show the command.
// Executables lose their folder (/…/bin/node → node).
const shortCommand = (cmd, task) => (/shell-snapshots\//.test(cmd) ? `sh: ${task?.command ?? "(command)"}` : cmd.replace(/^\S*\/(\S+)/, "$1")).replace(/\s+/g, " ");

/** The live dialog's markdown: a verdict line, the process tree, then the output's end. */
export function liveMarkdown(task, live) {
  const now = (live.now ?? Date.now() / 1000) * 1000;
  const out = [];
  const age = task.started ? fmtDur(now - task.started) : "";
  const quiet = live.mtime != null ? now - live.mtime * 1000 : null;
  const written = live.size < 0 ? "no output file" : live.size === 0 ? "output empty so far" : `output ${fmtBytes(live.size)}, last written ${fmtDur(quiet)} ago`;
  out.push(`**running ${age}** · ${written}`);
  const procs = live.procs;
  if (!procs.length) {
    out.push("", "No process holds the output file: the task may just have ended (the panel updates within seconds), or it runs on another machine.");
  } else {
    const busy = procs.filter((p) => p.stat[0] === "R" || p.cpu >= 20).sort((a, b) => b.cpu - a.cpu);
    const top = busy[0];
    const hint = top
      ? `Busy: \`${shortCommand(top.command, task).slice(0, 80)}\` at ${top.cpu.toFixed(0)}% CPU. It is computing; if this lasts far longer than usual it may be looping.`
      : procs.some((p) => /^[DU]/.test(p.stat)) ? "Waiting on disk."
      : quiet != null && quiet > 300_000 ? `All ${procs.length} processes idle and nothing written for ${fmtDur(quiet)}: waiting on something (network, a lock, a server, input) or stuck.`
      : `All ${procs.length} processes idle: waiting on something (a child, the network, a timer).`;
    out.push("", hint, "", "~~~~");
    const w = { pid: Math.max(3, ...procs.map((p) => String(p.pid).length)), etime: Math.max(7, ...procs.map((p) => p.etime.length)), time: Math.max(8, ...procs.map((p) => p.time.length)) };
    out.push(`${"PID".padEnd(w.pid)}  ${"STATE".padEnd(9)}  ${"CPU%".padStart(5)}  ${"CPU TIME".padStart(w.time)}  ${"ELAPSED".padStart(w.etime)}  COMMAND`);
    for (const p of procs) {
      const cmd = `${"  ".repeat(p.depth)}${p.depth ? "└ " : ""}${shortCommand(p.command, task)}`;
      out.push(`${String(p.pid).padEnd(w.pid)}  ${(STATE_WORDS[p.stat[0]] ?? p.stat).padEnd(9)}  ${p.cpu.toFixed(1).padStart(5)}  ${p.time.padStart(w.time)}  ${p.etime.padStart(w.etime)}  ${cmd.slice(0, 160)}`);
    }
    out.push("~~~~");
  }
  const lines = live.tail.replace(/\r(?!\n)/g, "\n").split("\n");
  const tail = lines.slice(-120).join("\n").replace(/\s+$/, "");
  out.push("", "**Output**", "");
  out.push(tail ? `~~~~\n${tail}\n~~~~` : "_Nothing yet. Many commands print only when they end, or their output is captured by `$(...)` or `| tail`; the processes above show what it is doing._");
  return out.join("\n");
}
