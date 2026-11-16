import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BG_PY, bgRequest, assignTasks, bgView, bgSummary, LIVE_SCRIPT, parseLive, liveMarkdown } from "../cc-dispatch/mods/cc-dispatch/bg.js";

const SID = "11111111-2222-3333-4444-555555555555";
const ts = (s) => `2026-11-08T03:${s}Z`;
const use = (t, id, name, input) => JSON.stringify({ type: "assistant", timestamp: ts(t), message: { content: [{ type: "tool_use", id, name, input }] } }) + "\n";
const result = (t, id, text, extra) => JSON.stringify({ type: "user", timestamp: ts(t), toolUseResult: extra, message: { content: [{ type: "tool_result", tool_use_id: id, content: text }] } }) + "\n";
const note = (t, body) => JSON.stringify({ type: "user", timestamp: ts(t), message: { content: `<task-notification>\n${body}\n</task-notification>` } }) + "\n";

// A Claude home with one transcript: a background shell, the hd wait, a Monitor, an async Agent,
// a foreground Bash (not a task), and a run folder the transcript names.
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cc-bg-"));
  const repo = join(home, "repo"), run = join(repo, ".cc-dispatch/dev-x");
  const proj = join(home, ".claude/projects", repo.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(proj, { recursive: true });
  const out = join(home, "build.output");
  writeFileSync(out, "step 1\n\x1b[32mstep 2\x1b[0m\nprogress 10%\rprogress 90%\n[exited with code 0]\n");
  const log = join(proj, `${SID}.jsonl`);
  writeFileSync(log,
    use("00:00", "u1", "Bash", { command: "npm run build", description: "Build", run_in_background: true }) +
    result("00:01", "u1", `Command running in background with ID: b1. Output is being written to: ${out}. You will be notified.`, { backgroundTaskId: "b1" }) +
    use("00:02", "u2", "Bash", { command: `python3 /x/hd_dispatch.py wait --run ${run}`, run_in_background: true, description: "Wait" }) +
    result("00:02", "u2", "Command running in background with ID: b2.", { backgroundTaskId: "b2" }) +
    use("00:03", "u3", "Monitor", { command: "tail -f x", description: "Watch logs" }) +
    result("00:03", "u3", "Monitor started (task m1, expires in 30m).", { taskId: "m1" }) +
    use("00:04", "u4", "Agent", { description: "Draft docs", subagent_type: "worker", prompt: "…" }) +
    result("00:04", "u4", "Async agent launched successfully.", { isAsync: true, agentId: "a1" }) +
    use("00:05", "u5", "Bash", { command: "ls" }) +
    result("00:05", "u5", "a b", { stdout: "a b" }) +
    note("00:06", "<task-id>m1</task-id>\n<summary>Monitor event: \"Watch logs\"</summary>\n<event>line one\nline two</event>") +
    note("00:07", "<task-id>b1</task-id>\n<tool-use-id>u1</tool-use-id>\n<status>completed</status>\n<summary>Background command \"Build\" completed (exit code 0)</summary>"));
  return { home, repo, run, log, out };
}

const bg = (home, req) => JSON.parse(execFileSync("python3", ["-I", "-c", BG_PY, JSON.stringify(req)], {
  encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CC_HD_HOME: join(home, "hd") },
}));

test("bg script: finds the session by the run folder and reads its tasks", () => {
  const { home, repo, run } = fixture();
  const o = bg(home, bgRequest([{ dir: run, repo, startedAt: Date.parse(ts("00:00")) }]));
  assert.equal(o.resolved[run], SID);
  const tasks = o.sessions[SID];
  assert.deepEqual(tasks.map((t) => [t.id, t.kind, t.status]),
    [["b1", "shell", "completed"], ["b2", "wait", "running"], ["m1", "monitor", "running"], ["a1", "agent", "running"]]);
  const [build, , mon] = tasks;
  assert.equal(build.title, "Build");
  assert.equal(build.ended, Date.parse(ts("00:07")));
  assert.deepEqual(build.tail, ["step 2", "progress 90%"]);
  assert.equal(mon.event, "line two");
});

test("bg script: a recorded session needs no search; appended notifications end tasks", () => {
  const { home, run, log } = fixture();
  const req = { runs: [{ dir: run, session: SID, cwd: null, since: 0 }] };
  bg(home, req);
  appendFileSync(log, note("00:09", "<task-id>a1</task-id>\n<status>failed</status>\n<summary>Agent \"Draft docs\" failed: boom</summary>"));
  const a = bg(home, req).sessions[SID].find((t) => t.id === "a1");
  assert.equal(a.status, "failed");
  assert.equal(bgSummary(a), "failed: boom");
});

