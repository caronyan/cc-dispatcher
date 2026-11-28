import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import vm from "node:vm";
import * as model from "../cc-dispatch/mods/cc-dispatch/model.js";
import * as loader from "../cc-dispatch/mods/cc-dispatch/loader.js";

const item = (id = "a1", extra = {}) => ({
  id, from: { topic: "B", task: "k2", terminal: "term-2", agent: "codex", run: "/r/.cc-dispatch/dev-b" },
  op: "task-edit", args: { task: "k1", depends: "B:k2", blocks: "", detail: "完整说明\n第二行" },
  summary: "让这个 Task 等待接口完成", reason: "需要先拿到稳定接口", created: 10, state: "open",
  decided_at: null, note: null, result: null, ...extra,
});
const section = (sep, path, value) => `\n${sep}${path}\n${JSON.stringify(value)}`;
const topicDump = (id, title = id, repo = "/r", tasks = {}) =>
  section(model.TOPIC_SEP, `${repo}/.cc-dispatch/topics/${id}/topic.json`, { id, title, tasks });
const approvalDump = (items) => section(model.APPROVALS_SEP, "/r/.cc-dispatch/topics/A/approvals.json", { items, next: 20 });
const fixture = (items = [item()]) => model.buildTopics([], model.parseTopics(
  topicDump("A", "目标 Topic") + approvalDump(items) + topicDump("B", "申请方 Topic")));
const target = (topics) => topics.find((topic) => topic.id === "A");

test("approval parsing counts only open items, sorts pending oldest first and history by most recent decision", () => {
  const values = [item("a2", { created: 20 }), item("a1"),
    ...["approved", "failed", "rejected", "answered", "withdrawn"].map((state, i) =>
      item(`a${i + 3}`, { state, created: i + 1, decided_at: i + 30 }))];
  const approvals = model.parseApprovals(JSON.stringify({ items: values, next: 8 }));
  assert.equal(approvals.readFailed, false);
  assert.deepEqual(approvals.open.map((entry) => entry.id), ["a1", "a2"]);
  assert.deepEqual(approvals.history.map((entry) => entry.state), ["withdrawn", "answered", "rejected", "failed", "approved"]);
  assert.equal(approvals.open[0].createdAt, 10000);
  assert.equal(approvals.history[0].decidedAt, 34000);
  assert.equal(values[0].createdAt, undefined, "raw records are not changed");
});

test("terminal applicants parse without a Topic but require a terminal and no task or run", () => {
  const from = { topic: null, task: null, run: null, terminal: "term-4", agent: "codex" };
  const parse = (identity) => model.parseApprovals(JSON.stringify({ items: [item("a1", { from: identity })], next: 2 }));
  assert.equal(parse(from).readFailed, false);
  assert.deepEqual(parse(from).open[0].from, from);
  for (const invalid of [{ ...from, terminal: null }, { ...from, terminal: "" },
    { ...from, topic: "" }, { ...from, task: "k1" }, { ...from, run: "dev-one" }, {}]) {
    assert.equal(parse(invalid).readFailed, true, JSON.stringify(invalid));
  }
});

test("damaged approval files are flagged without inventing pending or handled entries; missing files are empty", () => {
  assert.deepEqual(model.parseApprovals(null), { open: [], history: [], readFailed: false });
  for (const text of ["", "{broken", "[]", "null", "{}", '{"items":{}}', JSON.stringify({ items: [null] }),
    JSON.stringify({ items: [item("a1", { state: "unknown" })] }),
    JSON.stringify({ items: [item("a1", { created: "10" })] }),
    JSON.stringify({ items: [item("a1", { result: { ok: false, output: {} } })] })]) {
    assert.deepEqual(model.parseApprovals(text), { open: [], history: [], readFailed: true }, text);
  }
  const dump = topicDump("A") + `\n${model.APPROVALS_SEP}/r/.cc-dispatch/topics/A/approvals.json\n{broken`
    + topicDump("B");
  const topics = model.buildTopics([], model.parseTopics(dump));
  assert.equal(target(topics).approvals.readFailed, true);
  assert.equal(topics.find((topic) => topic.id === "B").approvals.readFailed, false);
});

