import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import vm from "node:vm";
import * as model from "../cc-dispatch/mods/cc-dispatch/model.js";
import * as loader from "../cc-dispatch/mods/cc-dispatch/loader.js";
import * as bg from "../cc-dispatch/mods/cc-dispatch/bg.js";
import * as stats from "../cc-dispatch/mods/cc-dispatch/stats.js";

const section = (sep, path, value) => `\n${sep}${path}\n${JSON.stringify(value)}`;
const record = (id, tasks = {}, extra = {}) => ({ topic: { id, title: id, tasks, ...extra }, backlog: { items: [] } });
const empty = { unacked: 0, openIn: 0, answersUnacked: 0, openOut: 0 };
const item = (id, extra = {}) => ({
  id, to: "A", from: { topic: "B", title: "Sender snapshot" }, kind: "note", text: id, at: 1,
  delivered: null, acked_at: null, answer: null, withdrawn_at: null, dropped: null, ...extra,
});

test("summary sections isolate marker text and aggregate counts from deleted recipients without counting user", () => {
  const run = "/r/.cc-dispatch/dev-run";
  const old = section(model.ASKS_SEP, `${run}/asks.json`, { q: { title: "Question" } })
    + section(model.ANSWERS_SEP, `${run}/answers.jsonl`, { id: "q", text: "Yes" })
    + `\n${model.ARCHIVE_SEP}${run}/archived\n2`
    + section(model.CONTROL_SEP, `${run}/control.json`, { state: "paused" })
    + section(model.SEP, `${run}/agents/a/meta.json`, { call: "a" })
    + section(model.TOPIC_SEP, "/r/.cc-dispatch/topics/A/topic.json", { id: "A", tasks: {}, follows: ["B", "deleted"] })
    + section(model.BACKLOG_SEP, "/r/.cc-dispatch/topics/A/backlog.json", { items: [] })
    + section(model.TOPIC_SEP, "/r/.cc-dispatch/topics/B/topic.json", { id: "B", tasks: {} })
    + section(model.STATE_SEP, `${run}/state.json`, { finished: 3 });
  const summaries = section(model.MESSAGE_SUMMARY_SEP, "/r/.cc-dispatch/messages/A.summary.json",
    { unacked: 2, open_in: 1, last_at: 10, by_sender: { B: { open: 1, answers_unacked: 2 }, user: { open: 30, answers_unacked: 40 } },
      markers: [model.ASKS_SEP, model.ANSWERS_SEP, model.ARCHIVE_SEP, model.CONTROL_SEP, model.SEP,
        model.TOPIC_SEP, model.BACKLOG_SEP, model.STATE_SEP, model.MESSAGE_SUMMARY_SEP].join("") })
    + section(model.MESSAGE_SUMMARY_SEP, "/r/.cc-dispatch/messages/deleted.summary.json",
      { by_sender: { A: { open: 3, answers_unacked: 4 }, B: { open: 2, answers_unacked: 1 } }, last_at: 20 })
    + section(model.MESSAGE_SUMMARY_SEP, "/other/.cc-dispatch/messages/A.summary.json", { unacked: 500, by_sender: { A: { open: 500 } } })
    + `\n${model.MESSAGE_SUMMARY_SEP}/r/.cc-dispatch/messages/broken.summary.json\n{broken`;
  for (const parse of [model.parseAsks, model.parseArchived, model.parseControls, model.parseMetaDump, model.parseTopics, model.parseStates]) {
    assert.deepEqual(parse(old + summaries), parse(old), parse.name);
    assert.deepEqual(parse(summaries), parse(""), parse.name);
  }
  const parsed = model.parseMessageSummaries(old + summaries);
  assert.equal(parsed.length, 3);
  const topics = model.buildTopics([], model.parseTopics(old), {}, parsed);
  assert.deepEqual(topics.find((t) => t.id === "A").messages, { unacked: 2, openIn: 1, answersUnacked: 4, openOut: 3 });
  assert.deepEqual(topics.find((t) => t.id === "B").messages, { unacked: 0, openIn: 0, answersUnacked: 3, openOut: 3 });
  assert.deepEqual(topics.find((t) => t.id === "A").follows, ["B", "deleted"]);
  assert.equal(topics.find((t) => t.id === "A").updatedAt, 20000);
  assert.deepEqual(model.buildTopics([], { A: record("A") })[0].messages, empty);
});

