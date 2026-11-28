import { test } from "node:test";
import assert from "node:assert/strict";
import * as bgModule from "../cc-dispatch/mods/cc-dispatch/bg.js";
import * as statsModule from "../cc-dispatch/mods/cc-dispatch/stats.js";
import {
  orderTopics, runCards,
  SEP, parseMetaDump, runDirOf, repoOf, kindOf, runRoots, buildCall, callNeed, buildRuns,
  summary, callDetail, runSpace, splitBySpace, callStage, runStage, stageSummary, groupByStage, SETTLED, cardCounts, ago, handoffAsk, handoffText, prettyReport, taskPath, timelineMarkdown, eventWords,
  CONTROL_SEP, parseControls, controlOps, controlBanner, quotaAgent, runQuotaAgent, quotaView, runParent, activeRuns, callTags,
  ARCHIVE_SEP, parseArchived, canArchive, archivedAway, cardView, parkedWhy, handoffAsks,
  agentIn, mainLive, needsTakeover, takeoverPrompt, takeoverBanner, skillOf,
  ASKS_SEP, ANSWERS_SEP, parseAsks, pendingItems, itemLine, answerRecord, answerText, LIST_SCRIPT,
  TOPIC_SEP, BACKLOG_SEP, STATE_SEP, parseTopics, parseStates, buildTopics, taskGroup, timelineTasks, taskSource, taskFollowers, nextSteps, nextDraft, requestState,
} from "../cc-dispatch/mods/cc-dispatch/model.js";

const RUN = "/r/.cc-dispatch/review-0107";
const meta = (call, extra = {}) => ({ call, name: `review-${call}`, mode: "read", effort: "high", dir: "/r", round: 1,
  report: `/tmp/cc-dispatch/h1/${call}/report.json`, schema: "/s.json", agent_dir: `${RUN}/agents/${call}`, started_at: 100, ...extra });
const dump = (...pairs) => pairs.map(([p, m]) => `\n${SEP}${p}\n${JSON.stringify(m)}`).join("");
const section = (sep, path, value) => `\n${sep}${path}\n${JSON.stringify(value)}`;
const topicRecord = (tasks = {}, extra = {}) => ({
  topic: { id: "topic-a", title: "Topic", created_at: 10, tasks, ...extra },
  backlog: { items: [] },
});

test("a run without helpers takes its main agent, session and start from its Topic binding", () => {
  const { topic } = topicRecord({ k1: { title: "T", kind: "review", run: "review-0107", agent: "claude-code", session: "s1", started_at: 100 } });
  const topics = parseTopics(section(TOPIC_SEP, "/r/.cc-dispatch/topics/topic-a/topic.json", topic));
  const terms = [{ address: "t-main", state: "live" }];
  const [run] = buildRuns([], terms, { [RUN]: { state: "running", owner: "t-main" } }, {}, {}, { [RUN]: {} }, topics);
  assert.deepEqual([run.parent, run.startedAt, run.lastAt, run.mains, run.live],
    ["t-main", 100_000, 100_000, [{ agent: "claude", session: "s1" }], true]);
});

test("Topic and state sections preserve the existing parsers, including when old sections are absent", () => {
  const { topic } = topicRecord();
  const topics = section(TOPIC_SEP, "/r/.cc-dispatch/topics/topic-a/topic.json", topic)
    + section(BACKLOG_SEP, "/r/.cc-dispatch/topics/topic-a/backlog.json", { items: [{ id: "b1", text: "idea" }] })
    + `\n${TOPIC_SEP}/r/.cc-dispatch/topics/broken/topic.json\n{broken`
    + section(STATE_SEP, `${RUN}/state.json`, { topic: topic.id, task: "k1" })
    + `\n${STATE_SEP}/r/.cc-dispatch/broken/state.json\n{broken`
    + section(STATE_SEP, "/r/.cc-dispatch/array/state.json", []);
  const old = section(ASKS_SEP, `${RUN}/asks.json`, { q: { kind: "question", title: "Pick" } })
    + section(ANSWERS_SEP, `${RUN}/answers.jsonl`, { id: "q", at: 5, text: "yes" })
    + `\n${ARCHIVE_SEP}${RUN}/archived\n12`
    + section(CONTROL_SEP, `${RUN}/control.json`, { state: "paused" })
    + dump([`${RUN}/agents/a/meta.json`, meta("a")]);
  for (const parse of [parseAsks, parseArchived, parseControls, parseMetaDump]) {
    assert.deepEqual(parse(old + topics), parse(old));
    assert.deepEqual(parse(topics), parse(""));
  }
  assert.deepEqual(parseTopics(topics), { [topic.id]: { topic, backlog: { items: [{ id: "b1", text: "idea" }] } } });
  assert.deepEqual(parseStates(topics), { [RUN]: { topic: topic.id, task: "k1" } });
  const onlyAsk = section(ASKS_SEP, `${RUN}/asks.json`, { q: { kind: "question", title: "Pick" } });
  assert.deepEqual(parseAsks(onlyAsk + topics), parseAsks(onlyAsk));
  const onlyControl = section(CONTROL_SEP, `${RUN}/control.json`, { state: "paused" });
  assert.deepEqual(parseControls(onlyControl + topics), parseControls(onlyControl));
});

test("buildTopics binds parent and child runs to independent Tasks, preserves drafts and wraps history", () => {
  const child = "/r/.cc-dispatch/test-child", old = "/r/.cc-dispatch/fix-old", stale = "/r/.cc-dispatch/dev-stale";
  const states = {
    [RUN]: { topic: "topic-a", task: "wrong-hint" }, [child]: { topic: "topic-a", task: "k2" },
    [old]: { title: "修复负数" }, [stale]: { topic: "missing", task: "k1" },
  };
  const runs = buildRuns([], [], {}, { [old]: 4000 }, {}, states);
  const request = { id: "r123456", type: "dispatch", target: "owner", agent: "codex", at: 11, delivered_at: 12 };
  const input = topicRecord({
    k1: { title: "Parent", kind: "dev", run: "review-0107", created_at: 10, started_at: 11 },
    k2: { title: "Child", kind: "test", run: "test-child", parent_task: "k1", created_at: 12 },
    k3: { title: "Draft", kind: "research", detail: "lines\nhere", depends_on: ["k2"], from_backlog: "b1", request, created_at: 13 },
  }, { archived: 30, paused_at: 25, deleting: 26, owner: { terminal: "t1" } });
  input.backlog.items.push({ id: "b1", text: "Idea", status: "refining", request, task_ids: ["k3"], created_at: 9, updated_at: 14 });
  const topics = buildTopics(runs, { "topic-a": input, empty: topicRecord({}, { id: "empty", title: "No runs" }) }, states);
  const topic = topics.find((t) => t.id === "topic-a");
  assert.equal(topic.implicit, false);
  assert.deepEqual(topic.runs.map((r) => r.dir), [RUN, child]);
  assert.equal(topic.tasks[0].run, runs.find((r) => r.dir === RUN));
  assert.equal(topic.tasks[0].runDir, RUN);
  assert.equal(topic.tasks[1].parentTask, "k1");
  assert.equal(topic.tasks[2].group, "queued");
  assert.deepEqual(topic.tasks[2].dependsOn, ["k2"]);
  assert.equal(topic.tasks[2].fromBacklog, "b1");
  assert.equal(topic.tasks[2].detail, "lines\nhere");
  assert.equal(topic.tasks[0].startedAt, 11000);
  assert.deepEqual(topic.tasks[2].request, { id: "r123456", type: "dispatch", target: "owner", agent: "codex", at: 11000, deliveredAt: 12000 });
  assert.equal(topic.backlog[0].updatedAt, 14000);
  assert.deepEqual(topic.backlog[0].taskIds, ["k3"]);
  assert.deepEqual([topic.archived, topic.pausedAt, topic.deleting, topic.updatedAt], [30000, 25000, true, 30000]);
  assert.deepEqual(topics.find((t) => t.id === "empty").runs, []);
  const history = topics.find((t) => t.id === "run:fix-old");
  assert.deepEqual([history.implicit, history.archived, history.tasks[0].id, history.tasks[0].kind], [true, 4000, "k1", "fix"]);
  assert.deepEqual(history.backlog, []);
  // A run from before Topics is wrapped as Topic → Task; the Task names what the run is about, not its directory again.
  assert.deepEqual([history.title, history.tasks[0].title], ["fix-old", "修复负数"]);
  assert.equal(topics.find((t) => t.id === "run:dev-stale").tasks[0].title, "dev-stale");
  assert.ok(topics.some((t) => t.id === "run:dev-stale"));
  assert.equal(topics.length, 4);
});

