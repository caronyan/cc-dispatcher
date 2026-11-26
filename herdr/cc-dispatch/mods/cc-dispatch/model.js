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
// A run the user archived from the panel: <run>/archived holds when (epoch seconds). Listed before the
// control.json files, so it never lands inside one of them.
export const ARCHIVE_SEP = "@@cc-dispatch-archived ";
// What the main agent waits on the person for (<run>/asks.json, hd_dispatch.py ask) and the person's answers
// from the panel (<run>/answers.jsonl, its last 50 lines). Listed first of all.
export const ASKS_SEP = "@@cc-dispatch-asks ";
export const ANSWERS_SEP = "@@cc-dispatch-answers ";
export const TOPIC_SEP = "@@cc-dispatch-topic ";
export const BACKLOG_SEP = "@@cc-dispatch-backlog ";
export const APPROVALS_SEP = "@@cc-dispatch-approvals ";
export const STATE_SEP = "@@cc-dispatch-state ";
export const MESSAGE_SUMMARY_SEP = "@@cc-dispatch-message-summary ";

// The shell script the loader runs: every run's control.json, each introduced by a CONTROL_SEP line
// with its path, then every meta.json under the given run-parent folders, each introduced by a SEP line.
export const LIST_SCRIPT = [
  'for root in "$@"; do',
  '  for f in "$root"/*/asks.json; do',
  '    [ -f "$f" ] || continue',
  `    printf '\\n${ASKS_SEP}%s\\n' "$f"`,
  '    cat "$f"',
  '  done',
  '  for f in "$root"/*/answers.jsonl; do',
  '    [ -f "$f" ] || continue',
  `    printf '\\n${ANSWERS_SEP}%s\\n' "$f"`,
  '    tail -n 50 "$f"',
  '  done',
  'done',
  'for root in "$@"; do',
  '  for f in "$root"/*/archived; do',
  '    [ -f "$f" ] || continue',
  `    printf '\\n${ARCHIVE_SEP}%s\\n' "$f"`,
  '    cat "$f"',
  '  done',
  'done',
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
  'for root in "$@"; do',
  '  for f in "$root"/topics/*/topic.json; do',
  '    [ -f "$f" ] || continue',
  `    printf '\\n${TOPIC_SEP}%s\\n' "$f"`,
  '    cat "$f"',
  '    b="${f%/topic.json}/backlog.json"',
  '    if [ -f "$b" ]; then',
  `      printf '\\n${BACKLOG_SEP}%s\\n' "$b"`,
  '      cat "$b"',
  '    fi',
  '    a="${f%/topic.json}/approvals.json"',
  '    if [ -e "$a" ]; then',
  `      printf '\\n${APPROVALS_SEP}%s\\n' "$a"`,
  '      cat "$a"',
  '    fi',
  '  done',
  'done',
  'for root in "$@"; do',
  '  for f in "$root"/*/state.json; do',
  '    [ -f "$f" ] || continue',
  `    printf '\\n${STATE_SEP}%s\\n' "$f"`,
  '    cat "$f"',
  '  done',
  'done',
  'for root in "$@"; do',
  '  for f in "$root"/messages/*.summary.json; do',
  '    [ -f "$f" ] || continue',
  `    printf '\\n${MESSAGE_SUMMARY_SEP}%s\\n' "$f"`,
  '    cat "$f"',
  '  done',
  'done',
].join("\n");

// Paths that exist, one per line, from the arguments.
export const EXISTS_SCRIPT = 'for p in "$@"; do [ -e "$p" ] && printf "%s\\n" "$p"; done; true';

export function parseJSON(text) {
  try { return JSON.parse(text); } catch { return null; }
}

const objectJSON = (v) => v && typeof v === "object" && !Array.isArray(v);
// Section headers always start a line (LIST_SCRIPT prints "\n<SEP>"); JSON values never hold a bare newline,
// so marker text inside a file cannot cut or forge a section.
const beforeSections = (text, separators) => {
  const all = `\n${String(text ?? "")}`;
  const ends = separators.map((s) => all.indexOf(`\n${s}`)).filter((i) => i >= 0);
  return ends.length ? all.slice(0, Math.min(...ends)) : all;
};
const sectionsOf = (text, sep) => text.split(`\n${sep}`).slice(1);

/** The SEP-separated dump of meta.json files → [{ path, meta }], skipping unreadable ones. */
export function parseMetaDump(text) {
  const out = [];
  for (const chunk of sectionsOf(beforeSections(text, [TOPIC_SEP, STATE_SEP, MESSAGE_SUMMARY_SEP]), SEP)) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const path = chunk.slice(0, nl).trim(), meta = parseJSON(chunk.slice(nl + 1));
    if (path && meta && typeof meta === "object" && meta.call) out.push({ path, meta });
  }
  return out;
}

/** The control.json files at the head of the dump → { <run dir>: { state, at, held, report } }. */
export function parseControls(text) {
  const out = {}, head = beforeSections(text, [SEP, TOPIC_SEP, STATE_SEP, MESSAGE_SUMMARY_SEP]);
  for (const chunk of sectionsOf(head, CONTROL_SEP)) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const path = chunk.slice(0, nl).trim(), c = parseJSON(chunk.slice(nl + 1));
    if (path && c && typeof c === "object" && c.state) out[path.replace(/\/control\.json$/, "")] = c;
  }
  return out;
}

/** The archive markers in LIST_SCRIPT's output → { <run dir>: archived at (ms) }. */
export function parseArchived(text) {
  const out = {}, head = beforeSections(text, [SEP, CONTROL_SEP, TOPIC_SEP, STATE_SEP, MESSAGE_SUMMARY_SEP]);
  for (const chunk of sectionsOf(head, ARCHIVE_SEP)) {
    const [path, at] = chunk.split("\n");
    if (path?.trim()) out[path.trim().replace(/\/archived$/, "")] = (Number(at) || 0) * 1000;
  }
  return out;
}

/** The asks and answers at the head of LIST_SCRIPT's output → { <run dir>: { asks: {id: item}, answers: [answer] } }. */
export function parseAsks(text) {
  const head = beforeSections(text, [ARCHIVE_SEP, CONTROL_SEP, SEP, TOPIC_SEP, STATE_SEP, MESSAGE_SUMMARY_SEP]);
  const out = {};
  const at = (dir) => (out[dir] ??= { asks: {}, answers: [] });
  for (const part of sectionsOf(head, ASKS_SEP)) {
    const [chunk] = part.split(`\n${ANSWERS_SEP}`);
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const path = chunk.slice(0, nl).trim(), v = parseJSON(chunk.slice(nl + 1));
    if (path && v && typeof v === "object" && !Array.isArray(v)) at(path.replace(/\/asks\.json$/, "")).asks = v;
  }
  for (const chunk of sectionsOf(head, ANSWERS_SEP)) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const path = chunk.slice(0, nl).trim();
    const list = chunk.slice(nl + 1).split(`\n${ASKS_SEP}`)[0].split("\n").map((l) => parseJSON(l.trim())).filter((a) => a && typeof a === "object" && a.id);
    if (path) at(path.replace(/\/answers\.jsonl$/, "")).answers = list;
  }
  return out;
}

// Keep source paths and grouping context without adding fields to the public Topic / Task shapes.
const topicDirs = new WeakMap(), taskContexts = new WeakMap(), runTerminals = new WeakMap();

const APPROVAL_STATES = ["open", "approved", "failed", "rejected", "answered", "withdrawn"];
export const APPROVAL_WORDS = {
  open: "待处理", approved: "已批准并执行", failed: "已批准 · 执行失败", rejected: "已驳回", answered: "已回复", withdrawn: "已撤回",
};
const APPROVAL_OPS = {
  "task-add": "新建 Task 草稿", "task-edit": "修改 Task 草稿", "task-rm": "删除 Task 草稿",
  "backlog-add": "新增待细化条目", "backlog-edit": "修改待细化条目", "backlog-rm": "删除待细化条目",
  request: "调整派发或细化请求", abandon: "放弃 Task", pause: "暂停 Topic", resume: "继续 Topic",
};

/** Missing approvals are empty; a damaged file is explicitly unreadable, never a processed list. */
export function parseApprovals(text) {
  const empty = { open: [], history: [], readFailed: false };
  if (text == null) return empty;
  const value = parseJSON(text);
  if (!objectJSON(value) || !Array.isArray(value.items) || !Number.isInteger(value.next) || value.next < 1 || value.items.some((item) =>
    !objectJSON(item) || typeof item.id !== "string" || !item.id
    || !objectJSON(item.from) || !(typeof item.from.topic === "string" && item.from.topic
      || item.from.topic === null && typeof item.from.terminal === "string" && item.from.terminal
        && item.from.task == null && item.from.run == null)
    || ["task", "terminal", "agent", "run"].some((key) => item.from[key] != null && typeof item.from[key] !== "string")
    || !Object.prototype.hasOwnProperty.call(APPROVAL_OPS, item.op) || !objectJSON(item.args)
    || typeof item.summary !== "string" || typeof item.reason !== "string"
    || typeof item.created !== "number" || !Number.isFinite(item.created)
    || !APPROVAL_STATES.includes(item.state)
    || (item.decided_at != null && (typeof item.decided_at !== "number" || !Number.isFinite(item.decided_at)))
    || (item.note != null && typeof item.note !== "string")
    || (item.result != null && (!objectJSON(item.result) || typeof item.result.ok !== "boolean"
      || (item.result.failure != null && typeof item.result.failure !== "string")
      || typeof item.result.output !== "string")))) return { ...empty, readFailed: true };
  const items = value.items.map((item) => ({ ...item, createdAt: item.created * 1000,
    decidedAt: item.decided_at == null ? null : item.decided_at * 1000 }));
  return {
    open: items.filter((item) => item.state === "open").sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    history: items.filter((item) => item.state !== "open").sort((a, b) =>
      (b.decidedAt ?? b.createdAt) - (a.decidedAt ?? a.createdAt) || b.id.localeCompare(a.id)),
    readFailed: false,
  };
}

/** Describe the exact stored operation and every argument without reconstructing a shell command. */
export function approvalOperation(item) {
  const labels = { task: "Task", title: "标题", kind: "职责", detail: "说明", depends: "要等的 Task", blocks: "在等它的 Task",
    add_depends: "增加依赖", remove_depends: "移除依赖",
    from_backlog: "来源条目", item: "条目", text: "内容", items: "条目", type: "请求类型", target: "接收方",
    agent: "agent", cancel: "撤销请求", resend: "重发请求", reason: "放弃原因", force: "仍然放弃" };
  return {
    title: `${APPROVAL_OPS[item.op] ?? item.op}（${item.op}）`,
    args: Object.entries(item.args ?? {}).map(([key, value]) => {
      const name = key.replace(/-/g, "_");
      const words = { target: { owner: "Topic 负责人", new_tab: "新标签页" }, type: { dispatch: "派发 Task", refine: "细化条目" } };
      const text = typeof value === "boolean" ? value ? "是" : "否"
        : value === "" ? ["depends", "blocks"].includes(name) ? "清空" : "空字符串"
        : words[name]?.[value] ?? (typeof value === "string" ? value : JSON.stringify(value));
      return { label: `${labels[name] ?? key}（--${key.replace(/_/g, "-")}）`, text };
    }),
  };
}