test("assignTasks: each task goes to the latest run of its session that started before it", () => {
  const runs = [{ dir: "A", startedAt: 1_000_000 }, { dir: "B", startedAt: 5_000_000 }, { dir: "C", startedAt: 1_000_000 }];
  const sessions = { s: [{ id: "early", started: 100 }, { id: "a", started: 2_000_000 }, { id: "b", started: 4_900_000 }, { id: "c", started: 6_000_000 }] };
  const got = assignTasks(runs, { A: "s", B: "s" }, sessions);
  assert.deepEqual(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.map((t) => t.id)])), { A: ["a"], B: ["b", "c"] });
});

test("bgView: wait hidden but noted, running first, a few ended, lost when Claude is gone", () => {
  const tasks = [
    { id: "w", kind: "wait", status: "running" },
    { id: "r", kind: "shell", status: "running", started: 5 },
    ...[1, 2, 3, 4, 5].map((n) => ({ id: `e${n}`, kind: "shell", status: "completed", ended: n })),
  ];
  const v = bgView(tasks, true);
  assert.equal(v.waiting, true);
  assert.deepEqual(v.running.map((t) => t.id), ["r"]);
  // three rows in all: the running one, then the two that ended last
  assert.deepEqual(v.ended.map((t) => t.id), ["e5", "e4"]);
  assert.equal(v.hidden, 3);
  const more = bgView(tasks, true, 5);
  assert.deepEqual(more.ended.map((t) => t.id), ["e5", "e4", "e3", "e2", "e1"]);
  assert.equal(more.hidden, 0);
  assert.equal(more.more, 3);
  const gone = bgView(tasks, false);
  assert.equal(gone.waiting, false);
  assert.equal(gone.ended.some((t) => t.id === "r" && t.status === "lost"), true);
});

const LIVE = `SIZE=0
MTIME=1000
NOW=1600
PIDS=10 
--PS--
    1     0 Ss   9-00:00:00   1:00.00   0.0 /sbin/launchd
   10     5 Ss   10:00   0:00.02   0.0 /bin/zsh -c source /u/.claude/shell-snapshots/s.sh && eval 'npm test'
   11    10 S    10:00   0:00.50   0.0 /usr/local/bin/node --test a.test.mjs
   12    11 R    09:59   9:58.00  99.5 /usr/local/bin/node worker.js
   99     1 S    01:00   0:00.01   0.0 /bin/sleep 60
--TAIL--
`;

test("parseLive keeps the tree under the shell holding the output file", () => {
  const v = parseLive(LIVE);
  assert.equal(v.size, 0);
  assert.equal(v.mtime, 1000);
  assert.deepEqual(v.procs.map((p) => [p.pid, p.depth]), [[10, 0], [11, 1], [12, 2]]);
  assert.equal(v.procs[2].cpu, 99.5);
  assert.equal(v.tail, "");
});

test("liveMarkdown names the busy process and shows the task's command for the shell", () => {
  const md = liveMarkdown({ started: 1000_000, command: "npm test" }, parseLive(LIVE));
  assert.match(md, /output empty so far/);
  assert.match(md, /Busy: `node worker\.js` at 100% CPU/);
  assert.match(md, /sh: npm test/);
  assert.match(md, /_Nothing yet\./);
});

test("liveMarkdown: idle processes and a quiet file read as waiting or stuck", () => {
  const idle = LIVE.replace("R    09:59   9:58.00  99.5", "S    09:59   0:00.10   0.0");
  assert.match(liveMarkdown({}, parseLive(idle)), /All 3 processes idle/);
  const gone = parseLive("SIZE=5\nMTIME=1590\nNOW=1600\nPIDS=\n--PS--\n--TAIL--\nhello\n");
  const md = liveMarkdown({}, gone);
  assert.match(md, /No process holds the output file/);
  assert.match(md, /~~~~\nhello\n~~~~/);
});

test("LIVE_SCRIPT finds the shell writing to a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "live-")), f = join(dir, "t.output");
  writeFileSync(f, "");
  const out = execFileSync("sh", ["-c", `sh -c 'echo started; sleep 3' >> "${f}" 2>&1 & sleep 0.5; sh -c '${LIVE_SCRIPT.replace(/'/g, "'\\''")}' x "${f}"`], { encoding: "utf8" });
  const v = parseLive(out);
  assert.ok(v.procs.some((p) => /sleep 3/.test(p.command)), out.slice(0, 400));
  assert.match(v.tail, /started/);
});