test("a state Topic hint cannot claim a run bound to another directory in topic.json", () => {
  const runs = buildRuns([], [], {}, {}, {}, { [RUN]: {} });
  const topics = buildTopics(runs, { a: topicRecord({ k1: { run: "other", kind: "dev" } }) }, { [RUN]: { topic: "topic-a" } });
  assert.equal(topics.find((t) => t.id === "topic-a").tasks[0].run, null);
  assert.ok(topics.some((t) => t.id === "run:review-0107"));
});

test("a run whose state.json lost its Topic copy stays under the Task topic.json binds it to", () => {
  const runs = buildRuns([], [], {}, {}, {}, { [RUN]: { mode: "review" } });
  const topics = buildTopics(runs, { a: topicRecord({ k1: { run: "review-0107", kind: "review" } }) }, { [RUN]: { mode: "review" } });
  assert.equal(topics.find((t) => t.id === "topic-a").tasks[0].run?.dir, RUN, "Task 归属以 topic.json 为准");
  assert.ok(!topics.some((t) => t.id === "run:review-0107"), "不再另成一个 Topic");
});

function groupedTask({ state = {}, control = null, call = {}, terms = [], task = {}, asks = {}, answers = [], implicit = false } = {}) {
  const entries = [{ path: `${RUN}/agents/a/meta.json`, meta: meta("a", { parent: "t-main", report_check: "ok", ...call }) }];
  const runs = buildRuns(entries, terms, control ? { [RUN]: control } : {}, {}, { [RUN]: { asks, answers } });
  const topics = buildTopics(runs, implicit ? {} : { a: topicRecord({ k1: { run: "review-0107", kind: "dev", ...task } }) },
    { [RUN]: { ...state, ...(implicit ? {} : { topic: "topic-a" }) } });
  return { topic: topics[0], task: topics[0].tasks[0] };
}

test("taskGroup keeps explicit Tasks active until finish, and infers completion only for inactive history", () => {
  const explicit = groupedTask();
  assert.equal(explicit.task.group, "active");
  assert.equal(taskGroup(explicit.task, explicit.topic), "active");
  assert.equal(groupedTask({ implicit: true }).task.group, "done");
  const terms = [{ address: "t-main", state: "live", program: { key: "claude-code" } }];
  assert.equal(groupedTask({ implicit: true, terms }).task.group, "active");
  for (const options of [{ task: { finished_at: 15 } }, { state: { finished: 16 } },
    { control: { state: "stopped" } }, { control: { state: "running", retired: 17 } }]) {
    assert.equal(groupedTask(options).task.group, "done", JSON.stringify(options));
  }
  assert.equal(taskGroup({ run: null, runDir: null }, {}), "queued");
});

test("taskGroup puts unanswered questions, helper trouble, pauses, handoffs and takeover in you", () => {
  const asks = { q: { kind: "question", title: "Choose", asked: 10 } };
  assert.equal(groupedTask({ asks, task: { finished_at: 20 } }).task.group, "you");
  assert.equal(groupedTask({ asks, answers: [{ id: "q", at: 9, text: "old" }] }).task.group, "you");
  assert.equal(groupedTask({ asks, answers: [{ id: "q", at: 11, text: "yes" }] }).task.group, "active");
  for (const control of [{ state: "paused", held: [] }, { state: "handoff" }]) {
    assert.equal(groupedTask({ control }).task.group, "you");
  }
  for (const call of [
    { address: "t-helper", report_check: null },
    { open: true, report_check: null },
    { failure: "quota" },
    { report_check: "bad" },
  ]) {
    assert.equal(groupedTask({ call, terms: [{ address: "t-helper", state: "live", status: "blocked" }] }).task.group, "you");
  }
  assert.equal(groupedTask({ state: { pending_decisions: { api: "Pick API" } } }).task.group, "you");
  assert.equal(groupedTask({ state: { tasks: { T2: { status: "parked", parked_why: "user" } } } }).task.group, "you");
  assert.equal(groupedTask({ state: { tasks: { T2: { status: "pending" } } } }).task.group, "you");
  const working = { address: "t-helper", report_check: null };
  const helper = { address: "t-helper", state: "live", status: "working" };
  assert.equal(groupedTask({ call: working, terms: [helper] }).task.group, "you");
  assert.equal(groupedTask({ call: working, terms: [helper, { address: "t-main", state: "live", program: { key: "codex" } }] }).task.group, "active");
});

test("abandoned Tasks keep the reason and finish even when their run still appears active or needs input", () => {
  const reason = "不再继续这个 Task";
  for (const options of [
    { state: { tasks: { a: { status: "running" } } }, call: { address: "t-helper", report_check: null },
      terms: [{ address: "t-helper", state: "live", status: "working" }, { address: "t-main", state: "live", program: { key: "codex" } }] },
    { control: { state: "paused" } },
    { asks: { q: { kind: "question", title: "Choose", asked: 10 } } },
    { state: { pending_decisions: { api: "Pick API" } } },
  ]) {
    const { task, topic } = groupedTask({ ...options, task: { abandoned_at: 200, abandon_reason: reason } });
    assert.equal(task.abandonedAt, 200000);
    assert.equal(task.abandonReason, reason);
    assert.equal(task.finishedAt, null);
    assert.equal(task.group, "done");
    assert.equal(taskGroup(task, topic), "done");
    assert.equal(topic.updatedAt, 200000);
  }
  const { task } = groupedTask();
  assert.equal(task.abandonedAt, null);
  assert.equal(task.abandonReason, null);
  assert.equal(taskGroup({ abandonedAt: 0, runDir: null }, {}), "done");
});

test("a Task stays abandoned when its bound run directory is missing", () => {
  const topics = buildTopics([], { a: topicRecord({
    k1: { run: "dev-missing", abandoned_at: 20, abandon_reason: "运行目录已找不到" },
  }) });
  const topic = topics[0], task = topic.tasks[0];
  assert.equal(task.run, null);
  assert.equal(task.runDir, "dev-missing");
  assert.equal(task.abandonedAt, 20000);
  assert.equal(task.abandonReason, "运行目录已找不到");
  assert.equal(taskGroup(task, topic), "done");
});

