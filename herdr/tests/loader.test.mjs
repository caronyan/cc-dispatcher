import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findRepo, loadRuns, loadReport, loadTask, loadDiff, earlierReports, handOver } from "../cc-dispatch/mods/cc-dispatch/loader.js";

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
