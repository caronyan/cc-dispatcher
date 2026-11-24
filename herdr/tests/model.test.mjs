import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEP, parseMetaDump, runDirOf, repoOf, kindOf, runRoots, buildCall, callNeed, buildRuns,
  summary, callDetail, runSpace, splitBySpace, callStage, runStage, stageSummary, groupByStage, SETTLED, cardCounts, ago, handoffAsk, handoffText, prettyReport, taskPath, timelineMarkdown, eventWords,
  CONTROL_SEP, parseControls, controlOps, controlBanner, quotaAgent, runQuotaAgent, quotaView, runParent, activeRuns, callTags,
  ARCHIVE_SEP, parseArchived, canArchive, archivedAway, cardView, parkedWhy, handoffAsks,
  agentIn, mainLive, needsTakeover, takeoverPrompt, takeoverBanner, skillOf,
  ASKS_SEP, ANSWERS_SEP, parseAsks, pendingItems, itemLine, answerRecord, answerText, LIST_SCRIPT,
} from "../cc-dispatch/mods/cc-dispatch/model.js";

const RUN = "/r/.cc-dispatch/review-0107";
const meta = (call, extra = {}) => ({ call, name: `review-${call}`, mode: "read", effort: "high", dir: "/r", round: 1,
  report: `/tmp/cc-dispatch/h1/${call}/report.json`, schema: "/s.json", agent_dir: `${RUN}/agents/${call}`, started_at: 100, ...extra });
const dump = (...pairs) => pairs.map(([p, m]) => `\n${SEP}${p}\n${JSON.stringify(m)}`).join("");

test("parseMetaDump keeps readable metas and skips broken ones", () => {
  const text = dump([`${RUN}/agents/a/meta.json`, meta("a")]) + `\n${SEP}${RUN}/agents/b/meta.json\n{broken`;
  const got = parseMetaDump(text);
  assert.equal(got.length, 1);
  assert.equal(got[0].meta.call, "a");
  assert.equal(got[0].path, `${RUN}/agents/a/meta.json`);
  assert.deepEqual(parseMetaDump(""), []);
});

test("paths: run dir, repo, kind", () => {
  assert.equal(runDirOf(`${RUN}/agents/a/meta.json`), RUN);
  assert.equal(repoOf(RUN), "/r");
  assert.equal(kindOf(RUN), "review");
  assert.equal(kindOf("/r/.cc-dispatch/feature-x"), "dev");
});

test("runRoots: the repo's plus live helpers' run parents, not finished ones", () => {
  const terms = [
    { state: "live", labels: { "cc.dir": "/other/.cc-dispatch/fix-1" } },
    { state: "finished", labels: { "cc.dir": "/old/.cc-dispatch/fix-1" } },
    { state: "live", labels: {} },
  ];
  assert.deepEqual(runRoots("/r/", terms), ["/other/.cc-dispatch", "/r/.cc-dispatch"]);
  assert.deepEqual(runRoots(null, []), []);
});

test("buildCall: labels win while live, meta.json after", () => {
  const m = meta("a", { address: "t9", round: 1, report_check: "missing", failure: null });
  const live = buildCall(m, RUN, [{ address: "t9", state: "live", status: "done", parent: "t1",
    labels: { "cc.round": "2", "cc.report": "ok", "cc.mode": "read" } }]);
  assert.equal(live.state, "live");
  assert.equal(live.round, 2);
  assert.equal(live.report, "ok");
  assert.equal(live.parent, "t1");
  const gone = buildCall({ ...m, report_check: "bad", failure: "quota" }, RUN, []);
  assert.equal(gone.state, "gone");
  assert.equal(gone.report, "bad");
  assert.equal(gone.failure, "quota");
  assert.equal(gone.startedAt, 100000);
  // after adopt, meta.json's parent wins over hc's (which never changes)
  const adopted = buildCall({ ...m, parent: "t5", adopted: { from: "t1", by: "t5" } }, RUN,
    [{ address: "t9", state: "live", parent: "t1" }]);
  assert.equal(adopted.parent, "t5");
  assert.equal(adopted.adoptedFrom, "t1");
});

test("buildCall: a helper hd_dispatch.py closed is gone, though the app's terminal list still has it", () => {
  const term = { address: "t9", name: "dev-a", state: "live", status: "working", labels: { "cc.round": "2" } };
  const c = buildCall(meta("a", { address: "t9", name: "dev-a", open: false, report_check: "ok" }), RUN, [term]);
  assert.deepEqual([c.state, c.status, c.lost, c.round], ["gone", null, false, 1]);
  // still open: the terminal is its own
  assert.equal(buildCall(meta("a", { address: "t9", open: true }), RUN, [term]).state, "live");
});

test("buildCall finds a live terminal by name when the address is unknown, and reads object status", () => {
  const c = buildCall(meta("a"), RUN, [{ address: "t3", name: "review-a", state: "live", status: { state: "working" } }]);
  assert.equal(c.address, "t3");
  assert.equal(c.name, "review-a");
  const renamed = buildCall(meta("a", { address: "t4" }), RUN, [{ address: "t4", name: "review-a-2", state: "live" }]);
  assert.equal(renamed.name, "review-a-2");
  assert.equal(buildCall(meta("a"), RUN, []).name, "review-a");
  assert.equal(c.status, "working");
});

