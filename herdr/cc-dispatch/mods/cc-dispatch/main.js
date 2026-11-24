// Topics contain Tasks, and each bound Task shows its run's helpers. Historical runs use the
// same view through implicit, single-Task Topics. Only this file imports Herdr.
// Only this file imports Herdr: model.js and loader.js are tested under node.
import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, TextView, TextareaState, Textarea } from "gpui-base";
import { exec, hc, run, spaces, agents, terminals, panes, focused, theme, settings, layout, openOverlay, closeOverlay, readTextFile, knownAgents, checking, props as blockProps } from "herdr";
import { callTags, callStage, runStage, cardCounts, cardView, CARD_WORDS, parkedWhy, STAGE_WORDS, splitBySpace, ago, handoffAsks, handoffText, baseName, agentTag, agentLabel, weakIsolation, canHandOver, AGENTS, resultMarkdown, roundsMarkdown, resultDoc, taskDoc, MARKDOWN_LIMIT, controlOps, controlBanner, needsTakeover, takeoverPrompt, takeoverBanner, runQuotaAgent, quotaView, pendingItems, itemLine, answerRecord, answerText, answerWords, failureWord, callLabel, taskGroup, groupTasks, requestState, topicDir } from "./model.js";
import { findRepo, loadRuns, loadReport, loadTasks, loadDiff, loadEvents, loadStopReport, loadHandoff, loadHandoffPrompt, controlRun, handOver, earlierReports, loadStats, loadBg, loadOutput, loadLive, loadQuota, archiveRun, saveAnswer, topicCmd, loadSummary } from "./loader.js";
import { assignTasks, topicTasks, bgView, bgSummary, liveMarkdown, BG_MORE } from "./bg.js";
import { topicTotals, callSpend, fmtTok, fmtDur } from "./stats.js";

const PANEL = "cc-dispatch-panel"; // the layout node the toggle shows and hides
const POLL = 4000;                 // meta.json re-read while shown; live status comes from terminals()
const HISTORY = 6;                 // ended runs shown before "Show n older"
const LIVE_POLL = 2000;            // a running background task's dialog re-reads its processes
const QUOTA_POLL = 30000;          // the main agents' quota (hd_usage.py keeps magpie's answer 60 s)
const TASK_KINDS = ["research", "review", "dev", "fix", "test", "retro"];
/** What each Task kind is for, what it may do, its limits and what its detail should say, shown under the kind picker. */
const KIND_GUIDE = {
  research: { use: "调研一个问题，或出一份能直接拿去实现的方案。", can: "读代码、查资料、做小实验，交回结论和证据；要方案时另给方案对比和实施步骤。", limit: "只读，不改你的代码。", hint: "写要回答的问题或要做的决定、背景约束、已排除的选项" },
  review: { use: "审查一份方案或一段代码改动。", can: "多方各自审查后合并结论，再找反例验证；默认把确认的问题修掉。", limit: "修复留在工作区、不提交；需要重新设计的列为后续任务，先问你。", hint: "写审查对象（方案文件、提交范围或分支）和需求背景；只要报告就写“只审不修”" },
  dev: { use: "按方案实现一项较大的改动。", can: "拆成任务卡并行写代码，逐张验收、合并、跑全量测试。", limit: "开工前会请你确认拆分；小改动和单个 bug 不必用它。", hint: "写方案或需求、验收标准、不能动的地方" },
  fix: { use: "修复已经确认、修法明确的问题。", can: "改代码并补回归测试，测试通过后放进工作区。", limit: "不提交；需要重新设计的问题交给 dev。", hint: "写问题现象、复现方法、期望的行为" },
  test: { use: "跑测试或补测试，查清失败原因。", can: "运行指定范围的测试，把失败分成产品问题、测试问题和环境问题。", limit: "只出报告，不修产品代码。", hint: "写测试范围（文件、提交范围，或全部）" },
  retro: { use: "复盘已经结束的运行，改进做法。", can: "读运行记录，修改 skill 规则或项目文档。", limit: "不改产品代码，不调用其他职责。", hint: "写要复盘的运行或 Topic，以及你关心的问题" },
};
const outputValue = (out, key) => (out ?? "").split("\n").find((line) => line.startsWith(`${key}=`))?.slice(key.length + 1) ?? null;
const commandError = (out) => (out || "hd_dispatch.py 运行失败").split("\n").filter((line) => line && !line.startsWith("FAILURE=")).slice(-2).join(" ");

const io = (on) => ({
  sh: (script, args = []) => exec("sh", ["-c", script, "cc-dispatch-panel", ...args], { on })
    .catch((e) => ({ code: 127, stdout: "", stderr: String(e.message ?? e) })),
  py: (script, args = []) => exec("python3", ["-I", "-c", script, ...args], { on })
    .catch((e) => ({ code: 127, stdout: "", stderr: String(e.message ?? e) })),
  readText: (path) => readTextFile(path, { on }).catch(() => null),
});

// Where a helper lives. agent.focus only picks the agent an { "agent": "focused" } block shows, and
// helpers started with hc run have no pane: go to the pane showing it if one does, else to the
// Claude that dispatched it, and peek at the helper over that tab (as the Agents list's click does).
const paneOf = (address) => (address && (panes() ?? []).find((p) => p.terminal === address)) || null;
function goTo(address, parent) {
  const own = paneOf(address);
  if (own) return run("pane.focus", { pane: own.pane });
  const home = paneOf(parent);
  if (home) run("pane.focus", { pane: home.pane });
  run("terminal.peek", { terminal: address });
}

// Work started from render waits for the render to end (cx.notify() throws during render).
const later = (cx, fn) => cx.spawn(async (cx) => { await cx.sleep(0); return fn(cx); });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const f = find(child, id); if (f) return f; }
  return null;
}

// ---- Look (theme tokens only) ----

function S() {
  const b = Number(settings().ui_font_size) || 13;
  return { title: b + 1, body: b + 0.5, small: b - 0.5, label: b - 1, dialog: b + 2 };
}
const mono = () => settings().font_family || "Menlo";
const icon = (name, size, color) => svg(`mods/cc-dispatch/icons/${name}.svg`).size(size).flex_none().text_color(color);
const mark = (size, color) => svg("mods/cc-dispatch/mark.svg").size(size).flex_none().text_color(color);
const stop = (_e, cx) => cx.stop_propagation();

// Stage colors: green once the work landed, accent while Claude still has to look, red/yellow when it went wrong.
function stageColor(t, stage) {
  return {
    blocked: t.blocked, lost: t.ansi1, failed: t.ansi1, offline: t.ansi3, retrying: t.ansi3, paused: t.ansi3, working: t.working, bad: t.ansi3, collect: t.accent, await: t.accent,
    review: t.accent, ok: t.done, merged: t.ansi2, done: t.ansi2, parked: t.muted, ended: t.muted,
  }[stage] ?? t.muted;
}
const CARD_COLORS = (t) => ({ merged: t.ansi2, done: t.ansi2, accepting: t.accent, running: t.working, pending: t.selected, parked: t.muted });
// Short, so the key stays on one line in a 380px panel.

// A run's dot: its most urgent stage, unless the person paused or stopped the run, which says more.
const dot = (t, stage, control = null) => control?.state === "paused" ? icon("pause-dot", 10, t.ansi3)
  : control?.state === "stopping" ? icon("ring", 10, t.ansi1).spin(900)
  : control?.state === "stopped" ? icon("square", 10, t.muted)
  : control?.state === "handoff" ? icon("handover", 10, t.accent)
  : stage === "working"
  ? icon("ring", 10, t.working).spin(900)
  : stage === "ended" || stage === "parked"
    ? div().w(8).h(8).flex_none().rounded_full().border(1.5).border_color(t.muted)
    : div().w(8).h(8).flex_none().rounded_full().bg(stageColor(t, stage));

// A helper's dot says only whether its terminal is open: spinning while it works, filled while the
// terminal is open, hollow once it is closed. What became of the work is the stage tag beside it.
// A helper the run's pause stopped shows the pause mark where its spinner was.
const termDot = (t, c) => c.held && c.state === "live" && c.status !== "working" ? icon("pause-dot", 10, t.ansi3)
  : c.state === "live" && c.status === "working"
  ? icon("ring", 10, t.working).spin(900)
  : c.state === "live"
    ? div().w(8).h(8).flex_none().rounded_full().bg(c.status === "blocked" ? t.blocked : t.foreground)
    : div().w(8).h(8).flex_none().rounded_full().border(1.5).border_color(t.muted);


// A status as a small icon right after a title: a tick once the work landed, a cross when it failed or was
// stopped, nothing while it works (the dot in front already spins), and a mark of its own for each state
// between. The word shows on hover.
const MARKS = {
  done: ["check", "done"], merged: ["check", "ansi2"], ok: ["check", "done"],
  failed: ["close", "ansi1"], lost: ["close", "ansi1"], bad: ["close", "ansi3"], stopped: ["close", "muted"],
  blocked: ["question", "ansi3"], paused: ["pause", "ansi3"], parked: ["pause", "muted"], offline: ["wifi-off", "ansi3"],
  retrying: ["refresh", "ansi3"], await: ["eye", "accent"], collect: ["eye", "accent"], review: ["eye", "accent"],
  handoff: ["handover", "accent"], delivered: ["send", "accent"], queued: ["hourglass", "muted"], draft: ["pencil", "muted"],
  pending: ["hourglass", "muted"], accepting: ["eye", "accent"],
};
const MARK_WORDS = { ...STAGE_WORDS, ...CARD_WORDS, done: "已完成", stopped: "已终止", stopping: "终止中", handoff: "交接中",
  delivered: "已送达", queued: "已排队", draft: "草稿" };
const statusMark = (t, id, stage) => {
  const glyph = stage === "stopping" ? icon("ring", 11, t.ansi1).spin(900)
    : stage === "running" ? icon("ring", 11, t.working).spin(900)
    : MARKS[stage] ? icon(MARKS[stage][0], 12, t[MARKS[stage][1]] ?? t.muted) : null;
  return glyph ? h_flex().id(id).flex_none().size(16).justify_center().items_center().tooltip(MARK_WORDS[stage] ?? stage).child(glyph) : null;
};

const pill = (t, text, color) => h_flex().h(18).px(7).flex_none().items_center().rounded(9).bg(t.selected)
  .text_size(S().label).text_color(color ?? t.muted).child(text);

function action(id, label, iconName, t, onClick, opts = {}) {
  const color = opts.color ?? t.foreground;
  return h_flex().id(id).h(28).px(10).gap(5).flex_none().items_center().rounded(6).border_1().border_color(t.border)
    .text_size(S().small).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover))
    .on_mouse_down("left", stop).on_click(onClick)
    .child(icon(iconName, 12, color)).child(label);
}

function dialogFrame(t, id, title, body, buttons, onClose, extra = null) {
  return v_flex().id(id).size_full().min_h(0).p(18).gap(14).bg(t.popover).text_size(S().body).text_color(t.foreground)
    .child(h_flex().flex_none().items_center().gap(8)
      .child(div().flex_1().min_w(0).truncate().text_size(S().dialog).font_semibold().child(title))
      .when(Boolean(extra), (el) => el.child(extra))
      .child(h_flex().id("x").size(24).justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click(onClose).child(icon("close", 14, t.muted))))
    .child(v_flex().flex_1().min_h(0).gap(10).children(body.filter(Boolean)))
    .child(h_flex().flex_none().justify_end().gap(8).children(buttons.filter(Boolean)));
}

function dialogButton(id, label, t, onClick, kind = "secondary", enabled = true) {
  const solid = kind === "primary", danger = kind === "danger";
  return h_flex().id(id).h(32).px(14).flex_none().items_center().rounded(8).border_1()
    .border_color(solid ? t.solid : danger ? t.ansi1 : t.input).bg(!enabled ? t.raised : solid ? t.solid : danger ? t.ansi1 : t.raised)
    .text_size(S().small).text_color(!enabled ? t.muted : solid ? t.solid_foreground : danger ? t.background : t.foreground)
    .when(solid || danger, (el) => el.font_semibold())
    .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(onClick)).child(label);
}

const note = (t, text, color) => div().flex_none().text_size(S().small).text_color(color ?? t.muted).child(text);
const monoBox = (t, id, text) => div().id(id).flex_1().min_h(0).overflow_y_scrollbar().px(12).py(10).rounded(8)
  .border_1().border_color(t.border).bg(t.background).font_family(mono()).text_size(S().small).text_color(t.foreground).child(text);

// ---- Structured docs (model.js resultDoc / taskDoc): an outline on the left, the chosen part on the right ----

const toneColor = (t, tone) => ({ ok: t.ansi2, bad: t.ansi1, warn: t.ansi3, accent: t.accent, info: t.ansi4, muted: t.muted })[tone] ?? null;
const KIND_COLOR = (t) => ({ added: t.ansi2, untracked: t.ansi6, modified: t.ansi3, deleted: t.ansi1, renamed: t.accent, conflict: t.ansi1 });
// One letter per kind in place of git's two-column code (untracked is "??", which reads as a broken glyph).
const KIND_MARK = { added: "A", untracked: "N", modified: "M", deleted: "D", renamed: "R", conflict: "!" };
const KIND_SHORT = { added: "新增", untracked: "未跟踪", modified: "修改", deleted: "删除", renamed: "改名", conflict: "冲突" };
const tdot = (color, size = 7) => div().size(size).flex_none().rounded(size / 2).bg(color);
const blockLabel = (t, text) => div().flex_none().text_size(S().label).font_semibold().text_color(t.muted).child(String(text).toUpperCase());

