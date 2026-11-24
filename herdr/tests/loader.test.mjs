import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, loadRuns, loadReport, loadTask, loadDiff, earlierReports, handOver, topicCmd, loadSummary } from "../cc-dispatch/mods/cc-dispatch/loader.js";
import { TOPIC_SCRIPT } from "../cc-dispatch/mods/cc-dispatch/model.js";

// The same I/O main.js gives the loader, on a real shell.
const io = {
  sh: async (script, args = []) => {
    const r = spawnSync("sh", ["-c", script, "cc-dispatch-panel", ...args], { encoding: "utf8" });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  },
  readText: async (p) => (existsSync(p) ? readFileSync(p, "utf8") : null),
};

function fixture() {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "ccd-")));
  execFileSync("git", ["init", "-q", repo]);
  const run = join(repo, ".cc-dispatch", "review-0107");
  const agent = join(run, "agents", "a");
  mkdirSync(agent, { recursive: true });
  const report = join(repo, "report.json");
  writeFileSync(join(agent, "meta.json"), JSON.stringify({ call: "a", name: "review-a", mode: "read", effort: "high",
    dir: repo, round: 2, report, agent_dir: agent, started_at: 1, report_check: "ok" }));
  writeFileSync(join(agent, "task-2.md"), "# 任务 a（第 2 轮）\n");
  writeFileSync(report, '{"ok":true}');
  writeFileSync(join(repo, "report.r1.json"), "{}");
  return { repo, run };
}

test("findRepo gives the git top level, or the folder", async () => {
  const { repo } = fixture();
  mkdirSync(join(repo, "sub"));
  assert.equal(await findRepo(io, join(repo, "sub")), repo);
  const plain = realpathSync(mkdtempSync(join(tmpdir(), "ccd-plain-")));
  assert.equal(await findRepo(io, plain), plain);
  assert.equal(await findRepo(io, ""), null);
});

test("loadRuns reads the repo's runs and the ones live helpers point at", async () => {
  const { repo, run } = fixture();
  const other = fixture();
  const { runs, error } = await loadRuns(io, repo, [{ address: "t5", state: "live", status: "working", name: "review-a",
    labels: { "cc.dir": other.run } }]);
  assert.equal(error, null);
  assert.deepEqual(runs.map((r) => r.dir).sort(), [run, other.run].sort());
  const empty = realpathSync(mkdtempSync(join(tmpdir(), "ccd-empty-")));
  assert.deepEqual((await loadRuns(io, empty, [])).runs, []);
});

test("report, task, earlier rounds and diff", async () => {
  const { repo } = fixture();
  const { runs } = await loadRuns(io, repo, []);
  const c = runs[0].calls[0];
  assert.deepEqual(await loadReport(io, c), { text: '{\n  "ok": true\n}', exists: true, path: c.reportPath });
  assert.deepEqual(await loadReport(io, { ...c, reportPath: join(repo, "none.json") }), { text: null, exists: false, path: null });
  assert.match(await loadTask(io, c), /第 2 轮/);
  assert.deepEqual(await earlierReports(io, c), [join(repo, "report.r1.json")]);
});

test("reports gone from /tmp are read from the run folder's copies", async () => {
  const { repo } = fixture();
  const c = (await loadRuns(io, repo, [])).runs[0].calls[0];
  const gone = { ...c, reportPath: join(repo, "gone", "report.json") };
  writeFileSync(join(c.agentDir, "report-r2.json"), '{"kept":1}');
  writeFileSync(join(c.agentDir, "report-r1.json"), "{}");
  assert.deepEqual(await loadReport(io, gone), { text: '{\n  "kept": 1\n}', exists: true, path: join(c.agentDir, "report-r2.json") });
  assert.deepEqual(await earlierReports(io, gone), [join(c.agentDir, "report-r1.json")]);
  assert.deepEqual(await earlierReports(io, c), [join(repo, "report.r1.json")]);
  writeFileSync(join(repo, "new.txt"), "x");
  assert.match(await loadDiff(io, c), /\?\? new\.txt/);
});

