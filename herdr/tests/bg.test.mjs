import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BG_PY, bgRequest, assignTasks, topicTasks, bgView, bgSummary, LIVE_SCRIPT, parseLive, liveMarkdown } from "../cc-dispatch/mods/cc-dispatch/bg.js";

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
  encoding: "utf8", env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: "", CODEX_HOME: "", CC_HD_HOME: join(home, "hd") },
}));

test("bg script: finds the session by the run folder and reads its tasks", () => {
  const { home, repo, run } = fixture();
  const o = bg(home, bgRequest([{ dir: run, repo, startedAt: Date.parse(ts("00:00")), mains: [{ agent: "claude", session: null }] }]));
  assert.deepEqual(o.runs[run], [SID]);
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
  const req = { runs: [{ dir: run, agent: "claude", session: SID, cwd: null, since: 0 }] };
  bg(home, req);
  appendFileSync(log, note("00:09", "<task-id>a1</task-id>\n<status>failed</status>\n<summary>Agent \"Draft docs\" failed: boom</summary>"));
  const a = bg(home, req).sessions[SID].find((t) => t.id === "a1");
  assert.equal(a.status, "failed");
  assert.equal(bgSummary(a), "failed: boom");
});

test("assignTasks: each task goes to the latest run of its session that started before it", () => {
  const runs = [{ dir: "A", startedAt: 1_000_000 }, { dir: "B", startedAt: 5_000_000 }, { dir: "C", startedAt: 1_000_000 }];
  const sessions = { s: [{ id: "early", started: 100 }, { id: "a", started: 2_000_000 }, { id: "b", started: 4_900_000 }, { id: "c", started: 6_000_000 }] };
  const got = assignTasks(runs, { A: ["s"], B: ["s"] }, sessions);
  assert.deepEqual(Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v.map((t) => t.id)])), { A: ["a"], B: ["b", "c"] });
});

test("assignTasks: a task whose command names a run folder goes to that run", () => {
  const runs = [{ dir: "/r/.cc-dispatch/old", startedAt: 1000 }, { dir: "/r/.cc-dispatch/old-2", startedAt: 5000 }];
  const sessions = { s: [{ id: "w", started: 9000, command: "hd_dispatch.py wait --run /r/.cc-dispatch/old --timeout 600" },
    { id: "w2", started: 9000, command: "hd_dispatch.py wait --run /r/.cc-dispatch/old-2" }, { id: "x", started: 9000, command: "ls" }] };
  const got = assignTasks(runs, { [runs[0].dir]: ["s"], [runs[1].dir]: ["s"] }, sessions);
  assert.deepEqual(got[runs[0].dir].map((t) => t.id), ["w"]);
  assert.deepEqual(got[runs[1].dir].map((t) => t.id), ["w2", "x"]);
});

test("topicTasks merges assigned runs, deduplicating session plus task id while retaining different sessions", () => {
  const runs = [{ dir: "/a", startedAt: 1000 }, { dir: "/b", startedAt: 900000 }, { dir: "/other", startedAt: 1000 }];
  const sessions = {
    s1: [{ id: "same", started: 2000 }, { id: "b", started: 1000000 }, { id: "b", started: 1000000 }],
    s2: [{ id: "same", started: 2000 }],
    s3: [{ id: "unrelated", started: 2000 }],
  };
  const assigned = assignTasks(runs, { "/a": ["s1", "s2"], "/b": ["s1"], "/other": ["s3"] }, sessions);
  const merged = topicTasks(assigned, { runs: [runs[0], runs[1], runs[0]] });
  assert.deepEqual(merged.map((t) => [t.session, t.id]), [["s1", "same"], ["s2", "same"], ["s1", "b"]]);
  assert.deepEqual(topicTasks(assigned, { runs: [] }), []);
  assert.deepEqual(topicTasks({}, { runs }), []);
  assert.equal(sessions.s1[0].session, undefined);
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
  assert.match(md, /暂时没有输出/);
  assert.match(md, /在忙：`node worker\.js` 占用 100% CPU/);
  assert.match(md, /sh: npm test/);
  assert.match(md, /_还没有输出。/);
});