test("the real list script reads only summaries and keeps hostile message bodies outside the dump", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "cc-message-list-")));
  const dir = join(repo, ".cc-dispatch");
  mkdirSync(join(dir, "topics/A"), { recursive: true });
  mkdirSync(join(dir, "messages"));
  writeFileSync(join(dir, "topics/A/topic.json"), JSON.stringify({ id: "A", tasks: {} }));
  writeFileSync(join(dir, "messages/A.json"), `${model.SEP}/injected\nBODY_MUST_NOT_BE_READ`);
  writeFileSync(join(dir, "messages/A.outbox.json"), "OUTBOX_MUST_NOT_BE_READ");
  writeFileSync(join(dir, "messages/A.summary.json"), JSON.stringify({ unacked: 2, open_in: 1 }));
  const sh = async (script, args) => {
    const r = spawnSync("sh", ["-c", script, "_", ...args], { encoding: "utf8" });
    assert.doesNotMatch(r.stdout, /BODY_MUST_NOT_BE_READ|OUTBOX_MUST_NOT_BE_READ/);
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const loaded = await loader.loadRuns({ sh }, repo, []);
  assert.equal(loaded.error, null);
  assert.deepEqual(loaded.topics[0].messages, { ...empty, unacked: 2, openIn: 1 });
});

test("dependency chains longer than the call stack resolve, and a null entry does not hide later edges", () => {
  const count = 20000, tasks = {};
  for (let i = 1; i <= count; i += 1) tasks[`k${i}`] = { depends_on: i < count ? [`k${i + 1}`] : [] };
  assert.equal(model.dependsState(model.buildTopics([], { A: record("A", tasks) }), "A", "k1").state, "pending");
  tasks[`k${count}`].depends_on = ["k1"];
  assert.equal(model.dependsState(model.buildTopics([], { A: record("A", tasks) }), "A", "k1").path.length, count + 1);
  const holes = model.buildTopics([], { A: record("A", { k1: { depends_on: [null, "k2"] }, k2: { depends_on: ["k1"] } }) });
  assert.equal(model.dependsState(holes, "A", "k1").state, "cycle");
});

test("dependency snapshots distinguish completion, pending, stopping, abandonment, deletion and cross-Topic cycles", () => {
  const states = { "/r/.cc-dispatch/dev-finished": { finished: 20 }, "/r/.cc-dispatch/dev-stopped": {}, "/r/.cc-dispatch/dev-retired": { finished: 30 } };
  const runs = model.buildRuns([], [], {
    "/r/.cc-dispatch/dev-stopped": { state: "stopped" },
    "/r/.cc-dispatch/dev-retired": { state: "running", retired: true },
  }, {}, {}, states);
  const topics = model.buildTopics(runs, {
    A: record("A", { k1: { depends_on: ["B:k1"] }, k2: { finished_at: 5 }, k3: {}, k4: { abandoned_at: 0 },
      k5: { run: "dev-finished" }, k6: { run: "dev-stopped" }, k7: { run: "dev-retired" } }),
    B: record("B", { k1: { depends_on: ["A:k1"] } }),
  }, states);
  for (const [ref, expected] of [["k2", "done"], ["k3", "pending"], ["k4", "abandoned"], ["k5", "done"],
    ["k6", "stopped"], ["k7", "stopped"], ["k9", "missing"], ["deleted:k1", "missing"], ["B:k1", "cycle"]]) {
    assert.equal(model.dependsState(topics, "A", ref).state, expected, ref);
  }
  assert.deepEqual(model.dependsState(topics, "A", "B:k1").path, ["B:k1", "A:k1", "B:k1"]);
  const same = model.buildTopics([], { A: record("A", { k1: { depends_on: ["k2"] }, k2: { depends_on: ["k1"] } }) });
  assert.deepEqual(model.dependsState(same, "A", "k1").path, ["A:k1", "A:k2", "A:k1"]);
  const finished = model.buildTopics(runs, { A: record("A", {
    k1: { run: "dev-stopped", finished_at: 2 }, k2: { run: "dev-finished", abandoned_at: 3 },
  }) }, states)[0];
  assert.equal(model.dependsState([finished], finished, "k1").state, "done");
  assert.equal(model.dependsState([finished], finished, "k2").state, "abandoned");
});

test("dependency lookup stays within the source repository", () => {
  const text = section(model.TOPIC_SEP, "/r/.cc-dispatch/topics/A/topic.json", { id: "A", tasks: {} })
    + section(model.TOPIC_SEP, "/other/.cc-dispatch/topics/B/topic.json", { id: "B", tasks: { k1: { finished_at: 1 } } });
  const topics = model.buildTopics([], model.parseTopics(text));
  assert.equal(model.dependsState(topics, "A", "B:k1").state, "missing");
});