function docBlock(t, b, id) {
  const z = S(), md = (text) => TextView.markdown(id, String(text ?? "")).selectable(true);
  const labelled = (el) => b.label ? v_flex().gap(4).child(blockLabel(t, b.label)).child(el) : el;
  switch (b.t) {
    case "lead": {
      const c = toneColor(t, b.tone) ?? t.accent;
      return h_flex().items_start().gap(10).rounded(6).bg(t.raised).pr(12).py(8)
        .child(div().w(3).flex_none().self_stretch().rounded(2).bg(c))
        .child(v_flex().flex_1().min_w(0).gap(3).child(blockLabel(t, b.label))
          .child(b.short ? div().text_size(z.dialog).font_semibold().text_color(c).child(b.text)
            : div().text_size(z.body).font_semibold().text_color(t.foreground).child(md(b.text))));
    }
    case "kv": return labelled(v_flex().gap(3).children(b.rows.map((r, i) => h_flex().id(`${id}-${i}`).items_start().gap(10)
      .child(div().w(128).flex_none().text_size(z.small).text_color(t.muted).child(r.k))
      .child(h_flex().flex_1().min_w(0).gap(6).items_start()
        .when(Boolean(toneColor(t, r.tone)) && r.tone !== "muted", (el) => el.child(tdot(toneColor(t, r.tone), 7).mt(5)))
        .child(div().flex_1().min_w(0).text_size(z.small).text_color(toneColor(t, r.tone) ?? t.foreground)
          .when(Boolean(r.mono), (el) => el.font_family(mono())).when(r.tone === "bad" || r.tone === "ok", (el) => el.font_semibold()).child(r.v))))));
    case "md": return labelled(div().text_size(z.body).text_color(t.foreground).child(md(b.text)));
    case "code": return labelled(div().px(10).py(8).rounded(6).border_1().border_color(t.border).bg(t.background)
      .font_family(mono()).text_size(z.label).text_color(t.foreground).child(b.text));
    case "files": {
      const k = KIND_COLOR(t);
      return v_flex().gap(2).children(b.rows.map((f, i) => h_flex().id(`${id}-${i}`).h(22).gap(8).items_center()
        .child(h_flex().w(26).h(17).flex_none().justify_center().items_center().rounded(4).bg(t.selected)
          .font_family(mono()).text_size(z.label).font_semibold().text_color(k[f.kind]).child(KIND_MARK[f.kind] ?? f.code))
        .child(div().w(62).flex_none().text_size(z.label).text_color(k[f.kind]).child(KIND_SHORT[f.kind]))
        .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(z.small)
          .text_color(f.kind === "deleted" ? t.muted : t.foreground).child(f.path))));
    }
    case "stat": {
      const max = Math.max(1, ...b.rows.map((r) => r.n)), W = 110;
      return v_flex().gap(2).children(b.rows.map((r, i) => h_flex().id(`${id}-${i}`).h(22).gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().font_family(mono()).text_size(z.small).child(r.path))
        .child(div().w(70).flex_none().text_size(z.label).font_family(mono())
          .child(h_flex().gap(4).child(div().text_color(t.ansi2).child(`+${r.plus}`)).child(div().text_color(t.ansi1).child(`−${r.minus}`))))
        .child(h_flex().w(W).h(6).flex_none().rounded(3).bg(t.selected).overflow_hidden()
          .child(div().h_full().w(Math.round(W * r.plus / max)).bg(t.ansi2))
          .child(div().h_full().w(Math.round(W * r.minus / max)).bg(t.ansi1)))));
    }
    case "events": return v_flex().gap(4).children(b.rows.map((e, i) => h_flex().id(`${id}-${i}`).items_start().gap(8)
      .child(div().w(112).flex_none().font_family(mono()).text_size(z.label).text_color(t.muted).child(e.time))
      .child(tdot(toneColor(t, e.tone) ?? t.border, 7).mt(5))
      .child(div().flex_1().min_w(0).text_size(z.small)
        .text_color(e.tone === "bad" || e.tone === "warn" ? toneColor(t, e.tone) : e.tone === "muted" ? t.muted : t.foreground)
        .when(e.tone === "bad", (el) => el.font_semibold()).child(e.text))));
    default: return null;
  }
}

/** The outline entries, in order: groups, then their children (with depth). */
const docEntries = (doc) => (doc?.nodes ?? []).flatMap((n) => [{ node: n, group: n, depth: -1 }, ...n.children.map((c) => ({ node: c, group: n, depth: c.depth ?? 0 }))]);

/** What the chosen entry shows: a group and all its children; a child and the ones nested under it. */
function docSelection(doc, sel) {
  const groups = doc?.nodes ?? [];
  if (!sel) return groups.map((g) => ({ group: g, parts: g.children, whole: true }));
  const g = groups.find((x) => x.id === sel);
  if (g) return [{ group: g, parts: g.children, whole: true }];
  for (const grp of groups) {
    const i = grp.children.findIndex((c) => c.id === sel);
    if (i < 0) continue;
    const d = grp.children[i].depth ?? 0, parts = [grp.children[i]];
    for (let j = i + 1; j < grp.children.length && (grp.children[j].depth ?? 0) > d; j++) parts.push(grp.children[j]);
    return [{ group: grp, parts, whole: false }];
  }
  return groups.map((x) => ({ group: x, parts: x.children, whole: true }));
}

// ---- The tab-bar button ----

function toggle() {
  const t = theme(), node = find(layout(), PANEL), on = Boolean(node) && !node.hidden;
  const live = (terminals() ?? []).filter((x) => x?.labels?.["cc.run"] && x.state === "live");
  const busy = live.filter((x) => (typeof x.status === "string" ? x.status : x.status?.state) === "working").length;
  // Styled like the tab bar's Files / Changes buttons (tabs mod panelButton). It starts at the block's left
  // edge, right after the tabs block's own 10px padding, and the block is wide enough that the rounded
  // corners are never clipped.
  return h_flex().size_full().items_center().justify_start().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-cc-dispatch").h(26).px(8).gap(5).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => run("layout.toggle", { id: PANEL }))
      .child(mark(14, on ? t.foreground : t.muted)).child("Dispatch")
      .when(live.length > 0, (el) => el.child(h_flex().h(16).px(5).items_center().rounded(8).bg(busy ? t.working : t.selected)
        .text_size(11).text_color(busy ? t.background : t.muted).child(String(busy || live.length)))));
}

// ---- The view ----

export default class Dispatch extends View {
  init(_props, cx) {
    this.role = blockProps()?.role ?? "panel";
    if (this.role === "bgtask") {
      const p = blockProps();
      this.live = null; this.liveAt = 0; this.liveBusy = false;
      const load = (cx) => {
        if (this.liveBusy) return;
        this.liveBusy = true;
        cx.spawn(async (cx) => {
          const live = await loadLive(io(p.on ?? null), p.output).catch(() => null);
          this.liveBusy = false; this.live = live; this.liveAt = Date.now(); cx.notify();
        });
      };
      load(cx);
      cx.timer.every(LIVE_POLL, load);
      return;
    }
    if (this.role === "decide") {
      const p = blockProps() ?? {};
      this.choice = null; this.sending = false; this.failed = null; this.saved = false; this.extra = null;
      this.answerBox = TextareaState.new({ rows: 3, placeholder: p.item?.kind === "question"
        ? "你的回答（也可以选上面的建议再补充）" : "给主 agent 的备注（可不填）：理由，或要注意什么" });
      this.answerBox.on("change", (_e, cx) => cx.notify());
      this.answerBox.on("focus", (_e, cx) => { this.typing = true; cx.notify(); });
      this.answerBox.on("blur", (_e, cx) => { this.typing = false; cx.notify(); });
      // The card's helper report: its open questions add to the context.
      if (p.reportPath) cx.spawn(async (cx) => {
        const files = io(p.on ?? null);
        const text = (await files.readText(p.reportPath)) ?? (p.reportBackup ? await files.readText(p.reportBackup) : null);
        const v = text ? (() => { try { return JSON.parse(text); } catch { return null; } })() : null;
        const qs = Array.isArray(v?.open_questions) ? v.open_questions.filter((x) => typeof x === "string" && x.trim()) : [];
        if (qs.length) { this.extra = qs; cx.notify(); }
      });
      return;
    }
    if (["dispatch", "task", "backlog", "newtopic"].includes(this.role)) {
      const p = blockProps() ?? {};
      this.sending = false; this.failed = null; this.kind = p.task?.kind ?? "dev";
      const field = (value, rows, placeholder) => {
        const box = TextareaState.new({ value: value ?? "", rows, placeholder });
        box.on("change", (_e, cx) => cx.notify());
        return box;
      };
      this.titleBox = field(p.task?.title, 2, "填写标题");
      this.detailBox = field(p.task?.detail, 6, "说明要做什么、期望结果和限制");
      this.backlogBox = field(p.item?.text, 8, "记录想法或待办，可以写多行");
      this.programs = p.programs ?? []; this.programsAt = 0; this.programsBusy = false;
      this.pick = p.ownerLive ? "owner" : null;
      if (this.role === "dispatch") this.refreshPrograms(cx, p.on ?? null);
      return;
    }
    if (this.role !== "panel") return;
    this.runs = []; this.topics = []; this.states = {}; this.error = null; this.repo = null; this.on = null; this.ctxKey = null; this.liveKey = null;
    this.open = null; this.fold = new Map(); this.groupFold = new Map(); this.bgMore = new Map(); this.showOld = false; this.showArchived = false; this.loading = false; this.token = 0; this.lastAgent = null;
    this.stats = { calls: {}, runs: {}, finished: {}, pending: {} }; this.statsFor = new Set(); this.statsBusy = false;
    this.bg = { runs: {}, sessions: {} };
    this.quota = {}; // agent -> { q, at, busy }
    this.programs = []; this.programsAt = 0; this.programsBusy = false; this.busy = new Set();
    cx.timer.every(POLL, (cx) => { if (this.shown()) this.refresh(cx); });
  }

  shown() { return !find(layout(), PANEL)?.hidden; }

  // The shown space, as Herdr's Spaces list names it.

  // Keep a Topic together even when its nested Tasks were started in another space.
  split() {
    const allSpaces = spaces() ?? [], shown = allSpaces.find((s) => s.active) ?? null;
    const runSplit = splitBySpace(this.runs, terminals() ?? [], allSpaces, shown, this.repo);
    const mineDirs = new Set(runSplit.mine.map((r) => r.dir)), mine = [], others = new Map();
    for (const topic of this.topics) {
      const dir = topicDir(topic);
      const repo = topic.implicit ? topic.runs[0]?.repo : dir?.replace(/\/\.cc-dispatch\/topics\/[^/]+$/, "");
      if ((this.repo && repo === this.repo) || topic.runs.some((r) => mineDirs.has(r.dir))) { mine.push(topic); continue; }
      if (!this.topicActive(topic)) continue;
      const g = runSplit.others.find((g) => g.runs.some((r) => topic.runs.includes(r)));
      const id = g?.id ?? topic.owner?.space ?? null;
      const name = g?.name ?? allSpaces.find((s) => s.id === id)?.name ?? baseName(repo);
      // A Topic whose space is unknown joins the row of the same name, so one space never shows twice.
      const key = id ?? [...others.keys()].find((k) => others.get(k).name === name) ?? `repo:${repo}`;
      if (!others.has(key)) others.set(key, { id, name, topics: [] });
      if (id && others.has(`repo:${repo}`) && others.get(`repo:${repo}`).name === name) {
        others.get(key).topics.push(...others.get(`repo:${repo}`).topics);
        others.delete(`repo:${repo}`);
      }
      others.get(key).topics.push(topic);
    }
    return { mine, others: [...others.values()] };
  }

  context() {
    const space = spaces().find((s) => s.active);
    if (!space) return null;
    const f = focused();
    const cwd = f?.space === space.id && f?.cwd ? f.cwd : null;
    return { on: space.machine ?? null, folder: cwd || space.folder || "" };
  }