test("LIST_SCRIPT reads approvals alongside Topics through loadRuns and isolates every older section parser", async () => {
  const repo = mkdtempSync(join(tmpdir(), "cc-approvals-")), root = join(repo, ".cc-dispatch");
  try {
    const topicDir = join(root, "topics/A"), runDir = join(root, "dev-one");
    mkdirSync(topicDir, { recursive: true }); mkdirSync(runDir, { recursive: true });
    writeFileSync(join(topicDir, "topic.json"), JSON.stringify({ id: "A", title: "Target", tasks: {} }));
    writeFileSync(join(topicDir, "backlog.json"), JSON.stringify({ items: [{ id: "b1", text: "idea" }] }));
    writeFileSync(join(topicDir, "approvals.json"), JSON.stringify({ items: [item()], next: 2 }));
    writeFileSync(join(runDir, "asks.json"), JSON.stringify({ q: { kind: "question", title: "Question" } }));
    writeFileSync(join(runDir, "state.json"), JSON.stringify({ finished: 30 }));
    const dump = execFileSync("sh", ["-c", model.LIST_SCRIPT, "test", root], { encoding: "utf8" });
    const loaded = await loader.loadRuns({ sh: async () => ({ code: 0, stdout: dump }) }, repo, []);
    assert.equal(loaded.error, null);
    assert.deepEqual(target(loaded.topics).approvals.open.map((entry) => entry.id), ["a1"]);
    assert.equal(target(loaded.topics).backlog[0].id, "b1");
    assert.equal(loaded.states[runDir].finished, 30);
    assert.equal(model.parseAsks(dump)[runDir].asks.q.title, "Question");
    assert.deepEqual(model.parseMetaDump(dump), []);
    assert.deepEqual(model.parseControls(dump), {});
    assert.deepEqual(model.parseArchived(dump), {});
    assert.deepEqual(model.parseMessageSummaries(dump), []);
    writeFileSync(join(topicDir, "approvals.json"), "{broken");
    const broken = execFileSync("sh", ["-c", model.LIST_SCRIPT, "test", root], { encoding: "utf8" });
    assert.equal(model.parseTopics(broken).A.approvals.readFailed, true);
  } finally { rmSync(repo, { recursive: true, force: true }); }
});

test("approval marker strings within JSON values cannot cut or forge sections", () => {
  const text = `hello ${model.APPROVALS_SEP}fake\n${model.TOPIC_SEP}fake\n${model.STATE_SEP}fake`;
  const dump = topicDump("A", text) + section(model.BACKLOG_SEP, "/r/.cc-dispatch/topics/A/backlog.json",
    { items: [{ id: "b1", text }] }) + approvalDump([item("a1", { summary: text, reason: text })])
    + topicDump("B") + section(model.STATE_SEP, "/r/.cc-dispatch/dev-b/state.json", { title: text })
    + section(model.MESSAGE_SUMMARY_SEP, "/r/.cc-dispatch/messages/A.summary.json", { unacked: 1 });
  const parsed = model.parseTopics(dump);
  assert.deepEqual(Object.keys(parsed), ["A", "B"]);
  assert.equal(parsed.A.topic.title, text);
  assert.equal(parsed.A.backlog.items[0].text, text);
  assert.equal(parsed.A.approvals.open[0].reason, text);
  assert.equal(model.parseStates(dump)["/r/.cc-dispatch/dev-b"].title, text);
  assert.equal(model.parseMessageSummaries(dump).length, 1);
});

