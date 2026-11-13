// What the cc-dispatch panel shows, from the run folders' meta.json files and herdr-core's live
// terminals. No Herdr imports: herdr/tests/model.test.mjs runs it under node.
//
// A run is <repo>/.cc-dispatch/<kind>-<run>/; each helper ("call") keeps its state in
// agents/<call>/meta.json (written by shared/scripts/hd_dispatch.py). A live helper terminal also
// carries labels cc.run, cc.call, cc.kind, cc.dir, cc.mode, cc.round, cc.report, cc.failure, cc.retry; the
// labels are fresher than meta.json while it lives, meta.json is all that is left after.
// A run the person paused or stopped from the panel has <run>/control.json (hd_dispatch.py pause,
// resume, stop): that is the run's state, a different thing from any helper's.

export const KINDS = ["research", "review", "dev", "fix", "test", "probe", "retro"];
export const SEP = "@@cc-dispatch-meta ";
export const CONTROL_SEP = "@@cc-dispatch-control ";

// The shell script the loader runs: every run's control.json, each introduced by a CONTROL_SEP line
// with its path, then every meta.json under the given run-parent folders, each introduced by a SEP line.
export const LIST_SCRIPT = [
  'for root in "$@"; do',
  '  for f in "$root"/*/control.json; do',
  '    [ -f "$f" ] || continue',
  `    printf '\\n${CONTROL_SEP}%s\\n' "$f"`,
  '    cat "$f"',
  '  done',
  'done',
  'for root in "$@"; do',
  '  for f in "$root"/*/agents/*/meta.json; do',
  '    [ -f "$f" ] || continue',
  `    printf '\\n${SEP}%s\\n' "$f"`,
  '    cat "$f"',
  '  done',
  'done',
].join("\n");

// Paths that exist, one per line, from the arguments.
export const EXISTS_SCRIPT = 'for p in "$@"; do [ -e "$p" ] && printf "%s\\n" "$p"; done; true';

export function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

/** The SEP-separated dump of meta.json files → [{ path, meta }], skipping unreadable ones. */
export function parseMetaDump(text) {
  const out = [];
  for (const chunk of String(text ?? "").split(SEP).slice(1)) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const path = chunk.slice(0, nl).trim(), meta = parseJSON(chunk.slice(nl + 1));
    if (path && meta && typeof meta === "object" && meta.call) out.push({ path, meta });
  }
  return out;
}

/** The control.json files at the head of the dump → { <run dir>: { state, at, held, report } }. */
export function parseControls(text) {
  const out = {}, head = String(text ?? "").split(SEP)[0];
  for (const chunk of head.split(CONTROL_SEP).slice(1)) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const path = chunk.slice(0, nl).trim(), c = parseJSON(chunk.slice(nl + 1));
    if (path && c && typeof c === "object" && c.state) out[path.replace(/\/control\.json$/, "")] = c;
  }
  return out;
}

/** <run>/agents/<call>/meta.json → <run>. */
export const runDirOf = (metaPath) => metaPath.replace(/\/agents\/[^/]+\/meta\.json$/, "");
/** <repo>/.cc-dispatch/<run> → <repo>/.cc-dispatch. */
export const parentOf = (runDir) => runDir.replace(/\/[^/]+\/?$/, "");
export const baseName = (p) => String(p ?? "").replace(/\/+$/, "").split("/").pop() ?? "";
/** <repo>/.cc-dispatch/<run> → <repo>. */
export const repoOf = (runDir) => parentOf(parentOf(runDir));

/** The skill a run folder belongs to, the way hd_dispatch.py names it. */
export function kindOf(runDir) {
  const k = baseName(runDir).split("-", 1)[0];
  return KINDS.includes(k) ? k : "dev";
}

/** Run-parent folders (…/.cc-dispatch) to read: the shown repo's, and every live helper's. */
export function runRoots(repo, terminals) {
  const roots = new Set();
  if (repo) roots.add(`${repo.replace(/\/+$/, "")}/.cc-dispatch`);
  for (const t of terminals ?? []) {
    const dir = t?.labels?.["cc.dir"];
    if (dir && t.state === "live") roots.add(parentOf(dir));
  }
  return [...roots].sort();
}

/** "ok" | "bad" | "missing" | null (not checked yet). */
function verdict(label, stored) {
  if (label === "ok" || label === "bad" || label === "missing") return label;
  return stored === "ok" || stored === "bad" || stored === "missing" ? stored : null;
}

/** The helper's terminal: by address, else by name among live ones. */
function terminalFor(meta, terminals) {
  const list = terminals ?? [];
  return (meta.address && list.find((t) => t.address === meta.address))
    ?? list.find((t) => t.name && t.name === meta.name && t.state === "live")
    ?? null;
}