/** Topic JSON and its optional backlog and approvals, following the existing run sections. */
export function parseTopics(text) {
  const out = {};
  for (const part of sectionsOf(beforeSections(text, [STATE_SEP, MESSAGE_SUMMARY_SEP]), TOPIC_SEP)) {
    const [data, approval] = part.split(`\n${APPROVALS_SEP}`);
    const [chunk, back] = data.split(`\n${BACKLOG_SEP}`), nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const path = chunk.slice(0, nl).trim(), topic = parseJSON(chunk.slice(nl + 1));
    if (!path || !objectJSON(topic) || typeof topic.id !== "string" || !topic.id) continue;
    const backlog = back ? parseJSON(back.slice(back.indexOf("\n") + 1)) : null;
    out[topic.id] = { topic, backlog: objectJSON(backlog) ? backlog : { items: [] } };
    if (approval != null) out[topic.id].approvals = parseApprovals(approval.slice(approval.indexOf("\n") + 1));
    topicDirs.set(topic, path.replace(/\/topic\.json$/, ""));
  }
  return out;
}

/** Every run's state.json; keys are absolute run directories, as in parseControls. */
export function parseStates(text) {
  const out = {};
  for (const chunk of sectionsOf(beforeSections(text, [MESSAGE_SUMMARY_SEP]), STATE_SEP)) {
    const nl = chunk.indexOf("\n");
    if (nl < 0) continue;
    const path = chunk.slice(0, nl).trim(), state = parseJSON(chunk.slice(nl + 1));
    if (path && objectJSON(state)) out[path.replace(/\/state\.json$/, "")] = state;
  }
  return out;
}

/** Summaries are last, so marker text inside them never enters the older section parsers. */
export function parseMessageSummaries(text) {
  // Each section starts a line; JSON never holds a raw newline, so "\n<marker>" only matches real sections.
  // Plain string search: the panel's runtime stalls on a pattern split of the whole ~1MB dump.
  const out = [], marker = `\n${MESSAGE_SUMMARY_SEP}`, all = `\n${String(text ?? "")}`, start = all.indexOf(marker);
  if (start < 0) return out;
  for (const chunk of all.slice(start).split(marker).slice(1)) {
    const nl = chunk.indexOf("\n"), path = chunk.slice(0, nl).trim();
    const match = path.match(/^(.*)\/\.cc-dispatch\/messages\/([^/]+)\.summary\.json$/);
    const summary = nl >= 0 ? parseJSON(chunk.slice(nl + 1)) : null;
    if (match && objectJSON(summary)) out.push({ repo: match[1], topic: match[2], summary });
  }
  return out;
}

/** The scanned Topic directory, with a fallback for Topics constructed outside the scanner. */
export function topicDir(topic) {
  if (topic?.implicit) return topic.runs?.[0]?.dir ?? null;
  const repo = topic?.repo ?? topic?.runs?.[0]?.repo ?? (topic?.runs?.[0]?.dir ? repoOf(topic.runs[0].dir) : null);
  return topicDirs.get(topic) ?? topic?.dir ?? (repo ? `${repo}/.cc-dispatch/topics/${topic.id}` : null);
}

/** Archive (or take back out) an ended run: `sh -c ARCHIVE_SCRIPT _ archive|unarchive <run dir>`. */
export const ARCHIVE_SCRIPT = 'case "$1" in archive) date +%s > "$2/archived" ;; unarchive) rm -f "$2/archived" ;; *) exit 2 ;; esac';

/**
 * Whether the panel offers to archive a run: once every helper is in a settled stage (report ok, merged,
 * done, parked, ended: nothing left for anyone to do), no card is still queued, in progress or in review,
 * and the run is not paused, stopping or handing off.
 * Not whether it is `live`: a run whose helpers all reported fine is done even while their terminals are
 * still open or its main agent still runs. `cards` is the run's card statuses (state.json), if any.
 * An archived run stays hidden only while this holds: a helper that needs someone again brings it back,
 * and hd_dispatch.py run / send remove the marker. A run hd_dispatch.py retire ended (control.json
 * `retired`) holds whatever its cards say: nobody carries it on.
 */
export function canArchive(r, cards) {
  const state = r?.control?.state ?? "running";
  if (["paused", "stopping", "handoff"].includes(state) || !r?.calls?.length) return false;
  if (r.control?.retired) return true;
  if (Object.values(cards ?? {}).some((s) => !CARD_FINAL.has(s))) return false; // a card still to do (queued, …)
  return r.calls.every((c) => SETTLED.has(callStage(c, cards?.[c.call])));
}

/** Archived and still settled: left out of the list (shown under "n archived"). */
export const archivedAway = (r, cards) => Boolean(r?.archived) && canArchive(r, cards);

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

/**
 * The helper's terminal: by address, else by name among live ones. None once hd_dispatch.py closed it
 * (meta.open false: cleanup, stop and freeze set it only after `hc kill` and `hc rm`), even while the app's
 * terminal list still has it: that list can lag herdr-core, and View on it fails with "no running terminal".
 */
function terminalFor(meta, terminals) {
  if (meta.open === false) return null;
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
    // The main agents it had before an adopt ([{terminal, agent, session}], oldest first; hd_dispatch.py earlier_mains).
    earlierMains: Array.isArray(meta.mains) ? meta.mains.filter((m) => m && typeof m === "object") : [],
    title: term?.title ?? "",
    // What hd_dispatch.py run --title gave it (Chinese since the panel went Chinese), shown on its row.
    taskTitle: meta.title ?? "",
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
  agy: { label: "Antigravity", isolation: "weak" },
};
export const agentLabel = (a) => AGENTS[a]?.label ?? a;
/** How the panel names a run's main agent: "the main agent (Codex)", or just "the main agent". */
export const mainAgentName = (r) => r?.mainAgent ? `主 agent（${agentLabel(r.mainAgent)}）` : "主 agent";
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

/** A main agent's program as a short key: claude-code → claude, …/codex → codex; not recorded → claude (runs from before it was). */
export const mainKey = (name) => { const n = String(name ?? "").toLowerCase(); return !n ? "claude" : n.includes("claude") ? "claude" : n.includes("codex") ? "codex"
  : /\bagy\b|antigravity/.test(n) ? "agy" : n; };

/**
 * Every main agent that dispatched to a run, newest first: [{agent, session}]. A long run outlives its
 * first one, and a takeover replaces it (meta.json's mains, older still). session is null when
 * hd_dispatch.py could not record it (bg.js then finds it); such an entry is kept only for a program
 * with no recorded session.
 */
export function runMains(calls) {
  const list = [
    ...[...calls].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)).map((c) => ({ agent: mainKey(c.mainAgent), session: c.session || null })),
    ...calls.flatMap((c) => [...c.earlierMains].reverse()).map((m) => ({ agent: mainKey(m.agent), session: m.session || null })),
  ];
  const known = new Set(list.filter((m) => m.session).map((m) => m.agent)), seen = new Set(), out = [];
  for (const m of list) {
    const k = `${m.agent}|${m.session}`;
    if (seen.has(k) || (!m.session && known.has(m.agent))) continue;
    seen.add(k); out.push(m);
  }
  return out;
}

export function buildRuns(entries, terminals, controls = {}, archived = {}, asks = {}, states = {}) {
  const byRun = new Map();
  for (const { path, meta } of entries ?? []) {
    const dir = runDirOf(path);
    if (!byRun.has(dir)) byRun.set(dir, []);
    byRun.get(dir).push(buildCall(meta, dir, terminals));
  }
  for (const dir of Object.keys(states ?? {})) if (!byRun.has(dir)) byRun.set(dir, []);
  const runs = [...byRun].map(([dir, calls]) => {
    calls.sort((a, b) => a.call.localeCompare(b.call));
    const control = controls?.[dir] && (controls[dir].state !== "running" || controls[dir].retired) ? controls[dir] : null;
    if (control?.state === "paused") for (const c of calls) c.held = (control.held ?? []).includes(c.call);
    const counts = {};
    for (const c of calls) { const n = callNeed(c); counts[n] = (counts[n] ?? 0) + 1; }
    const need = calls.map(callNeed).sort((a, b) => rank(a) - rank(b))[0] ?? "gone";
    return {
      dir, id: baseName(dir), kind: kindOf(dir), repo: repoOf(dir),
      calls, counts, need, control, archived: archived?.[dir] ?? null,
      // The terminal that holds the run (control.json owner), known even before it dispatched any helper.
      owner: controls?.[dir]?.owner ?? null,
      asks: asks?.[dir]?.asks ?? {}, answers: asks?.[dir]?.answers ?? [],
      hd: calls.find((c) => c.hd)?.hd ?? null,
      helpersLive: calls.some((c) => c.state === "live"),
      parent: runParent(calls, terminals),
      // Its main agents' sessions, whose logs list their background tasks (bg.js).
      mains: runMains(calls),
      adopted: calls.some((c) => c.adoptedFrom),
      lastAt: Math.max(0, ...calls.map((c) => c.startedAt || 0)),
      space: calls.find((c) => c.space)?.space ?? null,
      claudeCwd: calls.find((c) => c.claudeCwd)?.claudeCwd ?? null,
      // The program the main agent runs (claude, codex, …) as hd_dispatch.py recorded it; the newest wins (adopt).
      mainAgent: calls.find((c) => c.adoptedFrom && c.mainAgent)?.mainAgent ?? calls.find((c) => c.mainAgent)?.mainAgent ?? null,
      startedAt: Math.min(...calls.map((c) => c.startedAt || Infinity)),
    };
  });
  for (const r of runs) if (!Number.isFinite(r.startedAt)) r.startedAt = 0;
  // `live`: the run is still going, the one test the whole panel uses (polling, tasks, quota, controls,
  // looks). Not just "a helper's terminal lives": between dispatches all may have ended while the main
  // agent works on (runs shells, reviews, merges).
  const active = activeRuns(runs, terminals);
  for (const r of runs) { r.live = active.has(r.dir); runTerminals.set(r, terminals ?? []); }
  return runs.sort((a, b) => (b.live - a.live) || (b.startedAt - a.startedAt) || b.id.localeCompare(a.id));
}

const epochMs = (at) => at == null ? null : (Number(at) || 0) * 1000;
const requestView = (r) => objectJSON(r) ? {
  id: r.id, type: r.type, target: r.target, agent: r.agent ?? null,
  at: epochMs(r.at) ?? 0, deliveredAt: epochMs(r.delivered_at),
} : null;

