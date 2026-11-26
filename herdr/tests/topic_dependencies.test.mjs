import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import * as model from "../cc-dispatch/mods/cc-dispatch/model.js";
import * as loader from "../cc-dispatch/mods/cc-dispatch/loader.js";

const snapshot = (id, tasks, extra = {}, repo = "/r") =>
  `\n${model.TOPIC_SEP}${repo}/.cc-dispatch/topics/${id}/topic.json\n${JSON.stringify({ id, title: id, tasks, ...extra })}`;
function topicsFixture() {
  return model.buildTopics([], model.parseTopics([
    snapshot("A", {
      k1: { title: "Current", depends_on: ["A:k2", "B:k1", "deleted:k7", "k9"] },
      k2: { title: "Local", depends_on: ["k1"] },
      k3: { title: "Queued", request: { type: "dispatch", target: "owner" }, depends_on: ["A:k1"] },
      k4: { title: "Delivered", request: { type: "dispatch", delivered_at: 1 } },
      k5: { title: "Bound", run: "dev-lost", depends_on: ["k1"] },
      k6: { title: "Abandoned", abandoned_at: 1 },
      k10: { title: "Another draft" },
    }, { title: "Alpha" }),
    snapshot("B", { k1: { title: "Finished", finished_at: 1 }, k2: { title: "Peer" }, k3: { title: "Waiting", depends_on: ["A:k1"] } }, { title: "Beta" }),
    snapshot("C", { k1: { title: "Archived", depends_on: ["A:k1"] } }, { archived: 1 }),
    snapshot("D", { k1: { title: "Deleting" } }, { deleting: 1 }),
    snapshot("elsewhere", { k1: { title: "Other repo", depends_on: ["A:k1"] } }, {}, "/other"),
  ].join("")));
}
const sourceTask = (topics) => {
  const topic = topics.find((item) => item.id === "A");
  return { topic, task: topic.tasks.find((item) => item.id === "k1") };
};
const choices = (topics) => {
  const { topic, task } = sourceTask(topics);
  return model.dependencyChoices(topics, topic, task);
};
const rows = (groups) => groups.flatMap((group) => group.tasks);

test("dependency refs parse strictly and serialize local, cross-Topic and empty selections", () => {
  assert.deepEqual(model.parseTaskRef("A", "k2"), { topic: "A", task: "k2" });
  assert.deepEqual(model.parseTaskRef("A", "other-topic:k12"), { topic: "other-topic", task: "k12" });
  for (const ref of [null, {}, "", "k0", "A:k01", "A:B:k1", "--task", "A:k1\n"]) {
    assert.equal(model.parseTaskRef("A", ref), null);
  }
  assert.equal(model.taskRefs("A", ["A:k2", "k2", "B:k3", "k10", "B:k3"]), "k2,B:k3,k10");
  assert.equal(model.taskRefs("A", []), "");
  assert.equal(model.taskRefs("A", ["broken-ref"]), "broken-ref");
});

test("dependency choices exclude self, implicit/deleting Topics, other repos and machines; archived Tasks remain", () => {
  const topics = topicsFixture();
  topics.push({ id: "history", title: "History", implicit: true, tasks: [{ id: "k1" }] },
    { id: "remote", title: "Other machine", on: "remote", repo: "/r", tasks: [{ id: "k1" }] });
  const groups = choices(topics), all = rows(groups);
  assert.deepEqual(groups.map((group) => group.id), ["A", "B", "C", "deleted"]);
  assert.deepEqual(groups[0].tasks.filter((task) => !task.missing).map((task) => task.id), ["k2", "k3", "k4", "k5", "k6", "k10"]);
  assert.equal(all.some((task) => task.ref === "k1"), false);
  assert.equal(groups.find((group) => group.id === "C").archived, true);
  assert.equal(all.find((task) => task.ref === "C:k1").canBlock, false);
  assert.equal(all.find((task) => task.ref === "B:k1").status, "done");
  assert.equal(all.find((task) => task.ref === "k6").status, "abandoned");
});