test("bg script: a foreground shell moved to the background after its timeout is a task", () => {
  const { home, run, log } = fixture();
  appendFileSync(log,
    use("00:10", "u6", "Bash", { command: "npm test", description: "Full tests" }) +
    result("00:20", "u6", "build=0\nCommand did not complete within its 600s timeout and was moved to the background (ID: b6). Output is being written to: /x/b6.output.",
      { stdout: "build=0", backgroundTaskId: "b6", timedOutAfterMs: 600000 }));
  const t = bg(home, { runs: [{ dir: run, session: SID, cwd: null, since: 0 }] }).sessions[SID].find((x) => x.id === "b6");
  assert.deepEqual([t.kind, t.status, t.title, t.output, t.started], ["shell", "running", "Full tests", "/x/b6.output", Date.parse(ts("00:10"))]);
});

test("bg script: a TaskStop ends its task as killed; a failed stop changes nothing", () => {
  const { home, run, log } = fixture();
  appendFileSync(log,
    use("00:10", "u6", "Bash", { command: "npm test", description: "Full tests", run_in_background: true }) +
    result("00:10", "u6", "Command running in background with ID: b6.", { backgroundTaskId: "b6" }) +
    use("00:11", "u7", "TaskStop", { task_id: "m1" }) +
    JSON.stringify({ type: "user", timestamp: ts("00:11"), message: { content: [{ type: "tool_result", tool_use_id: "u7", content: "No task found", is_error: true }] } }) + "\n" +
    use("00:12", "u8", "TaskStop", { task_id: "b6" }) +
    result("00:12", "u8", '{"message":"Successfully stopped task: b6"}', { message: "Successfully stopped task: b6" }));
  const tasks = bg(home, { runs: [{ dir: run, session: SID, cwd: null, since: 0 }] }).sessions[SID];
  const b6 = tasks.find((x) => x.id === "b6"), m1 = tasks.find((x) => x.id === "m1");
  assert.deepEqual([b6.status, b6.ended], ["killed", Date.parse(ts("00:12"))]);
  assert.equal(m1.status, "running");
});

test("bg script: a running shell whose output file says it ended is ended, and the marker is not its tail", () => {
  const { home, run, log } = fixture();
  const out = join(home, "b9.output");
  writeFileSync(out, "build=0\n\n[killed]\n");
  appendFileSync(log,
    use("00:10", "u9", "Bash", { command: "npm test", description: "Tests", run_in_background: true }) +
    result("00:10", "u9", `Command running in background with ID: b9. Output is being written to: ${out}.`, { backgroundTaskId: "b9" }));
  const t = bg(home, { runs: [{ dir: run, session: SID, cwd: null, since: 0 }] }).sessions[SID].find((x) => x.id === "b9");
  assert.equal(t.status, "killed");
  assert.ok(t.ended > 0);
  assert.deepEqual(t.tail, ["build=0"]);
  writeFileSync(out, "ok\n[exited with code 1]\n");
  assert.equal(bg(home, { runs: [{ dir: run, session: SID, cwd: null, since: 0 }] }).sessions[SID].find((x) => x.id === "b9").status, "failed");
});

test("a run read by every main agent session that dispatched to it", () => {
  const r = { dir: "/r", sessions: ["s2", "s1"], startedAt: 1000, repo: "/repo" };
  assert.deepEqual(bgRequest([r]).runs.map((x) => x.session), ["s2", "s1"]);
  const out = assignTasks([r], { "/r": "s1" }, { s1: [{ id: "a", started: 2000 }], s2: [{ id: "b", started: 3000 }] });
  assert.deepEqual(out["/r"].map((t) => t.id).sort(), ["a", "b"]);
  assert.deepEqual(bgRequest([{ dir: "/x", startedAt: 0 }]).runs.map((x) => x.session), [null]);
});

test("bgRequest skips runs whose main agents were all something else than Claude Code", () => {
  const got = bgRequest([{ dir: "/a", mainAgent: "codex", sessions: [] }, { dir: "/b", mainAgent: null, sessions: [] },
    { dir: "/c", mainAgent: "codex", sessions: ["s1"] }]).runs.map((x) => x.dir);
  assert.deepEqual(got, ["/b", "/c"]);
});