test("message groups retain delivery and question states and only allow authorized acknowledgement or withdrawal", () => {
  const incoming = [
    item("queued"), item("delivered", { delivered: { at: 2 } }), item("acked", { acked_at: 3 }),
    item("other-question", { kind: "question" }),
    item("user-question", { from: { user: true }, kind: "question" }),
    item("withdrawn", { kind: "question", withdrawn_at: 2 }),
    item("dropped", { kind: "question", dropped: "deleted" }),
    item("user-answer", { from: { user: true }, kind: "question", acked_at: 2, answer: { text: "Yes", acked_at: null } }),
  ];
  const outgoing = item("own-question", { to: "deleted", from: { topic: "A" }, kind: "question" });
  const groups = model.messageGroups({ topic: "A", incoming, answers: [outgoing], outgoing: [outgoing] }, [{ id: "B", title: "Sender" }]);
  assert.deepEqual(groups.map((g) => g.title), ["Sender", "用户", "deleted（已删除）"]);
  const rows = Object.fromEntries(groups.flatMap((g) => g.items).map((row) => [row.item.id, row]));
  for (const [id, text] of [["queued", "排队"], ["delivered", "已送达"], ["acked", "已确认"],
    ["other-question", "待回答"], ["withdrawn", "已撤销"], ["dropped", "已作废"], ["user-answer", "已回答"]]) {
    assert.ok(rows[id].status.includes(text), id);
  }
  assert.equal(rows["other-question"].canWithdraw, false);
  assert.equal(rows["user-question"].canWithdraw, true);
  assert.equal(rows["own-question"].canWithdraw, true);
  assert.equal(rows.acked.canAck, false);
  assert.equal(rows.withdrawn.canAck, false);
  assert.equal(rows.dropped.canAck, false);
  assert.equal(rows["user-answer"].canAck, true);
  assert.equal(model.questionState(item("race", { kind: "question", answer: {}, withdrawn_at: 2, dropped: "deleted" })), "answered");
});

function node() {
  const target = { attrs: {}, nodes: [] };
  const proxy = new Proxy(target, {
    get: (value, key) => key in value ? value[key] : (...args) => {
      if (["id", "tooltip", "on_click"].includes(key)) value.attrs[key] = args[0];
      if (key === "child") value.nodes.push(args[0]);
      if (key === "children") value.nodes.push(...args[0]);
      if (key === "when" && args[0]) args[1](proxy);
      return proxy;
    },
  });
  return proxy;
}
const elements = (root) => root && typeof root === "object" ? [root, ...root.nodes.flatMap(elements)] : [];
const texts = (root) => typeof root === "string" ? [root] : root?.nodes.flatMap(texts) ?? [];
const byId = (root, id) => elements(root).find((el) => el.attrs.id === id);
const colors = { ansi1: "red", ansi3: "yellow", accent: "blue", foreground: "white", background: "black", muted: "grey" };
const source = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class Dispatch", "class Dispatch");

function harness(props = {}, overrides = {}) {
  const calls = [], overlays = [], pending = [], remote = [];
  let response = { topic: "A", incoming: [], answers: [], outgoing: [] }, reject = null;
  const context = vm.createContext({
    ...model, ...loader, ...bg, ...stats, View: class {},
    h_flex: node, v_flex: node, div: node, svg: node, image: node, Textarea: { new: node },
    TextareaState: { new: ({ value = "" } = {}) => ({ text: value, value() { return this.text; }, on() {} }) },
    settings: () => ({}), theme: () => colors, agents: () => [], terminals: () => [], checking: () => false,
    spaces: () => [{ id: "space", active: true }], blockProps: () => props,
    openOverlay: (args) => overlays.push(args), closeOverlay() {},
    exec: async (_program, _args, opts) => { remote.push(opts.on); return { code: 0 }; },
    topicCmd: async (files, hd, args) => {
      calls.push({ hd, args: Array.from(args) });
      await files.sh("true");
      if (args[1] === "inbox") return { ok: true, out: `INBOX=0\nMESSAGE_DATA=${JSON.stringify(response)}` };
      if (reject) return { ok: false, out: reject };
      if (args[1] === "follow") return { ok: true, out: args.includes("--remove") ? "FOLLOWS=" : "FOLLOWS=B" };
      return { ok: true, out: "MESSAGE=m-new" };
    },
    ...overrides,
  });
  vm.runInContext(`${source}\nglobalThis.TopicView = Dispatch;`, context);
  const cx = { notify() {}, stop_propagation() {}, sleep: async () => {}, timer: { every() {} },
    spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); } };
  const view = new context.TopicView();
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { view, cx, calls, overlays, remote, flush,
    setData(data) { response = data; }, fail(text) { reject = text; },
    async click(button) { assert.equal(typeof button?.attrs.on_click, "function"); button.attrs.on_click({}, cx); await flush(); } };
}