test("handOver runs hd_dispatch.py handover in the background and logs beside the call", async () => {
  const home = mkdtempSync(join(tmpdir(), "cc-handover-"));
  const bin = join(home, "bin"), run = join(home, "run");
  mkdirSync(bin); mkdirSync(join(run, "agents/T1"), { recursive: true });
  writeFileSync(join(bin, "hc"), "#!/bin/sh\n", { mode: 0o755 });
  const hd = join(home, "hd_dispatch.py");
  writeFileSync(hd, "import sys, json\nprint(json.dumps(sys.argv[1:]))\n");
  const sh = async (script, args) => {
    const r = spawnSync("sh", ["-c", script, "sh", ...args], { encoding: "utf8", env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` } });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const r = await handOver({ sh }, { dir: run, hd }, { call: "T1" }, "claude");
  assert.ok(r.ok, r.text);
  const log = join(run, "agents/T1/handover.log");
  for (let i = 0; i < 50 && !(existsSync(log) && readFileSync(log, "utf8")); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(JSON.parse(readFileSync(log, "utf8")), ["handover", "--run", run, "--call", "T1", "--to", "claude", "--why", "manual", "--notify"]);
});

test("loadRuns scans Topic drafts, bound runs without helpers and corrupt files without losing old runs", async () => {
  const { repo, run } = fixture();
  const dir = join(repo, ".cc-dispatch/topics/topic-a"), draft = join(repo, ".cc-dispatch/topics/draft");
  const stateRun = join(repo, ".cc-dispatch/test-child"), broken = join(repo, ".cc-dispatch/dev-broken");
  for (const path of [dir, draft, stateRun, broken]) mkdirSync(path, { recursive: true });
  writeFileSync(join(dir, "topic.json"), JSON.stringify({
    id: "topic-a", title: "Parent", created_at: 1, tasks: {
      k1: { title: "Parent", kind: "review", run: "review-0107" },
      k2: { title: "Child", kind: "test", run: "test-child", parent_task: "k1" },
    },
  }));
  writeFileSync(join(dir, "backlog.json"), JSON.stringify({ items: [{ id: "b1", text: "Idea", created_at: 3 }] }));
  writeFileSync(join(draft, "topic.json"), JSON.stringify({ id: "draft", title: "Draft", created_at: 2, tasks: {} }));
  writeFileSync(join(draft, "backlog.json"), "{broken");
  writeFileSync(join(run, "state.json"), JSON.stringify({ topic: "topic-a", task: "k1", finished: 5 }));
  writeFileSync(join(stateRun, "state.json"), JSON.stringify({ topic: "topic-a", task: "k2" }));
  writeFileSync(join(broken, "state.json"), "{broken");
  mkdirSync(join(repo, ".cc-dispatch/topics/broken"));
  writeFileSync(join(repo, ".cc-dispatch/topics/broken/topic.json"), "{broken");
  const loaded = await loadRuns(io, repo, []);
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.runs.map((r) => r.dir).sort(), [run, stateRun].sort());
  assert.deepEqual(loaded.states[run], { topic: "topic-a", task: "k1", finished: 5 });
  assert.deepEqual(loaded.topics.map((t) => t.id).sort(), ["draft", "topic-a"]);
  const topic = loaded.topics.find((t) => t.id === "topic-a");
  assert.equal(topic.tasks[0].group, "done");
  assert.equal(topic.tasks[1].run.dir, stateRun);
  assert.equal(topic.tasks[1].group, "active");
  assert.equal(topic.backlog[0].createdAt, 3000);
  assert.deepEqual(loaded.topics.find((t) => t.id === "draft").backlog, []);
});

test("loadRuns exposes consistent Topic data when no roots exist or scanning fails", async () => {
  assert.deepEqual(await loadRuns(io, null, []), { runs: [], topics: [], states: {}, error: null });
  const failed = await loadRuns({ sh: async () => ({ code: 1, stdout: "", stderr: "failed" }) }, "/repo", []);
  assert.deepEqual(failed, { runs: [], topics: [], states: {}, error: "failed" });
});

test("topicCmd passes each literal argument to sh and returns command output and code", async () => {
  const args = ["topic", "task-add", "--title", '中文\n"quoted" \'single\' $(touch /nope) `echo nope`', "--detail", "a\nb"];
  const calls = [];
  const r = await topicCmd({ sh: async (...call) => {
    calls.push(call);
    return { code: 3, stdout: "reason\n", stderr: "FAILURE=TOPIC_PAUSED\n" };
  } }, "/path with spaces/hd.py", args);
  assert.deepEqual(calls, [[TOPIC_SCRIPT, ["/path with spaces/hd.py", ...args]]]);
  assert.deepEqual(r, { ok: false, out: "reason\n\nFAILURE=TOPIC_PAUSED", code: 3 });
});

test("topicCmd's real shell preserves Chinese, multiline, quotes, substitutions and backticks as argv", async () => {
  const home = mkdtempSync(join(tmpdir(), "cc-topic-argv-"));
  const hd = join(home, "hd dispatch.py"), marker = join(home, "injected");
  writeFileSync(hd, "import json, sys\nprint(json.dumps(sys.argv[1:], ensure_ascii=False))\n");
  const text = `中文\n"double" 'single' $(touch "${marker}") \`touch "${marker}"\` \\ literal`;
  const args = ["topic", "task-add", "--title", text, "--detail", `${text}\nsecond line`, "--repo", home];
  const result = await topicCmd(io, hd, args);
  assert.equal(result.ok, true, result.out);
  assert.equal(result.code, 0);
  assert.deepEqual(JSON.parse(result.out), args);
  assert.equal(existsSync(marker), false);
});

test("topicCmd finds an installed hd_dispatch.py without requiring hc", async () => {
  const home = mkdtempSync(join(tmpdir(), "cc-topic-fallback-"));
  const scripts = join(home, ".claude/skills/cc-herdr-dispatch-dev/shared/scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "hd_dispatch.py"), "import json, sys\nprint(json.dumps(sys.argv[1:]))\n");
  const sh = async (script, args) => {
    const res = spawnSync("sh", ["-c", script, "sh", ...args], { encoding: "utf8", env: { ...process.env, HOME: home } });
    return { code: res.status, stdout: res.stdout, stderr: res.stderr };
  };
  const args = ["topic", "init", "--title", "Draft", "--repo", home];
  assert.deepEqual(JSON.parse((await topicCmd({ sh }, "/missing/hd_dispatch.py", args)).out), args);
});

test("topicCmd stop launches hd_dispatch.py through nohup in the background", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-topic-stop-")), hd = join(dir, "hd.py"), output = join(dir, "argv.json");
  writeFileSync(hd, "import json, sys, time\nfrom pathlib import Path\ntime.sleep(0.2)\nPath(sys.argv[-1]).write_text(json.dumps(sys.argv[1:]))\n");
  const args = ["topic", "stop", "--topic", "topic-a", "--repo", output];
  const result = await topicCmd(io, hd, args);
  assert.deepEqual(result, { ok: true, out: "STOP_STARTED=1", code: 0 });
  for (let i = 0; i < 50 && !(existsSync(output) && readFileSync(output, "utf8")); i++) await new Promise((ok) => setTimeout(ok, 50));
  assert.deepEqual(JSON.parse(readFileSync(output, "utf8")), args);
});

test("loadSummary reads scanned explicit summaries including empty drafts, and historical documents in order", async () => {
  const { repo, run } = fixture(), dir = join(repo, ".cc-dispatch/topics/draft");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "topic.json"), JSON.stringify({ id: "draft", title: "Draft", tasks: {} }));
  writeFileSync(join(dir, "research.md"), "Do not read this for an explicit Topic");
  let { topics } = await loadRuns(io, repo, []);
  const explicit = topics.find((t) => t.id === "draft"), implicit = topics.find((t) => t.implicit);
  assert.equal(await loadSummary(io, explicit), null);
  writeFileSync(join(dir, "summary.md"), "");
  assert.equal(await loadSummary(io, explicit), "");
  writeFileSync(join(dir, "summary.md"), "## k1\n结论\n");
  assert.equal(await loadSummary(io, explicit), "## k1\n结论\n");
  assert.equal(await loadSummary(io, implicit), null);
  writeFileSync(join(run, "log.md"), "Log");
  assert.equal(await loadSummary(io, implicit), "Log");
  writeFileSync(join(run, "result.md"), "Result");
  assert.equal(await loadSummary(io, implicit), "Result");
  writeFileSync(join(run, "research.md"), "Research");
  assert.equal(await loadSummary(io, implicit), "Research");
});