/**
 * One helper as the panel shows it.
 * state: "live" | "finished" | "gone"; status: working | blocked | done | idle | error | null.
 */
export function buildCall(meta, runDir, terminals) {
  const term = terminalFor(meta, terminals);
  const labels = term?.labels ?? {};
  const live = term?.state === "live";
  const status = live ? (typeof term.status === "string" ? term.status : term.status?.state ?? null) : null;
  return {
    key: `${runDir}#${meta.call}`,
    runDir,
    call: meta.call,
    // The name herdr's Agents list shows for this helper: the live terminal's, else the one it was given.
    name: term?.name || meta.name || meta.call,
    mode: labels["cc.mode"] || meta.mode || "",
    effort: meta.effort ?? "",
    round: Number(labels["cc.round"] || meta.round || 1),
    report: verdict(labels["cc.report"], meta.report_check),
    failure: (live ? labels["cc.failure"] : null) || meta.failure || null,
    // "capacity 1/4" while hd_dispatch.py retries a busy server or a rate limit for it.
    retry: (live ? labels["cc.retry"] : null) || null,
    // The network is down (hd_dispatch.py's check): it waits for it, using up no retry.
    offline: live && labels["cc.net"] === "down",
    state: !term ? "gone" : live ? "live" : "finished",
    status,
    address: term?.address ?? meta.address ?? null,
    // hc's parent is set once at start; after `adopt` the new main agent is only in meta.json
    parent: (meta.adopted ? meta.parent : term?.parent) ?? meta.parent ?? null,
    adoptedFrom: meta.adopted?.from ?? null,
    // The dispatching Claude as hd_dispatch.py recorded it (runs from before that have none).
    session: meta.session ?? null,
    space: meta.space ?? null,
    claudeCwd: meta.claude_cwd ?? null,
    mainAgent: meta.dispatcher_agent ?? null,
    title: term?.title ?? "",
    dir: meta.dir ?? "",
    workdir: meta.workdir ?? "",
    reportPath: meta.report ?? "",
    schema: meta.schema ?? "",
    agentDir: meta.agent_dir ?? `${runDir}/agents/${meta.call}`,
    startedAt: Number(meta.started_at || 0) * 1000,
    // hd_dispatch.py's path, for the panel's pause / resume / stop (runs from before that have none).
    hd: meta.hd ?? null,
    // The agent it runs as (codex unless a handover changed it), and the Claude Code sessions it ran.
    agent: labels["cc.agent"] || meta.agent || "codex",
    claudeSessions: Array.isArray(meta.claude_sessions) ? meta.claude_sessions : [],
    // The agent a handover from the panel is moving it to, while that runs (hd_dispatch.py handover).
    handingTo: (live ? labels["cc.handover"] : null) || null,
    frozen: meta.frozen?.round === Number(labels["cc.round"] || meta.round || 1) ? meta.frozen : null,
    // Stopped by the run's pause and not told to carry on yet (buildRuns sets it from control.json).
    held: false,
    // Its terminal vanished while it should be there (cleanup, stop and freeze close it on purpose) before
    // it handed in a good report: herdr restarted or crashed, or someone closed it. hd_dispatch.py records
    // it as meta.lost when it sees it; the panel sees it without the main agent, which may be gone too.
    lost: !term && verdict(labels["cc.report"], meta.report_check) !== "ok"
      && (meta.open === true || meta.lost?.round === Number(meta.round || 1)),
  };
}

/**
 * The agents a helper can run as, as hd_dispatch.py's AGENTS has them (a fixed list: each needs its own
 * way to start and resume). weak: no sandbox; only its task file's rules keep it in its folder.
 */
export const AGENTS = {
  codex: { label: "Codex", isolation: "sandbox" },
  claude: { label: "Claude Code", isolation: "weak" },
};
export const agentLabel = (a) => AGENTS[a]?.label ?? a;
/** How the panel names a run's main agent: "the main agent (Codex)", or just "the main agent". */
export const mainAgentName = (r) => r?.mainAgent ? `the main agent (${agentLabel(r.mainAgent)})` : "the main agent";
export const weakIsolation = (c) => AGENTS[c?.agent]?.isolation === "weak";

/** Whether the panel offers to hand a helper over: its run is running and it has no good report. */
export const canHandOver = (c, r) => !r?.control && c.report !== "ok" && !c.handingTo;

// Most urgent first: what the person (or Claude) has to act on.
const URGENCY = ["blocked", "lost", "error", "offline", "retry", "held", "bad", "working", "review", "done", "gone"];

