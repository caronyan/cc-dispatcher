import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATS_PY, statsRequest, runTotals, fmtTok, fmtDur, callSpend } from "../cc-dispatch/mods/cc-dispatch/stats.js";

const line = (ts, type, payload) => JSON.stringify({ timestamp: ts, type, payload }) + "\n";
const tokens = (input, cached, output) => ({ type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output } } });

// A home with a Codex home (~/.codex-api) holding one helper thread, and a run with state.json.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cc-stats-"));
  const codex = join(home, ".codex-api"), run = join(home, "repo/.cc-dispatch/dev-20261108-x");
  mkdirSync(join(codex, "sessions"), { recursive: true });
  mkdirSync(join(run, "agents/T1"), { recursive: true });
  const log = join(codex, "sessions/rollout-a.jsonl");
  writeFileSync(log,
    line("2026-11-08T03:00:00Z", "session_meta", { cwd: "/wt/T1" }) +
    line("2026-11-08T03:00:01Z", "turn_context", { model: "gpt-6.1-sol" }) +
    line("2026-11-08T03:00:02Z", "response_item", { type: "function_call", name: "exec_command", arguments: "{}" }) +
    line("2026-11-08T03:00:03Z", "response_item", { type: "custom_tool_call", name: "apply_patch", input: "*** Begin Patch\n*** Update File: /wt/T1/a.js\n*** Add File: /wt/T1/b.js\n*** End Patch" }) +
    line("2026-11-08T03:00:04Z", "event_msg", tokens(1_000_000, 800_000, 10_000)));
  const db = join(codex, "state_5.sqlite");
  execFileSync("sqlite3", [db, `create table threads (id text, rollout_path text, created_at integer, first_user_message text);
    insert into threads values ('a', '${log}', 1, '<hc>…</hc>\n\n读取任务文件 ${run}/agents/T1/task-1.md，按其中要求完成。');
    insert into threads values ('b', '/nowhere.jsonl', 2, 'something else');`]);
  writeFileSync(join(run, "state.json"), JSON.stringify({ tasks: { T1: { status: "merged" }, T2: { status: "running" }, T3: { status: "parked" } } }));
  const r = { dir: run, live: false, startedAt: Date.parse("2026-11-08T02:59:00Z"), calls: [{ key: `${run}#T1`, agentDir: `${run}/agents/T1` }] };
  return { home, log, run, r };
}

const stats = (home, req) => JSON.parse(execFileSync("python3", ["-I", "-c", STATS_PY, JSON.stringify(req)], {
  encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: "", CC_HD_HOME: join(home, "hd") },
}));

test("stats script: finds the helper's thread by its task file and totals its log", () => {
  const { home, run, r } = fixture();
  const out = stats(home, statsRequest([r]));
  const s = out.calls[`${run}#T1`];
  assert.deepEqual(s.tokens, { input: 1_000_000, cached: 800_000, cache_write: 0, output: 10_000 });
  assert.equal(s.model, "gpt-6.1-sol");
  assert.equal(s.commands, 1);
  assert.equal(s.files, 2);
  assert.equal(s.sessions, 1);
  assert.deepEqual(out.runs[run], { total: 3, merged: 1, parked: 1, status: { T1: "merged", T2: "running", T3: "parked" } });
});

test("stats script: reads only what was appended, and a half-written line waits", () => {
  const { home, log, run, r } = fixture();
  stats(home, statsRequest([r]));
  appendFileSync(log, line("2026-11-08T03:05:00Z", "response_item", { type: "function_call", name: "exec_command", arguments: "{}" }) + '{"timestamp":"2026-11-08T03:06');
  let s = stats(home, statsRequest([r])).calls[`${run}#T1`];
  assert.equal(s.commands, 2);
  appendFileSync(log, `:00Z","type":"event_msg","payload":${JSON.stringify(tokens(3_000_000, 2_500_000, 30_000))}}\n`);
  s = stats(home, statsRequest([r])).calls[`${run}#T1`];
  assert.equal(s.commands, 2);
  assert.equal(s.tokens.input, 3_000_000);
  assert.equal(s.last, Date.parse("2026-11-08T03:06:00Z"));
  const cache = JSON.parse(readFileSync(join(home, "hd/.panel-stats.json"), "utf8"));
  assert.ok(cache.logs[log].off > 0);
});

test("stats script: a closed helper's codex event stands in for its logs; a live one's names its rollouts", () => {
  const { home, log, run, r } = fixture();
  const snap = { t: 1, ev: "codex", round: 1, model: "m", tokens: { input: 5, cached: 4, cache_write: 0, output: 1 },
    commands: 7, files: 3, first: 1, last: 2, sessions: 1, rollouts: [log] };
  writeFileSync(join(run, "agents/T1/events.jsonl"), JSON.stringify({ t: 0, ev: "dispatch", round: 1 }) + "\n" + JSON.stringify(snap) + "\n");
  let s = stats(home, statsRequest([r])).calls[`${run}#T1`];
  assert.deepEqual(s, { tokens: snap.tokens, model: "m", commands: 7, files: 3, first: 1, last: 2, sessions: 1 });
  execFileSync("sqlite3", [join(home, ".codex-api/state_5.sqlite"), "delete from threads"]);
  const live = { ...r, live: true, calls: [{ ...r.calls[0], state: "live" }] };
  s = stats(home, statsRequest([live])).calls[`${run}#T1`];
  assert.equal(s.commands, 1);
  assert.equal(s.tokens.input, 1_000_000);
});