/** Explicit Topics and historical, single-run Topics share the same panel shape. */
export function buildTopics(runs, topics = {}, states = {}, summaries = []) {
  const list = [], claimed = new Set(), allRuns = runs ?? [];
  for (const { topic: raw, backlog, approvals } of Object.values(topics ?? {})) {
    if (!objectJSON(raw) || !raw.id) continue;
    const topic = {
      id: raw.id, title: raw.title ?? raw.id, implicit: false, archived: epochMs(raw.archived),
      pausedAt: epochMs(raw.paused_at), deleting: Boolean(raw.deleting), owner: raw.owner ?? null,
      createdAt: epochMs(raw.created_at) ?? 0, tasks: [], backlog: [], runs: [], updatedAt: 0,
      follows: Array.isArray(raw.follows) ? raw.follows.filter((id) => typeof id === "string") : [],
      messages: { unacked: 0, openIn: 0, answersUnacked: 0, openOut: 0 },
      approvals: approvals ?? parseApprovals(null),
    };
    const dir = topicDirs.get(raw);
    if (dir) topicDirs.set(topic, dir);
    for (const [id, t] of Object.entries(raw.tasks ?? {})) {
      if (!objectJSON(t)) continue;
      // topic.json holds the binding; a main agent rewriting state.json can drop its copy of it.
      const run = allRuns.find((r) => baseName(r.dir) === t.run
        && (!dir || parentOf(r.dir) === parentOf(parentOf(dir)))) ?? null;
      const task = {
        id, title: t.title ?? id, kind: t.kind ?? run?.kind ?? "dev", detail: t.detail ?? "",
        dependsOn: Array.isArray(t.depends_on) ? [...t.depends_on] : [], parentTask: t.parent_task ?? null,
        fromBacklog: t.from_backlog ?? null, run,
        runDir: run?.dir ?? (t.run && dir ? `${parentOf(parentOf(dir))}/${t.run}` : t.run ?? null), agent: t.agent ?? null,
        request: requestView(t.request), summaryLine: t.summary_line ?? null, artifact: t.artifact ?? null,
        createdAt: epochMs(t.created_at) ?? 0, startedAt: epochMs(t.started_at), finishedAt: epochMs(t.finished_at),
        abandonedAt: epochMs(t.abandoned_at), abandonReason: t.abandon_reason ?? null,
        summaryDone: t.summary_done ?? null, summaryOpen: t.summary_open ?? null,
        group: "queued",
      };
      taskContexts.set(task, { state: run ? states[run.dir] ?? {} : {}, runs: allRuns });
      topic.tasks.push(task);
      if (run) {
        claimed.add(run.dir);
        if (!topic.runs.includes(run)) topic.runs.push(run);
      }
    }
    topic.backlog = (Array.isArray(backlog?.items) ? backlog.items : []).filter(objectJSON).map((b) => ({
      id: b.id, text: b.text ?? "", status: b.status ?? "open", request: requestView(b.request),
      taskIds: Array.isArray(b.task_ids) ? [...b.task_ids] : [],
      createdAt: epochMs(b.created_at) ?? 0, updatedAt: epochMs(b.updated_at) ?? 0,
    }));
    list.push(topic);
  }
  for (const run of allRuns) {
    if (claimed.has(run.dir)) continue;
    const task = {
      // The Topic already carries the run's directory name; the Task shows what the run is about.
      id: "k1", title: states[run.dir]?.title || run.id || baseName(run.dir), kind: run.kind, detail: "", dependsOn: [],
      parentTask: null, fromBacklog: null, run, runDir: run.dir, agent: run.mainAgent ?? null,
      request: null, summaryLine: null, artifact: null, createdAt: run.startedAt || 0,
      startedAt: run.startedAt || null, finishedAt: null, abandonedAt: null, abandonReason: null,
      summaryDone: null, summaryOpen: null, group: "active",
    };
    taskContexts.set(task, { state: states[run.dir] ?? {}, runs: allRuns });
    list.push({
      id: `run:${baseName(run.dir)}`, title: baseName(run.dir), implicit: true,
      archived: run.archived ?? null, pausedAt: run.control?.state === "paused" ? epochMs(run.control.at) : null,
      deleting: false, owner: null, createdAt: run.startedAt || 0, tasks: [task], backlog: [], runs: [run], updatedAt: 0,
      follows: [], messages: { unacked: 0, openIn: 0, answersUnacked: 0, openOut: 0 },
      approvals: parseApprovals(null),
    });
  }
  for (const topic of list) {
    const dir = topicDir(topic), repo = dir?.replace(/\/\.cc-dispatch\/topics\/[^/]+$/, "");
    let lastMessageAt = 0;
    if (!topic.implicit) for (const entry of summaries) {
      if (repo && entry.repo !== repo) continue;
      const s = entry.summary, sender = topic.id === "user" ? null : s.by_sender?.[topic.id];
      const count = (n) => Math.max(0, Number(n) || 0);
      if (entry.topic === topic.id) {
        topic.messages.unacked += count(s.unacked);
        topic.messages.openIn += count(s.open_in);
      }
      topic.messages.answersUnacked += count(sender?.answers_unacked);
      topic.messages.openOut += count(sender?.open);
      if (entry.topic === topic.id || sender) lastMessageAt = Math.max(lastMessageAt, epochMs(s.last_at) || 0);
    }
    for (const task of topic.tasks) task.group = taskGroup(task, topic);
    topic.updatedAt = Math.max(topic.createdAt, topic.archived || 0, topic.pausedAt || 0, lastMessageAt,
      ...[...topic.approvals.open, ...topic.approvals.history].flatMap((item) => [item.createdAt, item.decidedAt || 0]),
      ...topic.tasks.flatMap((t) => [t.createdAt, t.startedAt || 0, t.finishedAt || 0, t.abandonedAt || 0, t.request?.at || 0, t.request?.deliveredAt || 0]),
      ...topic.backlog.flatMap((b) => [b.updatedAt, b.request?.at || 0, b.request?.deliveredAt || 0]),
      ...topic.runs.map((r) => r.lastAt || r.startedAt || 0));
  }
  return list.sort((a, b) => (b.updatedAt - a.updatedAt) || b.id.localeCompare(a.id));
}

/** Resolve local and cross-Topic dependencies from the same repository's snapshots. */
export function dependsState(topics, srcTopic, ref) {
  const list = Array.isArray(topics) ? topics : Object.values(topics ?? {});
  const src = typeof srcTopic === "string" ? list.find((t) => t.id === srcTopic) : srcTopic;
  const repo = (t) => topicDir(t)?.replace(/\/\.cc-dispatch\/topics\/[^/]+$/, "") ?? t?.repo;
  const sourceRepo = repo(src);
  const find = (id) => list.find((t) => t.id === id && (!sourceRepo || !repo(t) || repo(t) === sourceRepo));
  const parse = (id, value) => {
    const parts = String(value ?? "").split(":");
    return parts.length === 1 ? [id, parts[0]] : parts.length === 2 ? parts : ["", ""];
  };
  const [topic, task] = parse(src?.id ?? srcTopic, ref), target = find(topic);
  const item = target?.tasks.find((t) => t.id === task);
  const result = { state: "missing", topic, task, title: item?.title ?? "", path: [] };
  if (!item) return result;
  // Iterative depth-first walk, like the script: chains of any length fit, each task is expanded once.
  const visited = new Set();
  const visit = (t, k) => {
    const path = [], stack = [];
    const enter = (topic, task) => {
      const key = `${topic.id}:${task.id}`, start = path.indexOf(key);
      if (start >= 0) return [...path.slice(start), key];
      if (!visited.has(key)) {
        visited.add(key);
        path.push(key);
        stack.push({ topic, deps: (task.dependsOn ?? [])[Symbol.iterator]() });
      }
      return null;
    };
    let cycle = enter(t, k);
    while (stack.length && !cycle) {
      const top = stack.at(-1), step = top.deps.next();
      if (step.done) { stack.pop(); path.pop(); continue; }
      const [id, tid] = parse(top.topic.id, step.value), next = find(id), child = next?.tasks.find((x) => x.id === tid);
      if (child) cycle = enter(next, child);
    }
    return cycle;
  };
  const cycle = visit(target, item);
  if (cycle) return { ...result, state: "cycle", path: cycle };
  const state = taskContexts.get(item)?.state ?? item.run?.state ?? {};
  // Same order as the script's depends_state: retiring writes state.finished too, so it is checked first.
  result.state = item.abandonedAt != null ? "abandoned" : item.finishedAt != null ? "done"
    : item.run?.control?.state === "stopped" || item.run?.control?.retired ? "stopped"
    : state.finished != null ? "done" : "pending";
  return result;
}

export function dependencyText(topics, srcTopic, dep) {
  const topic = topics.find((t) => t.id === dep.topic);
  return { pending: `等 ${topic?.title ?? dep.topic}·${dep.title || dep.task}`,
    stopped: "依赖已终止", abandoned: "依赖已放弃", missing: "依赖已删除",
    cycle: `依赖成环：${dep.path.join(" → ")} · 请编辑依赖` }[dep.state] ?? "";
}

/** The script accepts local kN refs and explicit Topic:kN refs. */
export function parseTaskRef(srcTopic, ref) {
  if (typeof ref !== "string" || !/^(?:[a-zA-Z0-9][a-zA-Z0-9_-]*:)?k[1-9][0-9]*$/.test(ref)) return null;
  const parts = ref.split(":");
  return { topic: parts.length === 1 ? srcTopic : parts[0], task: parts.at(-1) };
}

/** Normalize and deduplicate selections, retaining invalid old refs until the user removes them. */
export function taskRefs(srcTopic, refs) {
  return [...new Set((refs ?? []).map((ref) => {
    const parsed = parseTaskRef(srcTopic, ref);
    return parsed ? parsed.topic === srcTopic ? parsed.task : `${parsed.topic}:${parsed.task}` : String(ref ?? "");
  }).filter(Boolean))].join(",");
}

const dependencyPeers = (topics, srcTopic) => {
  const repo = (topic) => topicDir(topic)?.replace(/\/\.cc-dispatch\/topics\/[^/]+$/, "") ?? topic?.repo;
  const sourceRepo = repo(srcTopic), sourceOn = srcTopic?.on ?? null;
  return (topics ?? []).filter((topic) => !topic.implicit
    && (!sourceRepo || repo(topic) === sourceRepo) && (topic.on ?? null) === sourceOn);
};

function reverseEdges(peers, srcTopic, srcTask) {
  const refs = new Set(), pending = new Set();
  for (const topic of peers) {
    for (const task of topic.tasks ?? []) {
      if (topic.id === srcTopic.id && task.id === srcTask.id) continue;
      if ((task.dependsOn ?? []).some((value) => {
        const parsed = parseTaskRef(topic.id, value);
        return parsed?.topic === srcTopic.id && parsed.task === srcTask.id;
      })) refs.add(topic.id === srcTopic.id ? task.id : `${topic.id}:${task.id}`);
    }
    if (topic.id === srcTopic.id) continue;
    for (const item of topic.approvals?.open ?? []) {
      if (item.op === "task-edit" && item.from.topic === srcTopic.id && item.from.task === srcTask.id
        && item.from.run == null && item.args.add_depends === `${srcTopic.id}:${srcTask.id}`) {
        const target = parseTaskRef(topic.id, item.args.task);
        if (target && target.task === item.args.task) pending.add(`${topic.id}:${target.task}`);
      }
    }
  }
  return { refs, pending };
}

/** Include selected reverse edges even when their Topic is hidden in the editor. */
export function taskBlockRefs(topics, srcTopic, srcTask) {
  const { refs, pending } = reverseEdges(dependencyPeers(topics, srcTopic), srcTopic, srcTask);
  return [...new Set([...refs, ...pending])];
}

/** Same-repository choices, including automatic blocks still awaiting a decision. */
export function dependencyChoices(topics, srcTopic, srcTask) {
  const peers = dependencyPeers(topics, srcTopic), blocked = reverseEdges(peers, srcTopic, srcTask);
  const selected = new Set(taskRefs(srcTopic.id, srcTask.dependsOn).split(",").filter(Boolean));
  const groups = new Map(), available = new Set();
  const groupFor = (id) => {
    if (!groups.has(id)) {
      const peer = peers.find((topic) => topic.id === id);
      groups.set(id, { id, title: peer?.title ?? id, archived: Boolean(peer?.archived), tasks: [] });
    }
    return groups.get(id);
  };
  for (const topic of peers.filter((peer) => !peer.deleting)) {
    for (const task of topic.tasks ?? []) {
      if (topic.id === srcTopic.id && task.id === srcTask.id) continue;
      const ref = topic.id === srcTopic.id ? task.id : `${topic.id}:${task.id}`;
      const committed = blocked.refs.has(ref), pendingBlock = blocked.pending.has(ref);
      const group = taskGroup(task, topic), request = requestState(task), control = task.run?.control;
      const status = task.abandonedAt != null ? "abandoned" : task.finishedAt != null ? "done"
        : control?.state === "stopped" || control?.retired ? "stopped"
        : ["paused", "stopping", "handoff"].includes(control?.state) ? control.state
        : group === "done" ? "done" : group === "you" ? "blocked"
        : task.runDir || task.run ? "running" : request ?? "draft";
      groupFor(topic.id).tasks.push({
        id: task.id, title: task.title, ref, status, depends: selected.has(ref), blocks: committed || pendingBlock,
        pendingBlock, missing: false, canBlock: (pendingBlock && !committed) || (!task.runDir && !task.run && !topic.archived),
      });
      available.add(ref);
    }
  }
  for (const ref of selected) {
    if (available.has(ref)) continue;
    const parsed = parseTaskRef(srcTopic.id, ref), peer = peers.find((topic) => topic.id === parsed?.topic);
    const existing = peer?.tasks?.find((task) => task.id === parsed?.task);
    const reason = !existing ? "已删除或编号无效" : peer.deleting ? "Topic 正在删除" : "Task 不能依赖自己";
    groupFor(parsed?.topic ?? srcTopic.id).tasks.push({
      id: parsed?.task ?? ref, title: existing?.title ?? "", ref, status: "missing", depends: true,
      blocks: false, missing: !existing, unavailableReason: reason, canBlock: false,
    });
  }
  return [...groups.values()].sort((a, b) => (b.id === srcTopic.id) - (a.id === srcTopic.id) || a.id.localeCompare(b.id))
    .map((group) => ({ ...group, tasks: group.tasks.sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)) || a.id.localeCompare(b.id)) }));
}