test("operations translate every supported action and retain every literal argument including clears and booleans", () => {
  for (const op of ["task-add", "task-edit", "task-rm", "backlog-add", "backlog-edit", "backlog-rm", "request", "abandon", "pause", "resume"]) {
    const view = model.approvalOperation(item("a1", { op }));
    assert.match(view.title, /[\u4e00-\u9fff]/);
    assert.ok(view.title.includes(op));
  }
  const operation = model.approvalOperation(item("a1", { args: {
    depends: "", blocks: "B:k1,k3", "from-backlog": "b1", force: true, cancel: false,
    target: "new_tab", type: "dispatch", detail: "line1\nline2", title: "", extra: "literal",
  } }));
  assert.deepEqual(operation.args.map((arg) => arg.text),
    ["清空", "B:k1,k3", "b1", "是", "否", "新标签页", "派发 Task", "line1\nline2", "空字符串", "literal"]);
  assert.ok(operation.args.some((arg) => arg.label === "来源条目（--from-backlog）"));
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
const colors = (mode = "dark") => Object.fromEntries(["ansi1", "ansi2", "ansi3", "accent", "foreground", "background", "muted",
  "border", "popover", "selected", "input", "hover", "raised", "solid", "solid_foreground", "done", "working"]
  .map((key) => [key, `${mode}-${key}`]));
const source = readFileSync(new URL("../cc-dispatch/mods/cc-dispatch/main.js", import.meta.url), "utf8")
  .replace(/^import .*;\n/gm, "").replace("export default class Dispatch", "class Dispatch");

function harness(initialProps = {}, mode = "dark") {
  let props = initialProps, result = { code: 0, stdout: "STATE=approved", stderr: "" };
  const calls = [], overlays = [], closed = [], pending = [];
  const context = vm.createContext({
    ...model, ...loader, View: class {},
    h_flex: node, v_flex: node, div: node, svg: node, image: node, Textarea: { new: node },
    ScrollHandle: { new: () => ({ scroll_to_item() {} }) },
    TextareaState: { new: ({ value = "" } = {}) => ({ text: value, value() { return this.text; }, on() {} }) },
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
const dialogProps = (entry = model.parseApprovals(JSON.stringify({ items: [item()], next: 2 })).open[0]) => ({
  role: "approval", topic: { id: "A", title: "目标 Topic" }, item: entry, applicant: "申请方 Topic · Codex",
  repo: "/r", hd: "/hd.py", on: "remote", overlay: "dialog",
});
function preparePanel(h, topics = fixture()) {
  h.view.init({}, h.cx);
  Object.assign(h.view, { topics, repo: "/r", ctx: { on: "remote", folder: "/r" }, runs: [] });
}
function attachPanel(h, p) {
  h.setProps({});
  const panel = new h.View();
  panel.init({}, h.cx);
  let refreshed = 0;
  Object.assign(panel, { context: () => ({ on: "remote", folder: "/r" }), ctxKey: "remote|/r", liveKey: "",
    refresh: () => refreshed++, renderTopics: node, renderFooter: node });
  h.setProps(p);
  return { panel, count: () => refreshed };
}

test("pending approvals share the decision area with questions, show applicant/reason/age and open a remote dialog", async () => {
  const topics = fixture(), topic = target(topics), h = harness();
  preparePanel(h, topics);
  h.view.itemsOf = () => [{ id: "q1", kind: "question", title: "已有待决", asked: 1000, options: [] }];
  topic.tasks.push({ id: "k1", title: "任务", run: { dir: "/r/.cc-dispatch/dev-a" } });
  const box = h.view.renderAsks(colors(), topic), row = byId(box, "approval-A|a1");
  for (const text of ["需要你处理", "2", "已有待决", "让这个 Task 等待接口完成", "申请方：申请方 Topic · Codex", "理由：需要先拿到稳定接口"]) {
    assert.ok(texts(box).includes(text), text);
  }
  assert.ok(texts(row).includes(model.ago(10000)));
  await h.click(row);
  const p = h.overlays.at(-1).props;
  assert.equal(p.role, "approval");
  assert.equal(p.on, "remote");
  assert.equal(p.repo, "/r");
  assert.equal(p.topic.id, "A");
  assert.equal(p.applicant, "申请方 Topic · Codex");
  assert.equal(p.item.args.detail, "完整说明\n第二行");
});

test("history is folded by default, shows the five most recent results and opens a read-only result", async () => {
  const entries = Array.from({ length: 7 }, (_, i) => item(`a${i + 1}`, {
    state: i === 6 ? "failed" : "answered", decided_at: 20 + i, note: `附言 ${i}`,
    result: i === 6 ? { ok: false, failure: "TASK_BOUND", output: "Task is already bound" } : null,
  }));
  const topics = fixture(entries), h = harness(), topic = target(topics);
  preparePanel(h, topics);
  let box = h.view.renderAsks(colors(), topic);
  assert.equal(byId(box, "approval-A|a7"), undefined);
  assert.ok(texts(box).includes("已处理的修改申请 · 最近 5 条"));
  await h.click(byId(box, "approval-history-A"));
  box = h.view.renderAsks(colors(), topic);
  assert.deepEqual(elements(box).map((el) => el.attrs.id).filter((id) => /^approval-A\|/.test(id)), ["approval-A|a7", "approval-A|a6", "approval-A|a5", "approval-A|a4", "approval-A|a3"]);
  assert.ok(texts(byId(box, "approval-A|a7")).some((text) => text.includes("执行失败") && text.includes("TASK_BOUND")));
  await h.click(byId(box, "approval-A|a7"));
  h.setProps({ ...h.overlays.at(-1).props, overlay: "dialog" });
  h.view.init({}, h.cx);
  const dialog = h.view.renderDialog();
  assert.ok(texts(dialog).includes("Task is already bound"));
  assert.ok(texts(dialog).includes("附言 6"));
  assert.equal(byId(dialog, "approval-approve"), undefined);
  assert.equal(byId(dialog, "approval-answer"), undefined);
});

test("unreadable approvals remain visible as an error, retain Topic priority and mark footer counts incomplete", () => {
  const topics = fixture(), topic = target(topics), h = harness();
  topic.approvals = { open: [], history: [], readFailed: true };
  preparePanel(h, topics);
  assert.match(texts(h.view.renderAsks(colors(), topic)).join(" "), /读取失败.*approvals\.json/);
  assert.equal(Boolean(h.view.topicActive(topic)), true);
  assert.ok(model.orderTopics(topics).running.includes(topic));
  h.view.split = () => ({ mine: topics });
  assert.match(texts(h.view.renderFooter(colors())).join(" "), /修改申请读取失败，计数不完整/);
});

test("only pending approvals add to footer counts and keep an otherwise ended Topic above old history", () => {
  const topics = fixture([item(), item("a2", { state: "rejected", decided_at: 20 })]), h = harness(), topic = target(topics);
  preparePanel(h, topics);
  h.view.split = () => ({ mine: topics });
  assert.match(texts(h.view.renderFooter(colors())).join(" "), /1 项等你/);
  assert.equal(Boolean(h.view.topicActive(topic)), true);
  assert.ok(model.orderTopics(topics).running.includes(topic));
  assert.equal(topic.updatedAt, 20000);
});

test("applicant titles use the target repository; deleted applicants retain the Topic id", () => {
  const topics = fixture(), h = harness(), topic = target(topics);
  topics.unshift(...model.buildTopics([], model.parseTopics(topicDump("B", "错误仓库", "/other"))));
  preparePanel(h, topics);
  assert.equal(h.view.approvalApplicant(topic, item()), "申请方 Topic · Codex");
  assert.match(h.view.approvalApplicant(topic, item("a1", { from: { topic: "deleted", agent: "claude" } })), /deleted（已删除）.*Claude/);
});

test("terminal applicants appear in approval lists and dialogs without a temporary Topic", async () => {
  const entry = item("a1", { from: { topic: null, task: null, run: null, terminal: "term-4", agent: "codex" } });
  const topics = fixture([entry]), topic = target(topics), h = harness();
  preparePanel(h, topics);
  const row = byId(h.view.renderAsks(colors(), topic), "approval-A|a1");
  assert.ok(row);
  assert.match(texts(row).join(" "), /来自终端 term-4（Codex）/);
  await h.click(row);
  const props = h.overlays.at(-1).props;
  assert.equal(props.applicant, "来自终端 term-4（Codex）");
  h.setProps({ ...props, overlay: "dialog" });
  h.view.init({}, h.cx);
  const text = texts(h.view.renderDialog()).join(" ");
  assert.match(text, /来自终端 term-4（Codex）/);
  assert.doesNotMatch(text, /Topic null|已删除/);
  assert.ok(byId(h.view.renderDialog(), "approval-approve"));
});

test("the dialog shows the complete request, operation and arguments in both themes with a scrollable body", () => {
  for (const mode of ["dark", "light"]) {
    const p = dialogProps(), h = harness(p, mode), tokens = new Set(Object.values(colors(mode)));
    h.view.init({}, h.cx);
    const rendered = h.view.renderDialog(), text = texts(rendered);
    for (const word of ["申请方 Topic · Codex", p.item.summary, p.item.reason, "修改 Task 草稿（task-edit）",
      "Task（--task）", "要等的 Task（--depends）", "在等它的 Task（--blocks）", "B:k2", "清空", "完整说明\n第二行",
      "批准并执行（推荐）", "驳回", "其他回复"]) assert.ok(text.includes(word), word);
    assert.equal(byId(rendered, "approval-body").attrs.overflow_y_scrollbar, true);
    assert.equal(byId(rendered, "approval-body").attrs.min_h, 0);
    assert.equal(byId(rendered, "approval-approve").attrs.bg, `${mode}-solid`);
    assert.equal(byId(rendered, "approval-reply"), undefined);
    for (const element of elements(rendered)) for (const key of ["bg", "text_color", "border_color"]) {
      if (element.attrs[key] != null) assert.ok(tokens.has(element.attrs[key]), `${mode}: ${key}=${element.attrs[key]}`);
    }
  }
});

test("approve and reject send literal argv with remote I/O, optional notes, then close and refresh", async () => {
  for (const [decision, note] of [["approve", ""], ["reject", ""], ["approve", "保留这段\n$(literal) `text`"], ["reject", "-附言"]]) {
    const p = dialogProps(), h = harness(p);
    h.view.init({}, h.cx);
    const refresh = attachPanel(h, p);
    if (note) await h.click(byId(h.view.renderDialog(), "approval-other"));
    h.view.noteBox.text = note;
    h.respond({ code: 0, stdout: `STATE=${decision === "approve" ? "approved" : "rejected"}` });
    await h.click(byId(h.view.renderDialog(), `approval-${decision}`));
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].program, "sh");
    assert.equal(h.calls[0].options.on, "remote");
    assert.deepEqual(h.calls[0].args.slice(3), ["/hd.py", "topic", "approval-decide", "--repo", "/r", "--topic", "A",
      "--id", "a1", `--decision=${decision}`, ...(note ? [`--note=${note}`] : [])]);
    assert.doesNotMatch(h.calls[0].args[1], /HC_TERMINAL_ID|hc send/);
    assert.deepEqual(h.closed, ["dialog"]);
    h.setProps({});
    refresh.panel.render(h.cx); await h.flush();
    assert.equal(refresh.count(), 1);
  }
});

test("collapsing a draft note omits it from both approve and reject", async () => {
  for (const decision of ["approve", "reject"]) {
    const h = harness(dialogProps());
    h.view.init({}, h.cx);
    await h.click(byId(h.view.renderDialog(), "approval-other"));
    h.view.noteBox.text = "草稿";
    await h.click(byId(h.view.renderDialog(), "approval-other"));
    await h.click(byId(h.view.renderDialog(), `approval-${decision}`));
    assert.equal(h.calls[0].args.some((arg) => arg.startsWith("--note=")), false);
  }
});

test("interrupted decisions and closing topics explain why a new decision was declined", async () => {
  for (const [failure, words] of [["APPROVAL_INTERRUPTED", /中断/], ["TOPIC_ARCHIVED", /归档/],
    ["TOPIC_DELETING", /删除/], ["TOPIC_MESSAGES_PENDING", /通知|消息/], ["TOPIC_STOPPING", /终止/]]) {
    const h = harness(dialogProps());
    h.view.init({}, h.cx);
    h.respond({ code: 3, stdout: `FAILURE=${failure}` });
    await h.click(byId(h.view.renderDialog(), "approval-reject"));
    assert.match(h.view.failed, words);
    assert.doesNotMatch(h.view.failed, /已批准/);
  }
});

test("other replies reveal a required note, reject whitespace even through the command guard and send answer", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  await h.click(byId(h.view.renderDialog(), "approval-other"));
  assert.ok(byId(h.view.renderDialog(), "approval-reply"));
  assert.equal(byId(h.view.renderDialog(), "approval-answer").attrs.on_click, undefined);
  h.view.noteBox.text = " \n ";
  h.view.decideApproval(h.cx, p, "answer", () => {});
  await h.flush();
  assert.equal(h.calls.length, 0);
  h.view.noteBox.text = "-请先提供接口说明";
  h.respond({ code: 0, stdout: "STATE=answered" });
  await h.click(byId(h.view.renderDialog(), "approval-answer"));
  assert.deepEqual(h.calls[0].args.slice(-2), ["--decision=answer", "--note=-请先提供接口说明"]);
  assert.deepEqual(h.closed, ["dialog"]);
});

test("decision failures keep the dialog, draft and reply editor open and allow retry", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  await h.click(byId(h.view.renderDialog(), "approval-other"));
  h.view.noteBox.text = "保留我的附言";
  h.respond({ code: 3, stdout: "", stderr: "FAILURE=READ_FAILED\ncannot read approvals" });
  await h.click(byId(h.view.renderDialog(), "approval-reject"));
  assert.deepEqual(h.closed, []);
  assert.equal(h.view.noteBox.value(), "保留我的附言");
  assert.equal(h.view.replying, true);
  assert.equal(h.view.sending, false);
  assert.match(h.view.failed, /处理修改申请失败.*READ_FAILED.*cannot read approvals/);
  assert.ok(byId(h.view.renderDialog(), "approval-error"));
  h.respond({ code: 0, stdout: "STATE=rejected" });
  await h.click(byId(h.view.renderDialog(), "approval-reject"));
  assert.deepEqual(h.closed, ["dialog"]);
});

test("APPROVAL_CLOSED informs the user, refreshes the panel and disables further decisions", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  const refresh = attachPanel(h, p);
  h.view.noteBox.text = "保留";
  h.respond({ code: 3, stdout: "", stderr: "FAILURE=APPROVAL_CLOSED\nalready closed" });
  await h.click(byId(h.view.renderDialog(), "approval-approve"));
  assert.deepEqual(h.closed, []);
  assert.match(h.view.failed, /已被处理.*刷新/);
  assert.equal(h.view.noteBox.value(), "保留");
  assert.ok(texts(h.view.renderDialog()).includes("未发送的附言"));
  assert.ok(texts(h.view.renderDialog()).includes("保留"));
  assert.equal(byId(h.view.renderDialog(), "approval-approve"), undefined);
  h.view.decideApproval(h.cx, p, "approve", () => {});
  await h.flush();
  assert.equal(h.calls.length, 1);
  h.setProps({});
  refresh.panel.render(h.cx); await h.flush();
  assert.equal(refresh.count(), 1);
});