test("Task abandonment controls and confirmation follow the command contract", async (t) => {
  const { readFileSync } = await import("node:fs");
  const { default: vm } = await import("node:vm");
  const model = await import("../cc-dispatch/mods/cc-dispatch/model.js");
  const node = () => {
    const target = { attrs: {}, nodes: [] };
    const proxy = new Proxy(target, {
      get: (value, key) => key in value ? value[key] : (...args) => {
        if (key === "id" || key === "tooltip" || key === "on_click") value.attrs[key] = args[0];
        if (key === "child") value.nodes.push(args[0]);
        if (key === "children") value.nodes.push(...args[0]);
        if (key === "when" && args[0]) args[1](proxy);
        return proxy;
      },
    });
    return proxy;
  };
  const elements = (root) => root && typeof root === "object" ? [root, ...root.nodes.flatMap(elements)] : [];
  const texts = (root) => typeof root === "string" ? [root] : root?.nodes.flatMap(texts) ?? [];
  const byId = (root, id) => elements(root).find((el) => el.attrs.id === id);
  const source = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8")
    .replace(/^import .*;\n/gm, "").replace("export default class Dispatch", "class Dispatch");
  const calls = [];
  let response, closed = 0;
  const context = vm.createContext({
    ...model, ...bgModule, ...statsModule, View: class {}, h_flex: node, v_flex: node, div: node, svg: node, image: node,
    settings: () => ({}), agents: () => [], blockProps: () => ({ role: "abandon" }),
    Textarea: { new: node },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    TextareaState: { new: () => ({ text: "", value() { return this.text; }, on() {} }) },
    topicCmd: async (_files, hd, args) => { calls.push({ hd, args: Array.from(args) }); return response; },
  });
  vm.runInContext(`${source}\nglobalThis.TaskView = Dispatch;`, context);
  const colors = { ansi1: "red", accent: "blue", foreground: "white", background: "black" };
  const pending = [], cx = { notify() {}, spawn(fn) { pending.push(fn(cx)); } };
  const close = () => { closed++; };
  const p = { topic: { id: "topic-a" }, task: { id: "k1", title: "卡住的 Task" }, repo: "/r", hd: "/hd.py" };
  const dialog = () => {
    const view = new context.TaskView();
    view.init({}, cx);
    return view;
  };
  const click = async (button) => {
    assert.equal(typeof button?.attrs.on_click, "function");
    button.attrs.on_click({}, cx);
    await Promise.all(pending.splice(0));
  };
  const panel = new context.TaskView();
  Object.assign(panel, {
    fold: new Map(), bgMore: new Map(), programs: [], topics: [], states: {}, stats: { runs: {} },
    controlButtons: () => [], mainAgentOf: () => null, renderControl: () => null,
    renderTakeover: () => null, renderCall: node, itemsOf: () => [{ answer: null }],
  });

  await t.test("a bound unfinished Task whose run is gone offers abandon on its stop square, folded or not", () => {
    const stub = panel.controlButtons;
    panel.controlButtons = context.TaskView.prototype.controlButtons;
    for (const [taskData, topicData, folded, expected] of [
      [{ run: "dev-missing" }, {}, false, true],
      [{ run: "dev-missing" }, {}, true, true],
      [{}, {}, false, false],
      [{ run: "dev-missing", finished_at: 20 }, {}, false, false],
      [{ run: "dev-missing", abandoned_at: 20 }, {}, false, false],
      [{ run: "dev-missing" }, { archived: 20 }, false, false],
      [{ run: "dev-missing" }, { deleting: true }, false, false],
      [{ run: "dev-missing" }, { implicit: true }, false, false],
    ]) {
      const topic = buildTopics([], { a: topicRecord({ k1: taskData }, topicData) })[0];
      if (topicData.implicit) topic.implicit = true;
      panel.fold.set("topic-a|k1", folded);
      const button = byId(panel.renderTask(colors, topic, topic.tasks[0]), "abandon-topic-a|k1");
      assert.equal(Boolean(button), expected, JSON.stringify({ taskData, topicData, folded }));
      if (button) {
        let opened;
        panel.openForm = (...args) => { opened = args; };
        button.attrs.on_click();
        assert.equal(opened[0], "abandon");
        assert.equal(opened[1], topic);
        assert.equal(opened[2].task.id, "k1");
      }
    }
    assert.ok(!byId(panel.renderTask(colors, buildTopics([], { a: topicRecord({ k1: { run: "dev-missing" } }) })[0], buildTopics([], { a: topicRecord({ k1: { run: "dev-missing" } }) })[0].tasks[0]), "abandon-topic-a|k1").nodes.some((x) => x === "放弃"),
      "放弃不再是单独的文字按钮，并入 Task 的终止方块");
    panel.controlButtons = stub;
  });

  await t.test("a finished Task offers next steps; one opens the dispatch dialog with its output, or the draft already written for it", async () => {
    const topic = buildTopics([], { a: topicRecord({
      k1: { kind: "research", title: "调研", run: "research-x", started_at: 30, finished_at: 40, summary_line: "方案定了", artifact: "/r/plan.md" },
    }) })[0];
    const task = topic.tasks[0];
    panel.topicRepo = () => "/r";
    const opened = [];
    panel.openForm = (...args) => opened.push(args);
    panel.fold.delete("topic-a|k1");
    let card = panel.renderTask(colors, topic, task);
    assert.ok(byId(card, "artifact-topic-a|k1"), "最新完成且没人接的 Task 默认展开，能看到产出");
    byId(card, "next-topic-a|k1-review").attrs.on_click({}, cx);
    assert.equal(opened[0][0], "dispatch");
    assert.equal(opened[0][2].next.from, "k1");
    assert.equal(opened[0][2].next.kind, "review");
    assert.match(opened[0][2].next.detail, /^输入：\/r\/plan\.md/);
    byId(card, "next-topic-a|k1-other").attrs.on_click({}, cx);
    assert.equal(opened[1][2].next.from, "k1", "其他…也带着这一步的产出");
    const withDraft = buildTopics([], { a: topicRecord({
      k1: { kind: "research", title: "调研", run: "research-x", started_at: 30, finished_at: 40, artifact: "/r/plan.md" },
      k2: { kind: "review", title: "审查方案", depends_on: ["k1"], created_at: 41 },
    }) })[0];
    panel.fold.set("topic-a|k1", false);
    card = panel.renderTask(colors, withDraft, withDraft.tasks[0]);
    byId(card, "next-topic-a|k1-review").attrs.on_click({}, cx);
    assert.equal(opened[2][2].task.id, "k2", "已有同职责的草稿接在它后面时，派发那个草稿，不重复新建");
    assert.equal(opened[2][2].next, undefined);

    const saved = { blockProps: context.blockProps, agents: context.agents };
    context.agents = () => [{ address: "t1", program: { key: "claude", name: "Claude" } }];
    const next = { from: "k1", ...model.nextDraft(task, "review", "/r/plan.md") };
    const props = { role: "dispatch", topic: { id: "topic-a", owner: { terminal: "t1", agent: "claude" } }, next, repo: "/r", hd: "/hd.py", ownerLive: true };
    context.blockProps = () => props;
    const view = dialog();
    view.titleBox.text = next.title; view.detailBox.text = next.detail;
    calls.length = 0; closed = 0;
    response = { ok: true, out: "TASK=k3" };
    await click(byId(view.renderForm(colors, props, close), "go"));
    const ops = calls.map((c) => c.args[1]);
    assert.deepEqual(ops.filter((op) => op !== "programs"), ["task-add", "request"], "确认后先新建 Task，再派给主 agent");
    const add = calls.find((c) => c.args[1] === "task-add").args;
    assert.ok(add.includes("--depends") && add[add.indexOf("--depends") + 1] === "k1");
    assert.ok(add.includes("review"));
    const req = calls.find((c) => c.args[1] === "request").args;
    assert.equal(req[req.indexOf("--task") + 1], "k3");
    assert.equal(req[req.indexOf("--target") + 1], "owner");
    assert.equal(closed, 1);
    Object.assign(context, saved);
    calls.length = 0; closed = 0;
  });

  await t.test("a Topic shows in the space that started it, whichever repository the panel's folder is in", () => {
    const saved = { spaces: context.spaces, terminals: context.terminals };
    // The NewEra space was made while a flushing terminal had focus, so Herdr gives it flushing's folder.
    context.spaces = () => [{ id: "spN", active: true, folder: "/w/flushing" }, { id: "spF", folder: "/w/cc" }];
    context.terminals = () => [];
    const own = { id: "a1", implicit: false, owner: { space: "spN" }, runs: [], tasks: [], dir: "/w/dsh/.cc-dispatch/topics/a1" };
    const theirs = { id: "b1", implicit: false, owner: { space: "spF" }, runs: [], tasks: [], dir: "/w/flushing/.cc-dispatch/topics/b1" };
    const orphan = { id: "c1", implicit: false, owner: { space: "gone" }, runs: [], tasks: [], dir: "/w/flushing/.cc-dispatch/topics/c1" };
    const recorded = { dir: "/w/flushing/.cc-dispatch/dev-1", repo: "/w/flushing", space: "spF", live: false, calls: [] };
    const unrecorded = { dir: "/w/flushing/.cc-dispatch/dev-0", repo: "/w/flushing", space: null, live: false, calls: [] };
    const old = (r) => ({ id: `run:${r.dir}`, implicit: true, runs: [r], tasks: [] });
    Object.assign(panel, { repo: "/w/flushing", runs: [recorded, unrecorded], topics: [own, theirs, orphan, old(recorded), old(unrecorded)], topicActive: () => false });
    assert.deepEqual(Array.from(panel.split().mine, (x) => x.id), ["a1", "c1"],
      "本空间发起的 Topic 在这里；别的空间的 Topic、记在别的空间的运行、以及同仓库里没记空间的旧运行（随仓库多数归 flushing 空间）都不串过来");
    Object.assign(context, saved);
  });

  await t.test("the summary timeline renders in its own dialog, where the panel's program list is absent", () => {
    const view = new context.TaskView();
    const topic = buildTopics([], { a: topicRecord({
      k1: { kind: "dev", title: "实现", run: "dev-x", agent: "codex", started_at: 30, finished_at: 40, summary_done: "做完了" },
      k2: { kind: "review", title: "审查", agent: "agy", created_at: 5 },
    }) })[0];
    const rendered = view.renderTimeline(colors, model.topicTimeline(topic));
    assert.ok(texts(rendered).includes("k1 · 实现"));
    assert.ok(texts(rendered).includes("做完了"));
  });

  await t.test("status marks use their own icons, which exist, and none borrows the eye that means view", async () => {
    const { readFile, access } = await import("node:fs/promises");
    const dir = new URL("../cc-dispatch/mods/cc-dispatch/", import.meta.url);
    const src = await readFile(new URL("main.js", dir), "utf8");
    const block = src.slice(src.indexOf("const MARKS = {"), src.indexOf("};", src.indexOf("const MARKS = {")));
    const icons = [...block.matchAll(/\[\s*"([\w-]+)"\s*,/g)].map((m) => m[1]);
    assert.ok(icons.length > 10);
    assert.ok(!icons.includes("eye"), "眼睛图标表示“查看”，状态标记不用它");
    for (const name of new Set(icons)) await access(new URL(`icons/${name}.svg`, dir));
  });

  await t.test("text cut short in the panel carries its full text as a tooltip", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8");
    const bare = src.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /\.truncate\(\)/.test(l) && !/\.truncate\(\)\.tooltip\(/.test(l));
    // Fixed short words (stat tiles, buttons, a status line), not names that can run long.
    const fixed = ["需要你处理", "child(value)", "child(label)", "child(item.text.split", "child(`${run.id"];
    const left = bare.filter(([, l]) => !fixed.some((f) => l.includes(f)));
    assert.deepEqual(left, [], "被截断的文字要带 .tooltip(全文)，鼠标悬停时能看到完整内容");
  });

  await t.test("the Task summary lists each card with its status, executor and report conclusion", () => {
    const { topic, task } = groupedTask({ state: { tasks: { a: { status: "merged", title: "卡 A", note: "合入了" }, T9: { status: "pending", title: "还没派" } } } });
    const cards = model.taskCards(task);
    assert.deepEqual(cards.map((c) => c.id), ["a", "T9"]);
    assert.equal(cards[1].stage, "pending");
    const view = new context.TaskView();
    view.reports = { a: model.reportGist({ status: "done", summary: "回报里的结论" }) };
    const body = view.renderTaskSummary(colors, { node: model.topicTimeline(topic)[0], detail: "要做的事", deps: [], cards });
    for (const want of ["说明", "要做的事", "卡片 · 2", "回报：已完成", "回报里的结论", "主 agent 记录：合入了", "还没派"]) assert.ok(texts(body).includes(want), want);
  });

  await t.test("review and stress reports without a summary still give their verdict and findings", () => {
    const review = model.reportGist({ verdict: "ISSUES", findings: [
      { id: "R2", severity: "low", problem: "小问题" }, { id: "R1", severity: "high", problem: "终止不完整\n细节" }] });
    assert.equal(review.verdict, "提出问题");
    assert.deepEqual(review.items, ["R1 [high] 终止不完整", "R2 [low] 小问题"]);
    const stress = model.reportGist({ verdict: "FAILS", cases: Array.from({ length: 7 }, (_, i) => ({ id: `C${i}`, title: `反例${i}` })), retracted: [] });
    assert.equal(stress.verdict, "找到反例");
    assert.equal(stress.items.length, 5);
    assert.equal(stress.more, 2);
    assert.equal(model.reportGist("x"), null);
  });

  await t.test("a run's background tasks render inside its Task, beside the helper rows", () => {
    const { topic, task } = groupedTask();
    panel.fold.set("topic-a|k1", false);
    const bgTask = { id: "b1", session: "s1", kind: "shell", title: "npm test", status: "completed", started: 1000, ended: 5000, output: "/o" };
    const rendered = panel.renderTask(colors, topic, task, { [task.run.dir]: [bgTask] });
    assert.ok(byId(rendered, "bg-topic-a|k1|s1|b1"), "后台任务应显示在所属 Task 里");
    assert.ok(texts(rendered).includes("npm test"));
    assert.ok(texts(rendered).includes("shell cmd"));
    assert.ok(!texts(rendered).some((x) => x.includes("后台")), "标签写 shell cmd，不写“后台命令”");
    const stub = panel.renderCall;
    panel.renderCall = (_t, c) => node().id(`call-${c.key}`);
    const ids = elements(panel.renderTask(colors, topic, task, { [task.run.dir]: [bgTask] })).map((el) => String(el.attrs.id ?? ""));
    panel.renderCall = stub;
    const area = ids.indexOf("bg-topic-a|k1"), firstCall = ids.findIndex((id) => id.startsWith("call-"));
    assert.ok(area >= 0, "后台命令在 Task 里有自己的区域");
    assert.ok(firstCall > area, "后台命令区域在子 agent 行之前，紧跟 Task 标题");
    assert.ok(!byId(panel.renderTask(colors, topic, task, {}), "bg-topic-a|k1|s1|b1"));
  });

  await t.test("a Task whose run has no helper spins only while its main agent works on that run alone", () => {
    const runs = buildRuns([], [], { [RUN]: { state: "running", owner: "t-main" } }, {}, {}, { [RUN]: { topic: "topic-a" } });
    const topic = buildTopics(runs, { a: topicRecord({ k1: { run: "review-0107", kind: "dev" } }) },
      { [RUN]: { topic: "topic-a" } })[0];
    const task = topic.tasks[0];
    const saved = { runs: panel.runs, mainAgentOf: panel.mainAgentOf, agents: context.agents };
    panel.runs = runs; panel.mainAgentOf = context.TaskView.prototype.mainAgentOf;
    try {
      context.agents = () => [{ address: "t-main", status: "idle" }];
      assert.equal(panel.taskStage(topic, task), "idle", "主 agent 空闲时不转圈");
      context.agents = () => [{ address: "t-main", status: "working" }];
      assert.equal(panel.taskStage(topic, task), "working", "主 agent 在忙且只管这一个运行时转圈");
      panel.runs = [...runs, ...buildRuns([], [], { "/r/.cc-dispatch/other": { state: "running", owner: "t-main" } }, {}, {}, { "/r/.cc-dispatch/other": {} })];
      assert.equal(panel.taskStage(topic, task), "idle", "主 agent 同时管着别的运行时，看不出在做哪个，不转圈");
      const rendered = panel.renderTask(colors, topic, task);
      assert.equal(byId(rendered, "mark-topic-a|k1").attrs.tooltip, "等待主 agent");
    } finally {
      panel.runs = saved.runs; panel.mainAgentOf = saved.mainAgentOf; context.agents = saved.agents;
    }
  });

  await t.test("abandoned status overrides stale pause controls and pending items do not block archive", () => {
    const { topic, task } = groupedTask({
      control: { state: "paused" }, task: { abandoned_at: 20, abandon_reason: "不再继续" },
    });
    panel.fold.set("topic-a|k1", false);
    panel.controlButtons = () => assert.fail("已放弃的 Task 不应继续显示运行控制按钮");
    panel.renderControl = () => assert.fail("已放弃的 Task 不应继续显示旧运行控制");
    const rendered = panel.renderTask(colors, topic, task);
    assert.equal(panel.taskStage(topic, task), "abandoned");
    assert.equal(byId(rendered, "mark-topic-a|k1").attrs.tooltip, "已放弃");
    assert.ok(byId(rendered, "tasksum-topic-a|k1"), "Task 行有摘要按钮");
    assert.ok(!texts(rendered).some((x) => /放弃原因|产物：/.test(x)), "说明、放弃原因和产物收进 Task 摘要，不在卡片里");
    assert.equal(model.topicTimeline(topic).find((n) => n.id === "k1").line, "已放弃：不再继续");
    assert.equal(panel.topicActive(topic), false);
    assert.equal(panel.topicControlButtons(colors, topic).length, 0);
    assert.equal(panel.archiveButton(colors, topic)[0].attrs.id, "archive-topic-a");
  });

  await t.test("empty reasons disable confirmation, including after a conflict", () => {
    const view = dialog();
    for (const text of ["", " \n\t "]) {
      view.reasonBox.text = text;
      let rendered = view.renderAbandon(colors, p, close);
      assert.equal(byId(rendered, "go").attrs.on_click, undefined);
      view.failureCode = "HELPERS_AT_WORK";
      rendered = view.renderAbandon(colors, p, close);
      assert.equal(byId(rendered, "force").attrs.on_click, undefined);
    }
    assert.equal(calls.length, 0);
  });

  await t.test("all rejection codes show explanations and only live conflicts offer force", async () => {
    const codes = ["REASON_REQUIRED", "TASK_NOT_BOUND", "TASK_DONE", "TOPIC_DELETING", "HELPERS_AT_WORK", "MAIN_LIVE"];
    for (const code of codes) {
      const view = dialog();
      view.reasonBox.text = "不再继续";
      response = { ok: false, out: `FAILURE=${code}\n运行拒绝了这次操作` };
      await click(byId(view.renderAbandon(colors, p, close), "go"));
      const rendered = view.renderAbandon(colors, p, close);
      assert.equal(view.failureCode, code);
      assert.ok(view.failed.includes("运行拒绝了这次操作"));
      assert.ok(view.failed.length > "运行拒绝了这次操作".length);
      assert.ok(texts(rendered).includes(view.failed));
      assert.equal(Boolean(byId(rendered, "force")), ["HELPERS_AT_WORK", "MAIN_LIVE"].includes(code));
      assert.equal(calls.at(-1).args.includes("--force"), false);
      assert.equal(view.reasonBox.value(), "不再继续");
      assert.equal(view.sending, false);
      assert.equal(closed, 0);
    }
  });

  await t.test("force keeps the reason and closes only after confirmed success", async () => {
    const view = dialog();
    view.reasonBox.text = "  不再继续\n后续工作另开 Task  ";
    response = { ok: false, out: "FAILURE=HELPERS_AT_WORK" };
    await click(byId(view.renderAbandon(colors, p, close), "go"));
    assert.ok(view.failed.includes("子 agent"));
    assert.deepEqual(calls.at(-1), { hd: "/hd.py", args: [
      "topic", "abandon", "--repo", "/r", "--topic", "topic-a", "--task", "k1", "--reason", "不再继续\n后续工作另开 Task",
    ] });
    response = { ok: true, out: "ABANDONED=k1" };
    await click(byId(view.renderAbandon(colors, p, close), "force"));
    assert.deepEqual(calls.at(-1).args, [
      "topic", "abandon", "--repo", "/r", "--topic", "topic-a", "--task", "k1", "--reason", "不再继续\n后续工作另开 Task", "--force",
    ]);
    assert.equal(closed, 1);
    const missingMarker = dialog();
    missingMarker.reasonBox.text = "不再继续";
    response = { ok: true, out: "没有成功标记" };
    await click(byId(missingMarker.renderAbandon(colors, p, close), "go"));
    assert.equal(closed, 1);
    assert.equal(missingMarker.failed, "没有成功标记");
  });

  await t.test("focus moving within the same repo keeps what the panel shows; another repo starts over", async () => {
    let repo = "/r";
    Object.assign(context, {
      findRepo: async () => repo, loadRuns: async () => ({ runs: [], topics: [], states: {}, error: null }), knownRoots: async () => [],
      terminals: () => [], checking: () => true, knownAgents: async () => [],
    });
    const jobs = [], cx2 = { notify() {}, sleep: async () => {}, spawn(fn) { jobs.push(fn(cx2)); } };
    const settle = async () => { while (jobs.length) await Promise.all(jobs.splice(0)); };
    const view = new context.TaskView();
    Object.assign(view, { token: 0, loading: false, place: null, fold: new Map(), groupFold: new Map(), bgMore: new Map() });
    const go = async (folder) => { view.ctx = { on: null, folder }; view.token++; view.loading = false; view.refresh(cx2); await settle(); };
    await go("/r");
    view.open = "run-a"; view.fold.set("topic-a", true);
    await go("/r/.cc-dispatch-wt/peek");  // a dialog or peek took focus, then gave it back
    assert.equal(view.open, "run-a", "关掉弹窗不应清空面板");
    assert.ok(view.fold.get("topic-a"));
    repo = "/other";
    await go("/other");
    assert.equal(view.open, null);
    assert.equal(view.fold.size, 0);
  });

  await t.test("a Task stays running while its main agent's background command runs, and a stats row brings it into view", () => {
    const { topic, task } = groupedTask({ call: { status: "done" } });
    const main = { address: "t-main" };
    const stage = (bgTasks, live = true) => {
      Object.assign(panel, { assigned: { [task.runDir]: bgTasks }, mainAgentOf: () => (live ? main : null), mainWorksOn: () => false });
      return panel.taskStage(topic, task);
    };
    const idle = stage([]);
    assert.notEqual(idle, "working");
    assert.equal(stage([{ status: "running", kind: "shell" }]), "working");
    assert.equal(stage([{ status: "running", kind: "wait" }]), idle, "hd_dispatch.py wait 由子 agent 的状态体现");
    assert.equal(stage([{ status: "completed", kind: "shell" }]), idle);
    assert.equal(stage([{ status: "running", kind: "shell" }], false), idle, "主 agent 不在了，命令已失联");
    panel.mainAgentOf = () => null;

    const scrolled = [], jobs = [], cx3 = { notify() {}, spawn(fn) { jobs.push(fn); } };
    Object.assign(panel, { scroll: { scroll_to_item: (i) => scrolled.push(i) }, anchors: new Map([[`${topic.id}|${task.id}`, 4]]) });
    panel.fold.set(`${topic.id}|${task.id}`, true);
    panel.jumpTo(topic, task, cx3);
    assert.equal(panel.fold.get(`${topic.id}|${task.id}`), false, "跳过去时展开");
    panel.scrollToJump(cx3); panel.scrollToJump(cx3); panel.scrollToJump(cx3);
    assert.deepEqual(scrolled, [4, 4], "先露出末尾，再把开头放到顶上，之后不再滚动");
  });
});