/** A question's terminal state takes precedence over delivery and acknowledgement. */
export const questionState = (item) => item?.kind !== "question" ? null
  : item.answer ? "answered" : item.withdrawn_at != null ? "withdrawn" : item.dropped ? "dropped" : "open";

export function messageStatus(item) {
  const state = questionState(item);
  const delivery = item.user_seen === true ? "已读" : item.acked_at != null ? "已确认" : item.delivered ? "已送达" : "排队";
  const word = { open: "待回答", answered: "已回答", withdrawn: "已撤销", dropped: "已作废" }[state];
  return state === "withdrawn" || state === "dropped" ? word
    : item.dropped && !state ? "已作废" : [word, delivery].filter(Boolean).join(" · ");
}

/** Incoming user questions also carry their answers; keep one row per message. */
export function messageGroups(data, topics = []) {
  const groups = new Map(), seen = new Set();
  for (const [direction, items] of [["incoming", data?.incoming], ["outgoing", data?.answers], ["outgoing", data?.outgoing]]) {
    for (const item of items ?? []) {
      if (!objectJSON(item)) continue;
      const key = `${item.to}|${item.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const id = direction === "incoming" ? item.from?.user ? "user" : item.from?.topic : item.to;
      const title = id === "user" ? "用户" : topics.find((t) => t.id === id)?.title
        ?? (direction === "incoming" ? item.from?.title : id && `${id}（已删除）`) ?? id ?? "未知 Topic";
      if (!groups.has(id)) groups.set(id, { id, title, items: [] });
      const state = questionState(item), incoming = direction === "incoming";
      const own = item.from?.user || (!incoming && item.from?.topic === data.topic);
      groups.get(id).items.push({ item, direction, status: messageStatus(item),
        canWithdraw: Boolean(own && state === "open"),
        canAck: Boolean(item.user_seen !== true
          && ((incoming && item.acked_at == null && item.withdrawn_at == null && !item.dropped)
            || (item.answer && item.answer.acked_at == null && own))),
      });
    }
  }
  for (const group of groups.values()) group.items.sort((a, b) => a.item.at - b.item.at);
  return [...groups.values()];
}

/**
 * A Topic's Tasks as a timeline, oldest first: when each started (or was drafted), its role, the
 * executor, where it stands, the one-line conclusion, what it completed and what it leaves open. Open
 * items are what the Task wrote at finish plus what its run still waits on you for (unanswered asks,
 * cards parked for you) and, for an unfinished Task, its cards not merged yet.
 */
export function topicTimeline(topic) {
  const lines = (text) => String(text ?? "").split("\n").map((x) => x.replace(/^\s*[-*•]\s*/, "").trim()).filter(Boolean);
  return [...(topic?.tasks ?? [])].map((task) => {
    const state = taskContexts.get(task)?.state ?? {}, group = taskGroup(task, topic);
    const cards = Object.entries(state.tasks ?? {}).filter(([id, c]) => objectJSON(c) && !c.check && id !== "survey" && !/-check-r\d+$/.test(id));
    const waiting = task.run ? pendingItems(task.run, Object.fromEntries(cards), state.pending_decisions).filter((x) => !x.answer).map((x) => x.title) : [];
    const unmerged = group === "done" ? [] : cards.filter(([, c]) => !["merged", "parked"].includes(c.status)).map(([id, c]) => `${id} ${c.title ?? ""}`.trim());
    const status = task.abandonedAt != null ? "abandoned" : group === "done" ? "done" : group === "queued" ? "queued" : group === "you" ? "you" : "active";
    return {
      id: task.id, kind: task.kind, title: task.title, agent: task.agent ?? task.request?.agent ?? null, status,
      at: task.startedAt || task.createdAt || 0, end: task.abandonedAt ?? task.finishedAt ?? null,
      line: task.abandonedAt != null ? `已放弃：${task.abandonReason ?? "未写原因"}` : task.summaryLine ?? null,
      done: lines(task.summaryDone), open: [...new Set([...lines(task.summaryOpen), ...waiting, ...unmerged])],
      artifact: task.artifact ?? null,
    };
  }).sort((a, b) => (a.status === "queued") - (b.status === "queued") || a.at - b.at || a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * A Task's cards for its summary dialog, in id order: each dispatched helper (its stage, executor, the report
 * to read its conclusion from, its card's note) and each card not dispatched yet (its status and note).
 */
export function taskCards(task) {
  const r = task?.run, state = taskContexts.get(task)?.state ?? r?.state ?? {};
  const cards = Object.fromEntries(Object.entries(state.tasks ?? {}).filter(([, c]) => objectJSON(c)));
  const calls = (r?.calls ?? []).map((c) => ({
    id: c.call, title: c.taskTitle || cards[c.call]?.title || "", stage: callStage(c, cards[c.call]?.status),
    agent: c.agent ?? null, rounds: c.round ?? 1, round: c.round ?? 1, note: cards[c.call]?.note ?? null,
    reportPath: c.reportPath || null, agentDir: c.agentDir || null,
  }));
  const have = new Set(calls.map((c) => c.id));
  const rest = Object.entries(cards).filter(([id, c]) => !have.has(id) && !c.check && id !== "survey" && !/-check-r\d+$/.test(id))
    .map(([id, c]) => ({ id, title: c.title ?? "", stage: c.status ?? "pending", agent: null, rounds: 0, note: c.note ?? null, reportPath: null, agentDir: null }));
  return [...calls, ...rest].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
}

/**
 * The panel's Topic order: running first (a Task working or waiting on the person), then paused, then the
 * rest that are not archived, each newest first; archived last, most recently archived first.
 */
export function orderTopics(topics) {
  const running = (x) => x.approvals?.open.length > 0 || x.approvals?.readFailed
    || x.tasks.some((task) => ["active", "you"].includes(taskGroup(task, x)));
  const open = topics.filter((x) => !x.archived);
  return {
    running: open.filter((x) => !x.pausedAt && running(x)),
    paused: open.filter((x) => x.pausedAt),
    ended: open.filter((x) => !x.pausedAt && !running(x)),
    archived: topics.filter((x) => x.archived).sort((a, b) => b.archived - a.archived),
  };
}

const GIST_VERDICTS = {
  LGTM: "没有问题", ISSUES: "提出问题", HOLDS: "未找到反例", FAILS: "找到反例", PASS: "测试通过", FAIL: "测试失败", BLOCKED: "受阻",
  done: "已完成", partial: "部分完成", blocked: "受阻",
};
/**
 * What a helper's report says, for the Task summary: its verdict in words, its one-line summary (summary or
 * answer) and the titles of what it found (findings, cases, failures, candidates), most severe first, at most 5.
 */
export function reportGist(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const raw = v.verdict ?? v.status, verdict = GIST_VERDICTS[raw] ?? (typeof raw === "string" ? raw : null);
  const summary = [v.summary, v.answer, v.recommendation?.reason].find((x) => typeof x === "string" && x.trim()) ?? "";
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const found = ["findings", "cases", "failures", "candidates"].flatMap((k) => Array.isArray(v[k]) ? v[k] : [])
    .filter((x) => x && typeof x === "object")
    .sort((a, b) => (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4));
  const items = found.slice(0, 5).map((x) => {
    const text = x.title ?? x.problem ?? x.claim ?? x.lesson ?? x.test ?? x.name ?? x.id ?? "";
    const line = String(text).split("\n")[0], id = x.id && !line.startsWith(String(x.id)) ? x.id : null;
    return [id, x.severity && `[${x.severity}]`, line].filter(Boolean).join(" ");
  });
  return { verdict, summary, items, more: Math.max(0, found.length - items.length), total: found.length };
}

/** A Task needs the person before it can be considered done, even after helpers have reported. */
export function taskGroup(task, topic) {
  if (task?.abandonedAt != null) return "done";
  const run = task?.run;
  if (!run && !task?.runDir) return "queued";
  if (!run) return task.finishedAt ? "done" : "active";
  const context = taskContexts.get(task), state = context?.state ?? run.state ?? {};
  const cards = Object.fromEntries(Object.entries(state.tasks ?? {}).filter(([id, c]) => objectJSON(c)
    && !c.check && id !== "survey" && !/-check-r\d+$/.test(id)));
  const statuses = Object.fromEntries(Object.entries(cards).map(([id, c]) => [id, c.status]));
  const control = run.control?.state ?? "running";
  const unanswered = pendingItems(run, cards, state.pending_decisions).some((x) => !x.answer);
  if (unanswered || ["paused", "handoff"].includes(control)
    || (run.calls ?? []).some((c) => ["blocked", "lost", "failed", "bad"].includes(callStage(c, statuses[c.call])))) return "you";
  const finished = Boolean(task.finishedAt || state.finished || control === "stopped" || run.control?.retired);
  if (finished) return "done";
  if (needsTakeover(run, runTerminals.get(run) ?? [], statuses)) return "you";
  const children = Array.isArray(state.children) ? state.children : [];
  const childLive = (context?.runs ?? []).some((r) => r.live && children.some((child) => child === r.dir || child === baseName(r.dir)));
  if (topic?.implicit && !run.live && !childLive && control !== "stopping" && canArchive(run, statuses)) return "done";
  return "active";
}

/** Groups stay in urgency order; task order inside each group comes from topic.json. */
export function groupTasks(topic) {
  return ["you", "active", "queued", "done"].map((group) => ({
    group, tasks: (topic?.tasks ?? []).filter((t) => taskGroup(t, topic) === group),
  })).filter((g) => g.tasks.length);
}

export const requestState = (task) => task?.request ? (task.request.deliveredAt == null ? "queued" : "delivered") : null;

/** "2 working · 1 report bad · 3 done" in urgency order. */
export function summary(counts) {
  const words = { blocked: "等你", error: "失败", offline: "等网络", retry: "重试中", held: "已暂停", bad: "回报不合格", working: "进行中", review: "待收回报", done: "已完成", gone: "已结束" };
  return URGENCY.filter((k) => counts?.[k]).map((k) => `${words[k]} ${counts[k]}`).join(" · ");
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

/** A failure category (hd_dispatch.py) in words; unknown ones as they are. */
export const FAILURE_WORDS = { quota: "额度用完", auth: "登录失效", context_limit: "上下文满", refused: "被拦截", timeout: "超时",
  network: "网络问题", net: "网络问题", net_down: "网络断开", rate_limit: "限流", capacity: "服务繁忙", model_unavailable: "模型不可用",
  other: "其他错误", exited: "已退出", blocked: "等确认", lost: "已中断", error: "出错" };
export const failureWord = (k) => FAILURE_WORDS[k] ?? String(k ?? "");
/** A retry label ("capacity 1/4") with its category in words. */
export const retryWords = (s) => String(s ?? "").replace(/^([a-z_]+)\s*(.*)$/, (_m, k, rest) => `${failureWord(k)} 重试 ${rest}`.trim());
/** A terminal's state or status (herdr) in words. */
const STATE_WORDS = { working: "在干活", idle: "空闲", blocked: "等确认", done: "已完成", error: "出错", gone: "已关闭", finished: "已结束", live: "在线" };
export const stateWord = (s) => STATE_WORDS[s] ?? String(s ?? "");

/** A helper's row label: its call id and task title, else its terminal name. */
export const callLabel = (c) => c.taskTitle ? `${c.call} ${c.taskTitle}` : c.name;

/** The line under a call's name, after its stage: what the stage word does not already say. */
export function callDetail(c) {
  const parts = [[c.mode, c.effort].filter(Boolean).join("·")];
  if (c.round > 1) parts.push(`第 ${c.round} 轮`);
  if (c.report === "missing") parts.push("没有回报");
  if (c.failure && !["exited", "blocked", "lost"].includes(c.failure)) parts.push(failureWord(c.failure));
  if (c.retry) parts.push(retryWords(c.retry));
  if (c.agent && c.agent !== "codex") parts.push(agentLabel(c.agent) + (weakIsolation(c) ? "（弱隔离）" : ""));
  if (c.handingTo) parts.push(`正在移交给 ${agentLabel(c.handingTo)}`);
  if (c.lost) parts.push("终端消失了");
  else if (c.state !== "live") parts.push("已关闭");
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
  blocked: "等你", lost: "已中断", failed: "失败", offline: "等网络", retrying: "重试中", paused: "已暂停", working: "进行中", bad: "回报不合格", collect: "待收回报",
  await: "待验收", review: "验收中", ok: "回报合格", merged: "已合并", done: "已完成", parked: "已搁置", ended: "已结束",
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

/** A run's top stage once every helper has settled; an unfinished Task in one waits on the main agent's wrap-up. */
export const FINISHING_STAGES = new Set(["ok", "merged", "done", "parked", "ended"]);

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
  return STAGES.filter((s) => n[s]).map((s) => `${STAGE_WORDS[s]} ${n[s]}`).join(" · ");
}

/** A dev run's cards by status, for the cards bar: [[status, n]] in a fixed order. */
export const CARD_ORDER = ["merged", "done", "accepting", "running", "pending", "parked"];
/** The words for card statuses, kept apart from the helpers' stages ("working" is a helper's terminal). */
export const CARD_WORDS = { merged: "已合并", done: "已完成", accepting: "验收中", running: "进行中", pending: "排队中", parked: "已搁置" };
const CARD_FINAL = new Set(["merged", "done", "parked"]);

/**
 * The cards line: merged out of the cards still meant to be merged (parked ones are not), and the cards
 * no helper of the run stands for (`calls`: the run's call ids), queued first, with the dependencies
 * they still wait on. `run` is the stats script's {status, cards, checks}.
 */
export function cardView(run, calls = []) {
  const cards = run?.cards ?? Object.fromEntries(Object.entries(run?.status ?? {}).map(([k, s]) => [k, { status: s }]));
  const all = Object.entries(cards), n = (s) => all.filter(([, c]) => c.status === s).length;
  const parked = n("parked"), merged = n("merged") + n("done");
  const have = new Set(calls);
  const undispatched = all.filter(([id, c]) => !have.has(id) && !CARD_FINAL.has(c.status))
    .map(([id, c]) => ({ id, ...c, waits: (c.depends_on ?? []).filter((d) => !CARD_FINAL.has(cards[d]?.status) || cards[d]?.status === "parked") }))
    .sort((a, b) => (a.status === "pending") - (b.status === "pending") || a.id.localeCompare(b.id));
  return { total: all.length, goal: all.length - parked, merged, parked, checks: run?.checks ?? 0, undispatched };
}

/**
 * Why a card is parked: "user" (waiting for the person to decide: carry on or drop it), "superseded" (another
 * card took its place) or "dropped" (decided against). state.json's parked_why, else read from its note
 * (older runs), else "user": the dev skill parks a card to hand it to the person.
 */
export function parkedWhy(card) {
  if (!card || card.status !== "parked") return null;
  if (["user", "superseded", "dropped"].includes(card.parked_why)) return card.parked_why;
  const note = `${card.note ?? ""} ${card.result ?? ""}`;
  if (/supersed|replaced by|取代|替代/i.test(note)) return "superseded";
  if (/dropped|abandon|不做|放弃/i.test(note)) return "dropped";
  return "user";
}
/**
 * A run's cards for the stats: its task cards (state.json tasks) when it has any, else one card per helper
 * call (a review or research run has no task cards): done once its report is in, parked when its terminal
 * closed without one, running otherwise. `stats` is the stats script's {status, cards, checks} for the run.
 */
export function runCards(run, stats) {
  if (Object.keys(stats?.status ?? {}).length || !run?.calls?.length) return stats ?? null;
  const status = {}, cards = {};
  for (const c of run.calls) {
    const need = callNeed(c);
    status[c.call] = need === "done" ? "done" : need === "gone" ? "parked" : "running";
    cards[c.call] = { status: status[c.call], title: c.title ?? c.call };
  }
  return { status, cards, checks: stats?.checks ?? 0 };
}

/** Card counts for the stats bars and key; a merged card is finished work, so it counts as done. */
export function cardCounts(cards) {
  const n = {};
  for (const raw of Object.values(cards?.status ?? {})) { const s = raw === "merged" ? "done" : raw; n[s] = (n[s] ?? 0) + 1; }
  const known = CARD_ORDER.filter((s) => n[s]).map((s) => [s, n[s]]);
  const other = Object.entries(n).filter(([s]) => !CARD_ORDER.includes(s));
  return [...known, ...other];
}

/** How long ago, short. */
export function ago(ms, now = Date.now()) {
  if (!ms) return "";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

/** The newest task file of a call: task-<round>.md. */
export const taskPath = (c) => `${c.agentDir}/task-${c.round}.md`;

/** The script for a write-mode helper's changes: stat and short status of its worktree. */
export const DIFF_SCRIPT = [
  'cd "$1" || exit 1',
  'git rev-parse --show-toplevel >/dev/null 2>&1 || { echo "不是 git 仓库：$1"; exit 0; }',
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
    accept: `${c.call} 的回报已合格，但 state.json 里这张卡还没进入验收，请按 dev 4.4 验收并更新卡片状态`,
  }[ask] ?? `请看一下 ${c.call}`;
  return `[cc-dispatch 面板] ${what}。run=${c.runDir} call=${c.call}（${run}）`;
}

/**
 * Which messages to the main agent fit a call now: [] when it needs nothing. `card` is its dev card
 * ({status, parked_why, note}), if any: a good report on a card still pending / running asks for review;
 * a card parked for the person to decide is "decide" (its item in pendingItems, answered in the decide dialog).
 */
export function handoffAsks(c, card) {
  const need = callNeed(c);
  const one = { blocked: "blocked", lost: "lost", error: "diagnose", bad: "bad", review: "collect" }[need];
  if (one) return [one];
  const stage = callStage(c, card?.status);
  if (stage === "await") return ["accept"];
  if (stage === "parked" && parkedWhy(card) === "user") return ["decide"];
  return [];
}

// ---- Waiting on the person: decisions and questions ----
//
// One list per run of what the main agent waits on the person for (hd_dispatch.py open_items does the same):
//   - <run>/asks.json, written with `hd_dispatch.py ask --add`: kind "decision" (pick one of 2-4 options, maybe a
//     recommended one) or "question" (facts or a preference only the person has; options are suggested answers);
//   - each dev card parked for the person (parked_why user) no ask is about: id card:<card>, carry on or drop it;
//   - an older run's state.json pending_decisions {key: text} (id pending:<key>); one about a parked card
//     (<card> or <card>-<what>) is folded into that card's item.
// The person's answer is appended to <run>/answers.jsonl and sent to the main agent; the item stays, marked
// answered, until the main agent closes it (ask --resolve, or the card's new status).

export const CARD_OPTIONS = [
  { key: "resume", label: "继续做", detail: "改回 pending，负责人按判断返工或重新派发；要改契约或拿不准的先问你" },
  { key: "drop", label: "不做了", detail: "记为 dropped；它的 worktree 和分支先问你是否保留，依赖它的卡改依赖或一起搁置" },
];

const legacyCard = (key, cards) => [...cards].sort((a, b) => b.length - a.length).find((c) => key === c || key.startsWith(`${c}-`)) ?? null;

/**
 * The run's open items, unanswered first, decisions before questions, oldest first. `cards` is the run's
 * state.json cards (stats.js), `pending` its pending_decisions.
 */
export function pendingItems(r, cards = {}, pending = {}) {
  const items = [];
  for (const [id, v] of Object.entries(r?.asks ?? {})) {
    if (!v || typeof v !== "object" || !["decision", "question"].includes(v.kind) || !v.title) continue;
    items.push({ id, kind: v.kind, title: String(v.title), context: v.context ? String(v.context) : "", card: v.card ?? null,
      options: Array.isArray(v.options) ? v.options.filter((o) => o?.key && o?.label).map((o) => ({ key: String(o.key), label: String(o.label), detail: o.detail ? String(o.detail) : "" })) : [],
      recommend: v.recommend ?? null, why: v.why ? String(v.why) : "", blocks: Array.isArray(v.blocks) ? v.blocks.map(String) : [],
      asked: (Number(v.asked) || 0) * 1000, source: "ask" });
  }
  const asked = new Set(items.map((x) => x.card).filter(Boolean));
  const parked = Object.entries(cards ?? {}).filter(([, c]) => parkedWhy(c) === "user").map(([id]) => id);
  const byCard = {};
  for (const id of parked) {
    if (asked.has(id)) continue;
    const c = cards[id];
    byCard[id] = { id: `card:${id}`, kind: "decision", title: `搁置的卡 ${id}：继续还是不做`, card: id,
      context: [c.title && `**${c.title}**`, c.note && `负责人的说明：${c.note}`, c.result && `结果：${c.result}`].filter(Boolean).join("\n\n"),
      options: CARD_OPTIONS, recommend: null, why: "", blocks: [], asked: 0, source: "card" };
    items.push(byCard[id]);
  }
  for (const [key, v] of Object.entries(pending ?? {})) {
    const text = typeof v === "string" ? v : JSON.stringify(v), card = legacyCard(key, parked);
    if (card && byCard[card]) { byCard[card].context = [byCard[card].context, `待你决定（${key}）：${text}`].filter(Boolean).join("\n\n"); continue; }
    if (card && asked.has(card)) continue;
    items.push({ id: `pending:${key}`, kind: "question", title: key, context: text, card: null, options: [], recommend: null, why: "", blocks: [], asked: 0, source: "pending" });
  }
  const last = {};  // an answer counts if given since the item was (last) asked
  for (const a of r?.answers ?? []) last[a.id] = a;
  for (const x of items) x.answer = last[x.id] && (Number(last[x.id].at) || 0) * 1000 >= x.asked ? last[x.id] : null;
  return items.sort((a, b) => (Boolean(a.answer) - Boolean(b.answer)) || ((a.kind === "question") - (b.kind === "question")) || (a.asked - b.asked) || a.id.localeCompare(b.id));
}

/** One line under an item's title: its options (the recommended one marked), or what it asks. */
export function itemLine(x) {
  if (x.answer) return `已回答 · ${answerWords(x.answer)}`;
  if (x.options.length) return x.options.map((o) => `${o.key === x.recommend ? "★ " : ""}${o.label}`).join(" / ");
  return (x.context || "").replace(/\s+/g, " ").slice(0, 140);
}

/** What the person chose and said, in a few words. */
export const answerWords = (a) => [a?.choice && a?.label ? a.label : null, (a?.text ?? "").trim() || null].filter(Boolean).join(" · ") || "已回答";

/** The line hd_dispatch.py reads back: { id, at (s), kind, choice, label, text, by }. */
export function answerRecord(x, { choice = null, text = "" } = {}, now = Date.now()) {
  const o = x.options.find((y) => y.key === choice) ?? null;
  return { id: x.id, at: Math.floor(now / 1000), kind: x.kind, choice: o?.key ?? null, label: o?.label ?? null, text: text.trim(), by: "panel" };
}

/** The message the main agent gets with the person's answer. */
export function answerText(r, x, ans) {
  const o = x.options.find((y) => y.key === ans.choice) ?? null, note = (ans.text ?? "").trim();
  const extra = note ? `。补充：${note}` : "";
  if (x.source === "card" && o) {
    const what = o.key === "resume"
      ? `搁置的卡 ${x.card} 我决定继续做：请按 dev 4.5「搁置之后」把它改回 pending，按你的判断返工或重新派发；要改契约或拿不准的先问我`
      : `搁置的卡 ${x.card} 我决定不做了：请按 dev 4.5「搁置之后」把它记为 parked_why=dropped，它的 worktree 和分支先问我是否保留`;
    return `[cc-dispatch 面板] ${what}${extra}。run=${r.dir} call=${x.card}`;
  }
  const said = x.kind === "decision" ? `我选 ${o ? `${o.key}「${o.label}」` : "（没选项）"}${extra}` : `我的回答：${[o?.label, note].filter(Boolean).join("；") || "（空）"}`;
  return `[cc-dispatch 面板] 待决项 ${x.id}「${x.title}」${said}。请按 herdr.md「待决项」照办，并用 hd_dispatch.py ask --resolve ${x.id} 记下。run=${r.dir}`;
}

/** Appends one answer: `sh -c ANSWER_SCRIPT _ <run dir> <json line>`. */
export const ANSWER_SCRIPT = 'printf "%s\\n" "$2" >> "$1/answers.jsonl"';

/** The first of handoffAsks, or null. */
export const handoffAsk = (c, card) => handoffAsks(c, card)[0] ?? null;

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
  if (!v) return "*（空）*";
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
    if (!v.length) return [`${pad}- *（无）*`];
    return v.flatMap((x) => (isScalar(x) ? [`${pad}- ${scalarMd(x, pad)}`] : objectItemMd(x, depth)));
  }
  const entries = Object.entries(v);
  if (!entries.length) return [`${pad}- *（无）*`];
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
  if (text != null && String(text).length > MARKDOWN_LIMIT) return `*内容太长（${String(text).length} 个字符），直接显示原文。*\n\n${fence(String(text), "json")}`;
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
        out.push(`### ${i + 1}. ${key ? item[key] : `第 ${i + 1} 项`}`);
        const rest = Object.fromEntries(Object.entries(item).filter(([kk]) => kk !== key));
        if (Object.keys(rest).length) out.push(listMd(rest, 0).join("\n"));
      });
    } else out.push(listMd(x, 0).join("\n"));
  }
  return out.join("\n\n");
}

