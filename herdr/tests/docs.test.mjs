import { test } from "node:test";
import assert from "node:assert/strict";
import { wordTone, parseDiff, resultDoc, splitHeadings, eventTone, taskDoc } from "../cc-dispatch/mods/cc-dispatch/model.js";

const call = (extra = {}) => ({ call: "W-1", report: "ok", reportPath: "/tmp/r.json", schema: "/s.json", round: 2, mode: "write", effort: "high", ...extra });

test("wordTone reads verdict and severity words", () => {
  assert.equal(wordTone("LGTM"), "ok");
  assert.equal(wordTone("FAIL"), "bad");
  assert.equal(wordTone("ISSUES"), "warn");
  assert.equal(wordTone("minor"), "muted");
  assert.equal(wordTone("something else"), null);
});

test("parseDiff sorts files into kinds and reads the stat", () => {
  const d = parseDiff("## wt-a @ /w\n M a.js\nA  b.js\n?? c.md\nUU d.js\n\n a.js | 4 +++-\n b.js | 2 ++\n 2 files changed, 5 insertions(+), 1 deletion(-)");
  assert.equal(d.head, "wt-a @ /w");
  assert.deepEqual(d.files.map((f) => f.kind), ["modified", "added", "untracked", "conflict"]);
  assert.deepEqual(d.stat[0], { path: "a.js", n: 4, plus: 3, minus: 1 });
  assert.match(d.total, /2 files changed/);
});

test("resultDoc leads with the verdict, then a node per field, then the worktree changes", () => {
  const text = JSON.stringify({ verdict: "ISSUES", summary: "two problems", findings: [{ title: "x", severity: "high" }, { title: "y", severity: "low" }] });
  const doc = resultDoc(call(), text, ["/tmp/report.r1.json"], "## b @ /w\n?? n.md\n");
  const [over, findings, changes] = doc.nodes;
  assert.equal(over.blocks[0].t, "lead");
  assert.equal(over.blocks[0].tone, "warn");
  assert.equal(over.blocks[0].short, true);
  assert.equal(over.blocks[1].text, "two problems");
  assert.equal(findings.children.length, 2);
  assert.equal(findings.tone, "bad");
  assert.equal(changes.title, "工作树里的改动");
  assert.equal(changes.children[0].badge, "未跟踪 1");
});

test("resultDoc without a report says so", () => {
  const doc = resultDoc(call({ report: "missing" }), null);
  assert.equal(doc.nodes.length, 1);
  assert.equal(doc.nodes[0].tone, "bad");
});

test("splitHeadings ignores headings inside code fences", () => {
  const s = splitHeadings("intro\n# A\none\n```\n# not\n```\n## B\ntwo");
  assert.equal(s.preface, "intro");
  assert.deepEqual(s.sections.map((x) => [x.title, x.level]), [["A", 1], ["B", 2]]);
});

test("eventTone: an exited helper with a good report is fine, blocked waits", () => {
  assert.equal(eventTone({ ev: "settle", report: "ok", failure: "exited" }), "ok");
  assert.equal(eventTone({ ev: "settle", report: "ok", failure: "blocked" }), "warn");
  assert.equal(eventTone({ ev: "settle", report: "bad" }), "bad");
  assert.equal(eventTone({ ev: "dispatch" }), "accent");
});

test("taskDoc groups events and task files by round, newest first", () => {
  const ev = [
    { ev: "dispatch", round: 1, t: 100, title: "T" },
    { ev: "settle", round: 1, t: 200, report: "ok" },
    { ev: "send", round: 2, t: 300 },
  ].map((e) => JSON.stringify(e)).join("\n");
  const doc = taskDoc(call({ failure: "exited" }), ev, { 1: "# Task\n## Goal\ng\n### Detail\nd", 2: "plain" });
  assert.deepEqual(doc.nodes.map((n) => n.title), ["概览", "第 2 轮 · 返工", "第 1 轮 · 首次派发"]);
  const failure = doc.nodes[0].blocks[0].rows.find((r) => r.k === "失败");
  assert.equal(failure.tone, "muted");
  const r2 = doc.nodes[1], r1 = doc.nodes[2];
  assert.equal(r2.badge, "当前");
  assert.equal(r2.children[0].blocks[0].rows.length, 1);
  assert.deepEqual(r1.children.slice(2).map((x) => [x.title, x.depth]), [["Task", 1], ["Goal", 2], ["Detail", 3]]);
});
