// What each helper spent: tokens, shell commands and patched files from its Codex session log, plus
// a dev run's cards from state.json. No Herdr imports: herdr/tests/stats.test.mjs runs it under node.
//
// A helper's Codex threads are the ones whose first message names one of its task files
// (<agent_dir>/task-1.md, or task-<k>.md for a round a handover started; hd_dispatch.py's FIRST_MSG); Codex records threads in
// <CODEX_HOME>/state_*.sqlite. Every ~/.codex* home is searched, since the helper templates may run
// Codex with their own CODEX_HOME. Session logs are read from where the last read stopped (a cache
// in $CC_HD_HOME, default /tmp/cc-dispatch), so polling a long session stays cheap.
//
// A helper that ran as Claude Code (a handover, hd_dispatch.py launch) also has its transcripts,
// ~/.claude/projects/*/<session>.jsonl for each of meta.json's claude_sessions; their usage is counted in
// the same shape (input includes cache reads and writes, cached = cache reads).
//
// hd_dispatch.py appends a "codex" event with the totals over all of them to <agent_dir>/events.jsonl each
// time a helper settles. A closed helper's last one is taken as is (its Codex logs may be gone by now); a
// live helper's gives the rollout paths, so the sqlite search is skipped. A handover after the last one
// voids it: the new session is not in it yet.