test("liveMarkdown: idle processes and a quiet file read as waiting or stuck", () => {
  const idle = LIVE.replace("R    09:59   9:58.00  99.5", "S    09:59   0:00.10   0.0");
  assert.match(liveMarkdown({}, parseLive(idle)), /3 个进程都空闲/);
  const gone = parseLive("SIZE=5\nMTIME=1590\nNOW=1600\nPIDS=\n--PS--\n--TAIL--\nhello\n");
  const md = liveMarkdown({}, gone);
  assert.match(md, /没有进程占着输出文件/);
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
  const t = bg(home, { runs: [{ dir: run, agent: "claude", session: SID, cwd: null, since: 0 }] }).sessions[SID].find((x) => x.id === "b6");
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
  const tasks = bg(home, { runs: [{ dir: run, agent: "claude", session: SID, cwd: null, since: 0 }] }).sessions[SID];
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
  const t = bg(home, { runs: [{ dir: run, agent: "claude", session: SID, cwd: null, since: 0 }] }).sessions[SID].find((x) => x.id === "b9");
  assert.equal(t.status, "killed");
  assert.ok(t.ended > 0);
  assert.deepEqual(t.tail, ["build=0"]);
  writeFileSync(out, "ok\n[exited with code 1]\n");
  assert.equal(bg(home, { runs: [{ dir: run, agent: "claude", session: SID, cwd: null, since: 0 }] }).sessions[SID].find((x) => x.id === "b9").status, "failed");
});

test("a run read by every main agent session that dispatched to it", () => {
  const r = { dir: "/r", mains: [{ agent: "codex", session: "s2" }, { agent: "claude", session: "s1" }], startedAt: 1000, repo: "/repo" };
  assert.deepEqual(bgRequest([r]).runs.map((x) => [x.agent, x.session]), [["codex", "s2"], ["claude", "s1"]]);
  const out = assignTasks([r], { "/r": ["s1", "s2"] }, { s1: [{ id: "a", started: 2000 }], s2: [{ id: "b", started: 3000 }] });
  assert.deepEqual(out["/r"].map((t) => t.id).sort(), ["a", "b"]);
  // the script not heard from yet: the recorded sessions
  assert.deepEqual(assignTasks([r], {}, { s2: [{ id: "b", started: 3000 }] })["/r"].map((t) => t.id), ["b"]);
});

test("bgRequest: one entry per main agent; an adopted run with none known still asks for its handoff packages", () => {
  const got = bgRequest([{ dir: "/a", mains: [] }, { dir: "/b", mains: [], adopted: true },
    { dir: "/c", mains: [{ agent: "codex", session: null }, { agent: "claude", session: "s1" }], adopted: true }]).runs;
  assert.deepEqual(got.map((x) => [x.dir, x.agent, x.adopted]), [["/b", null, true], ["/c", "codex", true], ["/c", "claude", false]]);
});

test("a run a Codex main agent took over still shows its earlier Claude Code main agent's tasks", () => {
  const { home, run } = fixture();
  // adopted before meta.json kept earlier main agents: the handoff package names the Claude session
  mkdirSync(join(run, "handoff", "1"), { recursive: true });
  writeFileSync(join(run, "handoff", "1", "handoff.json"), JSON.stringify({ from: { terminal: "t1", agent: "claude", session: SID } }));
  const r = { dir: run, mains: [{ agent: "codex", session: null }], adopted: true, startedAt: 0 };
  const o = bg(home, bgRequest([r]));
  assert.deepEqual(o.runs[run], [SID]);
  assert.ok(assignTasks([r], o.runs, o.sessions)[run].length > 0);
});

// ---- codex adapter ----

const cts = (s) => `2026-11-08T04:${s}:00.000Z`;
const ccall = (t, id, name, args) => JSON.stringify({ timestamp: cts(t), type: "response_item",
  payload: { type: "function_call", name, arguments: JSON.stringify(args), call_id: id } }) + "\n";
const cout = (t, id, output) => JSON.stringify({ timestamp: cts(t), type: "response_item",
  payload: { type: "function_call_output", call_id: id, output } }) + "\n";
const running = (n, out = "") => `Chunk ID: x\nWall time: 10.0 seconds\nProcess running with session ID ${n}\nOriginal token count: 1\nOutput:\n${out}`;
const exited = (code, out = "") => `Chunk ID: y\nWall time: 1.0 seconds\nProcess exited with code ${code}\nOriginal token count: 1\nOutput:\n${out}`;
const TH = "019a0000-0000-7000-8000-000000000001";