/** What one helper needs, as one word for dots and summaries. */
export function callNeed(c) {
  if (c.state === "live" && c.status === "blocked") return "blocked";
  if (c.lost) return "lost";
  if (c.held && c.state === "live" && c.status !== "working") return "held";
  if (c.offline) return "offline";
  if (c.state === "live" && c.retry && c.status !== "working") return "retry";
  if ((c.state === "live" && c.status === "error") || (c.failure && c.failure !== "exited" && c.failure !== "blocked")) return "error";
  if (c.state === "live" && c.status === "working") return "working";
  if (c.report === "bad") return "bad";
  if (c.report === "ok") return "done";
  if (c.state === "live") return "review"; // settled, report not collected yet
  return "gone";
}

const rank = (need) => { const i = URGENCY.indexOf(need); return i < 0 ? URGENCY.length : i; };

/** Runs, newest first; each with its calls in call order and a summary. */
/**
 * A run's main agent terminal: of the helpers' parents, newest dispatch first, one whose terminal is
 * still live; else the newest. A long run outlives its first main agent (closed, then a new one carries
 * on dispatching), so the first helper's parent may be long gone.
 */
export function runParent(calls, terminals) {
  const byNewest = calls.filter((c) => c.parent).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const live = new Set((terminals ?? []).filter((t) => t.state === "live").map((t) => t.address));
  return (byNewest.find((c) => live.has(c.parent)) ?? byNewest[0])?.parent ?? null;
}

export function buildRuns(entries, terminals, controls = {}) {
  const byRun = new Map();
  for (const { path, meta } of entries ?? []) {
    const dir = runDirOf(path);
    if (!byRun.has(dir)) byRun.set(dir, []);
    byRun.get(dir).push(buildCall(meta, dir, terminals));
  }
  const runs = [...byRun].map(([dir, calls]) => {
    calls.sort((a, b) => a.call.localeCompare(b.call));
    const control = controls?.[dir] && controls[dir].state !== "running" ? controls[dir] : null;
    if (control?.state === "paused") for (const c of calls) c.held = (control.held ?? []).includes(c.call);
    const counts = {};
    for (const c of calls) { const n = callNeed(c); counts[n] = (counts[n] ?? 0) + 1; }
    const need = calls.map(callNeed).sort((a, b) => rank(a) - rank(b))[0] ?? "gone";
    return {
      dir, id: baseName(dir), kind: kindOf(dir), repo: repoOf(dir),
      calls, counts, need, control,
      hd: calls.find((c) => c.hd)?.hd ?? null,
      live: calls.some((c) => c.state === "live"),
      parent: runParent(calls, terminals),
      session: calls.find((c) => c.session)?.session ?? null,
      space: calls.find((c) => c.space)?.space ?? null,
      claudeCwd: calls.find((c) => c.claudeCwd)?.claudeCwd ?? null,
      // The program the main agent runs (claude, codex, …) as hd_dispatch.py recorded it; the newest wins (adopt).
      mainAgent: calls.find((c) => c.adoptedFrom && c.mainAgent)?.mainAgent ?? calls.find((c) => c.mainAgent)?.mainAgent ?? null,
      startedAt: Math.min(...calls.map((c) => c.startedAt || Infinity)),
    };
  });
  for (const r of runs) if (!Number.isFinite(r.startedAt)) r.startedAt = 0;
  return runs.sort((a, b) => (b.live - a.live) || (b.startedAt - a.startedAt) || b.id.localeCompare(a.id));
}

/** "2 working · 1 report bad · 3 done" in urgency order. */
export function summary(counts) {
  const words = { blocked: "waiting on you", error: "failed", offline: "waiting for network", retry: "retrying", held: "paused", bad: "report bad", working: "working", review: "to collect", done: "done", gone: "ended" };
  return URGENCY.filter((k) => counts?.[k]).map((k) => `${counts[k]} ${words[k]}`).join(" · ");
}

// A helper's mode and effort as two letters (write·high → "wh"), and its round past the first ("r2").
const MODE_LETTER = { read: "r", write: "w", net: "n" };
const EFFORT_LETTER = { high: "h", medium: "m", low: "l" };
export function callTags(c) {
  const me = (MODE_LETTER[c.mode] ?? "") + (EFFORT_LETTER[c.effort] ?? "");
  return [me, c.round > 1 ? `r${c.round}` : ""].filter(Boolean);
}

/** The agent tag of a helper not running as Codex ("claude"), else null; weak marks its isolation. */
export function agentTag(c) {
  if (!c?.agent || c.agent === "codex") return null;
  return { text: c.agent, weak: weakIsolation(c) };
}