test("Topics are listed running first, then paused, then the rest, with archived last", () => {
  const live = { address: "t-helper", state: "live", status: "working" };
  const topic = (id, extra, tasks = []) => ({ id, archived: null, pausedAt: null, tasks, ...extra });
  const busy = groupedTask({ terms: [live, { address: "t-main", state: "live", program: { key: "codex" } }] }).task;
  assert.equal(busy.group, "active");
  const order = orderTopics([
    topic("done", {}), topic("old-archive", { archived: 1 }), topic("paused", { pausedAt: 5 }, [busy]),
    topic("run", {}, [busy]), topic("new-archive", { archived: 9 }, [busy]),
  ]);
  assert.deepEqual(Object.fromEntries(Object.entries(order).map(([k, v]) => [k, v.map((x) => x.id)])),
    { running: ["run"], paused: ["paused"], ended: ["done"], archived: ["new-archive", "old-archive"] });
});

test("Task grouping ignores survey and review-check entries, and retired runs cannot stay live", () => {
  const tasks = {
    survey: { status: "parked" },
    "T1-check-r1": { status: "parked" },
    marked: { status: "parked", check: true },
  };
  assert.equal(groupedTask({ state: { tasks } }).task.group, "active");
  assert.equal(groupedTask({ state: { tasks }, implicit: true }).task.group, "done");
  const result = groupedTask({
    control: { state: "running", retired: 15 },
    terms: [{ address: "t-main", state: "live", program: { key: "codex" } }],
  });
  assert.equal(result.task.group, "done");
  assert.equal(result.task.run.live, false);
});