test("an approved operation that fails stays open with the reason, refreshes and cannot execute again", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  const refresh = attachPanel(h, p);
  await h.click(byId(h.view.renderDialog(), "approval-other"));
  h.view.noteBox.text = "请保留原有标题";
  h.respond({ code: 0, stdout: "cannot edit a bound Task\nFAILURE=TASK_BOUND\nSTATE=failed" });
  await h.click(byId(h.view.renderDialog(), "approval-approve"));
  assert.deepEqual(h.closed, []);
  assert.match(h.view.failed, /已批准.*执行失败.*TASK_BOUND.*cannot edit a bound Task/);
  const dialog = h.view.renderDialog();
  assert.ok(byId(dialog, "approval-result"));
  assert.ok(texts(dialog).some((text) => text.includes("cannot edit a bound Task")));
  assert.ok(texts(dialog).includes("请保留原有标题"));
  assert.equal(byId(dialog, "approval-approve"), undefined);
  h.view.decideApproval(h.cx, p, "approve", () => {});
  await h.flush();
  assert.equal(h.calls.length, 1);
  h.setProps({});
  refresh.panel.render(h.cx); await h.flush();
  assert.equal(refresh.count(), 1);
});

test("an in-flight decision disables all choices and repeated click handlers cannot submit twice", async () => {
  const p = dialogProps(), h = harness(p);
  h.view.init({}, h.cx);
  let resolve;
  h.respond(new Promise((done) => { resolve = done; }));
  const dialog = h.view.renderDialog();
  byId(dialog, "approval-approve").attrs.on_click({}, h.cx);
  byId(dialog, "approval-approve").attrs.on_click({}, h.cx);
  byId(dialog, "approval-reject").attrs.on_click({}, h.cx);
  await Promise.resolve();
  assert.equal(h.calls.length, 1);
  for (const id of ["approval-approve", "approval-reject", "approval-other"]) {
    assert.equal(byId(h.view.renderDialog(), id).attrs.on_click, undefined);
  }
  resolve({ code: 0, stdout: "STATE=approved" });
  await h.flush();
  assert.deepEqual(h.closed, ["dialog"]);
});

test("approval results use the final state and failure from multiline output", async () => {
  const h = harness(dialogProps());
  h.view.init({}, h.cx);
  h.respond({ code: 0, stdout: "STATE=approved\nFAILURE=earlier\ninvalid task\nFAILURE=TASK_BOUND\nSTATE=failed\n" });
  await h.click(byId(h.view.renderDialog(), "approval-approve"));
  assert.deepEqual(h.closed, []);
  assert.equal(h.view.approvalState, "failed");
  assert.equal(h.view.approvalResult.failure, "TASK_BOUND");
});