/** The line under a call's name, after its stage: what the stage word does not already say. */
export function callDetail(c) {
  const parts = [[c.mode, c.effort].filter(Boolean).join("·")];
  if (c.round > 1) parts.push(`round ${c.round}`);
  if (c.report === "missing") parts.push("no report");
  if (c.failure && !["exited", "blocked", "lost"].includes(c.failure)) parts.push(c.failure);
  if (c.retry) parts.push(`retry ${c.retry}`);
  if (c.agent && c.agent !== "codex") parts.push(agentLabel(c.agent) + (weakIsolation(c) ? " (weak isolation)" : ""));
  if (c.handingTo) parts.push(`handing over to ${agentLabel(c.handingTo)}`);
  if (c.lost) parts.push("terminal vanished");
  else if (c.state !== "live") parts.push("closed");
  return parts.filter(Boolean).join(" · ");
}

// ---- Stages: one word per helper, joining its terminal, its report and its card ----
//
// The helper's own state wins while it needs someone (waiting, failed, working, bad report); then
// the card's status in the run's state.json (dev runs: the call id is the card id) says what the
// dispatching Claude made of it; then the report verdict.

/** Most urgent first. */
export const STAGES = ["blocked", "lost", "failed", "offline", "retrying", "paused", "working", "bad", "collect", "await", "review", "ok", "merged", "done", "parked", "ended"];
export const STAGE_WORDS = {
  blocked: "waiting on you", lost: "interrupted", failed: "failed", offline: "waiting for network", retrying: "retrying", paused: "paused", working: "working", bad: "report bad", collect: "to collect",
  await: "awaiting review", review: "in review", ok: "report ok", merged: "merged", done: "done", parked: "parked", ended: "ended",
};

/** One helper's stage; `card` is its card's status in state.json, if it has one. */
export function callStage(c, card) {
  const need = callNeed(c);
  if (need === "blocked") return "blocked";
  if (need === "lost") return "lost";
  if (need === "error") return "failed";
  if (need === "offline") return "offline";
  if (need === "retry") return "retrying";
  if (need === "held") return "paused";
  if (need === "working") return "working";
  if (need === "bad") return "bad";
  if (card === "merged" || card === "parked" || card === "done") return card;
  if (card === "accepting") return "review";
  if (need === "review") return "collect";
  if (need === "done") return card === "running" || card === "pending" ? "await" : "ok";
  return "ended";
}

/** A run's stage: its most urgent helper's. */
export const runStage = (stages) => [...stages].sort((a, b) => STAGES.indexOf(a) - STAGES.indexOf(b))[0] ?? "ended";

/** Stages whose work needs nobody: their groups start folded. */
export const SETTLED = new Set(["ok", "merged", "done", "parked", "ended"]);

/** A run's helpers grouped by stage, most urgent group first, dispatch order kept inside a group. → [{stage, calls}] */
export function groupByStage(calls, stageOf) {
  const by = new Map();
  for (const c of calls) {
    const s = stageOf(c);
    if (!by.has(s)) by.set(s, []);
    by.get(s).push(c);
  }
  return STAGES.filter((s) => by.has(s)).map((stage) => ({ stage, calls: by.get(stage) }));
}

/** "2 working · 1 awaiting review · 9 merged" in urgency order. */
export function stageSummary(stages) {
  const n = {};
  for (const s of stages) n[s] = (n[s] ?? 0) + 1;
  return STAGES.filter((s) => n[s]).map((s) => `${n[s]} ${STAGE_WORDS[s]}`).join(" · ");
}

/** A dev run's cards by status, for the cards bar: [[status, n]] in a fixed order. */
export const CARD_ORDER = ["merged", "done", "accepting", "running", "pending", "parked"];
export function cardCounts(cards) {
  const n = {};
  for (const s of Object.values(cards?.status ?? {})) n[s] = (n[s] ?? 0) + 1;
  const known = CARD_ORDER.filter((s) => n[s]).map((s) => [s, n[s]]);
  const other = Object.entries(n).filter(([s]) => !CARD_ORDER.includes(s));
  return [...known, ...other];
}

/** How long ago, short. */
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** The newest task file of a call: task-<round>.md. */
export const taskPath = (c) => `${c.agentDir}/task-${c.round}.md`;

/** The script for a write-mode helper's changes: stat and short status of its worktree. */
export const DIFF_SCRIPT = [
  'cd "$1" || exit 1',
  'git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "not a git worktree: $1"; exit 0; }',
  'echo "## $(git rev-parse --abbrev-ref HEAD 2>/dev/null) @ $1"',
  'git status --short | head -200',
  'echo',
  'git diff --stat HEAD | tail -60',
].join("\n");