test("existing dependencies backfill checkboxes, deleted refs remain removable, and blocks come from every Task's dependencies", () => {
  const groups = choices(topicsFixture()), all = rows(groups);
  assert.deepEqual(all.filter((task) => task.depends).map((task) => task.ref), ["k2", "k9", "B:k1", "deleted:k7"]);
  assert.deepEqual(all.filter((task) => task.blocks).map((task) => task.ref), ["k2", "k3", "k5", "B:k3", "C:k1"]);
  assert.deepEqual(all.filter((task) => task.missing).map((task) => task.ref), ["k9", "deleted:k7"]);
  assert.deepEqual(all.filter((task) => task.canBlock).map((task) => task.ref),
    ["k2", "k3", "k4", "k6", "k10", "B:k1", "B:k2", "B:k3"]);
  assert.deepEqual(all.filter((task) => ["k3", "k4", "k5"].includes(task.ref)).map((task) => task.status), ["queued", "delivered", "running"]);
  const topics = topicsFixture(), { task } = sourceTask(topics);
  task.dependsOn = ["D:k1", "broken-ref"];
  const filtered = rows(choices(topics));
  assert.equal(filtered.find((item) => item.ref === "D:k1").depends, true);
  assert.equal(filtered.find((item) => item.ref === "broken-ref").missing, true);
});

test("reverse refs retain existing edges from deleting Topics without exposing them as choices", () => {
  const topics = topicsFixture(), { topic, task } = sourceTask(topics);
  topics.find((peer) => peer.id === "D").tasks[0].dependsOn = ["A:k1"];
  const refs = model.taskBlockRefs(topics, topic, task);
  assert.ok(refs.includes("D:k1"));
  assert.equal(rows(choices(topics)).some((item) => item.ref === "D:k1"), false);
  assert.equal(refs.some((ref) => ref.startsWith("elsewhere:")), false);
});