  refresh(cx) {
    if (this.loading) return;
    this.loading = true;
    const token = this.token, ctx = this.ctx;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const files = io(ctx?.on ?? null);
        const repo = ctx ? await findRepo(files, ctx.folder) : null;
        if (token !== this.token) return;
        const { runs, topics, states, error } = await loadRuns(files, repo, terminals() ?? []);
        if (token !== this.token) return;
        this.repo = repo; this.runs = runs; this.topics = topics; this.states = states; this.error = error;
        later(cx, (cx) => { if (token === this.token) this.refreshStats(cx, files, token); });
        later(cx, (cx) => { if (token === this.token) this.refreshQuota(cx, files, token); });
        later(cx, (cx) => { if (token === this.token) this.refreshPrograms(cx, ctx?.on ?? null, token); });
        const pending = topics.some((topic) => !topic.implicit && this.topicRepo(topic) === repo && !topic.archived && !topic.pausedAt && !topic.deleting
          && [...topic.tasks, ...topic.backlog].some((x) => x.request?.target === "owner" && x.request.deliveredAt == null));
        if (repo && pending && !checking()) {
          const delivered = await topicCmd(files, runs.find((r) => r.hd)?.hd, ["topic", "deliver", "--repo", repo]);
          if (token !== this.token) return;
          if (!delivered.ok) this.error = `自动送达失败：${commandError(delivered.out)}`;
          else if (outputValue(delivered.out, "DELIVERED")) {
            const next = await loadRuns(files, repo, terminals() ?? []);
            if (token !== this.token) return;
            this.runs = next.runs; this.topics = next.topics; this.states = next.states; this.error = next.error;
          }
        }
      } catch (e) {
        if (token === this.token) this.error = String(e?.message ?? e);
      } finally {
        if (token === this.token) { this.loading = false; cx.notify(); }
      }
    });
  }

  refreshPrograms(cx, on, token = null) {
    if (this.programsBusy || Date.now() - this.programsAt < 60000) return;
    this.programsBusy = true;
    cx.spawn(async (cx) => {
      try {
        const programs = await knownAgents({ on });
        if (token != null && token !== this.token) return;
        this.programs = programs.filter((p) => p.installed); this.programsAt = Date.now(); this.programsError = null;
      } catch (e) {
        if (token != null && token !== this.token) return;
        this.programsError = `读不到可用 agent：${e?.message ?? e}`;
      } finally {
        if (token == null || token === this.token) { this.programsBusy = false; cx.notify(); }
      }
    });
  }

  // Spend and the main agent's background tasks, a slower read than meta.json: live runs (model.js
  // activeRuns: helpers or main agent still going) every poll, ended runs once (they no longer change).
  refreshStats(cx, files, token) {
    if (this.statsBusy) return;
    const want = this.runs.filter((r) => r.live || !this.statsFor.has(r.dir));
    if (!want.length) return;
    this.statsBusy = true;
    cx.spawn(async (cx) => {
      try {
        const s = await loadStats(files, want);
        if (token !== this.token) return;
        // The main agents' background tasks, from their transcripts (bg.js).
        const b = await loadBg(files, want);
        if (token !== this.token) return;
        this.statsError = s.error ? `stats: ${s.error}` : b.error ? `tasks: ${b.error}` : null;
        if (!b.error) { Object.assign(this.bg.runs, b.runs); Object.assign(this.bg.sessions, b.sessions); }
        if (s.error) return;
        Object.assign(this.stats.calls, s.calls); Object.assign(this.stats.runs, s.runs); Object.assign(this.stats.finished, s.finished ?? {});
        for (const r of want) this.stats.pending[r.dir] = s.pending?.[r.dir] ?? {};
        for (const r of want) if (!r.live) this.statsFor.add(r.dir);
      } finally {
        if (token === this.token) { this.statsBusy = false; cx.notify(); }
      }
    });
  }

  // Each live run's main agent's quota, per subscription (claude, codex), at most every QUOTA_POLL.
  refreshQuota(cx, files, token) {
    const now = Date.now(), want = new Map();
    for (const r of this.runs) {
      if (!r.live) continue;
      const agent = runQuotaAgent(r, terminals() ?? []);
      if (agent && !want.has(agent)) want.set(agent, r.hd);
    }
    for (const [agent, hd] of want) {
      const cur = this.quota[agent];
      if (cur?.busy || (cur && now - cur.at < QUOTA_POLL)) continue;
      this.quota[agent] = { ...(cur ?? { q: null }), at: now, busy: true };
      cx.spawn(async (cx) => {
        const q = await loadQuota(files, hd, agent).catch(() => null);
        if (token !== this.token) return;
        this.quota[agent] = { q, at: Date.now(), busy: false };
        cx.notify();
      });
    }
  }

  // Under a live run's head: the subscription its main agent runs on and how much of each window is used.
  renderQuota(t, r) {
    if (!r.live) return null;
    const agent = runQuotaAgent(r, terminals() ?? []);
    const v = agent ? quotaView(agent, this.quota[agent]?.q) : null;
    if (!v) return null;
    const color = { high: t.ansi1, warn: t.ansi3, ok: t.muted };
    const clock = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
    const tip = v.windows.map((w) => `${w.text}${w.resets ? ` · 重置于 ${new Date(w.resets).toDateString() === new Date().toDateString() ? clock(w.resets) : `${new Date(w.resets).getMonth() + 1}/${new Date(w.resets).getDate()} ${clock(w.resets)}`}` : ""}`).join("\n")
      + `\n来源：${v.source === "magpie" ? "magpie" : "agent 自己的日志"}`;
    return h_flex().id(`quota-${r.dir}`).flex_none().pl(30).pr(10).pb(6).gap(6).items_center().flex_wrap()
      .text_size(S().label).tooltip(tip)
      .child(icon("gauge", 11, t.muted))
      .child(div().flex_none().text_color(t.muted).child(`主 agent · ${v.label}`))
      .children(v.windows.map((w) => div().flex_none().text_color(color[w.level]).when(w.level !== "ok", (el) => el.font_semibold()).child(w.text)));
  }

  // The Claude a hand-off goes to: the one that dispatched the call, else the focused agent.
  receiver(c) {
    const every = agents() ?? [];
    const parent = c.parent && every.find((a) => a.address === c.parent);
    if (parent) return parent;
    const space = (spaces() ?? []).find((s) => s.active)?.id;
    const all = every.filter((a) => a.space === space);
    const f = all.find((a) => a.focused);
    if (f && !(f.address === c.address)) { this.lastAgent = f.address; return f; }
    return all.find((a) => a.address === this.lastAgent) ?? null;
  }

  render(cx) {
    if (this.role === "toggle") return toggle();
    if (this.role !== "panel") return this.renderDialog();
    const t = theme();

    // Follow the shown space and its focused folder; a new place starts over.
    const ctx = this.context(), key = ctx ? `${ctx.on}|${ctx.folder}` : "";
    if (key !== this.ctxKey) {
      this.ctxKey = key; this.ctx = ctx; this.token++; this.loading = false; this.statsBusy = false; this.open = null;
      this.runs = []; this.topics = []; this.states = {}; this.repo = null; this.error = null; this.statsError = null;
      this.stats = { calls: {}, runs: {}, finished: {}, pending: {} }; this.statsFor = new Set(); this.bg = { runs: {}, sessions: {} }; this.quota = {};
      this.programs = []; this.programsAt = 0; this.programsBusy = false; this.busy = new Set();
      this.fold.clear(); this.groupFold.clear(); this.bgMore.clear(); this.showOld = false; this.showArchived = false; this.lastAgent = null;
      later(cx, (cx) => this.refresh(cx));
    }
    // Helpers came, went or relabelled themselves: re-read meta.json now, not at the next poll.
    const live = (terminals() ?? []).filter((x) => x?.labels?.["cc.run"]);
    const liveKey = live.map((x) => `${x.address}:${x.state}:${JSON.stringify(x.labels)}`).sort().join("|");
    if (liveKey !== this.liveKey) { this.liveKey = liveKey; if (this.ctxKey) later(cx, (cx) => this.refresh(cx)); }
    const shown = this.shown();
    if (shown && this.wasHidden) later(cx, (cx) => this.refresh(cx));
    this.wasHidden = !shown;

    const node = find(layout(), PANEL);
    return v_flex().id("cc-dispatch").size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(S().body)
      .child(h_flex().h(42).flex_none().pl(14).pr(8).gap(8).items_center().border_b(1).border_color(t.border)
        .child(mark(17, t.accent))
        .child(div().text_size(S().title).font_semibold().child("Dispatch"))
        .child(div().flex_1())
        .when(Boolean(this.repo), (el) => el.child(action("new-topic", "新建 Topic", "task", t, () => {
          const owner = this.receiver({});
          this.openForm("newtopic", null, { owner: owner?.address ?? null, ownerName: owner?.program?.name ?? null });
        }, { color: t.accent })))
        .child(h_flex().id("refresh").size(24).justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop).on_click((_e, cx) => this.refresh(cx))
          .child(this.loading ? icon("ring", 13, t.muted).spin(900) : icon("refresh", 13, t.muted)))
        .when(Boolean(node), (el) => el.child(h_flex().id("close").size(24).justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop).on_click(() => run("layout.hide", { id: PANEL })).child(icon("close", 14, t.muted)))))
      .child(this.renderTopics(t))
      .child(this.renderFooter(t));
  }

  topicActive(topic) {
    return !topic.archived && (topic.pausedAt || topic.tasks.some((task) => ["active", "you"].includes(taskGroup(task, topic))));
  }

  topicHD(topic) { return topic?.runs.find((r) => r.hd)?.hd ?? this.runs.find((r) => r.hd)?.hd ?? null; }

  topicRepo(topic) {
    const dir = topicDir(topic);
    return (topic?.implicit ? topic.runs[0]?.repo : dir?.replace(/\/\.cc-dispatch\/topics\/[^/]+$/, "")) ?? this.repo;
  }

  // Forms only need serializable metadata; render/group/summary keep the original model objects.
  topicProps(topic) {
    return topic ? { id: topic.id, title: topic.title, implicit: topic.implicit, archived: topic.archived, pausedAt: topic.pausedAt,
      owner: topic.owner, tasks: topic.tasks.map((task) => ({ id: task.id, title: task.title, run: task.runDir })),
      runs: topic.runs.map((r) => ({ id: r.id, dir: r.dir, hd: r.hd })) } : null;
  }

  openForm(role, topic, extra = {}) {
    const ownerLive = Boolean(topic?.owner?.terminal) && (agents() ?? []).some((a) => a.address === topic.owner.terminal);
    openOverlay({ mod: "cc-dispatch", kind: "dialog", width: 560, height: role === "dispatch" ? 760 : role === "task" ? 640 : 430,
      props: { role, topic: this.topicProps(topic), repo: this.topicRepo(topic), hd: this.topicHD(topic),
        on: this.ctx?.on ?? null, space: (spaces() ?? []).find((s) => s.active)?.id,
        ownerLive, programs: this.programs, ...extra } });
  }

  command(cx, topic, op, args = []) {
    if (this.busy.has(topic.id)) return;
    const token = this.token, files = io(this.ctx?.on ?? null), hd = this.topicHD(topic), repo = this.topicRepo(topic);
    this.busy.add(topic.id); this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        // Historical Topics have no topic.json; their controls still address the underlying run.
        let res;
        if (topic.implicit) {
          const r = topic.runs[0];
          const got = ["archive", "unarchive"].includes(op) ? await archiveRun(files, r, op) : await controlRun(files, r, op);
          res = { ok: got.ok, out: got.text ?? got.error };
        } else res = await topicCmd(files, hd, ["topic", op, "--repo", repo, "--topic", topic.id, ...args]);
        if (token !== this.token) return;
        if (!res.ok) this.error = commandError(res.out);
        else later(cx, (cx) => { if (token === this.token) this.refresh(cx); });
      } catch (e) {
        if (token === this.token) this.error = String(e?.message ?? e);
      } finally {
        if (token === this.token) { this.busy.delete(topic.id); cx.notify(); }
      }
    });
  }

  renderTopics(t) {
    const body = v_flex().id("topics").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8);
    if (this.error) body.child(note(t, this.error, t.ansi1));
    const { mine, others } = this.split();
    if (!mine.length) {
      body.child(v_flex().p(8).gap(6)
        .child(note(t, this.repo ? `${baseName(this.repo)} 里还没有 Topic。` : "打开一个空间，就能看到它的 Topic。", t.foreground))
        .child(note(t, "新建 Topic 后添加 Task 草稿，或用 cc-herdr-dispatch 系列 skill 开始工作。历史运行也会显示在这里。")));
      return this.renderOthers(t, body, others);
    }
    const live = mine.filter((topic) => this.topicActive(topic)), ended = mine.filter((topic) => !topic.archived && !this.topicActive(topic));
    const archived = mine.filter((topic) => topic.archived).sort((a, b) => b.archived - a.archived);
    const old = this.showOld ? ended : ended.slice(0, HISTORY);
    body.children([...live, ...old].map((topic) => this.renderTopic(t, topic)));
    const link = (id, text, onClick) => div().id(id).flex_none().py(4).text_size(S().small).text_color(t.muted).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click(onClick).child(text);
    if (ended.length > HISTORY) {
      body.child(link("older", this.showOld ? "收起" : `再显示 ${ended.length - HISTORY} 个更早的`,
        (_e, cx) => { this.showOld = !this.showOld; cx.notify(); }));
    }
    if (archived.length) {
      body.child(link("archived", this.showArchived ? "隐藏已归档" : `已归档 ${archived.length} 个 · 显示`,
        (_e, cx) => { this.showArchived = !this.showArchived; cx.notify(); }));
      if (this.showArchived) body.children(archived.map((topic) => this.renderTopic(t, topic)));
    }
    return this.renderOthers(t, body, others);
  }

  // Other spaces with Topics going: one row each.
  renderOthers(t, body, others) {
    if (!others.length) return body;
    body.child(div().flex_none().pt(6).px(2).text_size(S().label).text_color(t.muted).child("其他空间"));
    for (const g of others) {
      const waiting = g.topics.some((topic) => topic.tasks.some((task) => taskGroup(task, topic) === "you"));
      body.child(h_flex().id(`space-${g.id ?? g.name}`).min_h(36).flex_none().px(10).py(6).gap(8).items_center().rounded(8)
        .border_1().border_dashed().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
        .when(Boolean(g.id), (el) => el.on_click(() => run("space.select", { id: g.id })))
        .child(dot(t, waiting ? "blocked" : "working"))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(S().body).font_semibold().child(g.name))
          .child(div().text_size(S().label).text_color(t.muted)
            .child(`${g.topics.length} 个 Topic · ${g.topics.reduce((n, topic) => n + topic.tasks.length, 0)} 个 Task`)))
        .when(Boolean(g.id), (el) => el.child(icon("chevron-right", 12, t.muted))));
    }
    return body;
  }

  renderTopic(t, topic) {
    const active = this.topicActive(topic);
    // Open by default while something is running, waiting on you, or drafted and not yet dispatched.
    const folded = this.fold.get(topic.id) ?? !(active || (!topic.archived && topic.tasks.some((task) => taskGroup(task, topic) === "queued")));
    const waiting = topic.tasks.some((task) => taskGroup(task, topic) === "you");
    const paused = Boolean(topic.pausedAt);
    const head = h_flex().id(`topic-${topic.id}`).min_h(36).flex_none().pl(10).pr(6).gap(7).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.fold.set(topic.id, !folded); cx.notify(); })
      .child(icon(folded ? "chevron-right" : "chevron-down", 12, t.muted))
      .child(dot(t, waiting ? "blocked" : active ? "working" : "done", paused ? { state: "paused" } : topic.deleting ? { state: "stopping" } : null))
      .child(div().flex_1().min_w(0).truncate().text_size(S().body).font_semibold().text_color(topic.archived ? t.muted : t.foreground).child(topic.title))
      .child(h_flex().id(`summary-${topic.id}`).size(22).flex_none().justify_center().items_center().rounded(6)
        .tooltip("查看摘要").cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          const files = io(this.ctx?.on ?? null);
          this.showText(cx, `${topic.title} · 摘要`, () => loadSummary(files, topic), topic.implicit ? "还没有总结文档。" : "还没有 Task 完成摘要。");
        }).child(icon("file", 13, t.muted)))
      .children(this.topicControlButtons(t, topic))
      .children(this.archiveButton(t, topic));
    const card = v_flex().flex_none().rounded(8).border_1().border_color(paused ? t.ansi3 : active ? t.input : t.border)
      .bg(active ? t.surface : t.background).overflow_hidden().child(head);
    const quotaAgents = new Set();
    for (const r of topic.runs) {
      const agent = runQuotaAgent(r, terminals() ?? []);
      if (quotaAgents.has(agent)) continue;
      const quota = this.renderQuota(t, r);
      if (quota) { quotaAgents.add(agent); card.child(quota); }
    }
    const stopping = topic.runs.some((r) => r.control?.state === "stopping");
    const stopped = topic.runs.length && topic.runs.every((r) => r.control?.state === "stopped" || r.control?.retired);
    if (paused || stopping || stopped || topic.deleting) card.child(h_flex().px(12).py(6).gap(7).items_center().border_t(1).border_color(t.border)
      .child(icon(paused ? "pause" : "square", 11, paused ? t.ansi3 : t.muted))
      .child(note(t, topic.deleting ? "Topic 删除中" : paused ? topic.implicit ? "已暂停" : "Topic 已暂停 · 继续后才能派发 Task" : stopping ? "Topic 终止中 · 子 agent 正在记录进度" : "Topic 已终止", paused ? t.ansi3 : t.muted)));
    const asks = this.renderAsks(t, topic);
    if (asks) card.child(asks);
    if (!folded) {
      const totals = topicTotals(this.stats, topic);
      if (totals.known || totals.cards || topic.tasks.length) card.child(this.renderStats(t, topic, totals));
      const assigned = assignTasks(this.runs, this.bg.runs, this.bg.sessions);
      const mainLive = topic.runs.some((r) => this.mainAgentOf(r));
      const bg = bgView(topicTasks(assigned, topic), mainLive, this.bgMore.get(topic.id) ?? 0);
      if (bg.running.length || bg.ended.length) card.child(this.renderBg(t, topic, bg));
      // Most urgent first (waiting on you, running, drafted, done); each Task's status is the mark after its title.
      card.children(groupTasks(topic).flatMap((g) => g.tasks).map((task) => this.renderTask(t, topic, task)));
      if (!topic.implicit && !topic.archived && !topic.deleting) card.child(h_flex().px(12).py(8)
        .child(action(`add-task-${topic.id}`, "+ Task", "task", t, () => this.openForm("task", topic), { color: t.accent })));
      if (!topic.implicit) card.child(this.renderBacklog(t, topic));
    }
    return card;
  }

  /** A Task's status, as a statusMark key. */
  taskStage(topic, task) {
    const r = task.run, group = taskGroup(task, topic), state = r?.control?.state, request = requestState(task);
    if (state === "paused" || state === "stopping" || state === "handoff") return state;
    if (state === "stopped" || r?.control?.retired) return "stopped";
    if (group === "done") return "done";
    if (group === "queued") return request === "delivered" ? "delivered" : request ? "queued" : "draft";
    if (group === "you") return "blocked";
    const stages = r?.calls.map((c) => callStage(c, this.stats.runs[r.dir]?.status?.[c.call])) ?? [];
    const top = stages.length ? runStage(stages) : "working";
    return top === "ended" ? "working" : top;
  }

  renderExecutor(t, key) {
    if (!key) return null;
    key = key === "agy" ? "antigravity" : key;
    const program = this.programs.find((p) => p.key === key) ?? (agents() ?? []).find((a) => a.program?.key === key)?.program;
    const glyph = !program?.icon ? div().text_size(S().label).text_color(t.muted).child(key)
      : program.tint ? svg(program.icon).size(13).flex_none().text_color(t.muted) : image(program.icon).size(13).flex_none();
    return h_flex().flex_none().gap(4).items_center().tooltip(program?.name ?? key).child(glyph);
  }

  renderTask(t, topic, task) {
    const r = task.run, group = taskGroup(task, topic), key = `${topic.id}|${task.id}`;
    const folded = this.fold.get(key) ?? !(group === "active" || group === "you"), inset = 42;
    const queued = group === "queued", request = requestState(task);
    const stage = this.taskStage(topic, task);
    const working = request === "queued" && task.request?.target === "owner" && topic.owner?.terminal
      ? this.topics.flatMap((p) => p.owner?.terminal === topic.owner.terminal
        ? p.tasks.filter((x) => x.runDir && !x.finishedAt && !this.states[x.runDir]?.finished && x.run?.control?.state !== "stopped" && !x.run?.control?.retired) : []) : [];
    const executor = this.renderExecutor(t, task.agent ?? task.request?.agent ?? (task.request?.target === "owner" ? topic.owner?.agent : null));
    // The main agent's terminal dot, as on a card: it spins while that agent works.
    const main = r && group !== "done" ? this.mainAgentOf(r) : null;
    const box = v_flex().flex_none().border_t(1).border_color(t.border).bg(t.surface);
    box.child(h_flex().id(`task-${key}`).min_h(32).pl(12).pr(10).py(5).gap(7).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.fold.set(key, !folded); cx.notify(); })
      .child(icon(folded ? "chevron-right" : "chevron-down", 10, t.muted))
      .when(Boolean(r) && group !== "done", (el) => el.child(termDot(t, { state: main ? "live" : "gone", status: main?.status ?? null })))
      .when(Boolean(executor), (el) => el.child(executor))
      .child(pill(t, task.kind))
      .child(div().min_w(0).flex_shrink(1).truncate().text_size(S().small).font_semibold().child(task.title))
      .children([statusMark(t, `mark-${key}`, stage)].filter(Boolean))
      .child(div().flex_1())
      .children(r ? this.controlButtons(t, r, topic) : []));
    if (working.length) box.child(note(t, `已排队 · 主 agent 正在做 ${working.map((x) => x.title).join("、")}`).pl(inset).pr(10).pb(5));
    if (folded) return box;
    if (task.detail) box.child(div().pl(inset).pr(10).py(5).text_size(S().small).text_color(t.muted).child(task.detail));
    if (task.dependsOn.length) box.child(note(t, `依赖：${task.dependsOn.map((id) => topic.tasks.find((x) => x.id === id)?.title ?? id).join("、")}`).pl(inset).pr(10).py(3));
    if (queued && !topic.archived && !topic.deleting) {
      box.child(h_flex().pl(inset).pr(10).py(6).gap(6).flex_wrap()
        .child(action(`edit-${key}`, "编辑", "task", t, () => this.openForm("task", topic, { task })))
        .child(action(`remove-${key}`, "删除", "trash", t, (_e, cx) => this.command(cx, topic, "task-rm", ["--task", task.id]), { color: t.ansi1 }))
        .when(!topic.pausedAt, (el) => el.child(action(`dispatch-${key}`, request ? "改派…" : "派发…", "send", t,
          () => this.openForm("dispatch", topic, { task }), { color: t.accent })))
        .when(Boolean(request), (el) => el.child(action(`cancel-${key}`, "撤销", "close", t,
          (_e, cx) => this.command(cx, topic, "request", ["--task", task.id, "--cancel"]))))
        .when(request === "delivered" && !topic.pausedAt, (el) => el.child(action(`resend-${key}`, "重发", "refresh", t,
          (_e, cx) => this.command(cx, topic, "request", ["--task", task.id, "--resend"])))));
    }
    if (r) {
      const control = this.renderControl(t, r), take = group !== "done" ? this.renderTakeover(t, r) : null;
      if (control) box.child(control);
      if (take) box.child(take);
      box.children(r.calls.map((c) => this.renderCall(t, c, true, inset)));
      const away = cardView(this.stats.runs[r.dir], r.calls.map((c) => c.call)).undispatched;
      if (away.length) box.child(v_flex().pl(inset).pr(10).py(6).gap(4)
        .child(note(t, "内部进度"))
        .children(away.map((k) => h_flex().id(`card-${r.dir}|${k.id}`).gap(7).items_center()
          .child(div().flex_none().text_size(S().label).child(k.id))
          .child(div().flex_1().min_w(0).truncate().text_size(S().small).text_color(t.muted).child(k.title ?? ""))
          .children([statusMark(t, `mark-${r.dir}|${k.id}`, k.status)].filter(Boolean))
          .tooltip(k.waits.length ? `等 ${k.waits.join("、")}` : k.note ?? ""))));
    }
    if (task.summaryLine) box.child(note(t, task.summaryLine, t.done).pl(inset).pr(10).py(5));
    if (task.artifact) box.child(note(t, `产物：${task.artifact}`).pl(inset).pr(10).pb(5));
    return box;
  }

  renderBacklog(t, topic) {
    const key = `backlog|${topic.id}`, folded = this.groupFold.get(key) ?? true;
    const editable = !topic.archived && !topic.deleting;
    const box = v_flex().flex_none().border_t(1).border_color(t.border)
      .child(h_flex().id(key).min_h(30).px(12).gap(7).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.groupFold.set(key, !folded); cx.notify(); })
        .child(icon(folded ? "chevron-right" : "chevron-down", 10, t.muted))
        .child(div().flex_1().text_size(S().label).text_color(t.muted).child(`backlog · ${topic.backlog.length} 条`))
        .when(editable, (el) => el.child(action(`add-${key}`, "+ 添加", "task", t,
          (_e, cx) => { cx.stop_propagation(); this.openForm("backlog", topic); }))));
    if (folded) return box;
    box.children(topic.backlog.map((item) => {
      const state = item.status === "refining" ? "细化中" : item.status === "refined" ? "已细化" : "待细化";
      const req = requestState(item);
      return v_flex().id(`${key}|${item.id}`).px(12).py(7).gap(5)
        .child(h_flex().gap(7).items_center()
          .child(div().flex_1().min_w(0).truncate().text_size(S().small).child(item.text.split("\n")[0])
            .when(editable, (el) => el.cursor_pointer().hover((s) => s.text_color(t.accent))
              .on_click(() => this.openForm("backlog", topic, { item }))).tooltip(item.text))
          .child(pill(t, state, item.status === "refining" ? t.accent : t.muted)))
        .when(Boolean(req), (el) => el.child(note(t, req === "delivered" ? "已送达" : "已排队")))
        .when(Boolean(item.taskIds.length), (el) => el.child(note(t, `已生成 Task：${item.taskIds.join("、")}`)))
        .when(editable, (el) => el.child(h_flex().gap(6).flex_wrap()
          .child(action(`edit-${key}-${item.id}`, "编辑", "task", t, () => this.openForm("backlog", topic, { item })))
          .child(action(`remove-${key}-${item.id}`, "删除", "trash", t,
            (_e, cx) => this.command(cx, topic, "backlog-rm", ["--item", item.id]), { color: t.ansi1 }))
          .when(!topic.pausedAt && item.status !== "refined", (el) => el.child(action(`refine-${key}-${item.id}`, req ? "重新细化" : "细化", "send", t,
            (_e, cx) => this.command(cx, topic, "request", ["--items", item.id, "--type", "refine", "--target", "owner"]), { color: t.accent })))
          .when(Boolean(req), (el) => el.child(action(`cancel-${key}-${item.id}`, "撤销", "close", t,
            (_e, cx) => this.command(cx, topic, "request", ["--items", item.id, "--type", "refine", "--cancel"]))))));
    }));
    if (!topic.backlog.length) box.child(note(t, "先记下想法，再交给主 agent 细化成 Task 草稿。").px(12).py(8));
    return box;
  }

  topicControlButtons(t, topic) {
    if (topic.archived || topic.deleting) return [];
    const unfinished = topic.tasks.some((task) => task.runDir && taskGroup(task, topic) !== "done"
      && !["stopped", "stopping"].includes(task.run?.control?.state) && !task.run?.control?.retired);
    const ops = topic.pausedAt ? ["resume", "stop"] : unfinished ? ["pause", "stop"] : [];
    return ops.map((op) => {
      const color = op === "stop" ? t.ansi1 : op === "resume" ? t.accent : t.foreground;
      return h_flex().id(`${op}-${topic.id}`).size(22).flex_none().justify_center().items_center().rounded(6).bg(color)
        .tooltip(`${{ pause: "暂停", resume: "继续", stop: "终止" }[op]}整个 Topic`).cursor_pointer().hover((s) => s.opacity(0.82))
        .on_mouse_down("left", stop).on_click((_e, cx) => {
          cx.stop_propagation();
          this.openTopicControl(topic, op);
        }).child(icon(op === "stop" ? "square" : op === "resume" ? "play-fill" : "pause-dot", 12, t.background));
    });
  }

  openTopicControl(topic, op) {
    const tasks = topic.tasks.filter((task) => op === "delete" || task.runDir).map((task) => ({ id: task.id, title: task.title, run: task.runDir }));
    const calls = topic.runs.flatMap((r) => r.calls);
    openOverlay({ mod: "cc-dispatch", kind: "dialog", width: 520, height: op === "delete" ? 480 : 430,
      props: { role: op === "delete" ? "delete" : "control", op, topic: this.topicProps(topic), tasks,
        repo: this.topicRepo(topic), hd: this.topicHD(topic), on: this.ctx?.on ?? null,
        run: topic.implicit ? this.topicProps(topic).runs[0] : null,
        helpers: calls.length, open: calls.filter((c) => c.state === "live").map((c) => c.name),
        working: calls.filter((c) => c.state === "live" && c.status === "working").map((c) => c.name),
        held: calls.filter((c) => c.held && c.state === "live").map((c) => c.name) } });
  }

  // The run's Pause / Resume / Stop, icons only, at the end of its head. Each opens a "control"
  // dialog to confirm; hd_dispatch.py does the work.
  controlButtons(t, r, topic = null) {
    const confirm = (op) => (_e, cx) => {
      cx.stop_propagation();
      const working = r.calls.filter((c) => c.state === "live" && c.status === "working").map((c) => c.name);
      const held = r.calls.filter((c) => c.held && c.state === "live").map((c) => c.name);
      const settled = r.calls.filter((c) => c.state === "live" && c.status !== "working" && !c.held).map((c) => c.name);
      const parentLive = Boolean(r.parent) && (terminals() ?? []).some((x) => x.address === r.parent && x.state === "live");
      openOverlay({ mod: "cc-dispatch", kind: "dialog", width: 480, height: op === "stop" ? 330 : 280,
        props: { role: "control", op, on: this.ctx?.on ?? null, run: { dir: r.dir, hd: r.hd, id: r.id }, working, held, settled, parentLive } });
    };
    // Solid chips, the icon in the panel's background color: a filled pause on `foreground`, a filled
    // play on `accent`, a hollow square on `ansi1`.
    const look = { pause: ["pause-dot", "暂停运行", t.foreground], resume: ["play-fill", "继续运行", t.accent], stop: ["square", "终止运行", t.ansi1] };
    const ops = controlOps(r, Boolean(this.states[r.dir]?.finished)).filter((op) => !(topic?.pausedAt && op === "resume") && !topic?.archived && !topic?.deleting);
    if (!ops.length) return [];
    return [h_flex().flex_none().gap(6).items_center().children(ops.map((op) => {
      const [name, tip, color] = look[op];
      return h_flex().id(`${op}-${r.dir}`).size(22).flex_none().justify_center().items_center().rounded(6).bg(color)
        .cursor_pointer().hover((s) => s.opacity(0.82)).tooltip(tip)
        .on_mouse_down("left", stop).on_click(confirm(op)).child(icon(name, op === "stop" ? 13 : 11, t.background));
    }))];
  }

  archiveButton(t, topic) {
    const stable = !topic.pausedAt && !topic.deleting && topic.tasks.every((task) => !task.runDir || taskGroup(task, topic) === "done")
      && topic.runs.every((r) => !this.itemsOf(r).some((x) => !x.answer));
    const op = topic.archived ? "unarchive" : stable ? "archive" : null;
    if (!op) return [];
    const tip = op === "archive" ? "归档：从面板上隐藏（文件保留）" : "取消归档：放回列表";
    return [h_flex().id(`${op}-${topic.id}`).size(22).flex_none().justify_center().items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip).on_mouse_down("left", stop)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.command(cx, topic, op);
      })
      .child(icon(op, 13, t.muted)),
    ...(op === "unarchive" ? [this.deleteButton(t, topic)] : [])];
  }

  // An archived run's Delete, beside Unarchive: a "delete" dialog to confirm, then hd_dispatch.py delete.
  deleteButton(t, topic) {
    return h_flex().id(`delete-${topic.id}`).size(22).flex_none().justify_center().items_center().rounded(6)
      .cursor_pointer().hover((s) => s.bg(t.hover)).tooltip("删除 Topic 和它的全部运行记录").on_mouse_down("left", stop)
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.openTopicControl(topic, "delete");
      })
      .child(icon("trash", 13, t.ansi1));
  }

  // Retire a run left handing off that no main agent will adopt: a "control" dialog with op retire.
  confirmRetire(r) {
    return (_e, cx) => {
      cx.stop_propagation();
      const open = r.calls.filter((c) => c.state === "live").map((c) => c.name);
      const working = r.calls.filter((c) => c.state === "live" && c.status === "working").map((c) => c.name);
      openOverlay({ mod: "cc-dispatch", kind: "dialog", width: 500, height: 330,
        props: { role: "control", op: "retire", on: this.ctx?.on ?? null, run: { dir: r.dir, hd: r.hd, id: r.id }, open, working } });
    };
  }

  // Under the head (folded or not): the run's paused / stopping / stopped / handing-off line.
  renderControl(t, r) {
    const banner = controlBanner(r);
    if (!banner) return null;
    const on = this.ctx?.on ?? null, state = r.control?.state;
    const color = state === "paused" ? t.ansi3 : state === "stopping" ? t.ansi1 : state === "handoff" ? t.accent : t.muted;
    const mark = state === "stopping" ? icon("ring", 11, color).spin(900)
      : icon(state === "paused" ? "pause" : state === "handoff" ? "handover" : "square", 11, color);
    return h_flex().flex_none().min_h(34).px(12).py(5).gap(8).items_center().border_t(1).border_color(t.border)
      .bg(state === "paused" ? t.background : t.surface)
      .child(mark)
      .child(div().flex_1().min_w(0).truncate().text_size(S().label).text_color(color).child(banner))
      .when(state === "stopped", (el) => el.child(action(`stopmd-${r.dir}`, "总结", "file", t,
        (_e, cx) => this.showText(cx, `${r.id} · 终止总结`, () => loadStopReport(io(on), r), "还没有 stop.md。"))))
      .when(state === "handoff", (el) => el
        .child(action(`handoffmd-${r.dir}`, "交接包", "file", t,
          (_e, cx) => this.showText(cx, `${r.id} · 交接包`, () => loadHandoff(io(on), r), "还没有 handoff.md。")))
        .child(action(`copyprompt-${r.dir}`, this.copied === r.dir ? "已复制" : "复制提示", "task", t, (_e, cx) => {
          cx.spawn(async (cx) => {
            const text = await loadHandoffPrompt(io(on), r);
            if (!text) return;
            cx.write_to_clipboard(text.trim());
            this.copied = r.dir; cx.notify();
            cx.timer.after(2000, (cx) => { if (this.copied === r.dir) { this.copied = null; cx.notify(); } });
          });
        }, { color: t.accent }))
        .child(action(`retire-${r.dir}`, "收尾", "archive", t, this.confirmRetire(r), { color: t.muted })));
  }

  // Under the head: a run whose main agent is gone and that is not done. Copy resume prompt puts the
  // words for a new main agent (any program that loads the skills) on the clipboard: it runs
  // hd_dispatch.py takeover, which recovers lost helpers and adopts the run in one step.
  renderTakeover(t, r) {
    const stats = this.stats.runs[r.dir];
    if (!needsTakeover(r, terminals(), stats?.status, Boolean(this.stats.finished?.[r.dir]))) return null;
    const key = `takeover|${r.dir}`;
    return h_flex().flex_none().min_h(34).px(12).py(5).gap(8).items_center().border_t(1).border_color(t.border).bg(t.surface)
      .child(icon("handover", 11, t.accent))
      .child(div().flex_1().min_w(0).truncate().text_size(S().label).text_color(t.accent).child(takeoverBanner(r)))
      .child(action(`takeover-${r.dir}`, this.copied === key ? "已复制" : "复制接手提示", "task", t, (_e, cx) => {
        cx.write_to_clipboard(takeoverPrompt(r));
        this.copied = key; cx.notify();
        cx.timer.after(2000, (cx) => { if (this.copied === key) { this.copied = null; cx.notify(); } });
      }, { color: t.accent }));
  }

  // The run's open items (model.js pendingItems), under its head whether folded or not: what the main agent
  // waits on you for. One row each (decision or question, its options with the recommended one starred, the
  // card it is about); a row opens the "decide" dialog. Answered ones stay, muted, until the main agent closes them.
  itemsOf(r) {
    return pendingItems(r, this.stats.runs[r.dir]?.cards ?? {}, this.stats.pending?.[r.dir] ?? {});
  }

  // The run's main agent, if its terminal runs an agent now: who an answer is sent to.
  mainAgentOf(r) {
    const term = r.control?.owner || r.parent;
    return term ? (agents() ?? []).find((a) => a.address === term) ?? null : null;
  }

  openDecide(r, x) {
    const to = this.mainAgentOf(r), call = x.card ? r.calls.find((c) => c.call === x.card) : null;
    openOverlay({ mod: "cc-dispatch", kind: "dialog", width: 640, height: 600,
      props: { role: "decide", on: this.ctx?.on ?? null, run: { dir: r.dir, id: r.id }, item: x,
        to: to ? { address: to.address, name: to.program?.name ?? to.address } : null,
        reportPath: call?.reportPath ?? null, reportBackup: call?.agentDir ? `${call.agentDir}/report-r${call.round}.json` : null } });
  }

  renderAsks(t, topic) {
    const items = topic.tasks.flatMap((task) => task.run ? this.itemsOf(task.run).map((x) => ({ task, r: task.run, x })) : []);
    if (!items.length) return null;
    const open = items.filter(({ x }) => !x.answer).length, z = S();
    const key = `asks|${topic.id}`, folded = this.groupFold.get(key) ?? false;
    const box = v_flex().flex_none().border_t(1).border_color(t.border).bg(t.background)
      .child(h_flex().id(`asks-${topic.id}`).h(28).flex_none().pl(12).pr(10).gap(7).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.groupFold.set(key, !folded); cx.notify(); })
        .child(icon(folded ? "chevron-right" : "chevron-down", 10, t.muted))
        .child(icon("decide", 11, open ? t.ansi3 : t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(z.label).font_semibold().text_color(open ? t.ansi3 : t.muted)
          .child(open ? "需要你处理" : "已回答 · 等主 agent 处理"))
        .child(h_flex().h(16).px(6).flex_none().items_center().rounded(8).bg(open ? t.ansi3 : t.selected)
          .text_size(z.label).text_color(open ? t.background : t.foreground).child(String(open || items.length))));
    if (folded) return box;
    box.children(items.map(({ task, r, x }) => {
      const done = Boolean(x.answer), color = done ? t.muted : t.foreground;
      return v_flex().id(`item-${r.dir}|${x.id}`).flex_none().pl(28).pr(10).py(5).gap(2).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_mouse_down("left", stop).on_click(() => this.openDecide(r, x))
        .child(h_flex().gap(7).items_center()
          .child(done ? icon("check", 11, t.done) : icon(x.kind === "decision" ? "decide" : "question", 11, x.kind === "decision" ? t.ansi3 : t.accent))
          .child(div().flex_1().min_w(0).truncate().text_size(z.small).text_color(color).child(x.title))
          .when(Boolean(x.card), (el) => el.child(h_flex().h(15).px(4).flex_none().items_center().rounded(3).bg(t.selected)
            .font_family(mono()).text_size(z.label - 1.5).text_color(t.muted).child(x.card)))
          .when(Boolean(x.asked), (el) => el.child(div().flex_none().text_size(z.label).text_color(t.muted).child(ago(x.asked)))))
        .child(div().pl(18).truncate().text_size(z.label).text_color(t.accent).child(`Task ${task.id} · ${task.title}`))
        .child(div().pl(18).truncate().text_size(z.label).text_color(t.muted).child(itemLine(x)));
    }));
    return box;
  }

  renderBg(t, topic, bg) {
    const z = S(), on = this.ctx?.on ?? null;
    const kindIcon = { shell: "terminal", monitor: "eye", agent: "bot" };
    const statusColor = { running: t.working, completed: t.muted, failed: t.ansi1, killed: t.ansi3, stopped: t.ansi3, lost: t.muted };
    const row = (task) => {
      const running = task.status === "running", age = fmtDur((task.ended || Date.now()) - (task.started || Date.now()));
      const word = running ? age : task.status === "completed" ? `已完成 · ${age}` : ({ failed: "失败", killed: "已停止", stopped: "已停止" }[task.status] ?? task.status);
      const sub = running ? (task.event || task.tail?.[task.tail.length - 1] || "") : (task.status === "completed" ? "" : bgSummary(task));
      return v_flex().id(`bg-${topic.id}|${task.session}|${task.id}`).flex_none().pl(28).pr(10).py(4).gap(1)
        // An output file (Claude Code) opens live while running, else its end; a log (Codex) is shown as is.
        .when(Boolean(task.output || task.log), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => running && task.kind !== "agent" && task.output
            ? openOverlay({ mod: "cc-dispatch", kind: "dialog", width: 860, height: 620,
              props: { role: "bgtask", title: task.title, output: task.output, on, task: { started: task.started, command: task.command } } })
            : this.showText(cx, `${task.title} · 输出`, async () => (task.output ? await loadOutput(io(on), task.output) : null) ?? task.log ?? null, "没有输出。",
              (text) => `~~~~\n${text.replace(/\s+$/, "")}\n~~~~`)))
        .child(h_flex().min_w(0).gap(8).items_center()
          .child(running && task.kind !== "agent" ? icon("ring", 11, t.working).spin(1400) : icon(kindIcon[task.kind] ?? "terminal", 11, running ? t.working : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(z.label).text_color(running ? t.foreground : t.muted).child(task.title))
          .child(div().flex_none().text_size(z.label).text_color(statusColor[task.status] ?? t.muted).child(word)))
        .when(Boolean(sub), (el) => el.child(div().pl(19).truncate().font_family(mono()).text_size(z.label - 1).text_color(t.muted).child(sub)));
    };
    const box = v_flex().flex_none().py(4).border_t(1).border_color(t.border).bg(t.background)
      .child(h_flex().pl(28).pr(10).py(3).gap(6).items_center().text_size(z.label).text_color(t.muted)
        .child(div().flex_1().child("后台任务 · 主 agent"))
        .child(div().flex_none().child(bg.running.length ? `${bg.running.length} 个运行中` : "没有在运行的")));
    box.children(bg.running.map(row));
    box.children(bg.ended.map(row));
    // Newest ended first; "n earlier" shows BG_MORE more each click, "show fewer" folds back to the first few.
    const link = (id, text, fn) => div().id(id).flex_none().text_size(z.label).text_color(t.muted).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { fn(); cx.notify(); }).child(text);
    if (bg.hidden || bg.more) box.child(h_flex().pl(28).pr(10).py(3).gap(12).items_center()
      .when(bg.hidden > 0, (el) => el.child(link(`bg-more-${topic.id}`, `更早的 ${bg.hidden} 个 · 再显示 ${Math.min(BG_MORE, bg.hidden)} 个`,
        () => this.bgMore.set(topic.id, bg.more + BG_MORE))))
      .when(bg.more > 0, (el) => el.child(link(`bg-less-${topic.id}`, "收起", () => this.bgMore.delete(topic.id)))));
    return box;
  }

  // What a run has spent so far, under its head: time, commands, patched files, tokens split into
  // cached / new input / output, and for dev runs how many cards are merged.
  renderStats(t, topic, s) {
    const z = S();
    const cell = (value, label) => v_flex().flex_1().min_w(0)
      .child(div().truncate().text_size(z.body).font_semibold().child(value))
      .child(div().truncate().text_size(z.label).text_color(t.muted).child(label));
    const bar = (parts, total) => h_flex().h(6).w_full().rounded(3).overflow_hidden().bg(t.selected)
      .children(parts.filter(([n]) => n > 0).map(([n, color]) => div().h_full().w(`${Math.min(100, (n / Math.max(1, total)) * 100).toFixed(2)}%`).bg(color)));
    const key = (color, label) => h_flex().gap(4).items_center().child(div().size(7).rounded(2).bg(color)).child(label);
    const line = (label, value) => h_flex().items_center().gap(6)
      .child(div().text_size(z.label).text_color(t.muted).child(label)).child(div().flex_1())
      .child(div().text_size(z.small).font_semibold().child(value));

    const cells = [
      s.elapsed != null && cell(fmtDur(s.elapsed), this.topicActive(topic) ? "已用时" : "用时"),
      s.known && cell(String(s.commands), "命令"),
      s.known && cell(String(s.files), "改动文件"),
    ].filter(Boolean);
    const box = v_flex().flex_none().px(12).pt(8).pb(10).gap(10).border_t(1).border_color(t.border);
    if (cells.length) box.child(h_flex().gap(8).children(cells));
    if (topic.tasks.length) {
      // One row per Task: its status, role and title, then one block per card it owns, coloured by the
      // card's status. Merged counts leave parked cards out (they show in the key); review calls are not cards.
      const colors = CARD_COLORS(t), done = topic.tasks.filter((task) => taskGroup(task, topic) === "done").length;
      const v = s.cards ? cardView(s.cards, topic.runs.flatMap((r) => r.calls.map((c) => `${r.dir}#${c.call}`))) : null;
      const rows = groupTasks(topic).flatMap((g) => g.tasks).map((task) => {
        const run = task.runDir ? this.stats.runs[task.runDir] : null, status = run?.status ?? {};
        const ids = Object.keys(status).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
        const own = ids.length ? cardView(run) : null, stage = this.taskStage(topic, task);
        return h_flex().gap(6).items_center().h(18)
          .child(h_flex().w(16).flex_none().justify_center().child(statusMark(t, `stat-${topic.id}|${task.id}`, stage === "working" ? "running" : stage) ?? div()))
          .child(div().min_w(0).flex_1().truncate().text_size(z.small).child(task.title))
          .when(ids.length > 0, (el) => el
            .child(div().w(84).flex_none().child(bar(cardCounts({ status }).map(([st, n]) => [n, colors[st] ?? t.muted]), ids.length)))
            .child(div().w(30).flex_none().text_size(z.label).text_color(t.muted).text_right().child(`${own.merged}/${own.goal}`)));
      });
      const counts = s.cards ? cardCounts(s.cards) : [];
      box.child(v_flex().gap(5)
        .child(h_flex().gap(6).items_center().text_size(z.label).text_color(t.muted)
          .child("Tasks").child(div().font_semibold().text_color(t.foreground).child(`${done}/${topic.tasks.length}`)))
        .children(rows)
        // All cards of the Topic: one bar by status, then the key with counts.
        .when(counts.length > 0, (el) => el.child(h_flex().pt(3).gap(6).items_center()
          .child(div().flex_1().min_w(0).child(bar(counts.map(([st, n]) => [n, colors[st] ?? t.muted]), v.total)))
          .child(div().w(30).flex_none().text_size(z.label).text_color(t.muted).text_right().child(`${v.merged}/${v.goal}`))))
        .when(counts.length > 0, (el) => el.child(h_flex().gap(8).overflow_hidden().text_size(z.label).text_color(t.muted)
          .children(counts.map(([st, n]) => key(colors[st] ?? t.muted, `${CARD_WORDS[st] ?? st} ${n}`).flex_none())))));
    }
    if (s.tokens) {
      const k = s.tokens;
      box.child(v_flex().gap(5)
        .child(line("token", fmtTok(k.total)))
        .child(bar([[k.cached, t.ansi4], [k.fresh, t.ansi6], [k.output, t.ansi3]], k.total))
        .child(h_flex().flex_wrap().gap(10).text_size(z.label).text_color(t.muted)
          .child(key(t.ansi4, `缓存 ${fmtTok(k.cached)}`))
          .child(key(t.ansi6, `新输入 ${fmtTok(k.fresh)}`))
          .child(key(t.ansi3, `输出 ${fmtTok(k.output)}`))));
    }
    return box;
  }

  // `tagged`: show the status mark (rows inside a stage group leave it to the group's header).
  renderCall(t, c, tagged = true, inset = 28) {
    const open = this.open === c.key, spent = this.stats.calls[c.key];
    const raw = callStage(c, this.stats.runs[c.runDir]?.status?.[c.call]);
    // Once the run is finished, a helper that reported fine (e.g. the survey, which has no card) is simply done.
    const stage = this.states[c.runDir]?.finished && (raw === "ok" || raw === "ended") ? "done" : raw;
    // The helper herdr has in front now (focused, or peeked/shown in a pane), as the Agents list marks it.
    const f = focused(), here = Boolean(c.address) && c.state === "live" && (f?.terminal === c.address || f?.shown === c.address || f?.agent === c.address);
    const live = c.state === "live";
    const tag = (text, color) => h_flex().h(15).px(4).flex_none().items_center().rounded(3).bg(t.selected)
      .font_family(mono()).text_size(S().label - 1.5).text_color(color ?? t.muted).child(text);
    // One line: the terminal dot, the name (white while its terminal is open, grey once closed), small
    // tags for mode·effort ("wh") and round ("r2"), a failure or retry word, and its tokens at the right.
    const row = h_flex().id(`call-${c.key}`).h(30).flex_none().pl(inset).pr(10).gap(7).items_center().cursor_pointer()
      .bg(open || here ? t.raised : t.surface).hover((s) => s.bg(open || here ? t.raised : t.hover))
      .when(here, (el) => el.border_l(2).border_color(t.accent))
      .on_click((_e, cx) => { this.open = open ? null : c.key; cx.notify(); })
      .child(termDot(t, c))
      .children([this.renderExecutor(t, c.agent ?? "codex")].filter(Boolean))
      .child(div().min_w(0).flex_shrink(1).truncate().text_size(S().body).text_color(live ? t.foreground : t.muted).child(callLabel(c)))
      .when(tagged, (el) => el.children([statusMark(t, `mark-${c.key}`, stage)].filter(Boolean)))
      .children(callTags(c).map((x) => tag(x)))
      .when(Boolean(agentTag(c)?.weak), (el) => el.child(tag("弱隔离", t.ansi3)))
      .when(Boolean(c.handingTo), (el) => el.child(tag(`→ ${c.handingTo}`, t.accent)))
      .when(Boolean(c.failure && c.failure !== "exited" && c.failure !== "blocked"), (el) => el.child(tag(failureWord(c.failure), t.ansi1)))
      .when(Boolean(c.retry), (el) => el.child(tag(c.retry.split(" ").pop(), t.ansi3)))
      .child(div().flex_1())
      .when(Boolean(spent?.tokens), (el) => el.child(div().flex_none().text_size(S().label).text_color(t.muted).child(fmtTok(spent.tokens.input + spent.tokens.output))));
    if (!open) return row;
    return v_flex().flex_none().bg(t.raised).child(row).child(this.renderActions(t, c, inset));
  }

  renderActions(t, c, inset = 28) {
    const on = this.ctx?.on ?? null, live = c.state === "live";
    const card = this.stats.runs[c.runDir]?.cards?.[c.call] ?? null;
    const asks = handoffAsks(c, card), to = asks.length && !asks.includes("decide") ? this.receiver(c) : null;
    // Two rows of separate outlined buttons, both ending in a 28px square column so their edges line up.
    // Row one: Result (its report and, for write and net helpers, the worktree's changes), Task (its
    // rounds: events and task files), View (live only; jumps to its terminal), then Clean up as an icon in the square. Row two,
    // when there is one: Ask (a message to its main agent) and Hand over…, on the same three columns as row one. Empty
    // cells keep the columns.
    const cell = (id, label, iconName, onClick, color = t.foreground) => h_flex().id(id).flex_1().min_w(0).h(28).px(6).gap(5)
      .justify_center().items_center().rounded(6).border_1().border_color(t.border)
      .text_size(S().small).text_color(color).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_mouse_down("left", stop).on_click(onClick).child(icon(iconName, 12, color)).child(div().truncate().child(label));
    const gap = () => div().flex_1().min_w(0);
    const square = (id, tip, iconName, onClick, color) => h_flex().id(id).flex_none().size(28).justify_center().items_center()
      .rounded(6).border_1().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover)).tooltip(tip)
      .on_mouse_down("left", stop).on_click(onClick).child(icon(iconName, 13, color));
    const grid = (cells, end) => h_flex().gap(6).children(cells.map((x) => x || gap())).child(end || div().flex_none().w(28));
    const writes = (c.mode === "write" || c.mode === "net") && c.dir;
    const view = grid([
      cell(`result-${c.key}`, "结果", "file", (_e, cx) => this.showResult(cx, c, on, writes)),
      cell(`task-${c.key}`, "任务", "task", (_e, cx) => this.showText(cx, `${c.call} · 任务和各轮`, async () => {
        const files = io(on);
        const [events, tasks] = [await loadEvents(files, c), await loadTasks(files, c)];
        const text = Object.entries(tasks).reverse().map(([k, x]) => `==> task-${k}.md <==\n${x ?? "（缺失）"}`).join("\n\n")
          + `\n\n==> events.jsonl <==\n${events ?? ""}`;
        return { text, markdown: roundsMarkdown(c, events, tasks), doc: taskDoc(c, events, tasks) };
      }, "没有任务文件。")),
      live && cell(`peek-${c.key}`, "查看", "eye", () => goTo(c.address, c.parent)),
    ], live && square(`kill-${c.key}`, "清理", "trash", () => openOverlay({
      mod: "cc-dispatch", kind: "dialog", width: 440, height: 220,
      props: { role: "cleanup", address: c.address, call: c.call, name: c.name } }), t.ansi1));
    // Ask: a message to its main agent. A card parked for you offers your two answers instead.
    // Hand over: freeze it and start another agent (or a fresh session of the same one) on its task.
    const run = this.runs.find((r) => r.dir === c.runDir) ?? null;
    const ASK_LABEL = { accept: "请求验收" };
    const item = asks.includes("decide") && run ? this.itemsOf(run).find((x) => x.card === c.call) ?? null : null;
    const askCells = asks.includes("decide")
      ? (item ? [cell(`decide-${c.key}`, item.answer ? "已回答 · 修改…" : "决定…", "decide", () => this.openDecide(run, item), t.ansi3)] : [])
      : to ? asks.map((ask) => cell(`ask-${ask}-${c.key}`, ASK_LABEL[ask] ?? "询问", "send", () => openOverlay({
        mod: "cc-dispatch", kind: "dialog", width: 480, height: 300,
        props: { role: "handoff", address: to.address, name: to.program?.name ?? to.address, text: handoffText(c, ask) } }), t.accent)) : [];
    const parentLive = Boolean(c.parent && (terminals() ?? []).find((x) => x.address === c.parent && x.state === "live"));
    const handIt = canHandOver(c, run) && cell(`handover-${c.key}`, "移交…", "handover", () => openOverlay({
      mod: "cc-dispatch", kind: "dialog", width: 500, height: 360,
      props: { role: "handover", on, run: { dir: c.runDir, hd: run?.hd ?? c.hd, id: run?.id ?? baseName(c.runDir) },
        call: c.call, name: c.name, agent: c.agent, live, round: c.round, mode: c.mode, parentLive,
        log: `${c.agentDir}/handover.log` } }));
    const second = [...askCells, handIt].filter(Boolean).slice(0, 2);
    const terminal = second.length ? grid([...second, null, null].slice(0, 3)) : null;
    const spend = callSpend(this.stats.calls[c.key]);
    const who = c.lost ? "已中断：交出合格回报之前终端消失了。要等主 agent（或你）决定怎么处理。"
      : c.offline ? "等网络：网络恢复后会自己接着做，不占重试次数。"
      : c.handingTo ? `正在移交给 ${agentLabel(c.handingTo)}：它在写交接说明`
      : weakIsolation(c) ? `${agentLabel(c.agent)} · 弱隔离：没有沙箱，只靠任务文件里的规定让它待在自己的目录里` : null;
    // Its dev card, when it has one: what the main agent made of it, and why it is parked.
    const why = parkedWhy(card);
    const cardLine = card && (why || card.note || card.result || ["pending", "running"].includes(card.status))
      ? [`卡片${CARD_WORDS[card.status] ?? card.status}`,
         why === "user" ? "等你决定" : why === "superseded" ? `已被${card.by ? ` ${card.by} ` : ""}取代` : why === "dropped" ? "已放弃" : null,
         card.note || card.result].filter(Boolean).join(" · ") : null;
    return v_flex().pl(inset).pr(10).pt(2).pb(10).gap(6)
      .when(Boolean(spend), (el) => el.child(div().pb(2).text_size(S().label).text_color(t.muted).child(spend)))
      .when(Boolean(who), (el) => el.child(div().pb(2).text_size(S().label).text_color(c.lost ? t.ansi1 : c.handingTo ? t.accent : t.ansi3).child(who)))
      .when(Boolean(cardLine), (el) => el.child(div().pb(2).text_size(S().label).text_color(why === "user" ? t.ansi3 : t.muted).child(cardLine)))
      .child(view)
      .when(Boolean(terminal), (el) => el.child(terminal));
  }

  // load() gives the source text (or { text, markdown }), render() its markdown; the dialog shows
  // the markdown and can switch to the source.
  showText(cx, title, load, empty, render = (text) => text) {
    cx.spawn(async () => {
      let text, markdown, doc = null;
      try {
        const got = await load();
        text = (typeof got === "string" ? got : got?.text) || empty;
        markdown = got?.markdown ?? render(text);
        doc = got?.doc ?? null;
      } catch (e) {
        text = markdown = String(e?.message ?? e);
      }
      openOverlay({ mod: "cc-dispatch", kind: "dialog", width: doc ? 980 : 760, height: doc ? 680 : 600, props: { role: "text", title, text, markdown, doc } });
    });
  }

  showResult(cx, c, on, writes) {
    this.showText(cx, `${c.call} · 结果（第 ${c.round} 轮）`, async () => {
      const files = io(on);
      const { text, exists, path } = await loadReport(files, c);
      const older = await earlierReports(files, c);
      const diff = writes ? await loadDiff(files, c) : null;
      const head = [
        `结论：${{ ok: "合格", bad: "不合格", missing: "缺失" }[c.report] ?? "还没检查（hd_dispatch.py collect 时检查）"}`,
        `文件：${c.reportPath}`,
        path && path !== c.reportPath ? `读的是运行目录里的副本：${path}` : null,
        `schema：${c.schema}`,
        older.length ? `之前各轮：${older.join(", ")}` : null,
      ].filter(Boolean).join("\n");
      return { text: `${head}\n\n${exists ? text : "（还没写回报）"}${diff != null ? `\n\n==> worktree <==\n${diff}` : ""}`,
        markdown: resultMarkdown(c, exists ? text : null, older, diff), doc: resultDoc(c, exists ? text : null, older, diff) };
    }, "");
  }

  renderFooter(t) {
    const topics = this.split().mine.filter((topic) => !topic.archived);
    const live = topics.filter((topic) => this.topicActive(topic) && !topic.pausedAt).length;
    const calls = new Map(topics.flatMap((topic) => topic.runs.flatMap((r) => r.calls.map((c) => [c.key, c]))));
    const helpers = [...calls.values()].filter((c) => c.state === "live" && c.status === "working").length;
    const waiting = topics.reduce((n, topic) => n + topic.runs.reduce((n, r) => n + this.itemsOf(r).filter((x) => !x.answer).length, 0), 0);
    const text = `${topics.length} 个 Topic · ${live} 个进行中 · ${helpers} 个 agent 在干活 · ${waiting} 项等你`;
    return h_flex().h(34).flex_none().px(14).items_center().border_t(1).border_color(t.border)
      .text_size(S().label).text_color(t.muted)
      .child(div().flex_1().min_w(0).truncate().tooltip(text).child(text))
      .when(Boolean(this.statsError), (el) => el.child(div().flex_none().max_w(160).truncate().text_color(t.ansi3).child(this.statsError)));
  }

  // ---- Dialogs ----

  // A structured doc: the outline (all, then each group and its parts), and what the chosen entry shows.
  renderDoc(t, p) {
    const z = S(), doc = p.doc;
    if (this.docFor !== p.title) { this.docFor = p.title; this.docSel = null; }
    const sel = this.docSel ?? null;
    const entry = (id, title, opts = {}) => {
      const on = (sel ?? null) === id, c = toneColor(t, opts.tone);
      return h_flex().id(`nav-${id ?? "all"}`).h(opts.group ? 26 : 22).flex_none().gap(6).items_center().rounded(5)
        .pl(opts.group ? 8 : 18 + 12 * Math.max(0, opts.depth ?? 0)).pr(6).cursor_pointer()
        .bg(on ? t.selected : t.background).hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => { this.docSel = id; cx.notify(); })
        .when(Boolean(opts.group), (el) => el.child(tdot(c ?? t.border, 7)))
        .when(!opts.group && Boolean(c) && opts.tone !== "muted", (el) => el.child(tdot(c, 5)))
        .child(div().flex_1().min_w(0).truncate().text_size(opts.group ? z.small : z.label)
          .when(Boolean(opts.group), (el) => el.font_semibold())
          .text_color(on || opts.group ? t.foreground : t.muted).child(title))
        .when(Boolean(opts.badge), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(z.label - 1).text_color(opts.tone === "accent" ? t.accent : t.muted).child(opts.badge)));
    };
    const nav = v_flex().id("doc-nav").w(230).flex_none().min_h(0).overflow_y_scrollbar().p(6).gap(1).rounded(8)
      .border_1().border_color(t.border).bg(t.background)
      .child(entry(null, "全部", { group: true, tone: "accent" }))
      .children(docEntries(doc).map((x) => x.depth < 0
        ? div().pt(6).child(entry(x.node.id, x.node.title, { group: true, tone: x.node.tone, badge: x.node.badge }))
        : entry(x.node.id, x.node.title, { depth: x.depth, tone: x.node.tone, badge: x.node.badge })));
    const head = (n, level, depth = 0) => {
      const c = toneColor(t, n.tone);
      return level === 0
        ? h_flex().gap(8).items_center().pb(6).border_b(1).border_color(t.border)
          .child(div().w(4).h(16).flex_none().rounded(2).bg(c ?? t.accent))
          .child(div().flex_1().min_w(0).truncate().text_size(z.title + 1).font_semibold().child(n.title))
          .when(Boolean(n.badge), (el) => el.child(pill(t, n.badge, n.tone === "accent" ? t.accent : t.muted)))
        : h_flex().gap(7).items_center().pt(depth > 0 ? 2 : 4)
          .when(Boolean(c) && n.tone !== "muted", (el) => el.child(tdot(c, 7)))
          .child(div().flex_1().min_w(0).text_size(depth > 0 ? z.body : z.title).font_semibold()
            .text_color(depth > 1 ? t.muted : t.foreground).child(n.title))
          .when(Boolean(n.badge), (el) => el.child(pill(t, n.badge)));
    };
    const blocks = (n) => n.blocks.map((b, i) => docBlock(t, b, `doc-${n.id}-${i}`));
    const content = v_flex().gap(22).children(docSelection(doc, sel).map(({ group, parts, whole }) => v_flex().gap(12)
      .child(whole ? head(group, 0) : h_flex().gap(6).items_center().text_size(z.small).text_color(t.muted)
        .child(group.title).child(icon("chevron-right", 11, t.muted)))
      .children(whole ? blocks(group) : [])
      .children(parts.map((n) => v_flex().gap(8).pl(Math.min(2, n.depth ?? 0) * 10)
        .child(head(n, 1, n.depth ?? 0)).children(blocks(n))))));
    return h_flex().flex_1().min_h(0).gap(10).items_start()
      .child(nav.h_full())
      .child(div().id(`doc-${p.title ?? ""}-${sel ?? "all"}`).flex_1().min_w(0).h_full().overflow_y_scrollbar().px(18).py(14)
        .rounded(8).border_1().border_color(t.border).bg(t.background).text_color(t.foreground).child(content));
  }

  // Answer one open item: pick an option (a decision's, or a question's suggested answer) and/or write. Send
  // appends the answer to <run>/answers.jsonl (hd_dispatch.py wait returns on it) and, when the run's main
  // agent runs and is not waiting on a question, sends it the message shown; else the next one reads it.
  renderDecide(t, p, close) {
    const x = p.item ?? {}, z = S(), run = p.run ?? {}, text = this.answerBox?.value() ?? "";
    const decision = x.kind === "decision", opts = x.options ?? [];
    const agent = p.to ? (agents() ?? []).find((a) => a.address === p.to.address) ?? null : null;
    const reach = !agent ? "gone" : agent.status === "blocked" ? "blocked" : "ok";
    const ready = decision ? Boolean(this.choice) : Boolean(this.choice || text.trim());
    const ans = { choice: this.choice, text };
    const msg = ready ? answerText({ dir: run.dir }, x, ans) : "";
    const badge = (label, color) => h_flex().h(18).px(7).flex_none().items_center().rounded(9).border_1().border_color(color)
      .text_size(z.label).text_color(color).child(label);
    const option = (o) => {
      const on = this.choice === o.key, rec = o.key === x.recommend;
      return h_flex().id(`opt-${o.key}`).flex_none().px(12).py(8).gap(10).items_start().rounded(8).border_1()
        .border_color(on ? t.accent : t.border).bg(on ? t.selected : t.background).cursor_pointer().hover((s) => s.bg(on ? t.selected : t.hover))
        .on_click((_e, cx) => { this.choice = on ? null : o.key; cx.notify(); })
        .child(div().mt(3).size(12).flex_none().rounded_full().border(on ? 4 : 1.5).border_color(on ? t.accent : t.muted))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(h_flex().gap(8).items_center()
            .child(div().flex_none().font_family(mono()).text_size(z.label).text_color(t.muted).child(o.key))
            .child(div().flex_1().min_w(0).text_size(z.body).font_semibold().text_color(t.foreground).child(o.label))
            .when(rec, (el) => el.child(badge("推荐", t.accent))))
          .when(Boolean(o.detail), (el) => el.child(div().text_size(z.small).text_color(t.muted).child(o.detail)))
          .when(rec && Boolean(x.why), (el) => el.child(div().text_size(z.small).text_color(t.accent).child(`理由：${x.why}`))));
    };
    const context = [x.context, this.extra?.length ? `**子 agent 还没解决的问题**\n\n${this.extra.map((q) => `- ${q}`).join("\n")}` : null,
      x.blocks?.length ? `在等这件事的：${x.blocks.join("、")}` : null].filter(Boolean).join("\n\n");
    const go = (_e, cx) => {
      if (!ready || this.sending) return;
      this.sending = true; this.failed = null; cx.notify();
      cx.spawn(async (cx) => {
        const saved = await saveAnswer(io(p.on ?? null), run.dir, answerRecord(x, ans));
        if (!saved.ok) { this.sending = false; this.failed = `回答没保存成功：${saved.error}`; cx.notify(); return; }
        if (reach === "ok") {
          const r = await hc(["send", p.to.address, msg]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
          if (r.code === 0) { close(); return; }
          this.failed = `已保存，但没发出去：${(r.stderr || r.stdout || "hc send 失败").trim().split("\n").pop()}。主 agent 下次等待时会看到。`;
        }
        this.sending = false; this.saved = true; cx.notify();
      });
    };
    const where = reach === "ok" ? `已保存到运行里（answers.jsonl），并发给了主 agent ${p.to.name}（${p.to.address}）。`
      : reach === "blocked" ? `已保存到运行里。${p.to?.name} 正在等一个确认，所以没往它那里输入；它下次等待或收回报时会看到你的回答。`
      : "已保存到运行里。主 agent 不在运行：之后谁接手这个运行，都能看到你的回答（hd_dispatch.py ask --list、wait、collect）。";
    const body = [
      h_flex().flex_none().gap(8).items_center()
        .child(badge(decision ? "决定" : "问题", decision ? t.ansi3 : t.accent))
        .when(Boolean(x.card), (el) => el.child(badge(`card ${x.card}`, t.muted)))
        .child(div().flex_1().min_w(0).truncate().text_size(z.label).text_color(t.muted).child(`${run.id ?? ""}${x.asked ? ` · ${ago(x.asked)}提问` : ""}`)),
      x.answer && note(t, `${ago(x.answer.at * 1000)}已回答：${answerWords(x.answer)}。再发一次会替换它。`, t.done),
      v_flex().id("decide-body").flex_1().min_h(0).overflow_y_scrollbar().gap(10)
        .when(Boolean(context), (el) => el.child(div().flex_none().px(14).py(10).rounded(8).border_1().border_color(t.border).bg(t.background)
          .text_size(z.body).child(TextView.markdown("decide-context", context).selectable(true))))
        .when(opts.length > 0, (el) => el
          .child(div().flex_none().text_size(z.label).text_color(t.muted).child(decision ? "选一个" : "建议的回答（可不选）"))
          .children(opts.map(option)))
        .child(div().flex_none().text_size(z.label).text_color(t.muted).child(decision ? "备注（可不填）" : "你的回答"))
        .child(div().id("answer").flex_none().on_mouse_down("left", stop)
          .child(Textarea.new(this.answerBox).h(78).w_full().px(10).py(8).rounded(8).border_1()
            .border_color(this.typing ? t.accent : t.input).bg(t.background).text_size(z.body).text_color(t.foreground)))
        .when(Boolean(msg), (el) => el.child(div().flex_none().text_size(z.label).text_color(t.muted).child(`主 agent 会收到：${msg}`))),
      note(t, this.saved ? (this.failed ?? where) : where, this.saved ? t.done : t.muted),
      this.failed && !this.saved && note(t, this.failed, t.ansi1),
    ];
    return dialogFrame(t, "decide", x.title ?? "", body, [
      dialogButton("cancel", this.saved ? "关闭" : "取消", t, close, this.saved ? "primary" : "secondary"),
      !this.saved && dialogButton("go", this.sending ? "发送中…" : reach === "ok" ? "发送" : "保存回答", t, go, "primary", ready && !this.sending),
    ], close);
  }

  renderForm(t, p, close) {
    const role = p.role, topic = p.topic, task = p.task;
    const title = this.titleBox.value(), detail = this.detailBox.value(), text = this.backlogBox.value();
    const owner = (agents() ?? []).find((a) => a.address === topic?.owner?.terminal);
    const ownerLive = Boolean(owner), ownerName = owner?.program?.name ?? agentLabel(topic?.owner?.agent) ?? "主 agent";
    const installed = this.programs.filter((program) => program.installed && program.run?.length);
    const fallback = installed.find((program) => program.key === topic?.owner?.agent) ?? installed[0];
    const picked = this.pick === "owner" && ownerLive ? "owner" : installed.some((program) => program.key === this.pick) ? this.pick
      : ownerLive && this.pick == null ? "owner" : fallback?.key ?? null;
    const program = installed.find((program) => program.key === picked);
    const editor = (label, id, box, height) => v_flex().flex_none().gap(5)
      .child(note(t, label, t.foreground))
      .child(div().id(id).on_mouse_down("left", stop).child(Textarea.new(box).w_full().h(height).px(10).py(8).rounded(8)
        .border_1().border_color(t.input).bg(t.background).text_size(S().body).text_color(t.foreground)));
    const kinds = v_flex().flex_none().gap(5).child(note(t, "职责", t.foreground))
      .child(h_flex().gap(5).flex_wrap().children(TASK_KINDS.map((kind) => h_flex().id(`kind-${kind}`).h(26).px(9).items_center().rounded(5)
        .border_1().border_color(this.kind === kind ? t.accent : t.border).bg(this.kind === kind ? t.selected : t.background)
        .text_size(S().small).text_color(this.kind === kind ? t.accent : t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.kind = kind; cx.notify(); }).child(kind))))
      .when(Boolean(KIND_GUIDE[this.kind]), (el) => {
        const g = KIND_GUIDE[this.kind], line = (label, text) => h_flex().gap(8).items_start()
          .child(div().w(28).flex_none().text_size(S().small).text_color(t.muted).child(label))
          .child(div().flex_1().min_w(0).text_size(S().small).text_color(t.foreground).child(text));
        return el.child(v_flex().gap(4).px(10).py(8).rounded(6).bg(t.hover)
          .child(line("作用", g.use)).child(line("能做", g.can)).child(line("限制", g.limit)).child(line("要写", g.hint)));
      });
    const choice = (key, label, subtitle) => h_flex().id(`executor-${key}`).flex_none().px(10).py(7).gap(8).items_center().rounded(6).border_1()
      .border_color(picked === key ? t.accent : t.border).bg(picked === key ? t.selected : t.background).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.pick = key; cx.notify(); })
      .child(div().size(10).flex_none().rounded_full().border(picked === key ? 3 : 1).border_color(picked === key ? t.accent : t.muted))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(S().small).child(label))
        .child(div().text_size(S().label).text_color(t.muted).child(subtitle)));
    const body = v_flex().id(`${role}-fields`).flex_1().min_h(0).overflow_y_scrollbar().gap(12);
    if (role === "newtopic") {
      body.child(editor("Topic 标题", "topic-title", this.titleBox, 54))
        .child(note(t, p.owner ? `主 agent：${p.ownerName ?? p.owner}（${p.owner}）` : "当前空间没有聚焦的主 agent，稍后可派发到新标签页。"));
    } else if (role === "backlog") {
      body.child(editor("backlog 内容", "backlog-text", this.backlogBox, 160));
      if (p.item?.request) body.child(note(t, "修改内容会撤销当前细化请求，条目回到待细化。", t.ansi3));
    } else {
      if (role === "task") body.child(editor("Task 标题", "task-title", this.titleBox, 48));
      else body.child(note(t, `${task.id} · ${task.title}`, t.foreground));
      body.child(kinds).child(editor("说明", "task-detail", this.detailBox, role === "dispatch" ? 100 : 130));
      if (role === "task" && task?.request) body.child(note(t, "修改职责或说明会撤销当前派发请求。", t.ansi3));
      if (role === "dispatch") {
        body.child(note(t, "执行者", t.foreground));
        if (ownerLive) body.child(choice("owner", `当前主 agent（${ownerName}）`, "加入队列，等主 agent 空闲时自动送达"));
        else body.child(note(t, "主 agent 已离线 · 默认新开标签页。", t.ansi3));
        body.children(installed.map((program) => choice(program.key, `${program.name} · 新标签页`, "在当前空间启动，并带上这个 Task 的派发消息")));
        if (this.programsBusy) body.child(note(t, "正在查找已安装的 agent…"));
        if (!this.programsBusy && !installed.length) body.child(note(t, "没有找到可在新标签页启动的 agent。"));
        if (this.programsError) body.child(note(t, this.programsError, t.ansi3));
      }
    }
    const ready = role === "backlog" ? Boolean(text.trim()) : role === "dispatch" ? Boolean(picked) && !topic?.pausedAt
      : Boolean(title.trim());
    const submit = (_e, cx) => {
      if (this.sending || !ready) return;
      this.sending = true; this.failed = null; cx.notify();
      const files = io(p.on ?? null);
      cx.spawn(async (cx) => {
        try {
          const invoke = async (op, args = []) => {
            const res = await topicCmd(files, p.hd, ["topic", op, "--repo", p.repo, ...(topic ? ["--topic", topic.id] : []), ...args]);
            if (!res.ok) throw new Error(commandError(res.out));
            return res.out;
          };
          if (role === "newtopic") {
            await invoke("init", ["--title", title, ...(p.owner ? ["--owner", p.owner] : [])]);
          } else if (role === "backlog") {
            await invoke(p.item ? "backlog-edit" : "backlog-add", [...(p.item ? ["--item", p.item.id] : []), "--text", text]);
          } else if (role === "task") {
            await invoke(task ? "task-edit" : "task-add", [...(task ? ["--task", task.id] : []), "--title", title, "--kind", this.kind, "--detail", detail]);
          } else {
            if (this.kind !== task.kind || detail !== task.detail) await invoke("task-edit", ["--task", task.id, "--kind", this.kind, "--detail", detail]);
            const agent = picked === "owner" ? owner?.program?.key ?? topic.owner?.agent : program.key;
            const out = await invoke("request", ["--task", task.id, "--type", "dispatch", "--target", picked === "owner" ? "owner" : "new_tab",
              ...(agent ? ["--agent", agent] : [])]);
            if (picked !== "owner") {
              const raw = outputValue(out, "MESSAGE");
              let message;
              try { message = JSON.parse(raw); } catch { throw new Error("派发请求已保存，但返回的 MESSAGE 无法读取。"); }
              if (typeof message !== "string" || !message) throw new Error("派发请求已保存，但没有返回首条消息。");
              run("tab.new", { space: p.space, folder: p.repo, argv: program.run, task: message });
            }
          }
          close();
        } catch (e) {
          this.failed = String(e?.message ?? e); this.sending = false; cx.notify();
        }
      });
    };
    const label = role === "newtopic" ? "新建 Topic" : role === "dispatch" ? picked === "owner" ? "加入队列" : "新开标签页并派发"
      : role === "backlog" ? p.item ? "保存" : "添加" : task ? "保存草稿" : "添加草稿";
    return dialogFrame(t, role, role === "dispatch" ? "派发 Task" : role === "task" ? task ? "编辑 Task 草稿" : "新建 Task 草稿"
      : role === "backlog" ? p.item ? "编辑 backlog" : "添加 backlog" : "新建 Topic",
    [body, this.failed && note(t, this.failed, t.ansi1)], [
      dialogButton("cancel", "取消", t, close),
      dialogButton("go", this.sending ? "处理中…" : label, t, submit, "primary", ready && !this.sending),
    ], close);
  }

  affectedTasks(t, p) {
    if (!p.topic) return null;
    return v_flex().id("affected-tasks").flex_1().min_h(40).overflow_y_scrollbar().gap(4)
      .child(note(t, `受影响的 Task（${p.tasks?.length ?? 0} 个）`, t.foreground))
      .children((p.tasks ?? []).map((task) => note(t, `${task.id} · ${task.title}`).tooltip(task.run ?? "草稿")))
      .when(!p.tasks?.length, (el) => el.child(note(t, p.op === "delete" ? "没有 Task。" : "没有已绑定运行的 Task。")));
  }

  renderDialog() {
    const t = theme(), p = blockProps() ?? {}, close = () => closeOverlay(p.overlay);
    if (["dispatch", "task", "backlog", "newtopic"].includes(p.role)) return this.renderForm(t, p, close);
    if (p.role === "text") {
      const md = p.markdown ?? null, raw = !md || this.raw || md.length > MARKDOWN_LIMIT;
      const seg = (id, label, on, value) => h_flex().id(id).h(24).px(10).items_center().rounded(5).text_size(S().small)
        .bg(on ? t.raised : t.popover).text_color(on ? t.foreground : t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.raw = value; cx.notify(); }).child(label);
      const modes = md && md.length <= MARKDOWN_LIMIT ? h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border)
        .child(seg("rendered", "排版", !raw, false)).child(seg("source", "原文", raw, true)) : null;
      const body = raw ? monoBox(t, "out", p.text ?? "")
        : p.doc ? this.renderDoc(t, p)
        : div().id(`md-${p.title ?? ""}`).flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).rounded(8).border_1().border_color(t.border).bg(t.background)
          .text_size(S().body).text_color(t.foreground).child(TextView.markdown("md-view", md).selectable(true));
      return dialogFrame(t, "text", p.title ?? "", [body], [dialogButton("close", "关闭", t, close, "primary")], close, modes);
    }
    if (p.role === "bgtask") {
      const md = this.live ? liveMarkdown(p.task ?? {}, this.live) : "正在读取它的进程…";
      const body = div().id("live").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).rounded(8).border_1().border_color(t.border).bg(t.background)
        .text_size(S().body).text_color(t.foreground).child(TextView.markdown("live-view", md).selectable(true));
      const stamp = h_flex().flex_none().gap(6).items_center().text_size(S().small).text_color(t.muted)
        .child(icon("ring", 11, t.working).spin(1400)).child(`实时 · 每 ${LIVE_POLL / 1000} 秒刷新`);
      return dialogFrame(t, "bgtask", `${p.title ?? "任务"} · 实时`, [body], [dialogButton("close", "关闭", t, close, "primary")], close, stamp);
    }
    if (p.role === "handoff") {
      const agent = (agents() ?? []).find((a) => a.address === p.address) ?? null;
      const problem = !agent ? `${p.name} 已经不在运行了，什么都没发。` : agent.status === "blocked" ? `${p.name} 正在等一个确认，先处理它。` : this.failed;
      const go = (_e, cx) => {
        if (problem || this.sending) return;
        this.sending = true; cx.notify();
        cx.spawn(async (cx) => {
          const r = await hc(["send", p.address, p.text]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
          if (r.code === 0) { close(); goTo(p.address, null); return; }
          this.sending = false; this.failed = (r.stderr || r.stdout || "发送失败").trim().split("\n").pop(); cx.notify();
        });
      };
      return dialogFrame(t, "handoff", "问主 agent？", [
        note(t, `把这条消息发给主 agent ${p.name}（${p.address}），由它决定怎么做；其他什么都不变。`),
        monoBox(t, "msg", p.text ?? ""),
        problem && note(t, problem, t.ansi1),
      ], [dialogButton("cancel", "取消", t, close), dialogButton("go", this.sending ? "发送中…" : "发送", t, go, "primary", !problem && !this.sending)], close);
    }
    if (p.role === "cleanup") {
      const go = (_e, cx) => {
        if (this.sending) return;
        this.sending = true; cx.notify();
        cx.spawn(async (cx) => {
          await hc(["kill", p.address]).catch(() => null);
          const r = await hc(["rm", p.address]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
          if (r.code === 0) { close(); return; }
          this.sending = false; this.failed = (r.stderr || "清理失败").trim().split("\n").pop(); cx.notify();
        });
      };
      return dialogFrame(t, "cleanup", `清理 ${p.name}？`, [
        note(t, `停下 ${p.name}（${p.address}）并关掉它的终端，和 hd_dispatch.py cleanup 一样。它的 meta.json、任务文件和回报都保留，运行的记录不会丢。`, t.foreground),
        note(t, "不会通知主 agent，它会看到这个子 agent 已经不在了。"),
        this.failed && note(t, this.failed, t.ansi1),
      ], [dialogButton("cancel", "取消", t, close), dialogButton("go", this.sending ? "正在停止…" : "清理", t, go, "danger", !this.sending)], close);
    }
    if (p.role === "handover") {
      const pick = this.pick ?? "codex", label = agentLabel(pick), weak = AGENTS[pick]?.isolation === "weak";
      const choice = (a) => h_flex().id(`to-${a}`).h(26).px(12).items_center().rounded(5).text_size(S().small)
        .bg(pick === a ? t.raised : t.popover).text_color(pick === a ? t.foreground : t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.pick = a; cx.notify(); })
        .child(agentLabel(a) + (a === p.agent ? "（新 session）" : ""));
      const picker = h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border).children(Object.keys(AGENTS).map(choice));
      const go = (_e, cx) => {
        if (this.sending) return;
        this.sending = true; this.failed = null; cx.notify();
        cx.spawn(async (cx) => {
          const r = await handOver(io(p.on ?? null), p.run ?? {}, { call: p.call, hd: p.run?.hd }, pick)
            .catch((e) => ({ ok: false, text: String(e?.message ?? e) }));
          if (r.ok) { close(); return; }
          this.sending = false; this.failed = (r.text || "hd_dispatch.py 运行失败").split("\n").slice(-2).join(" "); cx.notify();
        });
      };
      return dialogFrame(t, "handover", `移交 ${p.name}？`, [
        h_flex().gap(10).items_center().text_size(S().body).text_color(t.foreground).child("交给").child(picker),
        note(t, p.live
          ? `停下 ${p.name}：给它最多 3 分钟写交接说明，然后关掉它的终端。${p.mode !== "read" ? "先给它的 worktree 存一个快照，里面的改动不会撤销。" : ""}`
          : `${p.name} 的终端已关闭；把它留下的东西（session 日志、屏幕、回报${p.mode !== "read" ? "、worktree 快照" : ""}）打包。`, t.foreground),
        note(t, `然后 ${label} 在同一个目录里接着做同一个任务、写同一份回报，算第 ${(p.round ?? 1) + 1} 轮，开始前先读交接包。`, t.foreground),
        weak && note(t, `${label} 在这里没有沙箱：只靠任务文件里的规定让它待在自己的目录里。`, t.ansi3),
        note(t, p.parentLive ? "会通知主 agent，它照常收回报。"
          : "主 agent 不在运行，不会通知任何人。"),
        note(t, `日志：${p.log}`),
        this.failed && note(t, this.failed, t.ansi1),
      ], [dialogButton("cancel", "取消", t, close), dialogButton("go", this.sending ? "正在启动…" : `移交给 ${label}`, t, go, "primary", !this.sending)], close);
    }
    if (p.role === "decide") return this.renderDecide(t, p, close);
    if (p.role === "delete") {
      const run = p.run ?? {};
      const go = (_e, cx) => {
        if (this.sending) return;
        this.sending = true; this.failed = null; cx.notify();
        cx.spawn(async (cx) => {
          const r = await (p.topic && !p.topic.implicit
            ? topicCmd(io(p.on ?? null), p.hd, ["topic", "delete", "--repo", p.repo, "--topic", p.topic.id]).then((res) => ({ ok: res.ok, text: res.out }))
            : controlRun(io(p.on ?? null), run, "delete")).catch((e) => ({ ok: false, text: String(e?.message ?? e) }));
          if (r.ok && /DELETED=/.test(r.text)) { close(); return; }
          this.sending = false;
          this.failed = (r.text || "hd_dispatch.py 运行失败").split("\n").filter((l) => !/^FAILURE=/.test(l)).slice(-2).join(" ");
          cx.notify();
        });
      };
      return dialogFrame(t, "delete", `删除 ${p.topic?.title ?? run.id}？`, [
        note(t, p.topic ? `删除整个 Topic、Task、backlog 和摘要，以及下列 Task 的运行记录（${p.helpers} 个子 agent 的回报、事件、提问与回答、交接包和缓存）。`
          : `删掉运行目录（${p.helpers} 个子 agent 的 meta.json、事件、任务文件、屏幕、保留的回报、提问和回答、交接包）、回报、进度说明、worktree 快照、面板缓存和复盘台账。`, t.foreground),
        this.affectedTasks(t, p),
        p.open?.length ? note(t, `关掉还开着的终端：${p.open.join("、")}。`, t.foreground) : null,
        note(t, "代码保留：不动 worktree 和 cc/<run>/* 分支，也不动 Codex 和 Claude Code 自己的session 日志。"),
        note(t, "删了就没法恢复。", t.ansi1),
        this.failed && note(t, this.failed, t.ansi1),
      ], [dialogButton("cancel", "取消", t, close),
        dialogButton("go", this.sending ? "正在删除…" : p.topic ? "删除 Topic" : "删除运行", t, go, "danger", !this.sending)], close);
    }
    if (p.role === "control") {
      const run = p.run ?? {}, op = p.op;
      const list = (names) => names?.length ? names.join("、") : "无";
      const text = p.topic ? {
        pause: [
          "暂停整个 Topic，并挂起下列 Task 中正在工作的子 agent；已有回报和 session 保留。",
          "Topic 暂停期间不能继续单个 Task，也不能派发新的 Task。继续 Topic 后，仅恢复这次暂停的运行。",
        ],
        resume: [
          "继续整个 Topic，恢复因 Topic 暂停而挂起的 Task；原先单独暂停的 Task 保持暂停。",
          "队列中的请求会在主 agent 空闲时自动送达。",
        ],
        stop: [
          "终止整个 Topic：撤销尚未确认的 Task 和 backlog 请求，并终止下列尚未结束的 Task。",
          "子 agent 最多有 3 分钟记录进度，然后关闭终端；worktree 和运行记录保留。各 Task 的总结写入 stop.md。",
        ],
      }[op] ?? [] : {
        pause: [
          `给正在干活的子 agent（${list(p.working)}）按下停止键。它们的 Codex session 会保留，继续时从停下的地方接着做。`,
          "已经做完这一轮的子 agent 保持原样。继续之前，主 agent 不能派发或发消息，它的等待也不会报回任何东西。",
        ],
        resume: [
          `让挂起的子 agent（${list(p.held)}）接着做任务，不重做已经做完的部分。之后运行照常进行，主 agent 照常收回报。`,
        ],
        retire: [
          `彻底结束 ${run.id}：不再有人接手它的交接包。${p.open?.length ? `关掉还开着的子 agent 终端（${list(p.open)}），回报保留。` : "没有开着的子 agent 终端。"}`,
          "在 state.json 里标记为已结束并归档。交接包、回报和 worktree 都保留；取消归档就能再看到它，再往里派发就会接着做。",
          p.working?.length ? `${list(p.working)} 还在干活：等它们停下才能收尾。` : "不会通知主 agent。",
        ],
        stop: [
          `让所有还没交出合格回报的子 agent（${list([...(p.working ?? []), ...(p.held ?? []), ...(p.settled ?? [])])}）停下，把已经做完的写进回报，最多给 3 分钟，然后关掉它们的终端。worktree 和运行目录都保留。`,
          p.parentLive ? "然后主 agent 拿到 stop.md，总结哪些做完了、哪些没做完，再问你下一步怎么办。你决定之前它不会派发任何东西。"
            : "主 agent 不在运行，不会通知任何人；总结在 stop.md 里。",
        ],
      }[op] ?? [];
      const name = p.topic?.title ?? run.id;
      const title = { pause: `暂停 ${name}？`, resume: `继续 ${name}？`, stop: `终止 ${name}？`, retire: `收尾 ${name}？` }[op] ?? "";
      const label = { pause: "暂停", resume: "继续", stop: p.topic ? "终止 Topic" : "终止运行", retire: "收尾" }[op];
      const go = (_e, cx) => {
        if (this.sending) return;
        this.sending = true; this.failed = null; cx.notify();
        cx.spawn(async (cx) => {
          const r = await (p.topic && !p.topic.implicit
            ? topicCmd(io(p.on ?? null), p.hd, ["topic", op, "--repo", p.repo, "--topic", p.topic.id]).then((res) => ({ ok: res.ok, text: res.out }))
            : controlRun(io(p.on ?? null), run, op)).catch((e) => ({ ok: false, text: String(e?.message ?? e) }));
          if (r.ok && !/RUN_CONTROL=|RUN_STOPPING/.test(r.text)) { close(); return; }
          this.sending = false;
          this.failed = r.ok ? `什么都没做：${r.text.split("\n").pop()}` : (r.text || "hd_dispatch.py 运行失败").split("\n").slice(-2).join(" ");
          cx.notify();
        });
      };
      return dialogFrame(t, "control", title, [
        ...text.map((x, i) => note(t, x, i === 0 ? t.foreground : t.muted)),
        this.affectedTasks(t, p),
        this.failed && note(t, this.failed, t.ansi1),
      ], [dialogButton("cancel", "取消", t, close),
        dialogButton("go", this.sending ? "处理中…" : label, t, go, op === "stop" ? "danger" : "primary", !this.sending)], close);
    }
    return div();
  }
}