/** What the panel sends to the Claude that dispatched a call, asking it to look. */
export function handoffText(c, ask) {
  const run = baseName(c.runDir);
  const what = {
    collect: `请收一下 ${c.call} 的回报并验收`,
    bad: `${c.call} 的回报没通过 schema 检查，请看一下并决定是否让它重交`,
    diagnose: `${c.call} 出错了（${c.failure ?? "error"}），请诊断`,
    blocked: `${c.call} 停在等人确认的地方，请看一下它卡在哪`,
    lost: `${c.call} 的终端意外消失了（第 ${c.round} 轮还没交合格回报），请先 collect 确认，再问我要不要 recover 恢复（按 herdr.md 里 lost 的做法）`,
  }[ask] ?? `请看一下 ${c.call}`;
  return `[cc-dispatch 面板] ${what}。run=${c.runDir} call=${c.call}（${run}）`;
}

/** Which hand-off fits a call now, or null when it needs nothing. */
export function handoffAsk(c) {
  const need = callNeed(c);
  return { blocked: "blocked", lost: "lost", error: "diagnose", bad: "bad", review: "collect" }[need] ?? null;
}

/** Pretty JSON when it parses, the text otherwise. */
export function prettyReport(text) {
  if (text == null) return null;
  const v = parseJSON(text);
  return v === null ? String(text) : JSON.stringify(v, null, 2);
}

// ---- Markdown for the text dialog ----