// argv[1]: {"calls": [{"key", "needle", "events", "live", "claude": [session], "cwd"}], "runs": [dir, ...]}
// stdout:  {"calls": {key: {tokens, model, commands, files, first, last}},
//           "runs": {dir: {status: {card: status}, cards: {card: {status, title, note, result, parked_why, by,
//                       depends_on}}, checks: n}},
//           "finished": {dir: epoch s},   runs whose state.json the main agent marked "finished"
//           "pending": {dir: {key: text}}} an older run's state.json pending_decisions (model.js pendingItems)
// A dev run's cards come from its state.json tasks. Review calls (<card>-check-r<k>, "check": true) and the
// survey are not cards to merge: they are counted in checks and left out, so they never sit in a stage.
export const STATS_PY = String.raw`
import glob, json, os, re, sqlite3, sys
from datetime import datetime

req = json.loads(sys.argv[1])
home = os.path.expanduser("~")
homes, seen = [], set()
for h in [os.environ.get("CODEX_HOME")] + sorted(glob.glob(os.path.join(home, ".codex*"))):
    if h and os.path.isdir(h) and os.path.realpath(h) not in seen:
        seen.add(os.path.realpath(h)); homes.append(h)

cache_dir = os.environ.get("CC_HD_HOME") or "/tmp/cc-dispatch"
cache_path = os.path.join(cache_dir, ".panel-stats.json")
try:
    cache = json.load(open(cache_path))
except Exception:
    cache = {}
logs = cache.get("logs") if isinstance(cache.get("logs"), dict) else {}

def epoch_ms(s):
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp() * 1000)
    except Exception:
        return None

def threads():
    """needle -> rollout paths, from every Codex home's thread table."""
    found = {c["needle"]: [] for c in req.get("calls_to_find", [])}
    if not found:
        return found
    for h in homes:
        for db in sorted(glob.glob(os.path.join(h, "state_*.sqlite"))):
            try:
                con = sqlite3.connect("file:%s?mode=ro" % db, uri=True, timeout=1)
                for needle in found:
                    for (path,) in con.execute("select rollout_path from threads where instr(first_user_message, ?) > 0 order by created_at", (needle,)):
                        if path and path not in found[needle]:
                            found[needle].append(path)
                con.close()
            except sqlite3.Error:
                pass
    return found

KEYS = (b'"token_count"', b'"function_call"', b'"custom_tool_call"', b'"local_shell_call"', b'"turn_context"', b'"session_meta"')

def patched(text, files):
    for line in (text or "").splitlines():
        for head in ("*** Add File: ", "*** Update File: ", "*** Delete File: ", "*** Move to: "):
            if line.startswith(head):
                files.add(line[len(head):].strip())

def scan(path):
    """One session log's totals, reading only what was appended since last time."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return logs.get(path)
    e = logs.get(path)
    if not isinstance(e, dict) or size < e.get("off", 0):
        e = {"off": 0, "commands": 0, "files": [], "tokens": None, "model": None, "first": None, "last": None}
    if size > e["off"]:
        with open(path, "rb") as f:
            f.seek(e["off"])
            data = f.read()
        end = data.rfind(b"\n")
        if end >= 0:
            files = set(e["files"])
            for line in data[:end].splitlines():
                if not any(k in line for k in KEYS):
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                ts = epoch_ms(ev.get("timestamp") or "")
                if ts:
                    e["first"] = e["first"] or ts
                    e["last"] = ts
                p = ev.get("payload") or {}
                kind, name = p.get("type"), p.get("name")
                if ev.get("type") == "turn_context":
                    e["model"] = p.get("model") or e["model"]
                elif kind == "token_count":
                    total = (p.get("info") or {}).get("total_token_usage")
                    if total:
                        e["tokens"] = {k: total.get(k) or 0 for k in ("input_tokens", "cached_input_tokens", "cache_write_input_tokens", "output_tokens")}
                elif kind == "local_shell_call" or (kind == "function_call" and name in ("exec_command", "shell", "container.exec")):
                    e["commands"] += 1
                elif kind == "custom_tool_call" and name == "apply_patch":
                    patched(p.get("input"), files)
                elif kind == "function_call" and name == "apply_patch":
                    try:
                        patched(json.loads(p.get("arguments") or "{}").get("input"), files)
                    except (ValueError, AttributeError):
                        pass
            e["files"] = sorted(files)
            e["off"] += end + 1
    logs[path] = e
    return e

def snapshot(path):
    """The last codex event in a call's events.jsonl, or None; None too when a handover came after it
    (a new session the event does not count yet)."""
    last = None
    try:
        with open(path, "rb") as f:
            for line in f:
                if b'"ev": "codex"' in line or b'"ev":"codex"' in line:
                    last = line
                elif b'"ev": "handover"' in line or b'"ev":"handover"' in line:
                    last = None
        return json.loads(last) if last else None
    except (OSError, ValueError):
        return None

claude_root = os.path.join(os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude"), "projects")

def transcript(session, cwd):
    """A Claude Code session's transcript path, or None."""
    if cwd:
        p = os.path.join(claude_root, "".join(ch if ch.isalnum() else "-" for ch in cwd), session + ".jsonl")
        if os.path.exists(p):
            return p
    found = sorted(glob.glob(os.path.join(claude_root, "*", session + ".jsonl")))
    return found[0] if found else None

def usage_tokens(x):
    read, write = x.get("cache_read_input_tokens") or 0, x.get("cache_creation_input_tokens") or 0
    return {"input_tokens": (x.get("input_tokens") or 0) + read + write, "cached_input_tokens": read,
            "cache_write_input_tokens": write, "output_tokens": x.get("output_tokens") or 0}

CLAUDE_WRITES = ("Edit", "Write", "MultiEdit", "NotebookEdit")

def scan_claude(path):
    """A Claude Code transcript's totals in the Codex log's shape, read from where the last read stopped.
    A message is logged once per content block with the same usage: an id seen lately counts once."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return logs.get(path)
    e = logs.get(path)
    if not isinstance(e, dict) or size < e.get("off", 0) or "recent" not in e:
        e = {"off": 0, "commands": 0, "files": [], "tokens": None, "model": None, "first": None, "last": None, "recent": {}}
    if size > e["off"]:
        with open(path, "rb") as f:
            f.seek(e["off"])
            data = f.read()
        end = data.rfind(b"\n")
        if end >= 0:
            files = set(e["files"])
            for line in data[:end].splitlines():
                if b'"assistant"' not in line:
                    continue
                try:
                    ev = json.loads(line)
                except ValueError:
                    continue
                m = ev.get("message")
                if ev.get("type") != "assistant" or not isinstance(m, dict):
                    continue
                ts = epoch_ms(ev.get("timestamp") or "")
                if ts:
                    e["first"] = e["first"] or ts
                    e["last"] = ts
                e["model"] = m.get("model") or e["model"]
                if m.get("usage"):
                    new = usage_tokens(m["usage"])
                    tot = e["tokens"] or {k: 0 for k in new}
                    old = e["recent"].pop(m.get("id") or "", None) or {k: 0 for k in new}
                    e["tokens"] = {k: tot[k] - old[k] + new[k] for k in new}
                    if m.get("id"):
                        e["recent"][m["id"]] = new
                        while len(e["recent"]) > 20:
                            e["recent"].pop(next(iter(e["recent"])))
                for b in m.get("content") or []:
                    if isinstance(b, dict) and b.get("type") == "tool_use":
                        inp = b.get("input") if isinstance(b.get("input"), dict) else {}
                        if b.get("name") == "Bash":
                            e["commands"] += 1
                        elif b.get("name") in CLAUDE_WRITES and (inp.get("file_path") or inp.get("notebook_path")):
                            files.add(inp.get("file_path") or inp.get("notebook_path"))
            e["files"] = sorted(files)
            e["off"] += end + 1
    logs[path] = e
    return e

out = {"calls": {}, "runs": {}, "finished": {}, "pending": {}}
snaps = {c["key"]: snapshot(c["events"]) for c in req.get("calls", []) if c.get("events")}
known = {c["needle"]: [p for p in (snaps.get(c["key"]) or {}).get("rollouts") or [] if os.path.exists(p)] for c in req.get("calls", [])}
req["calls_to_find"] = [c for c in req.get("calls", []) if not known.get(c["needle"])]
found = threads()
for c in req.get("calls", []):
    snap = snaps.get(c["key"])
    if snap and not c.get("live"):
        out["calls"][c["key"]] = {k: snap.get(k) for k in ("tokens", "model", "commands", "files", "first", "last", "sessions")}
        continue
    s = {"tokens": None, "model": None, "commands": 0, "files": 0, "first": None, "last": None, "sessions": 0}
    names = set()
    paths = [(scan, p) for p in known.get(c["needle"]) or found.get(c["needle"], [])]
    paths += [(scan_claude, p) for p in (transcript(x, c.get("cwd")) for x in c.get("claude") or []) if p]
    for read, path in paths:
        e = read(path)
        if not e:
            continue
        s["sessions"] += 1
        s["commands"] += e["commands"]
        names.update(e["files"])
        s["model"] = e["model"] or s["model"]
        s["first"] = min(x for x in (s["first"], e["first"]) if x) if (s["first"] or e["first"]) else None
        s["last"] = max(s["last"] or 0, e["last"] or 0) or None
        if e["tokens"]:
            t = {"input": e["tokens"]["input_tokens"], "cached": e["tokens"]["cached_input_tokens"],
                 "cache_write": e["tokens"]["cache_write_input_tokens"], "output": e["tokens"]["output_tokens"]}
            prev = s["tokens"] or {"input": 0, "cached": 0, "cache_write": 0, "output": 0}
            s["tokens"] = {k: prev[k] + t[k] for k in prev}
    s["files"] = len(names)
    out["calls"][c["key"]] = s

for d in req.get("runs", []):
    try:
        state = json.load(open(os.path.join(d, "state.json")))
        state = state if isinstance(state, dict) else {}
    except Exception:
        state = {}
    if state.get("finished"):  # the main agent marked the run done (herdr.md)
        out["finished"][d] = state["finished"]
    pend = state.get("pending_decisions")
    if isinstance(pend, dict) and pend:
        out["pending"][d] = {str(k): v if isinstance(v, str) else json.dumps(v, ensure_ascii=False) for k, v in pend.items()}
    tasks = state.get("tasks")
    if isinstance(tasks, dict) and tasks:
        cards, checks = {}, 0
        for k, v in tasks.items():
            if not isinstance(v, dict):
                continue
            if re.search(r"-check-r\d+$", k) or k == "survey" or v.get("check"):
                checks += 1
                continue
            card = {f: v[f] for f in ("title", "note", "result", "parked_why", "by") if isinstance(v.get(f), str) and v[f]}
            card["status"] = str(v.get("status") or "")
            deps = v.get("depends_on")
            if isinstance(deps, list):
                card["depends_on"] = [str(x) for x in deps]
            cards[k] = card
        out["runs"][d] = {"status": {k: c["status"] for k, c in cards.items()}, "cards": cards, "checks": checks}

# Keep the cache to the logs that still exist, newest first, at most 400.
keep = sorted(((p, e) for p, e in logs.items() if os.path.exists(p)), key=lambda x: -(x[1].get("last") or 0))[:400]
try:
    os.makedirs(cache_dir, exist_ok=True)
    tmp = cache_path + ".%d" % os.getpid()
    with open(tmp, "w") as f:
        json.dump({"logs": dict(keep)}, f)
    os.replace(tmp, cache_path)
except OSError:
    pass
print(json.dumps(out))
`;