function node() {
  const target = { attrs: {}, nodes: [] };
  const proxy = new Proxy(target, {
    get: (value, key) => key in value ? value[key] : (...args) => {
      value.attrs[key] = args.length ? args[0] : true;
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
const byId = (root, id) => elements(root).find((element) => element.attrs.id === id);
const colors = (mode) => Object.fromEntries(["ansi1", "ansi2", "ansi3", "accent", "foreground", "background", "muted",
  "border", "popover", "selected", "input", "hover", "raised", "solid", "solid_foreground", "done", "working"]
  .map((key) => [key, `${mode}-${key}`]));
const source = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class Dispatch", "class Dispatch");

function harness(initialProps = {}, mode = "dark") {
  let props = initialProps, result = { code: 0, stdout: "TASK=k1", stderr: "" };
  const calls = [], overlays = [], closed = [], pending = [];
  const context = vm.createContext({
    ...model, ...loader, View: class {},
    h_flex: node, v_flex: node, div: node, svg: node, image: node,
    settings: () => ({}), theme: () => colors(mode), agents: () => [], terminals: () => [],
    spaces: () => [], layout: () => null, blockProps: () => props,
    openOverlay: (args) => overlays.push(args), closeOverlay: (id) => closed.push(id),
    exec: async (program, args, options) => { calls.push({ program, args: Array.from(args), options }); return result; },
  });
  vm.runInContext(`${source}\nglobalThis.TopicView = Dispatch;`, context);
  const cx = { notify() {}, stop_propagation() {}, sleep: async () => {}, timer: { every() {} },
    spawn(fn) { pending.push(Promise.resolve().then(() => fn(cx))); } };
  const view = new context.TopicView();
  const flush = async () => { while (pending.length) await Promise.all(pending.splice(0)); };
  return { view, cx, calls, overlays, closed, flush, View: context.TopicView,
    setProps(value) { props = value; }, respond(value) { result = value; },
    async click(button) { assert.equal(typeof button?.attrs.on_click, "function"); button.attrs.on_click({}, cx); await flush(); } };
}
const dialogProps = (topics = topicsFixture()) => {
  const { topic, task } = sourceTask(topics);
  return { role: "dependencies", topic, task, groups: choices(topics), repo: "/r", hd: "/hd.py", on: "remote", overlay: "dialog" };
};
function preparePanel(h, topics) {
  h.view.init({}, h.cx);
  Object.assign(h.view, { topics, repo: "/r", ctx: { on: "remote", folder: "/r" }, fold: new Map(),
    controlButtons: () => [], runs: [] });
}

test("expanded draft actions and folded dependency/cycle warnings open the same remote editor", async () => {
  const topics = topicsFixture(), { topic, task } = sourceTask(topics);
  const h = harness();
  preparePanel(h, topics);
  h.view.fold.set("A|k1", false);
  await h.click(byId(h.view.renderTask(colors("dark"), topic, task), "dependencies-A|k1"));
  let p = h.overlays.at(-1).props;
  assert.equal(p.role, "dependencies");
  assert.equal(p.on, "remote");
  assert.equal(p.repo, "/r");
  assert.deepEqual(Array.from(p.topic.tasks[0].dependsOn), task.dependsOn);
  assert.deepEqual(p.groups.map((group) => group.id), ["A", "B", "C", "deleted"]);
  h.view.fold.set("A|k1", true);
  const folded = h.view.renderTask(colors("dark"), topic, task);
  assert.ok(texts(folded).some((text) => text.includes("依赖成环")));
  assert.equal(byId(folded, "dependencies-A|k1"), undefined);
  await h.click(byId(folded, "edit-dependency-A|k1-A:k2"));
  p = h.overlays.at(-1).props;
  assert.equal(p.task.id, "k1");
  assert.equal(p.on, "remote");
});

test("bound Tasks and archived, deleting or implicit Topics have no edit-dependency entry", () => {
  const topics = topicsFixture(), { topic, task } = sourceTask(topics), h = harness();
  preparePanel(h, topics);
  for (const [peer, item] of [
    [{ ...topic, archived: 1 }, task], [{ ...topic, deleting: true }, task],
    [{ ...topic, implicit: true }, task], [topic, { ...task, runDir: "/r/.cc-dispatch/dev-bound" }],
  ]) {
    h.view.fold.set("A|k1", false);
    const rendered = h.view.renderTask(colors("dark"), peer, item);
    assert.equal(byId(rendered, "dependencies-A|k1"), undefined);
    assert.equal(elements(rendered).some((el) => String(el.attrs.id).startsWith("edit-dependency-")), false);
    h.view.openDependencies(peer, item);
  }
  assert.equal(h.overlays.length, 0);
});

test("the dialog preserves existing selections and allows removal of deleted dependencies while only drafts can block", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  assert.deepEqual(Array.from(h.view.depends), ["k2", "B:k1", "deleted:k7", "k9"]);
  assert.deepEqual(Array.from(h.view.blocks), ["k2", "k3", "k5", "B:k3", "C:k1"]);
  const rendered = h.view.renderDialog();
  assert.equal(byId(rendered, "blocks-deleted:k7"), undefined);
  for (const ref of ["k5", "C:k1"]) {
    assert.equal(byId(rendered, `blocks-${ref}`).attrs.on_click, undefined, ref);
  }
  for (const ref of ["k3", "k4"]) assert.equal(typeof byId(rendered, `blocks-${ref}`).attrs.on_click, "function");
  assert.ok(texts(byId(rendered, "depends-deleted:k7")).some((text) => text.includes("已删除")));
  await h.click(byId(rendered, "depends-deleted:k7"));
  assert.equal(h.view.depends.has("deleted:k7"), false);
  await h.click(byId(h.view.renderDialog(), "blocks-B:k2"));
  assert.equal(h.view.blocks.has("B:k2"), true);
  await h.click(byId(h.view.renderDialog(), "blocks-B:k2"));
  assert.equal(h.view.blocks.has("B:k2"), false);
});

test("saving submits both complete directions in one user command with the remote machine and empty strings", async () => {
  for (const [depends, blocks] of [[["A:k2", "B:k2"], ["A:k10", "B:k3"]], [[], []], [["B:k2"], []], [[], ["A:k10"]]]) {
    const p = dialogProps(), h = harness(p);
    h.view.init({}, h.cx);
    h.view.depends = new Set(depends); h.view.blocks = new Set(blocks);
    await h.click(byId(h.view.renderDialog(), "save-dependencies"));
    assert.equal(h.calls.length, 1);
    const call = h.calls[0];
    assert.equal(call.program, "sh");
    assert.equal(call.options.on, "remote");
    assert.deepEqual(call.args.slice(3), ["/hd.py", "topic", "task-edit", "--repo", "/r", "--topic", "A", "--task", "k1",
      "--depends", model.taskRefs("A", depends), "--blocks", model.taskRefs("A", blocks)]);
    assert.doesNotMatch(call.args[1], /HC_TERMINAL_ID|--terminal/);
    assert.deepEqual(h.closed, ["dialog"]);
  }
});

test("saving sends only changed directions and ignores toggles restored to their original value", async () => {
  const p = dialogProps(), h = harness(p);
  p.blockRefs = [...model.taskBlockRefs(topicsFixture(), p.topic, p.task), "D:k1"];
  h.view.init({}, h.cx);
  await h.click(byId(h.view.renderDialog(), "depends-deleted:k7"));
  await h.click(byId(h.view.renderDialog(), "blocks-k2"));
  await h.click(byId(h.view.renderDialog(), "blocks-k2"));
  await h.click(byId(h.view.renderDialog(), "save-dependencies"));
  const args = h.calls[0].args;
  assert.equal(args.includes("--blocks"), false);
  assert.ok(args.includes("--depends"));
  const other = harness(p);
  other.view.init({}, other.cx);
  await other.click(byId(other.view.renderDialog(), "blocks-B:k2"));
  await other.click(byId(other.view.renderDialog(), "save-dependencies"));
  const reverse = other.calls[0].args;
  assert.equal(reverse.includes("--depends"), false);
  assert.ok(reverse[reverse.indexOf("--blocks") + 1].includes("D:k1"));
});

test("a pending automatic block is selected, labelled and retained when editing another block", async () => {
  const pending = { id: "a1", from: { topic: "A", task: "k1", run: null }, op: "task-edit",
    args: { task: "k1", add_depends: "A:k1" }, state: "open", summary: "Add", reason: "Wait", created: 1 };
  const items = [pending, { ...pending, id: "a2", state: "rejected", args: { ...pending.args, task: "k2" } },
    { ...pending, id: "a3", from: { ...pending.from, run: "dev-one" }, args: { ...pending.args, task: "k2" } }];
  const topics = model.buildTopics([], model.parseTopics(snapshot("A", { k1: {}, k2: {} })
    + snapshot("B", { k1: {}, k2: {} })
    + `\n${model.APPROVALS_SEP}/r/.cc-dispatch/topics/B/approvals.json\n${JSON.stringify({ items, next: 4 })}`));
  const { topic, task } = sourceTask(topics), h = harness();
  preparePanel(h, topics);
  h.view.openDependencies(topic, task);
  const p = h.overlays.at(-1).props;
  for (const keep of [true, false]) {
    const dialog = harness(p);
    dialog.view.init({}, dialog.cx);
    assert.deepEqual([...dialog.view.blocks], ["B:k1"]);
    const row = byId(dialog.view.renderDialog(), "blocks-B:k1");
    assert.match(texts(row).join(" "), /待批准/);
    if (!keep) await dialog.click(row);
    await dialog.click(byId(dialog.view.renderDialog(), "blocks-k2"));
    await dialog.click(byId(dialog.view.renderDialog(), "save-dependencies"));
    assert.deepEqual(dialog.calls[0].args.slice(-2), ["--blocks", keep ? "B:k1,k2" : "k2"]);
  }
});

test("selected self and deleting dependencies show their reason and can be removed", async () => {
  const topics = topicsFixture(), { task } = sourceTask(topics);
  task.dependsOn = ["A:k1", "D:k1"];
  const p = dialogProps(topics), h = harness(p);
  h.view.init({}, h.cx);
  for (const [ref, reason] of [["k1", /自己|自身/], ["D:k1", /正在删除|删除中/]]) {
    const row = byId(h.view.renderDialog(), `depends-${ref}`);
    assert.ok(h.view.depends.has(ref));
    assert.match(texts(row).join(" "), reason);
    await h.click(row);
    assert.equal(h.view.depends.has(ref), false);
  }
  await h.click(byId(h.view.renderDialog(), "save-dependencies"));
  assert.deepEqual(h.calls[0].args.slice(-2), ["--depends", ""]);
});

test("failures keep the dialog and selections, report Chinese reasons and a cycle path, and allow retry", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  h.view.depends = new Set(["k2"]); h.view.blocks = new Set(["B:k3"]);
  for (const failure of ["DEPENDS_INVALID", "DEPENDS_SELF", "DEPENDS_MISSING", "DEPENDS_CYCLE", "TASK_BOUND", "TOPIC_STOPPING"]) {
    h.respond({ code: 3, stdout: failure === "DEPENDS_CYCLE" ? "CYCLE=A:k1 -> B:k3 -> A:k1" : "", stderr: `FAILURE=${failure}\nEnglish failure` });
    await h.click(byId(h.view.renderDialog(), "save-dependencies"));
    assert.equal(h.closed.length, 0);
    assert.deepEqual(Array.from(h.view.depends), ["k2"]);
    assert.deepEqual(Array.from(h.view.blocks), ["B:k3"]);
    assert.equal(h.view.sending, false);
    assert.match(h.view.failed, /[\u4e00-\u9fff]/);
    assert.ok(byId(h.view.renderDialog(), "dependency-error"));
    if (failure === "DEPENDS_CYCLE") assert.match(h.view.failed, /依赖成环[\s\S]*A:k1 -> B:k3 -> A:k1/);
    if (failure === "TOPIC_STOPPING") assert.match(h.view.failed, /终止/);
  }
  h.respond({ code: 0, stdout: "TASK=k1" });
  await h.click(byId(h.view.renderDialog(), "save-dependencies"));
  assert.deepEqual(h.closed, ["dialog"]);
});

test("saving prevents duplicate submissions and changing selections while the command is pending", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  let resolve;
  await h.click(byId(h.view.renderDialog(), "depends-deleted:k7"));
  h.respond(new Promise((done) => { resolve = done; }));
  const rendered = h.view.renderDialog(), save = byId(rendered, "save-dependencies").attrs.on_click;
  save({}, h.cx); save({}, h.cx);
  byId(rendered, "depends-k10").attrs.on_click({}, h.cx);
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  assert.equal(h.view.depends.has("k10"), false);
  const sending = h.view.renderDialog();
  assert.equal(byId(sending, "save-dependencies").attrs.on_click, undefined);
  assert.equal(byId(sending, "depends-k10").attrs.on_click, undefined);
  resolve({ code: 0, stdout: "TASK=k1" });
  await h.flush();
  assert.deepEqual(h.closed, ["dialog"]);
});

test("a successful dependency edit refreshes panel snapshots on their next render", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  h.setProps({});
  const panel = new h.View();
  panel.init({}, h.cx);
  let refreshed = 0;
  Object.assign(panel, { context: () => ({ on: "remote", folder: "/r" }), ctxKey: "remote|/r", liveKey: "",
    refresh: () => refreshed++, renderTopics: node, renderFooter: node });
  h.setProps(p);
  h.view.depends.clear(); h.view.blocks.clear();
  await h.click(byId(h.view.renderDialog(), "save-dependencies"));
  h.setProps({});
  panel.render(h.cx);
  await h.flush();
  assert.equal(refreshed, 1);
});