const isScalar = (v) => v === null || typeof v !== "object";
const TITLE_KEYS = ["title", "name", "id", "task", "file", "path", "summary"];
const fence = (text, lang = "") => { const f = /```/.test(text) ? "````" : "```"; return `${f}${lang}\n${text}\n${f}`; };

/** A scalar as markdown on one list line; continuation lines indented under `pad`. */
function scalarMd(v, pad = "") {
  if (v === null || v === undefined) return "—";
  if (typeof v !== "string") return `\`${String(v)}\``;
  if (!v) return "*(empty)*";
  if (/^[\w./:#@-]{1,60}$/.test(v) && !/^\d+$/.test(v)) return `\`${v}\``; // enums, ids, paths
  // Several lines inside a list are output or logs: a code block under the item.
  if (v.includes("\n")) return `\n\n${fence(v.replace(/\s+$/, "")).split("\n").map((l) => `${pad}  ${l}`).join("\n")}\n`;
  return v;
}

const itemTitle = (o) => TITLE_KEYS.find((k) => typeof o[k] === "string" && o[k] && o[k].length <= 120 && !o[k].includes("\n"));

/** Any JSON value as nested bullet lines. */
function listMd(v, depth) {
  const pad = "  ".repeat(depth);
  if (isScalar(v)) return [`${pad}- ${scalarMd(v, pad)}`];
  if (Array.isArray(v)) {
    if (!v.length) return [`${pad}- *(none)*`];
    return v.flatMap((x) => (isScalar(x) ? [`${pad}- ${scalarMd(x, pad)}`] : objectItemMd(x, depth)));
  }
  const entries = Object.entries(v);
  if (!entries.length) return [`${pad}- *(none)*`];
  return entries.flatMap(([k, x]) => isScalar(x)
    ? [`${pad}- **${k}**: ${scalarMd(x, pad)}`]
    : [`${pad}- **${k}**${Array.isArray(x) ? ` (${x.length})` : ""}`, ...listMd(x, depth + 1)]);
}

/** An object inside a list: its title key in bold, the rest nested under it. */
function objectItemMd(o, depth) {
  if (Array.isArray(o)) return [`${"  ".repeat(depth)}-`, ...listMd(o, depth + 1)];
  const pad = "  ".repeat(depth), key = itemTitle(o);
  const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== key));
  if (!key) return [`${pad}-`, ...listMd(rest, depth + 1)];
  return [`${pad}- **${o[key]}**`, ...(Object.keys(rest).length ? listMd(rest, depth + 1) : [])];
}

/**
 * A report (JSON text) as markdown: each top-level field a section; prose stays prose, lists of
 * findings/items become numbered sub-sections titled by their title/name/id. Not JSON: shown as is.
 */
export const MARKDOWN_LIMIT = 300000; // longer reports show as source: rendering them is slow

export function jsonMarkdown(text) {
  if (text != null && String(text).length > MARKDOWN_LIMIT) return `*Too long to render (${String(text).length} characters): showing the source.*\n\n${fence(String(text), "json")}`;
  const v = parseJSON(text);
  if (v === null) return text == null ? "" : fence(String(text));
  if (isScalar(v) || Array.isArray(v)) return listMd(v, 0).join("\n");
  const out = [];
  for (const [k, x] of Object.entries(v)) {
    out.push(`## ${k}`);
    if (typeof x === "string" && x.length > 0) out.push(/^[\w./:#@-]{1,60}$/.test(x) ? scalarMd(x) : x);
    else if (isScalar(x)) out.push(scalarMd(x));
    else if (Array.isArray(x) && x.length && x.every((i) => i && typeof i === "object" && !Array.isArray(i))) {
      x.forEach((item, i) => {
        const key = itemTitle(item);
        out.push(`### ${i + 1}. ${key ? item[key] : `item ${i + 1}`}`);
        const rest = Object.fromEntries(Object.entries(item).filter(([kk]) => kk !== key));
        if (Object.keys(rest).length) out.push(listMd(rest, 0).join("\n"));
      });
    } else out.push(listMd(x, 0).join("\n"));
  }
  return out.join("\n\n");
}

/** The report dialog: verdict and paths, then the report. */
export function reportMarkdown(c, text, older = []) {
  const verdict = { ok: "passes the schema", bad: "**fails the schema**", missing: "no report file" }[c.report] ?? "not checked yet (`hd_dispatch.py collect` checks it)";
  const head = [
    `- **verdict**: ${verdict}`,
    `- **file**: \`${c.reportPath}\``,
    `- **schema**: \`${c.schema}\``,
    older.length ? `- **earlier rounds**: ${older.map((p) => `\`${baseName(p)}\``).join(", ")}` : null,
  ].filter(Boolean).join("\n");
  return `${head}\n\n---\n\n${text == null ? "*No report written yet.*" : jsonMarkdown(text)}`;
}

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (sec) => { const d = new Date(sec * 1000); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const tok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

/** One events.jsonl line (hd_dispatch.py) in words. */
export function eventWords(e) {
  const unsent = e.sent === false ? " — **not delivered**" : "";
  switch (e.ev) {
    case "dispatch": return `dispatched ${[e.mode, e.effort].filter(Boolean).join("·")}${e.title ? ` "${e.title}"` : ""}${unsent}`;
    case "send": return e.why !== "retry" ? `sent round ${e.round}${unsent}`
      : e.kind === "network" ? `network back: told to carry on${unsent}` : `told to carry on (${e.kind} retry ${e.n})${unsent}`;
    case "offline": return "**network down**: waiting for it, no retry used";
    case "retry": return `${e.kind}: retry ${e.n}/${e.max} at ${clock(e.at).slice(6)}`;
    case "settle": return ["settled: " + (e.state === "live" ? e.status : e.state), e.report && `report ${e.report}`,
      e.failure && `**${e.failure}**`, e.retried && `after ${e.retried} retr${e.retried === 1 ? "y" : "ies"}`,
      e.nested && `started ${e.nested.length} terminal(s) itself`].filter(Boolean).join(", ");
    case "stall": return `no progress for ${e.minutes} min in turn ${e.turn}`;
    case "codex": return [`Codex so far: ${e.tokens ? `${tok(e.tokens.input + e.tokens.output)} tok` : "no tokens"}`,
      `${e.commands ?? 0} cmd`, `${e.files ?? 0} files`, e.model].filter(Boolean).join(" · ");
    case "cleanup": return "cleaned up";
    case "pause": return e.interrupted ? "**paused**: stopped mid-turn" : "**paused**: its retry dropped";
    case "resume": return `resumed: told to carry on${unsent}`;
    case "stop": return e.asked ? "**run stopped**: asked to report what it has" : "**run stopped**";
    case "freeze": return [`**frozen** (${e.why ?? "manual"})`, e.progress ? "wrote a progress note" : e.asked ? "asked for a note, none came" : null,
      e.snapshot && `worktree saved \`${String(e.snapshot).slice(0, 10)}\``].filter(Boolean).join(", ");
    case "lost": return "**interrupted**: its terminal vanished before it reported";
    case "recover": return `**recovered**: ${e.how === "resume" ? "its own session reopened" : "a new session read the task"}, held until resumed`;
    case "adopt": return `**adopted** by the main agent in ${e.by ?? "?"}${e.agent ? ` (${e.agent})` : ""}${e.frm ? `, was ${e.frm}` : ""}`;
    case "handover": return `**handed over** ${e.frm ?? "?"} → ${e.to}${e.why ? ` (${e.why})` : ""}${e.isolation === "weak" ? ", weak isolation" : ""}${unsent}`;
    default: return e.ev;
  }
}

/** A call's events.jsonl as a markdown list, oldest first. */
export function timelineMarkdown(text) {
  const evs = String(text ?? "").split("\n").map((l) => l.trim() && parseJSON(l)).filter((e) => e && e.ev);
  if (!evs.length) return "*No events recorded. Helpers dispatched before hd_dispatch.py kept events.jsonl have none.*";
  return evs.map((e) => `- \`${clock(e.t)}\` · r${e.round ?? 1} · ${eventWords(e)}`).join("\n");
}

/**
 * The Result dialog: what the helper concluded, then (write/net helpers) what it changed. `diff` is
 * DIFF_SCRIPT's output, or null for a read-only helper.
 */