const dialogProps = (role = "messages") => ({
  role, topic: { id: "A", title: "Alpha", follows: ["deleted"] }, hd: "/hd.py", repo: "/r", on: "remote",
  peers: [{ id: "A", title: "Alpha" }, { id: "B", title: "Beta" }], nodes: [],
});

test("the message dialog reads inbox as user, groups peers, and rereads after sending, withdrawing or acknowledging", async () => {
  const p = dialogProps(), h = harness(p);
  h.setData({ topic: "A", incoming: [
    item("q", { from: { user: true }, kind: "question", text: "User question" }),
    item("b", { text: "Peer message" }),
  ], answers: [], outgoing: [] });
  h.view.init({}, h.cx); await h.flush();
  assert.deepEqual(h.calls[0].args, ["topic", "inbox", "--repo", "/r", "--topic", "A", "--as-user", "--all"]);
  let rendered = h.view.renderDialog();
  assert.ok(byId(rendered, "message-peer-user"));
  assert.ok(byId(rendered, "message-peer-B"));
  await h.click(byId(rendered, "withdraw-q"));
  assert.deepEqual(h.calls.at(-2).args, ["topic", "msg-withdraw", "--repo", "/r", "--as-user", "--topic", "A", "--ids", "q"]);
  assert.equal(h.calls.at(-1).args[1], "inbox");
  await h.click(byId(h.view.renderDialog(), "ack-b"));
  assert.deepEqual(h.calls.at(-2).args, ["topic", "msg-ack", "--repo", "/r", "--as-user", "--topic", "A", "--ids", "b"]);
  await h.click(byId(h.view.renderDialog(), "message-kind-question"));
  const text = '-literal\n中文 $(not executed) `literal` "@@cc-dispatch-meta "';
  h.view.messageBox.text = text;
  await h.click(byId(h.view.renderDialog(), "message-send"));
  assert.deepEqual(h.calls.at(-2).args, ["topic", "msg", "--repo", "/r", "--as-user", "--topic", "A", "--kind", "question", `--text=${text}`]);
  assert.equal(h.calls.at(-1).args[1], "inbox");
  assert.equal(h.view.messageBox.value(), "");
  assert.ok(h.remote.every((on) => on === "remote"));
});

test("failed message changes keep the draft and reread current state; long or archived messages cannot send", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx); await h.flush();
  h.view.messageBox.text = "Draft";
  h.fail("FAILURE=QUESTION_CLOSED\nSTATE=answered");
  await h.click(byId(h.view.renderDialog(), "message-send"));
  assert.equal(h.view.messageBox.value(), "Draft");
  assert.equal(h.calls.at(-1).args[1], "inbox");
  assert.match(h.view.failed, /STATE=answered/);
  h.view.messageBox.text = "x".repeat(4001);
  assert.equal(byId(h.view.renderDialog(), "message-send").attrs.on_click, undefined);
  h.view.messageBox.text = "\u{1f600}".repeat(4000);
  assert.equal(typeof byId(h.view.renderDialog(), "message-send").attrs.on_click, "function");
  p.topic.archived = 1;
  h.view.messageBox.text = "Draft";
  assert.equal(byId(h.view.renderDialog(), "message-send").attrs.on_click, undefined);
});