test("an implicit parent stays active while a nested child run is live", () => {
  const child = "/r/.cc-dispatch/test-child";
  const runs = buildRuns([
    { path: `${RUN}/agents/a/meta.json`, meta: meta("a", { report_check: "ok" }) },
    { path: `${child}/agents/test/meta.json`, meta: meta("test", { address: "t-child", parent: "t-main" }) },
  ], [{ address: "t-child", state: "live", status: "working" }, { address: "t-main", state: "live", program: { key: "codex" } }]);
  const topics = buildTopics(runs, {}, { [RUN]: { children: ["test-child"] } });
  assert.equal(topics.find((t) => t.id === "run:review-0107").tasks[0].group, "active");
});

test("requestState distinguishes queued from delivered", () => {
  const active = groupedTask().task;
  const queued = { id: "draft", run: null, runDir: null, request: { id: "r1", deliveredAt: null } };
  assert.equal(requestState(active), null);
  assert.equal(requestState(queued), "queued");
  assert.equal(requestState({ request: { deliveredAt: 0 } }), "delivered");
  assert.equal(requestState({ request: { deliveredAt: 12000 } }), "delivered");
});

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
  assert.equal(callDetail({ mode: "read", effort: "high", round: 1, report: null, failure: null, retry: "capacity 1/4", state: "live" }), "read·high · 服务繁忙 重试 1/4");
  assert.equal(callNeed({ ...base, status: "working", offline: true }), "offline");
  assert.equal(callStage({ ...base, status: "error", offline: true, retry: null }), "offline");
  assert.equal(callNeed({ ...base, status: "blocked", offline: true }), "blocked");
  assert.equal(buildCall({ call: "a", name: "n" }, "/r/.cc-dispatch/dev-x", [{ name: "n", state: "live", status: "working", labels: { "cc.net": "down" } }]).offline, true);
  assert.equal(eventWords({ ev: "send", why: "retry", kind: "network" }), "网络恢复，已让它继续");
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
  assert.equal(summary(runs[0].counts), "等你 1 · 进行中 1");
  assert.equal(runs[0].mainAgent, "codex"); // the adopter's program wins
});