// A Claude Code transcript: one message logged twice (two content blocks, same usage), one more after.
function claudeTranscript(home, session, cwd) {
  const dir = join(home, ".claude/projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const usage = (i, r, w, o) => ({ input_tokens: i, cache_read_input_tokens: r, cache_creation_input_tokens: w, output_tokens: o });
  const msg = (ts, id, content, u) => JSON.stringify({ type: "assistant", timestamp: ts, message: { id, model: "claude-opus-5-5", content, usage: u } }) + "\n";
  const path = join(dir, `${session}.jsonl`);
  writeFileSync(path,
    JSON.stringify({ type: "user", message: { role: "user", content: "读取任务文件" } }) + "\n" +
    msg("2026-11-08T04:00:00Z", "m1", [{ type: "text", text: "ok" }], usage(10, 100, 50, 5)) +
    msg("2026-11-08T04:00:01Z", "m1", [{ type: "tool_use", name: "Bash", input: { command: "ls" } }], usage(10, 100, 50, 5)) +
    msg("2026-11-08T04:00:05Z", "m2", [{ type: "tool_use", name: "Edit", input: { file_path: "/wt/T1/a.js" } }], usage(2, 200, 0, 7)));
  return { path, msg, usage };
}

test("stats script: a handover voids the codex event; Claude Code transcripts count once per message", () => {
  const { home, log, run, r } = fixture();
  const snap = { t: 1, ev: "codex", round: 1, model: "m", tokens: { input: 5, cached: 4, cache_write: 0, output: 1 },
    commands: 7, files: 3, first: 1, last: 2, sessions: 1, rollouts: [log] };
  writeFileSync(join(run, "agents/T1/events.jsonl"), [snap, { t: 3, ev: "handover", round: 2, frm: "codex", to: "claude" }]
    .map((e) => JSON.stringify(e)).join("\n") + "\n");
  const { path, msg, usage } = claudeTranscript(home, "s-1", "/wt/T1");
  const call = { ...r.calls[0], state: "live", claudeSessions: ["s-1"], workdir: "/wt/T1" };
  let s = stats(home, statsRequest([{ ...r, live: true, calls: [call] }])).calls[`${run}#T1`];
  // Codex's log (found again by its task file) plus the transcript: 160+5 and 202+7.
  assert.deepEqual(s.tokens, { input: 1_000_000 + 160 + 202, cached: 800_000 + 300, cache_write: 50, output: 10_000 + 12 });
  assert.equal(s.commands, 2);
  assert.equal(s.files, 2); // a.js in both, b.js from Codex
  assert.equal(s.sessions, 2);
  assert.equal(s.model, "claude-opus-5-5");
  // The same message again in the next read counts once; a new one adds.
  appendFileSync(path, msg("2026-11-08T04:00:06Z", "m2", [{ type: "text", text: "done" }], usage(2, 200, 0, 9))
    + msg("2026-11-08T04:00:09Z", "m3", [], usage(1, 0, 0, 1)));
  s = stats(home, statsRequest([{ ...r, live: true, calls: [call] }])).calls[`${run}#T1`];
  assert.equal(s.tokens.output, 10_000 + 5 + 9 + 1);
  assert.equal(s.tokens.input, 1_000_000 + 160 + 202 + 1);
});

test("stats script: no thread, no tokens", () => {
  const { home, run, r } = fixture();
  const other = { ...r, calls: [{ key: `${run}#T9`, agentDir: `${run}/agents/T9` }] };
  const s = stats(home, statsRequest([other])).calls[`${run}#T9`];
  assert.equal(s.tokens, null);
  assert.equal(s.commands, 0);
});

test("runTotals: split tokens, totals, elapsed", () => {
  const run = { live: false, startedAt: 1000, calls: [{ key: "a" }, { key: "b" }, { key: "c" }] };
  const calls = {
    a: { tokens: { input: 100, cached: 60, cache_write: 0, output: 5 }, commands: 3, files: 2, last: 61_000 },
    b: { tokens: { input: 50, cached: 10, cache_write: 0, output: 5 }, commands: 1, files: 0, last: 5000 },
  };
  const t = runTotals(run, calls, { total: 3, merged: 1, parked: 0 });
  assert.deepEqual(t.tokens, { cached: 70, fresh: 80, output: 10, total: 160 });
  assert.equal(t.commands, 4);
  assert.equal(t.files, 2);
  assert.equal(t.elapsed, 60_000);
  assert.deepEqual(t.cards, { total: 3, merged: 1, parked: 0 });
  assert.equal(runTotals({ ...run, live: true }, calls, null, 31_000).elapsed, 30_000);
  assert.equal(runTotals(run, {}, null).known, false);
});

test("formatting", () => {
  assert.equal(fmtTok(144_600_000), "144.6M");
  assert.equal(fmtTok(9_400), "9.4K");
  assert.equal(fmtTok(812), "812");
  assert.equal(fmtDur(33_060_000), "9h11m");
  assert.equal(fmtDur(240_000), "4m");
  assert.equal(fmtDur(35_000), "35s");
  assert.equal(callSpend({ tokens: { input: 13_000_000, cached: 0, cache_write: 0, output: 500_000 }, commands: 101, files: 1 }), "13.5M tok · 101 cmd · 1 file");
  assert.equal(callSpend(null), "");
});