test("Task summaries show reverse dependencies from local, cross-Topic, bound and archived Tasks", () => {
  const topics = topicsFixture(), { topic, task } = sourceTask(topics), h = harness();
  preparePanel(h, topics);
  h.view.openTaskSummary(topic, task);
  const p = h.overlays.at(-1).props;
  assert.equal(p.blocks.length, 5);
  assert.ok(p.blocks.some((line) => line.includes("Beta·k3")));
  assert.ok(p.blocks.some((line) => line.includes("Bound")));
  const summary = h.view.renderTaskSummary(colors("dark"), p);
  assert.ok(texts(summary).includes("在等它的 Task"));
  assert.ok(texts(summary).some((text) => text.includes("Beta·k3")));
  assert.ok(texts(h.view.renderTaskSummary(colors("dark"), { ...p, blocks: [] })).includes("没有 Task 在等它。"));
});

test("both themes use tokens and a vertical scrolling list with flexible, wrapping Task labels", () => {
  for (const mode of ["dark", "light"]) {
    const p = dialogProps(), h = harness(p, mode), tokens = new Set(Object.values(colors(mode)));
    p.groups[0].tasks[0].title = "长标题".repeat(100);
    h.view.init({}, h.cx);
    const rendered = h.view.renderDialog(), list = byId(rendered, "dependency-list");
    assert.equal(list.attrs.overflow_y_scrollbar, true);
    assert.equal(list.attrs.min_h, 0);
    assert.ok(byId(list, "dependency-depends"));
    assert.ok(byId(list, "dependency-blocks"));
    const row = byId(list, "depends-k2");
    assert.ok(elements(row).some((el) => el.attrs.min_w === 0 && el.attrs.flex_1));
    assert.equal(elements(row).some((el) => el.attrs.truncate), false);
    for (const element of elements(rendered)) for (const key of ["bg", "text_color", "border_color"]) {
      if (element.attrs[key] != null) assert.ok(tokens.has(element.attrs[key]), `${mode}: ${key}=${element.attrs[key]}`);
    }
  }
});