/** The report dialog: verdict and paths, then the report. */
export function reportMarkdown(c, text, older = []) {
  const verdict = { ok: "通过 schema 检查", bad: "**没通过 schema 检查**", missing: "没有回报文件" }[c.report] ?? "还没检查（`hd_dispatch.py collect` 时检查）";
  const head = [
    `- **结论**：${verdict}`,
    `- **文件**：\`${c.reportPath}\``,
    `- **schema**：\`${c.schema}\``,
    older.length ? `- **之前各轮**： ${older.map((p) => `\`${baseName(p)}\``).join(", ")}` : null,
  ].filter(Boolean).join("\n");
  return `${head}\n\n---\n\n${text == null ? "*还没写回报。*" : jsonMarkdown(text)}`;
}

const pad2 = (n) => String(n).padStart(2, "0");
const clock = (sec) => { const d = new Date(sec * 1000); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`; };
const tok = (n) => n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n);

/** One events.jsonl line (hd_dispatch.py) in words. */
export function eventWords(e) {
  const unsent = e.sent === false ? " — **没送达**" : "";
  switch (e.ev) {
    case "dispatch": return `已派发 ${[e.mode, e.effort].filter(Boolean).join("·")}${e.title ? `「${e.title}」` : ""}${unsent}`;
    case "send": return e.why !== "retry" ? `发出第 ${e.round} 轮${unsent}`
      : e.kind === "network" ? `网络恢复，已让它继续${unsent}` : `已让它继续（${failureWord(e.kind)}，第 ${e.n} 次重试）${unsent}`;
    case "offline": return "**网络断开**：等网络恢复，不占重试次数";
    case "retry": return `${failureWord(e.kind)}：${clock(e.at).slice(6)} 第 ${e.n}/${e.max} 次重试`;
    case "settle": return ["停下：" + stateWord(e.state === "live" ? e.status : e.state), e.report && `回报${{ ok: "合格", bad: "不合格", missing: "缺失" }[e.report] ?? ` ${e.report}`}`,
      e.failure && `**${failureWord(e.failure)}**`, e.retried && `重试过 ${e.retried} 次`,
      e.nested && `自己开了 ${e.nested.length} 个终端`].filter(Boolean).join("，");
    case "stall": return `第 ${e.turn} 轮 ${e.minutes} 分钟没有进展`;
    case "codex": return [`Codex 累计：${e.tokens ? `${tok(e.tokens.input + e.tokens.output)} tok` : "没有 token 记录"}`,
      `${e.commands ?? 0} 条命令`, `${e.files ?? 0} 个文件`, e.model].filter(Boolean).join(" · ");
    case "cleanup": return "已清理";
    case "pause": return e.interrupted ? "**已暂停**：中途打断" : "**已暂停**：取消了它的重试";
    case "resume": return `已继续：让它接着做${unsent}`;
    case "stop": return e.asked ? "**运行已终止**：已让它交代做到哪了" : "**运行已终止**";
    case "freeze": return [`**已冻结**（${e.why === "manual" || !e.why ? "手动" : e.why}）`, e.progress ? "写了进度说明" : e.asked ? "要过进度说明，没有交" : null,
      e.snapshot && `已保存 worktree \`${String(e.snapshot).slice(0, 10)}\``].filter(Boolean).join("，");
    case "lost": return "**已中断**：交回报之前终端消失了";
    case "recover": return `**已恢复**：${e.how === "resume" ? "重新打开了原 session" : "新 session 读了任务"}，等继续`;
    case "adopt": return `**已接手**：${e.by ?? "?"} 里的主 agent${e.agent ? `（${e.agent}）` : ""}${e.frm ? `，原来是 ${e.frm}` : ""}`;
    case "handover": return `**已移交** ${e.frm ?? "?"} → ${e.to}${e.why ? `（${e.why === "manual" ? "手动" : e.why}）` : ""}${e.isolation === "weak" ? "，弱隔离" : ""}${unsent}`;
    default: return e.ev;
  }
}

