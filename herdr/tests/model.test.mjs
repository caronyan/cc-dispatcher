import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SEP, parseMetaDump, runDirOf, repoOf, kindOf, runRoots, buildCall, callNeed, buildRuns,
  summary, callDetail, runSpace, splitBySpace, callStage, runStage, stageSummary, groupByStage, SETTLED, cardCounts, ago, handoffAsk, handoffText, prettyReport, taskPath, timelineMarkdown, eventWords,
  CONTROL_SEP, parseControls, controlOps, controlBanner, quotaAgent, runQuotaAgent, quotaView, runParent, activeRuns, callTags,
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
  assert.deepEqual(Object.keys(AGENTS), ["codex", "claude"]);
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