/** What the stats script needs for one call: the text its Codex thread's first message contains. */
export const needleOf = (c) => `${c.agentDir}/task-`;  // task-1.md, or the round a handover started
/** hd_dispatch.py's event log for one call. */
export const eventsOf = (c) => `${c.agentDir}/events.jsonl`;

/** The script's request for these runs' calls. */
export function statsRequest(runs) {
  return {
    calls: runs.flatMap((r) => r.calls.map((c) => ({
      key: c.key, needle: needleOf(c), events: eventsOf(c), live: c.state === "live",
      claude: c.claudeSessions ?? [], cwd: c.workdir || c.dir || "",
    }))),
    runs: runs.map((r) => r.dir),
  };
}

const sumTokens = (list) => list.reduce((a, t) => t ? {
  input: a.input + t.input, cached: a.cached + t.cached, cache_write: a.cache_write + t.cache_write, output: a.output + t.output,
} : a, { input: 0, cached: 0, cache_write: 0, output: 0 });

/**
 * One run's totals from its calls' stats: tokens split into cached / new input / output,
 * commands, files, elapsed time, and cards.
 */
export function runTotals(run, callStats, cards, now = Date.now()) {
  const list = run.calls.map((c) => callStats?.[c.key]).filter(Boolean);
  const withTokens = list.filter((s) => s.tokens);
  const t = sumTokens(withTokens.map((s) => s.tokens));
  const lasts = list.map((s) => s.last).filter(Boolean);
  const start = run.startedAt || Math.min(...list.map((s) => s.first || Infinity));
  const end = run.live ? now : (lasts.length ? Math.max(...lasts) : 0);
  return {
    tokens: withTokens.length ? { cached: t.cached, fresh: Math.max(0, t.input - t.cached), output: t.output, total: t.input + t.output } : null,
    commands: list.reduce((n, s) => n + (s.commands || 0), 0),
    files: list.reduce((n, s) => n + (s.files || 0), 0),
    elapsed: Number.isFinite(start) && start > 0 && end > start ? end - start : null,
    cards: cards ?? null,
    known: list.length > 0,
  };
}