/** A call's events.jsonl as a markdown list, oldest first. */
export function timelineMarkdown(text) {
  const evs = String(text ?? "").split("\n").map((l) => l.trim() && parseJSON(l)).filter((e) => e && e.ev);
  if (!evs.length) return "*没有事件记录。hd_dispatch.py 开始记 events.jsonl 之前派出的子 agent 没有记录。*";
  return evs.map((e) => `- \`${clock(e.t)}\` · r${e.round ?? 1} · ${eventWords(e)}`).join("\n");
}

/**
 * The Result dialog: what the helper concluded, then (write/net helpers) what it changed. `diff` is
 * DIFF_SCRIPT's output, or null for a read-only helper.
 */
export function resultMarkdown(c, text, older = [], diff = null) {
  const parts = [reportMarkdown(c, text, older)];
  if (diff != null) parts.push(`## worktree 里的改动\n\n${diffMarkdown(diff).replace(/^### /, "")}`);
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
    const how = mine.find((e) => e.ev === "handover") ? "已移交" : k === 1 ? "首次派发" : "返工";
    out.push(`## 第 ${k} 轮${k === c.round ? " · 当前" : ""} · ${how}`);
    if (mine.length) out.push(mine.map((e) => `- \`${clock(e.t)}\` · ${eventWords(e)}`).join("\n"));
    else if (!evs.length && k === rounds) out.push("*没有事件记录。hd_dispatch.py 开始记 events.jsonl 之前派出的子 agent 没有记录。*");
    const task = tasks[k];
    out.push(task == null ? `*第 ${k} 轮没有任务文件。*` : `### 任务文件 \`task-${k}.md\`\n\n${demote(task, 3)}`);
  }
  return out.join("\n\n");
}

/** The worktree dialog: DIFF_SCRIPT's output, its "## branch @ dir" line as a heading. */
export function diffMarkdown(text) {
  const lines = String(text ?? "").split("\n");
  const head = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : null;
  const body = lines.join("\n").replace(/^\n+|\s+$/g, ""); // keep git status's leading column
  return [head && `### \`${head}\``, body ? fence(body) : "*没有改动。*"].filter(Boolean).join("\n\n");
}

// ---- Structured documents for the Result and Task dialogs ----
//
// A doc is { nodes: [node] }; a node is { id, title, tone?, badge?, blocks: [block], children: [node] }
// (children: same shape, `depth` for indenting in the outline). The dialog draws an outline of the
// nodes on the left and the chosen one on the right. Blocks:
//   { t: "lead", label, text, tone }      a conclusion, set off and bold
//   { t: "kv", rows: [{ k, v, tone, mono }] }
//   { t: "md", label?, text }             markdown prose
//   { t: "code", label?, text }           logs and output
//   { t: "files", rows: [{ code, kind, path }] }   git status, kind added|modified|deleted|renamed|untracked|conflict
//   { t: "stat", rows: [{ path, n, plus, minus }], total }
//   { t: "events", rows: [{ time, text, tone }] }
// Tones: ok, bad, warn, accent, info, muted.

const TONE_RANK = { bad: 0, warn: 1, accent: 2, info: 3, ok: 4, muted: 5 };
const worst = (tones) => tones.filter(Boolean).sort((a, b) => TONE_RANK[a] - TONE_RANK[b])[0] ?? null;

/** A verdict / status word's tone. */
export function wordTone(v) {
  const w = String(v ?? "").toLowerCase().trim();
  if (v === true || /^(done|ok|pass|passed|lgtm|holds|fixed|accepted|merged|success|yes|true)$/.test(w)) return "ok";
  if (v === false || /^(fail|fails|failed|blocked|error|bad|missing|no|false|critical|blocker|high|p0|p1|severe)$/.test(w)) return "bad";
  if (/^(partial|issues|medium|major|p2|warn|warning|skipped|skip|flaky|unknown)$/.test(w)) return "warn";
  if (/^(low|minor|info|nit|p3|trivial)$/.test(w)) return "muted";
  return null;
}