test("callNeed orders what to act on", () => {
  const base = { state: "live", status: "done", report: null, failure: null };
  assert.equal(callNeed({ ...base, status: "blocked" }), "blocked");
  assert.equal(callNeed({ ...base, status: "error" }), "error");
  assert.equal(callNeed({ ...base, state: "gone", failure: "quota" }), "error");
  assert.equal(callNeed({ ...base, state: "gone", failure: "exited", report: "ok" }), "done");
  assert.equal(callNeed({ ...base, status: "working" }), "working");
  assert.equal(callNeed({ ...base, status: "error", retry: "capacity 1/4" }), "retry");
  assert.equal(callNeed({ ...base, status: "working", retry: "capacity 1/4" }), "working");
  assert.equal(callStage({ ...base, status: "error", retry: "capacity 1/4" }), "retrying");
  assert.equal(callDetail({ mode: "read", effort: "high", round: 1, report: null, failure: null, retry: "capacity 1/4", state: "live" }), "read·high · retry capacity 1/4");
  assert.equal(callNeed({ ...base, status: "working", offline: true }), "offline");
  assert.equal(callStage({ ...base, status: "error", offline: true, retry: null }), "offline");
  assert.equal(callNeed({ ...base, status: "blocked", offline: true }), "blocked");
  assert.equal(buildCall({ call: "a", name: "n" }, "/r/.cc-dispatch/dev-x", [{ name: "n", state: "live", status: "working", labels: { "cc.net": "down" } }]).offline, true);
  assert.equal(eventWords({ ev: "send", why: "retry", kind: "network" }), "network back: told to carry on");
  assert.equal(callNeed({ ...base, report: "bad" }), "bad");
  assert.equal(callNeed(base), "review");
  assert.equal(callNeed({ ...base, state: "gone" }), "gone");
});

test("buildRuns: live first, newest first, the most urgent need", () => {
  const entries = parseMetaDump(dump(
    [`${RUN}/agents/b/meta.json`, meta("b", { address: "t2", dispatcher_agent: "claude" })],
    [`${RUN}/agents/a/meta.json`, meta("a", { address: "t1", dispatcher_agent: "codex", adopted: { from: "t0" } })],
    ["/r/.cc-dispatch/fix-0101/agents/x/meta.json", meta("x", { started_at: 500, report_check: "ok" })],
  ));
  const runs = buildRuns(entries, [
    { address: "t1", state: "live", status: "working", labels: {} },
    { address: "t2", state: "live", status: "blocked", labels: {} },
  ]);
  assert.deepEqual(runs.map((r) => r.id), ["review-0107", "fix-0101"]);
  assert.equal(runs[0].live, true);
  assert.equal(runs[0].need, "blocked");
  assert.deepEqual(runs[0].calls.map((c) => c.call), ["a", "b"]);
  assert.equal(runs[1].need, "done");
  assert.equal(summary(runs[0].counts), "1 waiting on you · 1 working");
  assert.equal(runs[0].mainAgent, "codex"); // the adopter's program wins
});

test("lost: a helper whose terminal vanished while open, before a good report", () => {
  const lost = buildCall(meta("a", { open: true, report_check: "missing" }), RUN, []);
  assert.equal(lost.lost, true);
  assert.equal(callNeed(lost), "lost");
  assert.equal(callStage(lost), "lost");
  assert.equal(handoffAsk(lost), "lost");
  assert.match(handoffText(lost, "lost"), /终端意外消失/);
  assert.match(callDetail(lost), /terminal vanished$/);
  assert.equal(buildCall(meta("a", { open: false }), RUN, []).lost, false); // cleaned up, stopped, frozen
  assert.equal(buildCall(meta("a", { open: true, report_check: "ok" }), RUN, []).lost, false); // its work is in
  assert.equal(buildCall(meta("a", { open: true, address: "t9" }), RUN, [{ address: "t9", state: "live" }]).lost, false);
  assert.equal(buildCall(meta("a", { round: 2, lost: { round: 2 } }), RUN, []).lost, true);
  assert.equal(stageSummary(["lost", "working"]), "1 interrupted · 1 working");
});

test("callDetail and ago", () => {
  assert.equal(callDetail({ mode: "write", effort: "high", round: 2, report: "bad", failure: null, state: "live" }),
    "write·high · round 2");
  assert.equal(callDetail({ mode: "read", effort: "", round: 1, report: "missing", failure: "quota", state: "gone" }),
    "read · no report · quota · closed");
  assert.equal(callDetail({ mode: "read", effort: "", round: 1, report: "ok", failure: "exited", state: "finished" }), "read · closed");
  assert.equal(ago(0), "");
  assert.equal(ago(1000, 1000 + 125000), "2m ago");
  assert.equal(ago(1000, 1000 + 3 * 86400000), "3d ago");
});

test("hand-off fits the need", () => {
  const c = { call: "a", runDir: RUN, state: "live", status: "done", report: "bad", failure: null };
  assert.equal(handoffAsk(c), "bad");
  assert.match(handoffText(c, "bad"), /run=\/r\/\.cc-dispatch\/review-0107 call=a/);
  assert.equal(handoffAsk({ ...c, report: "ok" }), null);
});