test("Topic summaries always expose messages and allow adding or removing follows including deleted Topics", async () => {
  const p = dialogProps("timeline"), h = harness(p);
  h.view.init({}, h.cx); await h.flush();
  let rendered = h.view.renderDialog();
  assert.ok(texts(rendered).includes("关注 Topic"));
  assert.ok(texts(rendered).includes("deleted（已删除）"));
  await h.click(byId(rendered, "summary-messages"));
  assert.equal(h.overlays.at(-1).props.role, "messages");
  assert.equal(h.overlays.at(-1).props.on, "remote");
  await h.click(byId(h.view.renderDialog(), "follow-B"));
  assert.deepEqual(h.calls.at(-2).args, ["topic", "follow", "--repo", "/r", "--as-user", "--topic", "A", "--target", "B"]);
  rendered = h.view.renderDialog();
  assert.ok(byId(rendered, "unfollow-B"));
  await h.click(byId(rendered, "unfollow-B"));
  assert.deepEqual(h.calls.at(-2).args, ["topic", "follow", "--repo", "/r", "--as-user", "--topic", "A", "--target", "B", "--remove"]);
  assert.ok(byId(h.view.renderDialog(), "follow-B"));
  h.view.follows = ["deleted"];
  await h.click(byId(h.view.renderDialog(), "unfollow-deleted"));
  assert.equal(h.calls.at(-2).args.at(-2), "deleted");
});

test("envelopes count incoming and answers, omit a zero count for open questions, and disappear otherwise", async () => {
  const h = harness();
  Object.assign(h.view, { fold: new Map([["A", true]]), topics: [], runs: [], repo: "/r", ctx: { on: "remote" },
    renderAsks: () => null, topicControlButtons: () => [], archiveButton: () => [] });
  for (const [messages, visible, count] of [
    [empty, false, null], [{ ...empty, unacked: 2, answersUnacked: 3 }, true, "5"], [{ ...empty, openOut: 1 }, true, null],
  ]) {
    const topic = model.buildTopics([], { A: record("A") })[0];
    topic.messages = messages; h.view.topics = [topic];
    const button = byId(h.view.renderTopic(colors, topic), "messages-A");
    assert.equal(Boolean(button), visible);
    if (!button) continue;
    assert.deepEqual(texts(button), count ? [count] : []);
    await h.click(button);
    assert.equal(h.overlays.at(-1).props.role, "messages");
    assert.equal(h.overlays.at(-1).props.topic.id, "A");
  }
});

test("older ended Topics with unacknowledged incoming messages remain visible beyond the history limit", () => {
  const h = harness(), mine = Array.from({ length: 9 }, (_, i) => model.buildTopics([], { [i]: record(String(i)) })[0]);
  mine[8].messages.unacked = 1;
  Object.assign(h.view, { split: () => ({ mine, others: [] }), renderTopic: (_t, topic) => node().id(`shown-${topic.id}`),
    renderOthers: (_t, body) => body, showOld: false });
  const rendered = h.view.renderTopics(colors);
  assert.ok(byId(rendered, "shown-8"));
  assert.ok(byId(rendered, "shown-5"));
  assert.ok(!byId(rendered, "shown-6"));
  assert.ok(texts(rendered).includes("再显示 2 个更早的"));
});

test("dependency warnings stay visible on folded Tasks and blocking states disable both dispatch and resend", () => {
  const h = harness();
  Object.assign(h.view, { fold: new Map(), controlButtons: () => [], stats: { runs: {} }, states: {} });
  const states = { "/r/.cc-dispatch/dev-stop": {} };
  const runs = model.buildRuns([], [], { "/r/.cc-dispatch/dev-stop": { state: "stopped" } }, {}, {}, states);
  for (const [dependency, expected, enabled] of [
    [{}, "等 Beta·Dependency", false], [{ run: "dev-stop" }, "依赖已终止", false],
    [{ abandoned_at: 1 }, "依赖已放弃", true], [null, "依赖已删除", true],
    [{ depends_on: ["A:k1"] }, "依赖成环", false], [{ finished_at: 1 }, null, true],
  ]) {
    const topics = model.buildTopics(runs, {
      A: record("A", { k1: { depends_on: ["B:k1"], request: { target: "new_tab", delivered_at: 1 } } }),
      B: record("B", dependency ? { k1: { title: "Dependency", ...dependency } } : {}, { title: "Beta" }),
    }, states);
    h.view.topics = topics;
    const topic = topics.find((t) => t.id === "A"), task = topic.tasks[0];
    h.view.fold.set("A|k1", false);
    const rendered = h.view.renderTask(colors, topic, task);
    if (expected) assert.ok(texts(rendered).some((text) => text.includes(expected)), expected);
    for (const id of ["dispatch-A|k1", "resend-A|k1"]) {
      assert.equal(typeof byId(rendered, id).attrs.on_click === "function", enabled, id);
    }
    h.view.fold.set("A|k1", true);
    if (expected) assert.ok(texts(h.view.renderTask(colors, topic, task)).some((text) => text.includes(expected)), expected);
  }
});