/** Topic totals count each call once and merge overlapping run intervals instead of adding them. */
export function topicTotals(stats, topic) {
  const seenRuns = new Set(), seenCalls = new Set(), intervals = [], now = Date.now();
  const out = { tokens: null, commands: 0, files: 0, elapsed: null, cards: null, known: false };
  for (const run of topic?.runs ?? []) {
    if (seenRuns.has(run.dir)) continue;
    seenRuns.add(run.dir);
    const calls = run.calls.filter((c) => {
      if (seenCalls.has(c.key)) return false;
      seenCalls.add(c.key);
      return true;
    });
    const totals = runTotals({ ...run, calls }, stats?.calls, stats?.runs?.[run.dir], now);
    out.known ||= totals.known;
    out.commands += totals.commands;
    out.files += totals.files;
    if (totals.tokens) {
      out.tokens ??= { cached: 0, fresh: 0, output: 0, total: 0 };
      for (const key of Object.keys(out.tokens)) out.tokens[key] += totals.tokens[key];
    }
    if (totals.cards) {
      out.cards ??= { status: {}, cards: {}, checks: 0 };
      for (const [id, status] of Object.entries(totals.cards.status ?? {})) out.cards.status[`${run.dir}#${id}`] = status;
      for (const [id, card] of Object.entries(totals.cards.cards ?? {})) out.cards.cards[`${run.dir}#${id}`] = card;
      out.cards.checks += totals.cards.checks || 0;
    }
    // Use all of a run's calls for its interval even if another run already counted their spend.
    const interval = runTotals(run, stats?.calls, null, now);
    if (interval.elapsed != null) {
      const lasts = run.calls.map((c) => stats?.calls?.[c.key]?.last).filter(Boolean);
      const end = run.live ? now : Math.max(...lasts);
      intervals.push([end - interval.elapsed, end]);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let end = 0;
  for (const [start, last] of intervals) {
    out.elapsed = (out.elapsed ?? 0) + Math.max(0, last - Math.max(start, end));
    end = Math.max(end, last);
  }
  return out;
}

/** 144.6M, 9.4K, 812. */
export function fmtTok(n) {
  if (n == null) return "";
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/** 9h11m, 4m, 35s. */
export function fmtDur(ms) {
  if (ms == null) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d${h % 24}h`;
}

/** One call's spend in a few words, for its row: "13.5M tok · 101 条命令 · 20 个文件". */
export function callSpend(s) {
  if (!s || (!s.tokens && !s.commands)) return "";
  const t = s.tokens ? s.tokens.input + s.tokens.output : null;
  return [t != null && `${fmtTok(t)} tok`, s.commands && `${s.commands} 条命令`, s.files && `${s.files} 个文件`]
    .filter(Boolean).join(" · ");
}
