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
  assert.deepEqual([over.blocks[0].label, over.blocks[0].text, findings.title], ["结论", "有问题", "发现"]);
  assert.equal(over.blocks[1].text, "two problems");
  assert.equal(findings.children.length, 2);
  assert.equal(findings.tone, "bad");
  assert.equal(changes.title, "worktree 里的改动");
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

test("panel text keeps technical nouns in English", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  const dir = new URL("../cc-dispatch/mods/cc-dispatch/", import.meta.url);
  // 面板文案里的技术名词保留英文，新交互使用中文说明。
  const banned = { "工作树": "worktree", "会话": "session", "令牌": "token" };
  const hits = readdirSync(dir).filter((f) => f.endsWith(".js")).flatMap((f) =>
    readFileSync(new URL(f, dir), "utf8").split("\n").flatMap((line, i) =>
      Object.keys(banned).filter((w) => line.includes(w)).map((w) => `${f}:${i + 1} 用了「${w}」，改写成 ${banned[w]}`)));
  assert.deepEqual(hits, []);
  const main = readFileSync(new URL("main.js", dir), "utf8");
  for (const word of ["新建 Topic", "新建 Task 草稿", "派发 Task", "当前主 agent", "主 agent 已离线",
    "已排队", "已送达", "改派…", "撤销", "重发", "细化中", "已细化", "摘要", "受影响的 Task", "个 agent 在干活", "项等你"]) {
    assert.ok(main.includes(word), `面板缺少中文文案：${word}`);
  }
  assert.doesNotMatch(main, /renderRun\b|renderGroups\b|还没有子 agent|no helper yet|Needs you/);
});

test("panel toggle and header are named Dispatch", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8");
  // 插件名保留英文 Dispatch：右上角开关和面板标题都用它，不译成“派发”。
  assert.equal(main.match(/\.child\("Dispatch"\)/g)?.length, 2, "开关和面板标题都应写 .child(\"Dispatch\")");
  assert.doesNotMatch(main, /\.child\("派发"\)/);
});

test("a Task is one row: agent icon before the name, no id or extra caption", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8");
  // Task 行只放主 agent 图标、职责、名称、状态和控制按钮；任务编号和说明文字不上行。
  assert.doesNotMatch(main, /控制这个 Task/, "控制按钮放在 Task 名称同一行，不另起一行写说明");
  assert.doesNotMatch(main, /\.child\(task\.id\)/, "Task 行不显示任务编号（如 k1）");
  assert.match(main, /\.when\(Boolean\(executor\), \(el\) => el\.child\(executor\)\)\s*\.child\(pill\(t, task\.kind\)\)/, "主 agent 图标放在 Task 名称前面");
  assert.match(main, /\.child\(termDot\(t, c\)\)\s*\.children\(\[this\.renderExecutor\(t, c\.agent/, "卡片的 agent 图标放在卡片名称前面");
});

test("Task status is an icon after the title; no group bars or status words under the Topic", async () => {
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8");
  // 状态用图标紧跟标题（勾、叉、中间态各有图标），不再用文字标签；Topic 下不再有“已完成 1”和分组状态栏。
  assert.doesNotMatch(main, /stageTagText|GROUP_WORDS|id\(`tasks-\$\{key\}`\)/, "去掉了文字状态标签、Topic 下的状态汇总和分组状态栏");
  assert.match(main, /\.child\(task\.title\)\)\s*\.children\(\[statusMark\(/, "Task 状态图标紧跟标题");
  assert.match(main, /\.child\(callLabel\(c\)\)\)\s*\.when\(tagged, \(el\) => el\.children\(\[statusMark\(/, "卡片状态图标紧跟名称");
  assert.match(main, /renderActions\(t, c, inset\)/, "卡片展开后的内容和卡片行同一缩进");
});
