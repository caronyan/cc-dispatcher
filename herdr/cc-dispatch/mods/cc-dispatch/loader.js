// What the panel reads from disk. Takes its I/O as arguments ({ sh, py, readText }) so
// herdr/tests/loader.test.mjs can run it under node; main.js passes Herdr's exec/readTextFile.
import { LIST_SCRIPT, EXISTS_SCRIPT, DIFF_SCRIPT, CONTROL_SCRIPT, QUOTA_SCRIPT, parseJSON, parseMetaDump, parseControls, parseArchived, parseAsks, ANSWER_SCRIPT, ARCHIVE_SCRIPT, buildRuns, runRoots, prettyReport, taskPath } from "./model.js";
import { STATS_PY, statsRequest } from "./stats.js";
import { BG_PY, bgRequest, LIVE_SCRIPT, parseLive } from "./bg.js";

/** The repository a folder belongs to (its git top level), else the folder itself. */
export async function findRepo({ sh }, folder) {
  if (!folder) return null;
  const r = await sh('git -C "$1" rev-parse --show-toplevel 2>/dev/null || printf "%s\\n" "$1"', [folder]);
  return (r.stdout ?? "").trim().split("\n")[0] || folder;
}

/**
 * Runs under the shown repo and under every live helper's run folder, merged with the live
 * terminals. Returns { runs, error }.
 */
export async function loadRuns({ sh }, repo, terminals) {
  const roots = runRoots(repo, terminals);
  if (!roots.length) return { runs: [], error: null };
  const r = await sh(LIST_SCRIPT, roots);
  if (r.code !== 0 && !r.stdout) return { runs: [], error: (r.stderr ?? "").trim() || `exit ${r.code}` };
  return { runs: buildRuns(parseMetaDump(r.stdout), terminals, parseControls(r.stdout), parseArchived(r.stdout), parseAsks(r.stdout)), error: null };
}

/** Archive or unarchive a run (op "archive" | "unarchive"): { ok, error }. */
export async function archiveRun({ sh }, r, op) {
  const x = await sh(ARCHIVE_SCRIPT, [op, r.dir]);
  return { ok: x.code === 0, error: x.code === 0 ? null : (x.stderr ?? "").trim() || `exit ${x.code}` };
}

/** Records the person's answer to one of a run's open items (model.js answerRecord) in <run>/answers.jsonl. */
export async function saveAnswer({ sh }, dir, record) {
  const x = await sh(ANSWER_SCRIPT, [dir, JSON.stringify(record)]);
  return { ok: x.code === 0, error: x.code === 0 ? null : (x.stderr ?? "").trim() || `exit ${x.code}` };
}

/** Where hd_dispatch.py keeps a copy of round k's report in the run folder (/tmp does not survive a reboot). */
export const backupPath = (c, k) => `${c.agentDir}/report-r${k}.json`;

/** A call's report: { text, exists, path }; the run folder's copy when the /tmp one is gone. */
export async function loadReport({ readText }, c) {
  for (const path of [c.reportPath, c.agentDir && backupPath(c, c.round)].filter(Boolean)) {
    const text = await readText(path);
    if (text != null) return { text: prettyReport(text), exists: true, path };
  }
  return { text: null, exists: false, path: null };
}

/** Pause, resume or stop a run with hd_dispatch.py → { ok, text } (stop only starts in the background). */
export async function controlRun({ sh }, r, op) {
  const res = await sh(CONTROL_SCRIPT, [r.hd ?? "", op, r.dir]);
  const text = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  return { ok: res.code === 0, text };
}

/**
 * Hand a helper over to `to` (hd_dispatch.py handover --notify, in the background: freezing it takes up
 * to 3 minutes) → { ok, text }. Its log is <agent_dir>/handover.log.
 */
export async function handOver({ sh }, r, c, to) {
  const res = await sh(CONTROL_SCRIPT, [r.hd ?? c.hd ?? "", "handover", r.dir, c.call, to]);
  const text = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
  return { ok: res.code === 0 && /HANDOVER_STARTED/.test(text), text };
}

/** A run being handed off: its package's handoff.md, or null. */
export const loadHandoff = ({ readText }, r) => r.control?.package ? readText(`${r.control.package}/handoff.md`) : Promise.resolve(null);