export function resultMarkdown(c, text, older = [], diff = null) {
  const parts = [reportMarkdown(c, text, older)];
  if (diff != null) parts.push(`## Changes in the worktree\n\n${diffMarkdown(diff).replace(/^### /, "")}`);
  return parts.join("\n\n---\n\n");
}

/** Push a markdown document's headings `by` levels down, so it nests under ours. */
const demote = (md, by) => String(md ?? "").replace(/^(#{1,6}) /gm, (_m, h) => `${"#".repeat(Math.min(6, h.length + by))} `);

/**
 * The Task dialog: the call's rounds, newest first. Each round: what happened in it (events.jsonl),
 * then its task file. `tasks` maps a round to its task file's text (null when missing).
 */
export function roundsMarkdown(c, eventsText, tasks = {}) {
  const evs = String(eventsText ?? "").split("\n").map((l) => l.trim() && parseJSON(l)).filter((e) => e && e.ev);
  const rounds = Math.max(c.round ?? 1, ...evs.map((e) => e.round ?? 1), ...Object.keys(tasks).map(Number));
  const out = [];
  for (let k = rounds; k >= 1; k--) {
    const mine = evs.filter((e) => (e.round ?? 1) === k);
    const how = mine.find((e) => e.ev === "handover") ? "handed over" : k === 1 ? "dispatched" : "rework";
    out.push(`## Round ${k}${k === c.round ? " · current" : ""} · ${how}`);
    if (mine.length) out.push(mine.map((e) => `- \`${clock(e.t)}\` · ${eventWords(e)}`).join("\n"));
    else if (!evs.length && k === rounds) out.push("*No events recorded. Helpers dispatched before hd_dispatch.py kept events.jsonl have none.*");
    const task = tasks[k];
    out.push(task == null ? `*No task file for round ${k}.*` : `### Task file \`task-${k}.md\`\n\n${demote(task, 3)}`);
  }
  return out.join("\n\n");
}

/** The worktree dialog: DIFF_SCRIPT's output, its "## branch @ dir" line as a heading. */
export function diffMarkdown(text) {
  const lines = String(text ?? "").split("\n");
  const head = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : null;
  const body = lines.join("\n").replace(/^\n+|\s+$/g, ""); // keep git status's leading column
  return [head && `### \`${head}\``, body ? fence(body) : "*No changes.*"].filter(Boolean).join("\n\n");
}

// ---- Spaces ----

const under = (path, folder) => Boolean(path && folder) && (path === folder || path.startsWith(`${folder.replace(/\/+$/, "")}/`));

/**
 * The herdr space a run belongs to: its dispatching Claude's terminal's space while that lives,
 * else the one hd_dispatch.py recorded, else a space whose folder is in the run's repository.
 */
export function runSpace(run, terminals, spaces) {
  const parent = run.parent && (terminals ?? []).find((t) => t.address === run.parent);
  const live = parent?.labels?.["herdr.space"];
  if (live) return live;
  const ids = new Set((spaces ?? []).map((s) => s.id));
  if (run.space && ids.has(run.space)) return run.space;
  return (spaces ?? []).find((s) => under(s.folder, run.repo))?.id ?? null;
}

/**
 * The shown space's runs, and the other spaces' live ones by space: { mine, others: [{ id, name,
 * runs }] }. A run whose space is not known stays with the shown one when it is in its repository.
 */
export function splitBySpace(runs, terminals, spaces, shown, repo) {
  const mine = [], others = new Map();
  for (const r of runs) {
    const id = runSpace(r, terminals, spaces);
    if (id === shown?.id || (!id && r.repo === repo)) { mine.push(r); continue; }
    if (!r.live) continue;
    const key = id ?? `repo:${r.repo}`;
    if (!others.has(key)) {
      const s = (spaces ?? []).find((x) => x.id === id);
      others.set(key, { id, name: s?.name || baseName(r.repo), runs: [] });
    }
    others.get(key).runs.push(r);
  }
  return { mine, others: [...others.values()] };
}

// ---- Run control: the panel's pause / resume / stop, run by hd_dispatch.py ----

// $1 hd_dispatch.py as the run recorded it, $2 pause|resume|stop|handover, $3 the run folder; handover
// adds $4 the call and $5 the agent. Herdr may start it with a short PATH, so the usual places for hc and
// python3 come first. stop and handover take minutes (helpers write what they have), so they go to the
// background, logging to <run>/stop.log and <run>/agents/<call>/handover.log.
// ---- The main agent's quota (hd_usage.py quota) ----

/** "claude" / "codex" from a program key, name or path, else null: the subscription hd_usage.py reads. */
export function quotaAgent(name) {
  const n = String(name ?? "").split("/").pop().toLowerCase();
  return n.includes("claude") ? "claude" : n.includes("codex") ? "codex" : null;
}

/**
 * The subscription a run's main agent uses right now: what its terminal runs (herdr's program key, else
 * its argv), else what hd_dispatch.py recorded at dispatch or adopt. null when it is neither.
 */
export function runQuotaAgent(r, terminals) {
  const term = r?.parent ? (terminals ?? []).find((x) => x.address === r.parent && x.state === "live") : null;
  return quotaAgent(term?.program?.key) ?? quotaAgent(term?.foreground?.argv?.[0] ?? term?.argv?.[0]) ?? quotaAgent(r?.mainAgent);
}

/**
 * What a run card shows of a quota: { label: "Codex · prolite", windows: [{ text: "5h 50%", level, resets }],
 * source }, or null. level: "high" at the handoff threshold (90), "warn" from 70. Windows that reset since
 * the reading are left out.
 */
export function quotaView(agent, q, now = Date.now()) {
  const wins = (q?.windows ?? []).filter((w) => typeof w.used === "number" && !(w.resets && w.resets * 1000 < now));
  if (!wins.length) return null;
  const short = (name) => {
    const [head, model] = String(name).split("·").map((x) => x.trim());
    const m = /^(\d+)\s+(\w)/.exec(head ?? "");
    return [m ? `${m[1]}${m[2]}` : head, model].filter(Boolean).join(" ");
  };
  return {
    label: [agentLabel(agent), q.plan].filter(Boolean).join(" · "),
    source: q.source ?? null,
    windows: wins.map((w) => ({ text: `${short(w.name)} ${Math.round(w.used)}%`, level: w.used >= 90 ? "high" : w.used >= 70 ? "warn" : "ok", resets: w.resets ? w.resets * 1000 : null })),
  };
}

// $1 the run's hd_dispatch.py (hd_usage.py sits beside it), $2 claude|codex. Prints the quota JSON or null.
export const QUOTA_SCRIPT = [
  'PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH',
  'D=$(dirname "$1"); [ -f "$D/hd_usage.py" ] || D=$(dirname "$(ls "$HOME"/.claude/skills/cc-herdr-dispatch-*/shared/scripts/hd_usage.py 2>/dev/null | head -n 1)")',
  '[ -f "$D/hd_usage.py" ] || { echo "hd_usage.py not found" >&2; exit 127; }',
  'python3 "$D/hd_usage.py" quota "$2" --slow',
].join("\n");

export const CONTROL_SCRIPT = [
  'PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH',
  'HD="$1"; [ -f "$HD" ] || HD=$(ls "$HOME"/.claude/skills/cc-herdr-dispatch-*/shared/scripts/hd_dispatch.py 2>/dev/null | head -n 1)',
  '[ -n "$HD" ] || { echo "hd_dispatch.py not found" >&2; exit 127; }',
  'command -v hc >/dev/null || { echo "hc not found on PATH" >&2; exit 127; }',
  'if [ "$2" = stop ]; then',
  '  nohup python3 "$HD" stop --run "$3" >"$3/stop.log" 2>&1 </dev/null &',
  '  echo STOP_STARTED=1',
  'elif [ "$2" = handover ]; then',
  '  nohup python3 "$HD" handover --run "$3" --call "$4" --to "$5" --why manual --notify >"$3/agents/$4/handover.log" 2>&1 </dev/null &',
  '  echo HANDOVER_STARTED=1',
  'else',
  '  python3 "$HD" "$2" --run "$3"',
  'fi',
].join("\n");

/** Which control buttons a run offers: pause and stop while it runs, resume and stop while paused. */
export function controlOps(r) {
  const state = r?.control?.state ?? "running";
  if (state === "stopping" || state === "stopped" || state === "handoff") return [];
  if (!r?.live && state !== "paused") return [];
  return state === "paused" ? ["resume", "stop"] : ["pause", "stop"];
}

/** The line under a paused, stopping or stopped run's head. */
export function controlBanner(r, now = Date.now()) {
  const c = r?.control;
  if (!c) return null;
  const since = c.at ? ago(Number(c.at) * 1000, now) : "";
  if (c.state === "paused") {
    const n = r.calls.filter((x) => x.held && x.state === "live").length;
    return ["Paused", since, n ? `${n} helper${n === 1 ? "" : "s"} held` : "no helper was working"].filter(Boolean).join(" · ");
  }
  if (c.state === "stopping") return "Stopping · helpers are writing what they have done";
  if (c.state === "stopped") return ["Stopped", since, `${mainAgentName(r)} has the summary`].filter(Boolean).join(" · ");
  if (c.state === "handoff") return ["Handing off", since, "give the next main agent the prompt"].filter(Boolean).join(" · ");
  return null;
}