test("lost: a helper whose terminal vanished while open, before a good report", () => {
  const lost = buildCall(meta("a", { open: true, report_check: "missing" }), RUN, []);
  assert.equal(lost.lost, true);
  assert.equal(callNeed(lost), "lost");
  assert.equal(callStage(lost), "lost");
  assert.equal(handoffAsk(lost), "lost");
  assert.match(handoffText(lost, "lost"), /终端意外消失/);
  assert.match(callDetail(lost), /终端消失了$/);
  assert.equal(buildCall(meta("a", { open: false }), RUN, []).lost, false); // cleaned up, stopped, frozen
  assert.equal(buildCall(meta("a", { open: true, report_check: "ok" }), RUN, []).lost, false); // its work is in
  assert.equal(buildCall(meta("a", { open: true, address: "t9" }), RUN, [{ address: "t9", state: "live" }]).lost, false);
  assert.equal(buildCall(meta("a", { round: 2, lost: { round: 2 } }), RUN, []).lost, true);
  assert.equal(stageSummary(["lost", "working"]), "已中断 1 · 进行中 1");
});

test("callDetail and ago", () => {
  assert.equal(callDetail({ mode: "write", effort: "high", round: 2, report: "bad", failure: null, state: "live" }),
    "write·high · 第 2 轮");
  assert.equal(callDetail({ mode: "read", effort: "", round: 1, report: "missing", failure: "quota", state: "gone" }),
    "read · 没有回报 · 额度用完 · 已关闭");
  assert.equal(callDetail({ mode: "read", effort: "", round: 1, report: "ok", failure: "exited", state: "finished" }), "read · 已关闭");
  assert.equal(ago(0), "");
  assert.equal(ago(1000, 1000 + 125000), "2 分钟前");
  assert.equal(ago(1000, 1000 + 3 * 86400000), "3 天前");
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
  assert.match(md, /### 2\. 第 2 项\n\n- \*\*change\*\*: no title here/);
  assert.match(md, /- \*\*passed\*\*: `true`/);
  assert.match(md, /- \*\*output_tail\*\*: \n\n  ```\n  line 1\n  line 2\n  ```/);
  assert.match(md, /## notes\n\n- `one`\n- `two`/);
  assert.match(md, /## empty\n\n- \*（无）\*/);
});

test("jsonMarkdown: not JSON or too long shows the source in a block", () => {
  assert.equal(jsonMarkdown("oops {"), "```\noops {\n```");
  assert.match(jsonMarkdown(`"${"x".repeat(MARKDOWN_LIMIT)}"`), /^\*内容太长/);
  assert.equal(jsonMarkdown(null), "");
});

test("reportMarkdown and diffMarkdown", () => {
  const c = { report: "bad", reportPath: "/r/report.json", schema: "/s.json" };
  const md = reportMarkdown(c, '{"status":"blocked"}', ["/r/report.r1.json"]);
  assert.match(md, /\*\*结论\*\*：\*\*没通过 schema 检查\*\*/);
  assert.match(md, /之前各轮\*\*： `report\.r1\.json`/);
  assert.match(md, /## status\n\n`blocked`/);
  assert.match(reportMarkdown({ ...c, report: null }, null), /\*还没写回报。\*/);
  assert.equal(diffMarkdown("## cc/run/T1 @ /wt\n M a.js\n\n 1 file changed"), "### `cc/run/T1 @ /wt`\n\n```\n M a.js\n\n 1 file changed\n```");
  assert.equal(diffMarkdown("## main @ /wt\n"), "### `main @ /wt`\n\n*没有改动。*");
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
  assert.equal(stageSummary(stages), "进行中 1 · 验收中 1 · 已合并 2");
  assert.deepEqual(cardCounts({ status: { a: "merged", b: "pending", c: "merged", d: "accepting", e: "odd" } }),
    [["done", 2], ["accepting", 1], ["pending", 1], ["odd", 1]]);
  assert.deepEqual(cardCounts({ status: { a: "merged", b: "done" } }), [["done", 2]], "统计里已合并和已完成是同一个“已完成”");
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
  assert.match(md[0], /· r1 · 已派发 write·high「token refresh」$/);
  assert.match(md[1], /服务繁忙：\d\d:\d\d:\d\d 第 1\/4 次重试$/);
  assert.match(md[2], /已让它继续（服务繁忙，第 1 次重试）$/);
  assert.match(md[3], /停下：已完成，回报合格，重试过 1 次$/);
  assert.match(md[4], /Codex 累计：1.5M tok · 12 条命令 · 3 个文件 · gpt$/);
  assert.match(md[5], /· r2 · 发出第 2 轮 — \*\*没送达\*\*$/);
  assert.match(timelineMarkdown(null), /没有事件记录/);
  assert.equal(eventWords({ ev: "settle", state: "gone", report: "missing", failure: "exited" }), "停下：已关闭，回报缺失，**已退出**");
  assert.match(eventWords({ ev: "lost" }), /已中断/);
  assert.match(eventWords({ ev: "recover", how: "resume" }), /重新打开了原 session/);
  assert.match(eventWords({ ev: "recover", how: "fresh" }), /新 session 读了任务/);
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
  assert.equal(summary(r.counts), "已暂停 1 · 待收回报 1");
  assert.deepEqual(controlOps(r), ["resume", "stop"]);
  assert.equal(controlBanner(r, 1000 * 1000 + 120000), "已暂停 · 2 分钟前 · 挂起 1 个子 agent");
  assert.match(timelineMarkdown('{"t":1,"ev":"pause","round":1,"interrupted":true}\n{"t":2,"ev":"stop","round":1,"asked":true}'),
    /已暂停\*\*：中途打断[\s\S]*运行已终止\*\*：已让它交代做到哪了/);
});

test("run control: buttons by state, and a running control.json counts as none", () => {
  assert.deepEqual(controlOps({ live: true, control: null }), ["pause", "stop"]);
  assert.deepEqual(controlOps({ live: false, control: null }), []);
  // A finished run (state.json "finished") has nothing left to pause or stop.
  assert.deepEqual(controlOps({ live: true, control: null }, true), []);
  assert.deepEqual(controlOps({ live: true, control: { state: "paused" } }, true), []);
  assert.deepEqual(controlOps({ live: true, control: { state: "stopping" } }), []);
  assert.deepEqual(controlOps({ live: false, control: { state: "stopped" } }), []);
  assert.match(controlBanner({ calls: [], control: { state: "stopped", at: 0 } }), /^已终止/);
  assert.match(controlBanner({ calls: [], control: { state: "stopped", at: 0 } }), /总结已交给主 agent$/);
  assert.match(controlBanner({ calls: [], mainAgent: "codex", control: { state: "stopped", at: 0 } }), /总结已交给主 agent（Codex）$/);
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
  assert.ok(md.indexOf("通过 schema 检查") < md.indexOf("## worktree 里的改动"));
  assert.match(md, /## worktree 里的改动\n\n`main @ \/w`/);
  assert.match(md, / M a\.js/);
  assert.doesNotMatch(resultMarkdown(c, '{"status":"done"}', [], null), /worktree 里的改动/);
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
  assert.ok(md.indexOf("## 第 2 轮 · 当前 · 已移交") < md.indexOf("## 第 1 轮 · 首次派发"));
  assert.match(md, /已移交\*\* codex → claude（context_limit），弱隔离/);
  assert.match(md, /\*\*已接手\*\*：t7 里的主 agent（codex），原来是 t1/);
  assert.match(md, /\*\*已冻结\*\*（context_limit），已保存 worktree `abcdef1234`/);
  assert.match(md, /### 任务文件 `task-2\.md`\n\n#### 任务 a（第 2 轮）/);
  assert.match(roundsMarkdown({ round: 1 }, null, { 1: null }), /没有事件记录[\s\S]*第 1 轮没有任务文件/);
});

import { agentTag, agentLabel, weakIsolation, canHandOver, AGENTS } from "../cc-dispatch/mods/cc-dispatch/model.js";

test("helper agents: the label wins, then meta.json, else codex; Claude Code is marked weak", () => {
  assert.equal(buildCall(meta("a"), RUN, []).agent, "codex");
  assert.equal(agentTag(buildCall(meta("a"), RUN, [])), null);
  const c = buildCall(meta("a", { agent: "claude", claude_sessions: ["s1", "s2"], address: "t5" }), RUN, []);
  assert.deepEqual(agentTag(c), { text: "claude", weak: true });
  assert.deepEqual(c.claudeSessions, ["s1", "s2"]);
  assert.ok(weakIsolation(c));
  assert.match(callDetail(c), /Claude Code（弱隔离）/);
  const live = buildCall(meta("a", { address: "t5" }), RUN, [{ address: "t5", state: "live", labels: { "cc.agent": "claude", "cc.handover": "codex" } }]);
  assert.equal(live.agent, "claude");
  assert.equal(live.handingTo, "codex");
  assert.match(callDetail(live), /正在移交给 Codex/);
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
  assert.equal(controlBanner(r, 100_000 + 120_000), "交接中 · 2 分钟前 · 把提示交给下一个主 agent");
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
  assert.equal(itemLine(items.find((x) => x.id === "env")), "已回答 · stg-2");
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
  assert.equal(takeoverBanner(r), "主 agent（Codex） 已经不在了 · 把提示交给新的主 agent");
  assert.equal(takeoverBanner({}), "主 agent 已经不在了 · 把提示交给新的主 agent");
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

test("a run without task cards counts its helper calls as cards; task cards win when present", () => {
  const run = { calls: [
    { call: "reviewer", state: "gone", report: "ok" },
    { call: "stress-r1", state: "live", status: "working" },
    { call: "stress-r0", state: "gone", report: null },
  ] };
  const v = runCards(run, { status: {}, cards: {}, checks: 0 });
  assert.deepEqual(v.status, { reviewer: "done", "stress-r1": "running", "stress-r0": "parked" });
  const dev = { status: { T1: "merged" }, cards: { T1: { status: "merged" } }, checks: 0 };
  assert.equal(runCards(run, dev), dev);
  assert.equal(runCards({ calls: [] }, undefined), null);
});

import { topicTimeline } from "../cc-dispatch/mods/cc-dispatch/model.js";

test("the Topic timeline lists Tasks oldest first with what each completed and leaves open, drafts last", () => {
  const topic = buildTopics([], { a: topicRecord({
    k1: { kind: "research", title: "调研", run: "research-old", started_at: 30, finished_at: 40, summary_line: "可行",
      summary_done: "- 摸清现状\n- 给出方案\n", summary_open: "等你定 A 还是 B", artifact: "/r/plan.md" },
    k2: { kind: "dev", title: "实现", created_at: 5 },
    k3: { kind: "fix", title: "修复", started_at: 20, run: "gone", abandoned_at: 25, abandon_reason: "不需要了" },
  }) })[0];
  const nodes = topicTimeline(topic);
  assert.deepEqual(nodes.map((n) => [n.id, n.status]), [["k3", "abandoned"], ["k1", "done"], ["k2", "queued"]]);
  assert.deepEqual(nodes[1].done, ["摸清现状", "给出方案"]);
  assert.deepEqual(nodes[1].open, ["等你定 A 还是 B"]);
  assert.equal(nodes[1].line, "可行");
  assert.equal(nodes[1].artifact, "/r/plan.md");
  assert.equal(nodes[0].line, "已放弃：不需要了");
  assert.equal(nodes[0].end, 25000);
});

test("an unfinished Task's timeline node lists the run's unanswered asks and cards not merged yet", () => {
  const { topic } = groupedTask({
    state: { tasks: { T1: { status: "merged", title: "已合入" }, T2: { status: "running", title: "进行中的卡" }, "T2-check-r1": { status: "running" } } },
    asks: { q: { kind: "question", title: "要不要保留旧入口" } },
  });
  const [node] = topicTimeline(topic);
  assert.equal(node.status, "you");
  assert.ok(node.open.includes("要不要保留旧入口"), JSON.stringify(node.open));
  assert.ok(node.open.includes("T2 进行中的卡"), JSON.stringify(node.open));
  assert.ok(!node.open.some((x) => x.startsWith("T1") || x.includes("check")), JSON.stringify(node.open));
});

test("a Task or Topic spins only while work runs; a Task whose helpers all settled but is not finished shows 待收尾", async () => {
  const { FINISHING_STAGES, callStage, runStage } = await import("../cc-dispatch/mods/cc-dispatch/model.js");
  const c = (o) => ({ state: "gone", status: null, report: "ok", failure: null, ...o });
  for (const card of ["merged", "done", "parked"]) assert.ok(FINISHING_STAGES.has(runStage([callStage(c({}), card)])), card);
  assert.ok(!FINISHING_STAGES.has(runStage([callStage(c({}), "merged"), callStage(c({}), "accepting")])));
  assert.ok(!FINISHING_STAGES.has(runStage([callStage(c({}), "merged"), callStage(c({ state: "live", status: "working" }), "running")])));
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8");
  assert.match(main, /FINISHING_STAGES\.has\(top\) \? "finishing" : top/, "main.js: taskStage must turn a fully settled unfinished run into 待收尾");
  assert.match(main, /const running = Boolean\(r\) && group === "active" && stage === "working";/, "main.js: the Task row spins only on its own running stage");
  assert.match(main, /running \? "working" : active \? "review" : "done"/, "main.js: the Topic row spins only while one of its Tasks runs");
  assert.match(main, /g\.topics\.some\(\(topic\) => this\.topicRunning\(topic\)\) \? "working"/, "main.js: another space's row spins only while one of its Tasks runs");
});

test("Tasks follow the timeline: by start, drafts last; a finished Task suggests next steps by kind and hands its output on", () => {
  const T = (id, extra = {}) => ({ id, kind: "dev", title: id, run: null, runDir: null, request: null, dependsOn: [], parentTask: null, ...extra });
  const research = T("k1", { kind: "research", startedAt: 3000, finishedAt: 4000, runDir: "/r/a", artifact: "/r/a/plan.md", summaryLine: "方案定了" });
  const dev = T("k2", { startedAt: 1000, createdAt: 9000, runDir: "/r/b" });
  const draft = T("k3", { kind: "review", createdAt: 500, dependsOn: ["k1"] });
  const topic = { id: "x1", implicit: false, tasks: [draft, research, dev], runs: [] };
  topic.tasks.forEach((task) => { task.group = task === draft ? "queued" : task === research ? "done" : "active"; });
  assert.deepEqual(timelineTasks(topic).map((x) => x.id), ["k2", "k1", "k3"], "按开始时间排，没派出的草稿排最后");
  assert.equal(taskSource(draft, topic), research, "依赖本 Topic 的 Task 就是接在它后面");
  assert.equal(taskSource(T("k4", { dependsOn: ["y9:k1"] }), topic), null, "依赖别的 Topic 不算接");
  assert.equal(taskSource(T("k5", { parentTask: "k2" }), topic), dev);
  assert.deepEqual(taskFollowers(research, topic), [draft]);
  assert.deepEqual(nextSteps(research).map((s) => s.kind), ["review", "dev"], "有方案的调研：审查或开发");
  assert.deepEqual(nextSteps({ ...research, artifact: "/r/a/research.md" }).map((s) => s.kind), ["research", "dev"]);
  assert.deepEqual(nextSteps(T("k6", { kind: "review" })).map((s) => s.kind), ["fix", "dev"]);
  assert.deepEqual(nextSteps(T("k7", { kind: "dev" })).map((s) => s.kind), ["review", "test"]);
  assert.deepEqual(nextSteps(T("k8", { kind: "test" })).map((s) => s.kind), ["fix"]);
  assert.deepEqual(nextSteps(T("k9", { kind: "fix" })).map((s) => s.kind), ["test", "review"]);
  assert.deepEqual(nextSteps({ ...research, abandonedAt: 1 }), [], "放弃的 Task 没有下一步");
  const next = nextDraft(research, "review", "/repo/plan.md");
  assert.equal(next.kind, "review");
  assert.match(next.title, /审查：k1/);
  assert.match(next.detail, /^输入：\/repo\/plan\.md\n接 k1（research）「k1」，结论：方案定了\n审查这份方案。$/);
});