const TONE_KEYS = ["severity", "priority", "level", "impact", "risk", "verdict", "status", "result", "passed", "outcome"];
const itemTone = (o) => worst(TONE_KEYS.filter((k) => k in o).map((k) => wordTone(o[k])));
const LOG_KEY = /(output|tail|log|stdout|stderr|trace|diff|snippet|excerpt|command)/i;
// Fields the conclusion lives in, shown first and set off.
const VERDICT_KEYS = ["verdict", "status"];
const LEAD_KEYS = ["summary", "answer"];
// Fields that are trouble when they have anything in them.
const FIELD_TONE = { failures: "bad", open_questions: "warn", deviations: "warn", blocked: "bad", retracted: "muted", skipped: "muted" };
/** Report field names (the schemas' keys) and their short enum values, in words; anything else as it is. */
const FIELD_WORDS = { status: "状态", verdict: "结论", summary: "摘要", answer: "回答", findings: "发现", severity: "严重度",
  confidence: "把握", category: "类别", location: "位置", evidence: "证据", suggestion: "建议", recommendation: "建议",
  problem: "问题", detail: "详情", title: "标题", path: "路径", change: "改动", files_changed: "改动的文件", tests: "测试",
  tests_added: "新增测试", passed: "通过", failed: "失败", failures: "失败项", skipped: "跳过", command: "命令",
  output_tail: "输出末尾", exit_code: "退出码", duration_s: "用时（秒）", open_questions: "待解决的问题", deviations: "偏离",
  risks: "风险", reason: "原因", question: "问题", options: "选项", option: "选项", pros: "优点", cons: "缺点", effort: "工作量",
  design: "设计", criteria_fit: "评估维度", consequence: "后果", conditions: "条件", claim: "论断", cases: "反例",
  candidates: "候选", reproduce: "复现", repro: "复现", trigger: "触发条件", fix: "修复", fix_hint: "修复提示",
  suggested_fix: "建议修法", proposed_change: "建议改动", expected: "预期", kind: "种类", name: "名称", ref: "出处",
  area: "领域", scope: "范围", target: "对象", target_file: "目标文件", target_section: "目标章节", lesson: "经验",
  addressed: "已处理", retracted: "已撤回", covers: "覆盖", existing_coverage: "已有覆盖", suites: "测试集", test: "测试",
  run: "运行", occurrences: "出现次数", id: "编号" };
const VALUE_WORDS = { done: "已完成", partial: "部分完成", blocked: "受阻", PASS: "通过", FAIL: "失败", BLOCKED: "受阻",
  HOLDS: "成立", FAILS: "不成立", LGTM: "没问题", ISSUES: "有问题", critical: "严重", high: "高", medium: "中", low: "低",
  must: "必须", should: "建议", verified: "已核实", likely: "很可能", speculative: "推测", reproduced: "已复现",
  product: "产品问题", env: "环境问题", flaky: "不稳定" };
const label = (k) => FIELD_WORDS[k] ?? String(k).replace(/_/g, " ");
const valueWord = (v) => (typeof v === "string" && VALUE_WORDS[v]) || v;