test("prettyReport and taskPath", () => {
  assert.equal(prettyReport('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(prettyReport("nope"), "nope");
  assert.equal(prettyReport(null), null);
  assert.equal(taskPath({ agentDir: "/x", round: 3 }), "/x/task-3.md");
});

import { runMains, mainKey } from "../cc-dispatch/mods/cc-dispatch/model.js";
import { jsonMarkdown, reportMarkdown, diffMarkdown, MARKDOWN_LIMIT } from "../cc-dispatch/mods/cc-dispatch/model.js";

test("jsonMarkdown: fields become sections, item lists numbered sub-sections, logs code blocks", () => {
  const md = jsonMarkdown(JSON.stringify({
    status: "done",
    summary: "Did the thing.\nTwo lines.",
    files_changed: [{ path: "a.py", change: "added x" }, { change: "no title here" }],
    tests: { passed: true, output_tail: "line 1\nline 2" },
    notes: ["one", "two"],
    empty: [],
  }));
  assert.match(md, /^## status\n\n`done`/);
  assert.match(md, /## summary\n\nDid the thing\.\nTwo lines\./);
  assert.match(md, /### 1\. a\.py\n\n- \*\*change\*\*: added x/);
  assert.match(md, /### 2\. item 2\n\n- \*\*change\*\*: no title here/);
  assert.match(md, /- \*\*passed\*\*: `true`/);
  assert.match(md, /- \*\*output_tail\*\*: \n\n  ```\n  line 1\n  line 2\n  ```/);
  assert.match(md, /## notes\n\n- `one`\n- `two`/);
  assert.match(md, /## empty\n\n- \*\(none\)\*/);
});

test("jsonMarkdown: not JSON or too long shows the source in a block", () => {
  assert.equal(jsonMarkdown("oops {"), "```\noops {\n```");
  assert.match(jsonMarkdown(`"${"x".repeat(MARKDOWN_LIMIT)}"`), /^\*Too long to render/);
  assert.equal(jsonMarkdown(null), "");
});

test("reportMarkdown and diffMarkdown", () => {
  const c = { report: "bad", reportPath: "/r/report.json", schema: "/s.json" };
  const md = reportMarkdown(c, '{"status":"blocked"}', ["/r/report.r1.json"]);
  assert.match(md, /\*\*verdict\*\*: \*\*fails the schema\*\*/);
  assert.match(md, /earlier rounds\*\*: `report\.r1\.json`/);
  assert.match(md, /## status\n\n`blocked`/);
  assert.match(reportMarkdown({ ...c, report: null }, null), /\*No report written yet\.\*/);
  assert.equal(diffMarkdown("## cc/run/T1 @ /wt\n M a.js\n\n 1 file changed"), "### `cc/run/T1 @ /wt`\n\n```\n M a.js\n\n 1 file changed\n```");
  assert.equal(diffMarkdown("## main @ /wt\n"), "### `main @ /wt`\n\n*No changes.*");
});

test("callStage: the helper's own trouble first, then its card, then its report", () => {
  const c = (o) => ({ state: "gone", status: null, report: "ok", failure: null, ...o });
  assert.equal(callStage(c({ state: "live", status: "blocked" }), "merged"), "blocked");
  assert.equal(callStage(c({ failure: "quota" }), "running"), "failed");
  assert.equal(callStage(c({ state: "live", status: "working" }), "running"), "working");
  assert.equal(callStage(c({ report: "bad" }), "accepting"), "bad");
  assert.equal(callStage(c({}), "merged"), "merged");
  assert.equal(callStage(c({}), "parked"), "parked");
  assert.equal(callStage(c({}), "done"), "done");
  assert.equal(callStage(c({}), "accepting"), "review");
  assert.equal(callStage(c({}), "running"), "await");
  assert.equal(callStage(c({}), undefined), "ok");
  assert.equal(callStage(c({ state: "live", status: "idle", report: null })), "collect");
  assert.equal(callStage(c({ report: null })), "ended");
  const stages = ["merged", "working", "merged", "review"];
  assert.equal(runStage(stages), "working");
  assert.equal(runStage([]), "ended");
  assert.equal(stageSummary(stages), "1 working · 1 in review · 2 merged");
  assert.deepEqual(cardCounts({ status: { a: "merged", b: "pending", c: "merged", d: "accepting", e: "odd" } }),
    [["merged", 2], ["accepting", 1], ["pending", 1], ["odd", 1]]);
  assert.deepEqual(cardCounts(null), []);
});

test("runSpace and splitBySpace: the main agent's space, else the recorded one, else by folder", () => {
  const terms = [{ address: "t1", state: "live", labels: { "herdr.space": "spA" } }];
  const spaces = [{ id: "spA", name: "alpha", folder: "/a" }, { id: "spB", name: "beta", folder: "/b/sub" }];
  assert.equal(runSpace({ parent: "t1", space: "spB", repo: "/b" }, terms, spaces), "spA");
  assert.equal(runSpace({ parent: "t9", space: "spB", repo: "/a" }, terms, spaces), "spB");
  assert.equal(runSpace({ parent: null, space: "gone", repo: "/b" }, terms, spaces), "spB");
  assert.equal(runSpace({ parent: null, space: null, repo: "/c" }, terms, spaces), null);
  const runs = [
    { dir: "/a/.cc-dispatch/x", repo: "/a", parent: "t1", live: true, calls: [] },
    { dir: "/b/.cc-dispatch/y", repo: "/b", parent: null, live: true, calls: [] },
    { dir: "/b/.cc-dispatch/z", repo: "/b", parent: null, live: false, calls: [] },
    { dir: "/c/.cc-dispatch/w", repo: "/c", parent: null, live: false, calls: [] },
  ];
  const { mine, others } = splitBySpace(runs, terms, spaces, spaces[0], "/c");
  assert.deepEqual(mine.map((r) => r.dir), ["/a/.cc-dispatch/x", "/c/.cc-dispatch/w"]);
  assert.deepEqual(others.map((g) => [g.id, g.name, g.runs.length]), [["spB", "beta", 1]]);
});

test("groupByStage: most urgent group first, dispatch order inside a group", () => {
  const calls = [{ k: "a", s: "merged" }, { k: "b", s: "working" }, { k: "c", s: "merged" }, { k: "d", s: "blocked" }];
  const g = groupByStage(calls, (c) => c.s);
  assert.deepEqual(g.map((x) => [x.stage, x.calls.map((c) => c.k)]), [["blocked", ["d"]], ["working", ["b"]], ["merged", ["a", "c"]]]);
  assert.deepEqual(groupByStage([], () => "ended"), []);
  assert.ok(SETTLED.has("merged") && !SETTLED.has("collect"));
});

test("timelineMarkdown: events.jsonl in words, oldest first", () => {
  const lines = [
    { t: 1794100000, ev: "dispatch", round: 1, mode: "write", effort: "high", title: "token refresh", sent: true },
    { t: 1794100100, ev: "retry", round: 1, kind: "capacity", n: 1, max: 4, at: 1794100130 },
    { t: 1794100130, ev: "send", round: 1, why: "retry", kind: "capacity", n: 1, sent: true },
    { t: 1794100900, ev: "settle", round: 1, state: "live", status: "done", report: "ok", retried: 1 },
    { t: 1794100901, ev: "codex", round: 1, tokens: { input: 1500000, cached: 1, cache_write: 0, output: 20000 }, commands: 12, files: 3, model: "gpt" },
    { t: 1794101000, ev: "send", round: 2, why: "rework", sent: false },
  ].map((e) => JSON.stringify(e)).join("\n") + "\nnot json\n";
  const md = timelineMarkdown(lines).split("\n");
  assert.equal(md.length, 6);
  assert.match(md[0], /· r1 · dispatched write·high "token refresh"$/);
  assert.match(md[1], /capacity: retry 1\/4 at \d\d:\d\d:\d\d$/);
  assert.match(md[2], /told to carry on \(capacity retry 1\)$/);
  assert.match(md[3], /settled: done, report ok, after 1 retry$/);
  assert.match(md[4], /Codex so far: 1.5M tok · 12 cmd · 3 files · gpt$/);
  assert.match(md[5], /· r2 · sent round 2 — \*\*not delivered\*\*$/);
  assert.match(timelineMarkdown(null), /No events recorded/);
  assert.equal(eventWords({ ev: "settle", state: "gone", report: "missing", failure: "exited" }), "settled: gone, report missing, **exited**");
  assert.match(eventWords({ ev: "lost" }), /interrupted/);
  assert.match(eventWords({ ev: "recover", how: "resume" }), /own session reopened/);
  assert.match(eventWords({ ev: "recover", how: "fresh" }), /new session read the task/);
});

test("a paused run: control.json from the dump, held helpers, the paused stage, its buttons and line", () => {
  const text = `\n${CONTROL_SEP}${RUN}/control.json\n${JSON.stringify({ state: "paused", at: 1000, held: ["a"] })}` + dump(
    [`${RUN}/agents/a/meta.json`, meta("a", { address: "t1", hd: "/x/hd_dispatch.py" })],
    [`${RUN}/agents/b/meta.json`, meta("b", { address: "t2" })],
  );
  assert.deepEqual(Object.keys(parseControls(text)), [RUN]);
  assert.equal(parseMetaDump(text).length, 2);
  const [r] = buildRuns(parseMetaDump(text), [
    { address: "t1", state: "live", status: "idle", labels: {} },
    { address: "t2", state: "live", status: "done", labels: {} },
  ], parseControls(text));
  assert.equal(r.control.state, "paused");
  assert.equal(r.hd, "/x/hd_dispatch.py");
  const [a, b] = r.calls;
  assert.equal(a.held, true);
  assert.equal(b.held, false);
  assert.equal(callNeed(a), "held");
  assert.equal(callStage(a), "paused");
  assert.equal(callStage(b), "collect");
  assert.equal(runStage([callStage(a), callStage(b)]), "paused");
  assert.equal(summary(r.counts), "1 paused · 1 to collect");
  assert.deepEqual(controlOps(r), ["resume", "stop"]);
  assert.equal(controlBanner(r, 1000 * 1000 + 120000), "Paused · 2m ago · 1 helper held");
  assert.match(timelineMarkdown('{"t":1,"ev":"pause","round":1,"interrupted":true}\n{"t":2,"ev":"stop","round":1,"asked":true}'),
    /paused\*\*: stopped mid-turn[\s\S]*run stopped\*\*: asked to report/);
});

test("run control: buttons by state, and a running control.json counts as none", () => {
  assert.deepEqual(controlOps({ live: true, control: null }), ["pause", "stop"]);
  assert.deepEqual(controlOps({ live: false, control: null }), []);
  assert.deepEqual(controlOps({ live: true, control: { state: "stopping" } }), []);
  assert.deepEqual(controlOps({ live: false, control: { state: "stopped" } }), []);
  assert.match(controlBanner({ calls: [], control: { state: "stopped", at: 0 } }), /^Stopped/);
  assert.match(controlBanner({ calls: [], control: { state: "stopped", at: 0 } }), /the main agent has the summary$/);
  assert.match(controlBanner({ calls: [], mainAgent: "codex", control: { state: "stopped", at: 0 } }), /the main agent \(Codex\) has the summary$/);
  const text = `\n${CONTROL_SEP}${RUN}/control.json\n{"state":"running"}` + dump([`${RUN}/agents/a/meta.json`, meta("a", { address: "t1" })]);
  const [r] = buildRuns(parseMetaDump(text), [{ address: "t1", state: "live", status: "working", labels: {} }], parseControls(text));
  assert.equal(r.control, null);
  assert.equal(callStage(r.calls[0]), "working");
});

test("callTags: mode and effort as two letters, the round past the first", () => {
  assert.deepEqual(callTags({ mode: "write", effort: "high", round: 1 }), ["wh"]);
  assert.deepEqual(callTags({ mode: "read", effort: "medium", round: 3 }), ["rm", "r3"]);
  assert.deepEqual(callTags({ mode: "net", effort: "", round: 2 }), ["n", "r2"]);
});

import { resultMarkdown, roundsMarkdown } from "../cc-dispatch/mods/cc-dispatch/model.js";

test("resultMarkdown: the report first, then the worktree's changes for a writing helper", () => {
  const c = { report: "ok", reportPath: "/tmp/r.json", schema: "/s.json" };
  const md = resultMarkdown(c, '{"status":"done"}', [], "## main @ /w\n M a.js\n a.js | 2 +-");
  assert.ok(md.indexOf("passes the schema") < md.indexOf("## Changes in the worktree"));
  assert.match(md, /## Changes in the worktree\n\n`main @ \/w`/);
  assert.match(md, / M a\.js/);
  assert.doesNotMatch(resultMarkdown(c, '{"status":"done"}', [], null), /Changes/);
});

test("roundsMarkdown: newest round first, each with its events and task file", () => {
  const ev = [
    { t: 1, ev: "dispatch", round: 1, mode: "write", effort: "high" },
    { t: 2, ev: "settle", round: 1, state: "live", status: "error", failure: "context_limit" },
    { t: 3, ev: "freeze", round: 1, why: "context_limit", snapshot: "abcdef1234567" },
    { t: 4, ev: "handover", round: 2, frm: "codex", to: "claude", why: "context_limit", isolation: "weak" },
    { t: 5, ev: "adopt", round: 2, frm: "t1", by: "t7", agent: "codex" },
  ].map((e) => JSON.stringify(e)).join("\n");
  const md = roundsMarkdown({ round: 2 }, ev, { 1: "# 任务 a\n做 X", 2: "# 任务 a（第 2 轮）\n接手" });
  assert.ok(md.indexOf("## Round 2 · current · handed over") < md.indexOf("## Round 1 · dispatched"));
  assert.match(md, /handed over\*\* codex → claude \(context_limit\), weak isolation/);
  assert.match(md, /\*\*adopted\*\* by the main agent in t7 \(codex\), was t1/);
  assert.match(md, /\*\*frozen\*\* \(context_limit\), worktree saved `abcdef1234`/);
  assert.match(md, /### Task file `task-2\.md`\n\n#### 任务 a（第 2 轮）/);
  assert.match(roundsMarkdown({ round: 1 }, null, { 1: null }), /No events recorded[\s\S]*No task file for round 1/);
});

import { agentTag, agentLabel, weakIsolation, canHandOver, AGENTS } from "../cc-dispatch/mods/cc-dispatch/model.js";

test("helper agents: the label wins, then meta.json, else codex; Claude Code is marked weak", () => {
  assert.equal(buildCall(meta("a"), RUN, []).agent, "codex");
  assert.equal(agentTag(buildCall(meta("a"), RUN, [])), null);
  const c = buildCall(meta("a", { agent: "claude", claude_sessions: ["s1", "s2"], address: "t5" }), RUN, []);
  assert.deepEqual(agentTag(c), { text: "claude", weak: true });
  assert.deepEqual(c.claudeSessions, ["s1", "s2"]);
  assert.ok(weakIsolation(c));
  assert.match(callDetail(c), /Claude Code \(weak isolation\)/);
  const live = buildCall(meta("a", { address: "t5" }), RUN, [{ address: "t5", state: "live", labels: { "cc.agent": "claude", "cc.handover": "codex" } }]);
  assert.equal(live.agent, "claude");
  assert.equal(live.handingTo, "codex");
  assert.match(callDetail(live), /handing over to Codex/);
  assert.deepEqual(Object.keys(AGENTS), ["codex", "claude", "agy"]);
  assert.equal(agentLabel("claude"), "Claude Code");
});

test("canHandOver: a running run's helper without a good report, not while one is under way", () => {
  const c = buildCall(meta("a"), RUN, []);
  assert.ok(canHandOver(c, { control: null }));
  assert.ok(!canHandOver({ ...c, report: "ok" }, { control: null }));
  assert.ok(!canHandOver(c, { control: { state: "paused" } }));
  assert.ok(!canHandOver({ ...c, handingTo: "claude" }, { control: null }));
});

test("a run being handed off offers no controls and says to give the prompt", () => {
  const r = { live: true, calls: [], control: { state: "handoff", at: 100, package: "/r/handoff/1", prompt: "/r/handoff/1/prompt.md" } };
  assert.deepEqual(controlOps(r), []);
  assert.equal(controlBanner(r, 100_000 + 120_000), "Handing off · 2m ago · give the next main agent the prompt");
});

test("the quota shown is the subscription the main agent's terminal runs now", () => {
  assert.equal(quotaAgent("claude"), "claude");
  assert.equal(quotaAgent("/opt/homebrew/bin/codex"), "codex");
  assert.equal(quotaAgent("nvim"), null);
  assert.equal(quotaAgent("/opt/homebrew/bin/agy"), "agy");
  const r = { parent: "t1", mainAgent: "claude" };
  assert.equal(runQuotaAgent(r, [{ address: "t1", state: "live", program: { key: "codex" } }]), "codex");
  assert.equal(runQuotaAgent(r, [{ address: "t1", state: "live", argv: ["/usr/bin/codex", "-s", "x"] }]), "codex");
  assert.equal(runQuotaAgent(r, []), "claude"); // its terminal is gone: what was recorded
  assert.equal(runQuotaAgent({ parent: "t1" }, [{ address: "t1", state: "live", program: { key: "shell" } }]), null);
});

test("quotaView: windows that have not reset, with their level", () => {
  const now = Date.parse("2026-11-13T10:00:00Z") ;
  const q = { source: "magpie", plan: "prolite", windows: [
    { name: "5 hours", used: 50.4, resets: now / 1000 + 3600 },
    { name: "7 days · Fable", used: 91, resets: now / 1000 + 86400 },
    { name: "7 days", used: 75 },
    { name: "1 hours", used: 99, resets: now / 1000 - 1 }] };
  const v = quotaView("codex", q, now);
  assert.equal(v.label, "Codex · prolite");
  assert.deepEqual(v.windows.map((w) => [w.text, w.level]), [["5h 50%", "ok"], ["7d Fable 91%", "high"], ["7d 75%", "warn"]]);
  assert.equal(quotaView("claude", { windows: [] }), null);
  assert.equal(quotaView("claude", null), null);
  assert.equal(quotaView("claude", { windows: [{ name: "5 hours", used: 1 }] }).label, "Claude Code");
});

test("a run's main agent is a live parent, newest dispatch first, not the first helper's", () => {
  const calls = [
    { call: "A", parent: "t19", startedAt: 1000 },
    { call: "B", parent: null, startedAt: 2000 },
    { call: "C", parent: "t4h", startedAt: 3000 },
  ];
  assert.equal(runParent(calls, [{ address: "t19", state: "finished" }, { address: "t4h", state: "live" }]), "t4h");
  assert.equal(runParent(calls, [{ address: "t19", state: "live" }, { address: "t4h", state: "finished" }]), "t19");
  assert.equal(runParent(calls, []), "t4h"); // none live: the newest
  assert.equal(runParent([{ call: "A" }], []), null);
});

test("a run is live while a helper or its main agent goes on: helpers, paused, or a live main agent's newest run; never stopped", () => {
  const terms = [{ address: "t4h", state: "live" }, { address: "t19", state: "finished" }];
  const runs = [
    { dir: "old", parent: "t4h", lastAt: 1, live: false },
    { dir: "new", parent: "t4h", lastAt: 5, live: false },
    { dir: "gone", parent: "t19", lastAt: 9, live: false },
    { dir: "held", parent: "t19", lastAt: 2, live: false, control: { state: "paused" } },
    { dir: "busy", parent: "t19", lastAt: 3, live: true },
    { dir: "halt", parent: "t4h", lastAt: 99, live: false, control: { state: "stopped" } },
  ];
  assert.deepEqual([...activeRuns(runs, terms)].sort(), ["busy", "held", "new"]);
});

test("buildRuns: a run whose helpers all ended stays live while its main agent works on", () => {
  const entries = [{ path: "/repo/.cc-dispatch/r1/agents/A/meta.json", meta: { call: "A", address: "t9", parent: "t4h", started_at: 10 } }];
  const terms = [{ address: "t9", state: "finished" }, { address: "t4h", state: "live" }];
  const [r] = buildRuns(entries, terms);
  assert.equal(r.helpersLive, false);
  assert.equal(r.live, true);
  assert.equal(buildRuns(entries, [{ address: "t9", state: "finished" }])[0].live, false);
});

test("parseArchived reads the markers ahead of control.json and meta.json", () => {
  const out = `\n${ARCHIVE_SEP}/r/.cc-dispatch/dev-a/archived\n1700000000\n\n${CONTROL_SEP}/r/.cc-dispatch/dev-b/control.json\n{"state":"stopped"}\n${SEP}/r/.cc-dispatch/dev-a/agents/x/meta.json\n{}`;
  assert.deepEqual(parseArchived(out), { "/r/.cc-dispatch/dev-a": 1700000000000 });
  assert.deepEqual(Object.keys(parseControls(out)), ["/r/.cc-dispatch/dev-b"]);
});

test("canArchive: every helper settled, whatever is still open", () => {
  const ok = { call: "a", state: "live", status: "done", report: "ok" };   // reported fine, terminal still open
  const run = (calls, extra = {}) => ({ live: true, control: null, calls, ...extra });
  assert.equal(canArchive(run([ok, { call: "b", state: "gone", report: "ok" }])), true);
  assert.equal(canArchive(run([ok, { call: "b", state: "live", status: "working" }])), false);
  assert.equal(canArchive(run([ok]), { a: "running" }), false);          // dev card not reviewed yet
  assert.equal(canArchive(run([ok]), { a: "merged" }), true);
  assert.equal(canArchive(run([{ call: "a", state: "live", status: "done", report: "bad" }])), false);
  for (const state of ["paused", "stopping", "handoff"]) assert.equal(canArchive(run([ok], { control: { state } })), false);
  assert.equal(canArchive(run([ok], { control: { state: "stopped" } })), true);
  assert.equal(canArchive(run([])), false);
  assert.equal(archivedAway(run([ok], { archived: 5 })), true);
  assert.equal(archivedAway(run([{ call: "a", state: "live", status: "working" }], { archived: 5 })), false);
});

test("buildRuns marks archived runs", () => {
  const entries = [{ path: `${RUN}/agents/a/meta.json`, meta: meta("a") }];
  const [r] = buildRuns(entries, [], {}, { [RUN]: 5 });
  assert.equal(r.archived, 5);
  assert.equal(buildRuns(entries, [])[0].archived, null);
});

test("cardView: merged out of the cards meant to be merged; cards with no helper, queued last", () => {
  const run = { checks: 2, cards: {
    T1: { status: "merged" }, T2: { status: "parked" }, T3: { status: "running" },
    T4: { status: "pending", depends_on: ["T1", "T3", "T2"] }, T5: { status: "accepting", note: "main agent runs it" } } };
  const v = cardView(run, ["T1", "T2", "T3"]);
  assert.deepEqual([v.merged, v.goal, v.parked, v.total, v.checks], [1, 4, 1, 5, 2]);
  assert.deepEqual(v.undispatched.map((k) => [k.id, k.waits]), [["T5", []], ["T4", ["T3", "T2"]]]);
  assert.equal(cardView({ status: { A: "merged" } }).goal, 1);  // status-only (older stats cache)
});

test("parkedWhy: state.json's reason, else read from the note, else the person decides", () => {
  assert.equal(parkedWhy({ status: "merged" }), null);
  assert.equal(parkedWhy({ status: "parked", parked_why: "dropped" }), "dropped");
  assert.equal(parkedWhy({ status: "parked", note: "superseded by WF (log 2026-11-13)" }), "superseded");
  assert.equal(parkedWhy({ status: "parked", note: "3 rounds failed" }), "user");
});

test("handoffAsks: review a good report on an unreviewed card; decide on a card parked for you", () => {
  const ok = { call: "T1", state: "gone", report: "ok" };
  assert.deepEqual(handoffAsks(ok, { status: "running" }), ["accept"]);
  assert.deepEqual(handoffAsks(ok, { status: "parked" }), ["decide"]);
  assert.deepEqual(handoffAsks(ok, { status: "parked", parked_why: "superseded" }), []);
  assert.deepEqual(handoffAsks(ok, { status: "merged" }), []);
  assert.deepEqual(handoffAsks({ ...ok, report: "bad" }, { status: "accepting" }), ["bad"]);
});

test("parseAsks reads asks.json and answers.jsonl ahead of the other dumps", () => {
  const D = "/r/.cc-dispatch/dev-1";
  const out = `\n${ASKS_SEP}${D}/asks.json\n{"api":{"kind":"decision","title":"409 or 410"}}\n${ANSWERS_SEP}${D}/answers.jsonl\n`
    + `{"id":"api","at":1,"choice":"B"}\nnot json\n\n${ARCHIVE_SEP}${D}/archived\n5\n\n${CONTROL_SEP}${D}/control.json\n{"state":"paused"}\n${SEP}${D}/agents/a/meta.json\n{}`;
  assert.deepEqual(parseAsks(out), { [D]: { asks: { api: { kind: "decision", title: "409 or 410" } }, answers: [{ id: "api", at: 1, choice: "B" }] } });
  assert.deepEqual(parseArchived(out), { [D]: 5000 });
  assert.equal(parseControls(out)[D].state, "paused");
  assert.match(LIST_SCRIPT, /asks\.json/);
});

test("pendingItems: asks, cards parked for you (with older pending_decisions folded in), answers", () => {
  const r = { dir: "/r/.cc-dispatch/dev-1", asks: {
    api: { kind: "decision", title: "409 or 410", options: [{ key: "A", label: "409" }, { key: "B", label: "410", detail: "gone for good" }], recommend: "B", why: "the client treats 410 as final", asked: 100 },
    env: { kind: "question", title: "Which staging?", context: "two exist", asked: 50 },
    junk: { kind: "maybe", title: "x" },
    about: { kind: "decision", title: "split T3?", card: "T3", options: [{ key: "y", label: "yes" }, { key: "n", label: "no" }] },
  }, answers: [{ id: "env", at: 200, text: "stg-2" }] };
  const cards = { T1: { status: "parked", note: "3 rounds failed", title: "Redact headers" }, T2: { status: "parked", note: "superseded by T1" },
    T3: { status: "parked", parked_why: "user" }, T4: { status: "merged" } };
  const items = pendingItems(r, cards, { "T1-redaction": "must redact quoted values", "pg": "which PG version" });
  assert.deepEqual(items.map((x) => x.id), ["about", "card:T1", "api", "pending:pg", "env"]);
  const t1 = items.find((x) => x.id === "card:T1");
  assert.match(t1.context, /Redact headers[\s\S]*3 rounds failed[\s\S]*T1-redaction.*quoted values/);
  assert.deepEqual(t1.options.map((o) => o.key), ["resume", "drop"]);
  assert.equal(itemLine(items.find((x) => x.id === "api")), "409 / ★ 410");
  assert.equal(itemLine(items.find((x) => x.id === "env")), "answered · stg-2");
  assert.equal(items.find((x) => x.id === "env").answer.text, "stg-2");
  assert.equal(pendingItems({ asks: {}, answers: [] }, {}, {}).length, 0);
  // asked again after the answer: the old answer no longer counts
  const again = pendingItems({ ...r, asks: { env: { ...r.asks.env, asked: 300 } } }, {}, {});
  assert.equal(again[0].answer, null);
});

test("answerRecord and answerText: what is saved and what the main agent gets", () => {
  const r = { dir: "/r/.cc-dispatch/dev-1" };
  const api = { id: "api", kind: "decision", title: "409 or 410", source: "ask", options: [{ key: "A", label: "409" }, { key: "B", label: "410" }] };
  assert.deepEqual(answerRecord(api, { choice: "B", text: " keep docs " }, 5000), { id: "api", at: 5, kind: "decision", choice: "B", label: "410", text: "keep docs", by: "panel" });
  const msg = answerText(r, api, { choice: "B", text: "keep docs" });
  assert.match(msg, /待决项 api「409 or 410」我选 B「410」。补充：keep docs/);
  assert.match(msg, /ask --resolve api/);
  const q = { id: "env", kind: "question", title: "Which staging?", source: "ask", options: [] };
  assert.match(answerText(r, q, { choice: null, text: "stg-2" }), /我的回答：stg-2/);
  const card = pendingItems(r, { T1: { status: "parked" } }, {})[0];
  assert.match(answerText(r, card, { choice: "drop", text: "" }), /T1 我决定不做了.*parked_why=dropped.*call=T1/);
  assert.match(answerText(r, card, { choice: "resume", text: "try a smaller scope" }), /改回 pending.*补充：try a smaller scope/);
});

test("canArchive: a queued card keeps the run open", () => {
  const ok = { call: "T1", state: "gone", report: "ok" };
  assert.equal(canArchive({ calls: [ok] }, { T1: "merged", T2: "pending" }), false);
  assert.equal(canArchive({ calls: [ok] }, { T1: "merged", T2: "parked" }), true);
});

test("canArchive: a retired run stays archived whatever its cards say, but not while handing off", () => {
  const ok = { call: "T1", state: "gone", report: "ok" }, cards = { T1: "accepting", T2: "pending" };
  assert.equal(canArchive({ calls: [ok], control: { state: "running", retired: { at: 1 } } }, cards), true);
  assert.equal(canArchive({ calls: [ok], control: { state: "handoff", retired: { at: 1 } } }, cards), false);
});

test("agentIn: herdr's program key, else the program in front; a bare shell or a gone terminal is none", () => {
  assert.equal(agentIn({ state: "live", program: { key: "codex" } }), "codex");
  assert.equal(agentIn({ state: "live", foreground: { argv: ["/opt/bin/antigravity", "x"] } }), "antigravity");
  assert.equal(agentIn({ state: "live", foreground: { argv: ["-zsh"] } }), null);
  assert.equal(agentIn({ state: "live", program: { key: "zsh" }, foreground: { argv: ["zsh"] } }), null);
  assert.equal(agentIn({ state: "finished", program: { key: "claude" } }), null);
  assert.equal(agentIn(undefined), null);
});

test("needsTakeover: the main agent is gone and the run is not done", () => {
  const terms = [{ address: "t1", state: "live", program: { key: "claude" } }];
  const run = (calls, extra = {}) => ({ dir: "/r/.cc-dispatch/20260101-x", kind: "dev", parent: "t1", calls, control: null, hd: "/h/hd_dispatch.py", ...extra });
  const settled = { call: "T1", state: "gone", report: "ok" };
  const working = { call: "T2", state: "live", status: "working" };
  assert.equal(needsTakeover(run([working]), terms, {}), false, "its main agent still runs");
  assert.equal(needsTakeover(run([working]), [], {}), true, "a helper still at work");
  assert.equal(needsTakeover(run([working]), [{ address: "t1", state: "live", foreground: { argv: ["zsh"] } }], {}), true, "back at the shell");
  assert.equal(needsTakeover(run([settled]), [], { T1: "merged" }), false, "all done");
  assert.equal(needsTakeover(run([settled]), [], { T1: "merged", T3: "pending" }), true, "a card left");
  assert.equal(needsTakeover(run([settled]), [], { T1: "parked" }), false, "parked is settled");
  assert.equal(needsTakeover(run([{ ...settled, report: null, lost: true }]), [], {}), true, "a lost helper");
  assert.equal(needsTakeover(run([settled], { control: { state: "stopped" } }), [], {}), true, "stopped, waiting on the person");
  assert.equal(needsTakeover(run([working], { control: { state: "handoff" } }), [], {}), false, "has its own prompt");
  assert.equal(needsTakeover(run([working]), [], {}, true), false, "state.json says finished");
});

test("takeoverPrompt names the skill, the run and the takeover command, for any main agent", () => {
  const r = { dir: "/r/.cc-dispatch/review-0107", kind: "review", hd: "/h/hd_dispatch.py", mainAgent: "codex" };
  const p = takeoverPrompt(r);
  assert.match(p, /cc-herdr-dispatch-review skill/);
  assert.match(p, /`python3 \/h\/hd_dispatch\.py takeover --run \/r\/\.cc-dispatch\/review-0107`/);
  assert.match(p, /确认之前/);
  assert.equal(skillOf({ kind: "probe" }), "cc-herdr-dispatch-dev");
  assert.equal(takeoverBanner(r), "The main agent (Codex) is gone · give a new one the prompt");
  assert.equal(takeoverBanner({}), "The main agent is gone · give a new one the prompt");
});

test("buildRuns lists every main agent of a run, newest first, whatever its program", () => {
  const runs = buildRuns([
    { path: `${RUN}/agents/a/meta.json`, meta: meta("a", { session: "s-claude", dispatcher_agent: "claude-code", started_at: 100 }) },
    { path: `${RUN}/agents/b/meta.json`, meta: meta("b", { session: "th-codex", dispatcher_agent: "/opt/bin/codex", started_at: 200 }) },
    { path: `${RUN}/agents/c/meta.json`, meta: meta("c", { session: "s-claude", dispatcher_agent: "claude", started_at: 300 }) },
  ], []);
  assert.deepEqual(runs[0].mains, [{ agent: "claude", session: "s-claude" }, { agent: "codex", session: "th-codex" }]);
});

test("runMains: a session-less entry only for a program with no recorded session", () => {
  const call = (mainAgent, session, startedAt) => ({ mainAgent, session, startedAt, earlierMains: [] });
  assert.deepEqual(runMains([call("codex", null, 3), call("claude", "s1", 2), call("claude", null, 1)]),
    [{ agent: "codex", session: null }, { agent: "claude", session: "s1" }]);
  assert.deepEqual(runMains([call(null, null, 1)]), [{ agent: "claude", session: null }]);
  assert.equal(mainKey("Codex CLI"), "codex");
  assert.equal(mainKey("agy"), "agy");
  assert.equal(mainKey("Antigravity"), "agy");
});

test("buildRuns keeps the main agent a takeover replaced (meta.json mains)", () => {
  const runs = buildRuns([
    { path: `${RUN}/agents/a/meta.json`, meta: meta("a", { session: "th-codex", dispatcher_agent: "codex", started_at: 100,
      adopted: { from: "t1", by: "t2" }, mains: [{ terminal: "t1", agent: "claude", session: "s-old" }] }) },
  ], []);
  assert.deepEqual(runs[0].mains, [{ agent: "codex", session: "th-codex" }, { agent: "claude", session: "s-old" }]);
  assert.equal(runs[0].adopted, true);
});