/** A run being handed off: the prompt for the next main agent, or null. */
export const loadHandoffPrompt = ({ readText }, r) => r.control?.prompt ? readText(r.control.prompt) : Promise.resolve(null);

/** A stopped run's stop.md, or null. */
export const loadStopReport = ({ readText }, r) => readText(r.control?.report || `${r.dir}/stop.md`);

/** A call's events.jsonl (hd_dispatch.py), or null. */
export const loadEvents = ({ readText }, c) => readText(`${c.agentDir}/events.jsonl`);

/** A call's newest task file, or null. */
export const loadTask = ({ readText }, c) => readText(taskPath(c));

/** Every round's task file: { k: text or null }. */
export async function loadTasks({ readText }, c) {
  const out = {};
  for (let k = 1; k <= (c.round ?? 1); k++) out[k] = await readText(`${c.agentDir}/task-${k}.md`);
  return out;
}

/** A write/net helper's worktree changes as text. */
export async function loadDiff({ sh }, c) {
  const r = await sh(DIFF_SCRIPT, [c.dir]);
  return (r.stdout || r.stderr || "").trim() || "No changes.";
}

/** Earlier rounds' reports that exist (report.r1.json, …, else the run folder's report-r<k>.json). */
export async function earlierReports({ sh }, c) {
  if (c.round <= 1 || !c.reportPath) return [];
  const pairs = [];
  for (let k = 1; k < c.round; k++) {
    pairs.push([c.reportPath.replace(/report\.json$/, `report.r${k}.json`), c.agentDir ? backupPath(c, k) : null]);
  }
  const r = await sh(EXISTS_SCRIPT, pairs.flat().filter(Boolean));
  const have = new Set((r.stdout ?? "").split("\n").map((s) => s.trim()).filter(Boolean));
  return pairs.map(([tmp, kept]) => (have.has(tmp) ? tmp : have.has(kept) ? kept : null)).filter(Boolean);
}

/**
 * What the given runs' helpers spent (stats.js): { calls: {key: stats}, runs: {dir: cards} }, or
 * { error } when the script could not run (no python3, a remote machine without it).
 */
export async function loadStats({ py }, runs) {
  if (!runs.length) return { calls: {}, runs: {}, finished: {}, pending: {} };
  const r = await py(STATS_PY, [JSON.stringify(statsRequest(runs))]);
  const v = r.code === 0 ? parseJSON(r.stdout) : null;
  if (!v || typeof v !== "object") return { error: ((r.stderr ?? "").trim().split("\n").pop() || `exit ${r.code}`) };
  return { calls: v.calls ?? {}, runs: v.runs ?? {}, finished: v.finished ?? {}, pending: v.pending ?? {} };
}

/**
 * The main agents' background tasks for these runs, whatever program they are (bg.js adapters):
 * { runs: {dir: [session]}, sessions: {session: [task]} }, or { error }.
 */
export async function loadBg({ py }, runs) {
  if (!runs.length) return { runs: {}, sessions: {} };
  const r = await py(BG_PY, [JSON.stringify(bgRequest(runs))]);
  const v = r.code === 0 ? parseJSON(r.stdout) : null;
  if (!v || typeof v !== "object") return { error: ((r.stderr ?? "").trim().split("\n").pop() || `exit ${r.code}`) };
  return { runs: v.runs ?? {}, sessions: v.sessions ?? {} };
}

/** The main agent's quota through hd_usage.py (magpie first): its JSON, or null when nothing is known. */
export async function loadQuota({ sh }, hd, agent) {
  if (!agent) return null;
  const r = await sh(QUOTA_SCRIPT, [hd ?? "", agent]);
  const v = r.code === 0 ? parseJSON(r.stdout) : null;
  return v && typeof v === "object" ? v : null;
}

/** The end of a background task's output file (at most 200 KB), or null. */
export async function loadOutput({ sh }, path) {
  if (!path) return null;
  const r = await sh('[ -f "$1" ] && tail -c 200000 "$1"', [path]);
  return r.code === 0 ? r.stdout : null;
}

/** A running task's output file, its processes and its end: parseLive's shape, or null. */
export async function loadLive({ sh }, path) {
  if (!path) return null;
  const r = await sh(LIVE_SCRIPT, [path]);
  return r.stdout ? parseLive(r.stdout) : null;
}