test("each refresh in a repository with Topics delivers without requests and reloads for any delivery change", async () => {
  const explicit = model.buildTopics([], { A: record("A", {}) });
  for (const output of ["DELIVERED=\nMESSAGE_DELIVERED=A", "DELIVERED=request\nMESSAGE_DELIVERED=", "UPDATED=1", "DELIVERED=\nMESSAGE_DELIVERED="]) {
    let loads = 0;
    const calls = [];
    const h = harness({}, {
      findRepo: async () => "/r",
      loadRuns: async () => { loads++; return { runs: [], topics: explicit, states: {}, error: null }; },
      topicCmd: async (_files, _hd, args) => { calls.push(Array.from(args)); return { ok: true, out: output }; },
    });
    h.view.init({}, h.cx);
    Object.assign(h.view, { ctx: { on: "remote", folder: "/r" }, refreshStats() {}, refreshQuota() {}, refreshPrograms() {} });
    h.view.refresh(h.cx); await h.flush();
    assert.deepEqual(calls, [["topic", "deliver", "--repo", "/r"]]);
    assert.equal(loads, /=(A|request|1)/.test(output) ? 2 : 1, output);
    h.view.refresh(h.cx); await h.flush();
    assert.equal(calls.length, 2);
  }
  const calls = [];
  const h = harness({}, {
    findRepo: async () => "/plain",
    loadRuns: async () => ({ runs: [], topics: [], states: {}, error: null }),
    topicCmd: async (_files, _hd, args) => { calls.push(Array.from(args)); return { ok: true, out: "" }; },
  });
  h.view.init({}, h.cx);
  Object.assign(h.view, { ctx: { folder: "/plain" }, refreshStats() {}, refreshQuota() {}, refreshPrograms() {} });
  h.view.refresh(h.cx); await h.flush();
  assert.deepEqual(calls, [], "a repository without Topics gets no deliver call");
});

test("static app checks retain the existing guard against delivery side effects", async () => {
  let delivered = false;
  const h = harness({}, {
    checking: () => true, findRepo: async () => "/r",
    loadRuns: async () => ({ runs: [], topics: [], states: {}, error: null }),
    topicCmd: async () => { delivered = true; return { ok: true, out: "" }; },
  });
  h.view.init({}, h.cx);
  Object.assign(h.view, { ctx: { folder: "/r" }, refreshStats() {}, refreshQuota() {}, refreshPrograms() {} });
  h.view.refresh(h.cx); await h.flush();
  assert.equal(delivered, false);
});

test("marker text inside any dumped JSON value cannot cut or forge a list section", () => {
  const title = `x ${model.MESSAGE_SUMMARY_SEP}y ${model.STATE_SEP}z ${model.TOPIC_SEP}w ${model.SEP}v ${model.ASKS_SEP}u`;
  const dump = [
    `\n${model.ASKS_SEP}/r/.cc-dispatch/dev-a/asks.json\n${JSON.stringify({ q1: { id: "q1", title } })}`,
    `\n${model.TOPIC_SEP}/r/.cc-dispatch/topics/A/topic.json\n${JSON.stringify({ id: "A", title, tasks: {} })}`,
    `\n${model.TOPIC_SEP}/r/.cc-dispatch/topics/B/topic.json\n${JSON.stringify({ id: "B", title: "b", tasks: {} })}`,
    `\n${model.STATE_SEP}/r/.cc-dispatch/dev-a/state.json\n${JSON.stringify({ note: title })}`,
  ].join("");
  assert.deepEqual(Object.keys(model.parseTopics(dump)), ["A", "B"]);
  assert.equal(model.parseTopics(dump).A.topic.title, title);
  assert.equal(model.parseStates(dump)["/r/.cc-dispatch/dev-a"].note, title);
  assert.equal(model.parseAsks(dump)["/r/.cc-dispatch/dev-a"].asks.q1.title, title);
});

test("the panel delivers only in a repository with Topics, reloads on any delivery change, and keeps Topics with unread answers in view", () => {
  const main = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8");
  assert.match(main, /if \(repo && topics\.some\(\(topic\) => !topic\.implicit\) && !checking\(\)\)/, "main.js: call topic deliver only when the repository has Topics");
  assert.match(main, /\["DELIVERED", "MESSAGE_DELIVERED", "UPDATED"\]\.some/, "main.js: reload the list on UPDATED as well");
  assert.match(main, /topic\.messages\?\.answersUnacked \?\? 0\) > 0/, "main.js: unread answers keep an ended Topic out of the earlier list");
});