/** An object's fields as blocks: short scalars together as a table, prose, logs and nested values apart. */
function fieldBlocks(o) {
  const blocks = [];
  let kv = null;
  for (const [k, v] of Object.entries(o ?? {})) {
    if (isScalar(v) && !(typeof v === "string" && (v.length > 100 || v.includes("\n")))) {
      if (!kv) blocks.push(kv = { t: "kv", rows: [] });
      const str = typeof v === "string" ? v : v == null ? "—" : String(v);
      kv.rows.push({ k: label(k), v: valueWord(str) || "（空）", tone: TONE_KEYS.includes(k) ? wordTone(v) : null,
        mono: typeof v !== "string" || /^[\w./:#@-]{1,100}$/.test(v) });
      continue;
    }
    kv = null;
    if (typeof v === "string") blocks.push(LOG_KEY.test(k) || /\n\s{2,}|\t/.test(v) ? { t: "code", label: label(k), text: v.replace(/\s+$/, "") } : { t: "md", label: label(k), text: v });
    else if (Array.isArray(v) && !v.length) blocks.push({ t: "kv", rows: [{ k: label(k), v: "无", tone: "muted" }] });
    else blocks.push({ t: "md", label: `${label(k)}${Array.isArray(v) ? ` (${v.length})` : ""}`, text: listMd(v, 0).join("\n") });
  }
  return blocks;
}

/** A top-level report field as an outline node. */
function fieldNode(k, v, id) {
  const node = { id, title: label(k), blocks: [], children: [] };
  if (Array.isArray(v)) {
    node.badge = String(v.length);
    if (!v.length) { node.blocks.push({ t: "kv", rows: [{ k: "条目", v: "无", tone: "muted" }] }); node.tone = "muted"; return node; }
    if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) {
      v.forEach((item, i) => {
        const key = itemTitle(item);
        const rest = Object.fromEntries(Object.entries(item).filter(([kk]) => kk !== key));
        node.children.push({ id: `${id}.${i}`, title: `${i + 1}. ${key ? item[key] : `第 ${i + 1} 项`}`, depth: 0,
          tone: itemTone(item), blocks: fieldBlocks(rest), children: [] });
      });
    } else node.blocks.push({ t: "md", text: listMd(v, 0).join("\n") });
    node.tone = FIELD_TONE[k] ?? worst(node.children.map((c) => c.tone));
    return node;
  }
  if (v && typeof v === "object") { node.blocks = fieldBlocks(v); node.tone = itemTone(v); return node; }
  node.blocks.push(typeof v === "string" ? { t: "md", text: v || "*（空）*" } : { t: "kv", rows: [{ k: label(k), v: String(v), mono: true }] });
  return node;
}

const STATUS_KIND = (xy) => xy === "??" ? "untracked" : /U|AA|DD/.test(xy) ? "conflict" : /R|C/.test(xy) ? "renamed"
  : /D/.test(xy) ? "deleted" : /A/.test(xy) ? "added" : "modified";

/** DIFF_SCRIPT's output: { head, files: [{ code, kind, path }], stat: [{ path, n, plus, minus }], total, note }. */
export function parseDiff(text) {
  const lines = String(text ?? "").split("\n");
  const head = lines[0]?.startsWith("## ") ? lines.shift().slice(3) : null;
  const files = [], stat = [];
  let total = null, note = [];
  for (const l of lines) {
    let m;
    if (!l.trim()) continue;
    if ((m = /^([ MADRCU?!]{2}) (.+)$/.exec(l)) && !l.includes(" | ")) { files.push({ code: m[1].trim() || m[1], kind: STATUS_KIND(m[1]), path: m[2] }); continue; }
    if ((m = /^\s*(.+?)\s+\|\s+(\d+|Bin.*)\s*([+-]*)\s*$/.exec(l))) {
      const plus = (m[3].match(/\+/g) ?? []).length, minus = (m[3].match(/-/g) ?? []).length, n = Number(m[2]) || 0;
      const share = plus + minus ? plus / (plus + minus) : 0;
      stat.push({ path: m[1], n, plus: Math.round(n * share), minus: n - Math.round(n * share) });
      continue;
    }
    if (/files? changed/.test(l)) { total = l.trim(); continue; }
    note.push(l);
  }
  return { head, files, stat, total, note: note.join("\n").trim() };
}

const KIND_WORD = { added: "新增", modified: "修改", deleted: "删除", renamed: "改名", untracked: "未跟踪", conflict: "冲突" };

/** The Result dialog as a doc: overview (verdict, conclusion), the report's fields, then the worktree's changes. */
export function resultDoc(c, text, older = [], diff = null) {
  const v = text == null || String(text).length > MARKDOWN_LIMIT ? null : parseJSON(text);
  const check = { ok: ["通过", "ok"], bad: ["没通过", "bad"], missing: ["没有回报文件", "bad"] }[c.report]
    ?? ["还没检查（hd_dispatch.py collect 时检查）", "muted"];
  const over = { id: "overview", title: "概览", blocks: [], children: [] };
  const obj = v && typeof v === "object" && !Array.isArray(v) ? v : null;
  const verdictKey = obj && VERDICT_KEYS.find((k) => typeof obj[k] === "string");
  if (verdictKey) { over.blocks.push({ t: "lead", label: label(verdictKey), text: valueWord(obj[verdictKey]), tone: wordTone(obj[verdictKey]) ?? "accent", short: true }); over.tone = wordTone(obj[verdictKey]); }
  for (const k of LEAD_KEYS) if (obj && typeof obj[k] === "string" && obj[k]) over.blocks.push({ t: "lead", label: label(k), text: obj[k], tone: over.tone ?? "accent" });
  if (obj?.recommendation && typeof obj.recommendation === "object") {
    const r = obj.recommendation, key = itemTitle(r) ?? Object.keys(r).find((k) => typeof r[k] === "string");
    if (key) over.blocks.push({ t: "lead", label: "建议", text: r[key], tone: "accent" });
  }
  over.blocks.push({ t: "kv", rows: [
    { k: "schema 检查", v: check[0], tone: check[1] },
    { k: "回报", v: c.reportPath || "—", mono: true },
    { k: "schema", v: c.schema || "—", mono: true },
    ...(older.length ? [{ k: "之前各轮", v: older.map(baseName).join(", "), mono: true }] : []),
  ] });
  if (!over.tone && check[1] === "bad") over.tone = "bad";
  const nodes = [over];
  if (text == null) over.blocks.push({ t: "kv", rows: [{ k: "回报", v: "还没写", tone: "warn" }] });
  else if (!obj) over.blocks.push({ t: v === null ? "code" : "md", label: "回报", text: v === null ? String(text) : listMd(v, 0).join("\n") });
  else {
    const skip = new Set([verdictKey, ...LEAD_KEYS.filter((k) => typeof obj[k] === "string")]);
    Object.entries(obj).forEach(([k, x], i) => { if (!skip.has(k)) nodes.push(fieldNode(k, x, `f${i}`)); });
  }
  if (diff != null) {
    const d = parseDiff(diff), counts = {};
    for (const f of d.files) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    const changes = { id: "changes", title: "worktree 里的改动", badge: String(d.files.length), tone: d.files.some((f) => f.kind === "conflict") ? "bad" : "info", blocks: [], children: [] };
    if (d.head) changes.blocks.push({ t: "kv", rows: [{ k: "分支 @ 目录", v: d.head, mono: true }] });
    if (d.note) changes.blocks.push({ t: "code", text: d.note });
    if (d.files.length) changes.children.push({ id: "changes.files", title: "文件", depth: 0,
      badge: Object.entries(counts).map(([k, n]) => `${KIND_WORD[k]} ${n}`).join(" · "), blocks: [{ t: "files", rows: d.files }], children: [] });
    if (d.stat.length) changes.children.push({ id: "changes.stat", title: "改动行数", depth: 0, badge: d.total ?? "", blocks: [{ t: "stat", rows: d.stat, total: d.total }], children: [] });
    if (!d.files.length && !d.stat.length && !d.note) changes.blocks.push({ t: "kv", rows: [{ k: "改动", v: "无", tone: "muted" }] });
    nodes.push(changes);
  }
  return { nodes };
}

/** A markdown file split at its headings (outside code fences): { preface, sections: [{ title, level, body }] }. */
export function splitHeadings(md) {
  const sections = [], pre = [];
  let cur = null, inFence = false;
  for (const line of String(md ?? "").split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const m = !inFence && /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) { sections.push(cur = { title: m[2], level: m[1].length, body: [] }); continue; }
    (cur ? cur.body : pre).push(line);
  }
  const trim = (ls) => ls.join("\n").replace(/^\s+|\s+$/g, "");
  return { preface: trim(pre), sections: sections.map((x) => ({ title: x.title, level: x.level, body: trim(x.body) })) };
}

/** An event's tone in the timeline. */
export function eventTone(e) {
  if (e.sent === false) return "bad";
  switch (e.ev) {
    case "dispatch": case "send": case "resume": case "adopt": case "handover": case "recover": return "accent";
    // exited after a good report is how a helper ends; blocked waits on someone
    case "settle": return e.report === "bad" || e.report === "missing" || (e.failure && !["exited", "blocked"].includes(e.failure)) ? "bad"
      : e.failure === "blocked" ? "warn" : e.report === "ok" ? "ok" : null;
    case "lost": case "stop": return "bad";
    case "retry": case "offline": case "stall": case "pause": case "freeze": return "warn";
    case "codex": case "cleanup": return "muted";
    default: return null;
  }
}

const plain = (md) => String(md).replace(/\*\*|`/g, "");

/** The Task dialog as a doc: an overview of the call, then each round (newest first) with its events and its task file. */
export function taskDoc(c, eventsText, tasks = {}) {
  const evs = String(eventsText ?? "").split("\n").map((l) => l.trim() && parseJSON(l)).filter((e) => e && e.ev);
  const rounds = Math.max(c.round ?? 1, ...evs.map((e) => e.round ?? 1), ...Object.keys(tasks).map(Number));
  const first = evs.find((e) => e.ev === "dispatch");
  const how = (k, mine) => mine.find((e) => e.ev === "handover") ? "已移交" : k === 1 ? "首次派发" : "返工";
  const over = { id: "overview", title: "概览", blocks: [], children: [] };
  over.blocks.push({ t: "kv", rows: [
    { k: "调用", v: c.call, mono: true },
    first?.title || c.title ? { k: "标题", v: first?.title || c.title } : null,
    { k: "模式 · 档位", v: [c.mode || first?.mode, c.effort || first?.effort].filter(Boolean).join(" · ") || "—", mono: true },
    { k: "agent", v: c.agent || "codex", tone: c.agent && c.agent !== "codex" ? "warn" : null },
    { k: "轮次", v: `${c.round ?? 1} / ${rounds}`, mono: true },
    { k: "回报", v: { ok: "合格", bad: "不合格", missing: "缺失" }[c.report] ?? "还没检查", tone: wordTone(c.report) ?? "muted" },
    c.failure ? { k: "失败", v: failureWord(c.failure), tone: c.failure === "exited" ? "muted" : c.failure === "blocked" ? "warn" : "bad" } : null,
    c.dir ? { k: "worktree", v: c.dir, mono: true } : null,
  ].filter(Boolean) });
  const summary = [];
  for (let k = 1; k <= rounds; k++) {
    const mine = evs.filter((e) => (e.round ?? 1) === k), settle = [...mine].reverse().find((e) => e.ev === "settle");
    const start = mine.find((e) => e.ev === "dispatch" || e.ev === "send" || e.ev === "handover");
    summary.push({ k: `第 ${k} 轮`, v: [how(k, mine), start && clock(start.t), settle ? plain(eventWords(settle)) : k === (c.round ?? 1) ? "进行中" : null].filter(Boolean).join(" · "),
      tone: settle ? eventTone(settle) : k === (c.round ?? 1) ? "accent" : "muted" });
  }
  over.blocks.push({ t: "kv", label: "各轮", rows: summary });
  const nodes = [over];
  for (let k = rounds; k >= 1; k--) {
    const mine = evs.filter((e) => (e.round ?? 1) === k), settle = [...mine].reverse().find((e) => e.ev === "settle");
    const node = { id: `r${k}`, title: `第 ${k} 轮 · ${how(k, mine)}`, badge: k === (c.round ?? 1) ? "当前" : "",
      tone: settle ? eventTone(settle) : k === (c.round ?? 1) ? "accent" : "muted", blocks: [], children: [] };
    const timeline = { id: `r${k}.events`, title: "时间线", depth: 0, badge: String(mine.length), blocks: [], children: [] };
    timeline.blocks.push(mine.length ? { t: "events", rows: mine.map((e) => ({ time: clock(e.t), text: plain(eventWords(e)), tone: eventTone(e) })) }
      : { t: "kv", rows: [{ k: "事件", v: evs.length ? "这一轮没有" : "没有记录（hd_dispatch.py 开始记 events.jsonl 之前派出的）", tone: "muted" }] });
    node.children.push(timeline);
    const task = tasks[k];
    if (task == null) node.children.push({ id: `r${k}.task`, title: `task-${k}.md`, depth: 0, tone: "muted", blocks: [{ t: "kv", rows: [{ k: "任务文件", v: "缺失", tone: "muted" }] }], children: [] });
    else {
      const { preface, sections } = splitHeadings(task);
      const top = Math.min(3, ...sections.map((x) => x.level));
      node.children.push({ id: `r${k}.task`, title: `task-${k}.md`, depth: 0, badge: sections.length ? String(sections.length) : "",
        blocks: preface ? [{ t: "md", text: preface }] : [], children: [], head: true });
      sections.forEach((x, i) => node.children.push({ id: `r${k}.s${i}`, title: x.title, depth: 1 + x.level - top,
        blocks: x.body ? [{ t: "md", text: demote(x.body, 2) }] : [], children: [] }));
    }
    nodes.push(node);
  }
  return { nodes };
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

/** "claude" / "codex" / "agy" from a program key, name or path, else null: the subscription hd_usage.py reads. */
export function quotaAgent(name) {
  const n = String(name ?? "").split("/").pop().toLowerCase();
  return n.includes("claude") ? "claude" : n.includes("codex") ? "codex" : /agy|antigravity/.test(n) ? "agy" : null;
}

/**
 * Runs still going: a helper's terminal lives, or it is paused, or it is the newest run of a main agent
 * whose terminal lives (its helpers may all have ended while it works on); never a stopped one.
 * → Set of run dirs. buildRuns sets each run's `live` from it.
 */
/**
 * The subscription a run's main agent uses right now: what its terminal runs (herdr's program key, else
 * its argv), else what hd_dispatch.py recorded at dispatch or adopt. null when it is neither.
 */
export function activeRuns(runs, terminals) {
  const live = new Set((terminals ?? []).filter((t) => t.state === "live").map((t) => t.address));
  const out = new Set(), newest = new Map();
  for (const r of runs ?? []) {
    const state = r.control?.state;
    if (state === "stopped" || state === "stopping" || r.control?.retired) continue;
    if ((r.helpersLive ?? r.live) || state === "paused") out.add(r.dir);
    if (r.parent && live.has(r.parent) && (newest.get(r.parent)?.lastAt ?? -1) < (r.lastAt || 0)) newest.set(r.parent, r);
  }
  for (const r of newest.values()) out.add(r.dir);
  return out;
}

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
  '[ -f "$D/hd_usage.py" ] || { echo "找不到 hd_usage.py" >&2; exit 127; }',
  'python3 "$D/hd_usage.py" quota "$2" --slow',
].join("\n");

export const CONTROL_SCRIPT = [
  'PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH',
  'HD="$1"; [ -f "$HD" ] || HD=$(ls "$HOME"/.claude/skills/cc-herdr-dispatch-*/shared/scripts/hd_dispatch.py 2>/dev/null | head -n 1)',
  '[ -n "$HD" ] || { echo "找不到 hd_dispatch.py" >&2; exit 127; }',
  'command -v hc >/dev/null || { echo "PATH 里找不到 hc" >&2; exit 127; }',
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

/** Topic commands keep every argument separate; stop returns while hd_dispatch.py winds runs down. */
export const TOPIC_SCRIPT = [
  'PATH="$HOME/.local/bin:$HOME/.cargo/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; export PATH',
  'HD="$1"; shift',
  '[ -f "$HD" ] || HD=$(ls "$HOME"/.claude/skills/cc-herdr-dispatch-*/shared/scripts/hd_dispatch.py 2>/dev/null | head -n 1)',
  '[ -f "$HD" ] || { echo "找不到 hd_dispatch.py" >&2; exit 127; }',
  'if [ "$1" = topic ] && [ "$2" = stop ]; then',
  '  nohup python3 "$HD" "$@" >/dev/null 2>&1 </dev/null &',
  '  echo STOP_STARTED=1',
  'else',
  '  python3 "$HD" "$@"',
  'fi',
].join("\n");

// ---- Taking a run over: a new main agent carries on a run whose main agent is gone ----

const SHELLS = new Set(["zsh", "bash", "sh", "fish", "login", "nu", "dash", "tcsh", "csh", "ksh"]);

/**
 * The agent a terminal runs now: herdr's program key, else the program in front (claude, codex, or any
 * other); null when the terminal is gone, finished or back at a bare shell. Not a fixed list, so a main
 * agent of a kind the panel has never heard of still counts.
 */
export function agentIn(term) {
  if (!term || term.state !== "live") return null;
  const name = (x) => { const n = String(x ?? "").split("/").pop().replace(/^-/, ""); return n && !SHELLS.has(n.toLowerCase()) ? n : null; };
  return name(term.program?.key) ?? name(term.foreground?.argv?.[0] ?? term.argv?.[0]);
}

/** Whether a run's main agent still runs: its parent terminal (the newest dispatcher or adopter) runs an agent. */
export const mainLive = (r, terminals) => Boolean(r?.parent && agentIn((terminals ?? []).find((x) => x.address === r.parent)));

/**
 * Whether the panel offers a new main agent the run (Copy resume prompt): its main agent is gone and it
 * is not done: paused, stopped (waiting on the person), a helper lost or not settled, or a card left.
 * Never while it stops or is handed off (that has its own prompt), nor once state.json says it is finished.
 */
export function needsTakeover(r, terminals, cards, finished = false) {
  const state = r?.control?.state ?? "running";
  if (finished || !r?.calls?.length || state === "stopping" || state === "handoff") return false;
  if (mainLive(r, terminals)) return false;
  return state === "paused" || state === "stopped" || r.calls.some((c) => c.lost) || !canArchive(r, cards);
}

/** The skill a run belongs to. */
export const skillOf = (r) => `cc-herdr-dispatch-${r?.kind && r.kind !== "probe" ? r.kind : "dev"}`;

/**
 * What the person gives a new main agent (Claude Code, Codex, any agent that loads the skills) to carry
 * the run on: the skill, the run folder and the one command that takes it over (hd_dispatch.py takeover).
 */
export function takeoverPrompt(r) {
  const hd = r?.hd ? `python3 ${r.hd}` : "python3 <cc-dispatcher>/shared/scripts/hd_dispatch.py";
  return `用 ${skillOf(r)} skill 接手 herdr 里一次主 agent 已经不在的运行，运行目录 ${r.dir}。`
    + `按 shared/herdr.md「接手运行」做：先运行 \`${hd} takeover --run ${r.dir}\`，照它的输出做，再向我复述现状。`
    + "我确认之前，不要派发、发送、合并或清理。";
}

/** The line under the head of a run waiting for a new main agent. */
export const takeoverBanner = (r) => `${mainAgentName(r)} 已经不在了 · 把提示交给新的主 agent`;

/** Which control buttons a run offers: pause and stop while it runs, resume and stop while paused. */
export function controlOps(r, finished = false) {
  const state = r?.control?.state ?? "running";
  if (finished || state === "stopping" || state === "stopped" || state === "handoff") return [];
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
    return ["已暂停", since, n ? `挂起 ${n} 个子 agent` : "当时没有子 agent 在干活"].filter(Boolean).join(" · ");
  }
  if (c.state === "stopping") return "终止中 · 子 agent 正在写下做到哪了";
  if (c.state === "stopped") return ["已终止", since, `总结已交给${mainAgentName(r)}`].filter(Boolean).join(" · ");
  if (c.state === "handoff") return ["交接中", since, "把提示交给下一个主 agent"].filter(Boolean).join(" · ");
  return null;
}