// A Codex home: the main agent's thread (in the repo, naming the run) and a helper's (<hc …>), in state_5.sqlite.
function codexFixture() {
  const home = mkdtempSync(join(tmpdir(), "cc-bg-codex-"));
  const repo = join(home, "repo"), run = join(repo, ".cc-dispatch/dev-y"), chome = join(home, ".codex-api");
  mkdirSync(join(chome, "sessions"), { recursive: true });
  mkdirSync(run, { recursive: true });
  const log = join(chome, "sessions", `rollout-${TH}.jsonl`), helper = join(chome, "sessions", "rollout-helper.jsonl");
  writeFileSync(helper, ccall("00", "h1", "exec_command", { cmd: `echo ${run}` }));
  writeFileSync(log,
    ccall("00", "c1", "exec_command", { cmd: `python3 hd_dispatch.py run --run ${run}` }) + cout("00", "c1", exited(0, "ok")) +
    // a build the agent goes on beside: background
    ccall("01", "c2", "exec_command", { cmd: "npm run build" }) + cout("01", "c2", running(7, "step 1\n")) +
    ccall("02", "c3", "exec_command", { cmd: "git status" }) + cout("02", "c3", exited(0, "clean")) +
    ccall("03", "c4", "write_stdin", { session_id: 7, chars: "", yield_time_ms: 1000 }) + cout("03", "c4", exited(0, "step 2\ndone\n")) +
    // a slow test run only polled until it ended: a foreground command, left out
    ccall("04", "c5", "exec_command", { cmd: "npm test" }) + cout("04", "c5", running(8)) +
    ccall("05", "c6", "write_stdin", { session_id: 8, chars: "", yield_time_ms: 30000 }) + cout("05", "c6", exited(1, "1 failing")) +
    // the hd wait, and a heredoc that fails in the background
    ccall("06", "c7", "exec_command", { cmd: `python3 hd_dispatch.py wait --run ${run}` }) + cout("06", "c7", running(9)) +
    ccall("07", "c8", "exec_command", { cmd: "python3 - <<'PY'\nimport json\nprint(check())\nPY" }) + cout("07", "c8", running(10, "checking\n")) +
    ccall("08", "c9", "exec_command", { cmd: "ls" }) + cout("08", "c9", exited(0, "a")) +
    ccall("09", "c10", "write_stdin", { session_id: 10, chars: "" }) + cout("09", "c10", exited(2, "boom\n")) +
    // a server stopped with ^C
    ccall("10", "c11", "exec_command", { cmd: "npm run dev" }) + cout("10", "c11", running(11, "listening\n")) +
    ccall("11", "c12", "update_plan", { plan: [] }) + cout("11", "c12", "ok") +
    ccall("12", "c13", "write_stdin", { session_id: 11, chars: "\u0003" }) + cout("12", "c13", exited(130)));
  const db = join(chome, "state_5.sqlite"), at = Math.floor(Date.parse(cts("12")) / 1000);
  execFileSync("python3", ["-I", "-c", `import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
con.execute("create table threads (id text, rollout_path text, cwd text, updated_at integer, first_user_message text)")
con.execute("insert into threads values (?,?,?,?,?)", ("${TH}", sys.argv[2], sys.argv[4], ${at}, "fix the build"))
con.execute("insert into threads values (?,?,?,?,?)", ("helper", sys.argv[3], sys.argv[4], ${at + 5}, "<hc task>"))
con.commit()`, db, log, helper, repo]);
  return { home, repo, run, log };
}

test("codex adapter: finds the main agent's thread and reads the processes it went on beside", () => {
  const { home, repo, run } = codexFixture();
  const o = bg(home, bgRequest([{ dir: run, repo, startedAt: Date.parse(cts("00")), mains: [{ agent: "codex", session: null }] }]));
  assert.deepEqual(o.runs[run], [TH]);
  const tasks = o.sessions[TH];
  assert.deepEqual(tasks.map((t) => [t.id, t.agent, t.kind, t.status, t.summary]), [
    ["codex-c2", "codex", "shell", "completed", null],
    ["codex-c7", "codex", "wait", "running", null],
    ["codex-c8", "codex", "shell", "failed", "退出码 2"],
    ["codex-c11", "codex", "shell", "killed", "退出码 130"],
  ]);
  const [build, , heredoc] = tasks;
  assert.deepEqual([build.title, build.started, build.ended, build.output], ["npm run build", Date.parse(cts("01")), Date.parse(cts("03")), null]);
  assert.deepEqual(build.tail, ["step 2", "done"]);
  assert.equal(build.log, "step 1\nstep 2\ndone\n");
  assert.equal(heredoc.title, "python3 - <<'PY' · print(check())");
});

test("codex adapter: a recorded thread needs no search; appended polls end its tasks", () => {
  const { home, run, log } = codexFixture();
  const req = { runs: [{ dir: run, agent: "codex", session: TH, cwd: null, since: 0 }] };
  assert.equal(bg(home, req).sessions[TH].find((t) => t.id === "codex-c7").status, "running");
  appendFileSync(log, ccall("20", "c20", "write_stdin", { session_id: 9, chars: "" }) + cout("20", "c20", "write_stdin failed: Unknown process id 9"));
  const w = bg(home, req).sessions[TH].find((t) => t.id === "codex-c7");
  assert.deepEqual([w.status, w.ended], ["lost", Date.parse(cts("20"))]);
});

test("bg script: a program without an adapter is skipped", () => {
  const { home, run } = fixture();
  assert.deepEqual(bg(home, { runs: [{ dir: run, agent: "aider", session: "x", cwd: null, since: 0 }] }), { runs: { [run]: [] }, sessions: {} });
});
