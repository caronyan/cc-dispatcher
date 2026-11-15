// cc-dispatch beside herdr's Agents list: the cc-herdr-dispatch skills' runs, one card per run
// (<repo>/.cc-dispatch/<kind>-<run>), each helper's round, report verdict and failure, history
// that outlives the terminals, and a hand-off to the Claude that dispatched it.
// Herdr's Agents list already shows live status and the sub-agent tree; this panel shows what only
// the skills know. Roles (props.role): the panel (default); "toggle", the tab-bar button that
// shows or hides the layout's "cc-dispatch-panel" node; dialogs "text", "handoff", "handover", "cleanup",
// "control" (confirms a run's pause / resume / stop), "bgtask" (a running background task, live).
// Only this file imports Herdr: model.js and loader.js are tested under node.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { exec, hc, run, spaces, agents, terminals, panes, focused, theme, settings, layout, openOverlay, closeOverlay, readTextFile, props as blockProps } from "herdr";
import { callTags, callStage, runStage, stageSummary, cardCounts, groupByStage, SETTLED, STAGE_WORDS, splitBySpace, ago, handoffAsk, handoffText, baseName, agentTag, agentLabel, weakIsolation, canHandOver, AGENTS, resultMarkdown, roundsMarkdown, resultDoc, taskDoc, MARKDOWN_LIMIT, controlOps, controlBanner, runQuotaAgent, quotaView } from "./model.js";
import { findRepo, loadRuns, loadReport, loadTasks, loadDiff, loadEvents, loadStopReport, loadHandoff, loadHandoffPrompt, controlRun, handOver, earlierReports, loadStats, loadBg, loadOutput, loadLive, loadQuota } from "./loader.js";
import { assignTasks, bgView, bgSummary, liveMarkdown, BG_MORE } from "./bg.js";
import { runTotals, callSpend, fmtTok, fmtDur } from "./stats.js";

const PANEL = "cc-dispatch-panel"; // the layout node the toggle shows and hides
const POLL = 4000;                 // meta.json re-read while shown; live status comes from terminals()
const HISTORY = 6;                 // ended runs shown before "Show n older"
const LIVE_POLL = 2000;            // a running background task's dialog re-reads its processes
const QUOTA_POLL = 30000;          // the main agents' quota (hd_usage.py keeps magpie's answer 60 s)

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
const CARD_WORDS = { merged: "merged", done: "done", accepting: "review", running: "run", pending: "todo", parked: "parked" };

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

const stageTag = (t, stage) => h_flex().h(16).px(6).flex_none().items_center().rounded(4).border_1()
  .border_color(stageColor(t, stage)).text_size(S().label).text_color(stageColor(t, stage)).child(STAGE_WORDS[stage]);

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
const KIND_SHORT = { added: "added", untracked: "new", modified: "modified", deleted: "deleted", renamed: "renamed", conflict: "conflict" };
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
  return h_flex().size_full().pr(10).items_center().justify_end().bg(t.chrome).border_b(1).border_color(t.border)
    .child(h_flex().id("toggle-cc-dispatch").h(26).px(8).gap(6).flex_none().items_center().rounded(6)
      .text_size(12).bg(on ? t.selected : t.chrome).text_color(on ? t.foreground : t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop)
      .on_click(() => run("layout.toggle", { id: PANEL }))
      .child(mark(15, on ? t.foreground : t.muted)).child("dispatch")
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
    if (this.role !== "panel") return;
    this.runs = []; this.error = null; this.repo = null; this.on = null; this.ctxKey = null; this.liveKey = null;
    this.open = null; this.fold = new Map(); this.groupFold = new Map(); this.bgMore = new Map(); this.showOld = false; this.loading = false; this.token = 0; this.lastAgent = null;
    this.stats = { calls: {}, runs: {} }; this.statsFor = new Set(); this.statsBusy = false;
    this.bg = { resolved: {}, sessions: {} };
    this.quota = {}; // agent -> { q, at, busy }
    cx.timer.every(POLL, (cx) => { if (this.shown()) this.refresh(cx); });
  }

  shown() { return !find(layout(), PANEL)?.hidden; }

  // The shown space, as Herdr's Spaces list names it.
  spaceName() { return spaces().find((s) => s.active)?.name || (this.repo ? baseName(this.repo) : ""); }

  // The shown space's runs, and other spaces' live runs by space.
  split() {
    const shown = spaces().find((s) => s.active) ?? null;
    return splitBySpace(this.runs, terminals() ?? [], spaces() ?? [], shown, this.repo);
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
    cx.spawn(async (cx) => {
      try {
        const files = io(ctx?.on ?? null);
        const repo = ctx ? await findRepo(files, ctx.folder) : null;
        const { runs, error } = await loadRuns(files, repo, terminals() ?? []);
        if (token !== this.token) return;
        this.repo = repo; this.runs = runs; this.error = error;
        later(cx, (cx) => this.refreshStats(cx, files, token));
        later(cx, (cx) => this.refreshQuota(cx, files));
      } catch (e) {
        this.error = String(e?.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
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
        if (!b.error) { Object.assign(this.bg.resolved, b.resolved); Object.assign(this.bg.sessions, b.sessions); }
        if (s.error) return;
        Object.assign(this.stats.calls, s.calls); Object.assign(this.stats.runs, s.runs);
        for (const r of want) if (!r.live) this.statsFor.add(r.dir);
      } finally {
        this.statsBusy = false;
        cx.notify();
      }
    });
  }

  // Each live run's main agent's quota, per subscription (claude, codex), at most every QUOTA_POLL.
  refreshQuota(cx, files) {
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
    const tip = v.windows.map((w) => `${w.text}${w.resets ? ` · resets ${new Date(w.resets).toDateString() === new Date().toDateString() ? clock(w.resets) : `${new Date(w.resets).getMonth() + 1}/${new Date(w.resets).getDate()} ${clock(w.resets)}`}` : ""}`).join("\n")
      + `\nfrom ${v.source === "magpie" ? "magpie" : "the agent's own log"}`;
    return h_flex().id(`quota-${r.dir}`).flex_none().pl(30).pr(10).pb(6).gap(6).items_center().flex_wrap()
      .text_size(S().label).tooltip(tip)
      .child(icon("gauge", 11, t.muted))
      .child(div().flex_none().text_color(t.muted).child(`main agent · ${v.label}`))
      .children(v.windows.map((w) => div().flex_none().text_color(color[w.level]).when(w.level !== "ok", (el) => el.font_semibold()).child(w.text)));
  }

  // The Claude a hand-off goes to: the one that dispatched the call, else the focused agent.
  receiver(c) {
    const all = agents() ?? [];
    const parent = c.parent && all.find((a) => a.address === c.parent);
    if (parent) return parent;
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
    if (key !== this.ctxKey) { this.ctxKey = key; this.ctx = ctx; this.token++; this.loading = false; this.statsBusy = false; this.open = null; later(cx, (cx) => this.refresh(cx)); }
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
        .child(div().text_size(S().title).font_semibold().child("cc-dispatch"))
        .child(div().flex_1().min_w(0).truncate().text_size(S().small).text_color(t.muted).child(this.spaceName()))
        .child(h_flex().id("refresh").size(24).justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop).on_click((_e, cx) => this.refresh(cx))
          .child(this.loading ? icon("ring", 13, t.muted).spin(900) : icon("refresh", 13, t.muted)))
        .when(Boolean(node), (el) => el.child(h_flex().id("close").size(24).justify_center().items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_mouse_down("left", stop).on_click(() => run("layout.hide", { id: PANEL })).child(icon("close", 14, t.muted)))))
      .child(this.renderRuns(t))
      .child(this.renderFooter(t));
  }

  renderRuns(t) {
    const body = v_flex().id("runs").flex_1().min_h(0).overflow_y_scrollbar().p(10).gap(8);
    if (this.error) body.child(note(t, `Could not read runs: ${this.error}`, t.ansi1));
    const { mine, others } = this.split();
    if (!mine.length) {
      body.child(v_flex().p(8).gap(6)
        .child(note(t, this.repo ? `No runs in ${baseName(this.repo)} yet.` : "Open a space to see its runs.", t.foreground))
        .child(note(t, "Runs appear here when a cc-herdr-dispatch skill dispatches helpers: /cc-herdr-dispatch-research, -review, -dev, -fix, -test.")));
      return this.renderOthers(t, body, others);
    }
    const live = mine.filter((r) => r.live), ended = mine.filter((r) => !r.live);
    const old = this.showOld ? ended : ended.slice(0, HISTORY);
    body.children([...live, ...old].map((r) => this.renderRun(t, r)));
    if (ended.length > HISTORY) {
      body.child(div().id("older").flex_none().py(4).text_size(S().small).text_color(t.muted).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.showOld = !this.showOld; cx.notify(); })
        .child(this.showOld ? "Show fewer" : `Show ${ended.length - HISTORY} older`));
    }
    return this.renderOthers(t, body, others);
  }

  // Other spaces with runs going: one row each; clicking shows that space (and the panel follows).
  renderOthers(t, body, others) {
    if (!others.length) return body;
    body.child(div().flex_none().pt(6).px(2).text_size(S().label).text_color(t.muted).child("Other spaces"));
    for (const g of others) {
      const stages = g.runs.flatMap((r) => r.calls.map((c) => callStage(c, this.stats.runs[r.dir]?.status?.[c.call])));
      body.child(h_flex().id(`space-${g.id ?? g.name}`).min_h(36).flex_none().px(10).py(6).gap(8).items_center().rounded(8)
        .border_1().border_dashed().border_color(t.border).cursor_pointer().hover((s) => s.bg(t.hover))
        .when(Boolean(g.id), (el) => el.on_click(() => run("space.select", { id: g.id })))
        .child(dot(t, runStage(stages)))
        .child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(S().body).font_semibold().child(g.name))
          .child(div().text_size(S().label).text_color(t.muted)
            .child([`${g.runs.length} run${g.runs.length === 1 ? "" : "s"}`, stageSummary(stages)].join(" · "))))
        .when(Boolean(g.id), (el) => el.child(icon("chevron-right", 12, t.muted))));
    }
    return body;
  }

  renderRun(t, r) {
    const folded = this.fold.has(r.dir) ? this.fold.get(r.dir) : !r.live;
    const other = this.repo && r.repo !== this.repo;
    const cards = this.stats.runs[r.dir], stages = r.calls.map((c) => callStage(c, cards?.status?.[c.call]));
    const claudeLive = Boolean(r.parent) && (terminals() ?? []).some((x) => x.address === r.parent && x.state === "live");
    const bg = bgView(this.tasksOf(r), claudeLive, this.bgMore.get(r.dir) ?? 0);
    // One line: what the run is, then its pause / resume / stop as icons. Its stage counts are the
    // group headers below; its spend, the stats under the head.
    const head = h_flex().id(`run-${r.dir}`).h(36).flex_none().pl(10).pr(6).gap(8).items_center().cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.fold.set(r.dir, !folded); cx.notify(); })
      .child(icon(folded ? "chevron-right" : "chevron-down", 12, t.muted))
      .child(dot(t, runStage(stages), r.control))
      .child(pill(t, r.kind, r.live ? t.foreground : t.muted))
      .child(div().flex_1().min_w(0).truncate().text_size(S().body).font_semibold().text_color(r.live ? t.foreground : t.muted)
        .child(r.id.replace(`${r.kind}-`, "") || r.id))
      .when(Boolean(other), (el) => el.child(div().flex_none().max_w(90).truncate().text_size(S().label).text_color(t.muted).child(baseName(r.repo))))
      .children(this.controlButtons(t, r));
    const paused = r.control?.state === "paused";
    const card = v_flex().flex_none().rounded(8).border_1().border_color(paused ? t.ansi3 : r.live ? t.input : t.border).bg(r.live || paused ? t.surface : t.background).overflow_hidden().child(head);
    const quota = this.renderQuota(t, r);
    if (quota) card.child(quota);
    const ctl = this.renderControl(t, r);
    if (ctl) card.child(ctl);
    if (!folded) {
      const totals = runTotals(r, this.stats.calls, this.stats.runs[r.dir]);
      if (totals.known || totals.cards) card.child(this.renderStats(t, r, totals));
      if (bg.running.length || bg.ended.length) card.child(this.renderBg(t, r, bg));
      card.child(this.renderGroups(t, r, cards));
    }
    return card;
  }

  // The run's helpers by stage, most urgent first. A group folds from its header; settled ones
  // (report ok, merged, done, parked, ended) start folded unless they are all the run has.
  renderGroups(t, r, cards) {
    const groups = groupByStage(r.calls, (c) => callStage(c, cards?.status?.[c.call]));
    const box = v_flex().border_t(1).border_color(t.border);
    for (const g of groups) {
      const key = `${r.dir}|${g.stage}`;
      const folded = this.groupFold.has(key) ? this.groupFold.get(key) : groups.length > 1 && SETTLED.has(g.stage);
      const color = stageColor(t, g.stage);
      box.child(h_flex().id(`group-${key}`).h(28).flex_none().pl(14).pr(10).gap(7).items_center()
        .border_t(1).border_color(t.border).bg(t.background).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.groupFold.set(key, !folded); cx.notify(); })
        .child(icon(folded ? "chevron-right" : "chevron-down", 10, t.muted))
        .child(g.stage === "working" ? icon("ring", 9, color).spin(900) : g.stage === "paused" ? icon("pause-dot", 9, color) : div().w(7).h(7).flex_none().rounded_full().bg(color))
        .child(div().flex_1().min_w(0).truncate().text_size(S().label).font_semibold().text_color(SETTLED.has(g.stage) ? t.muted : color)
          .child(STAGE_WORDS[g.stage]))
        .child(h_flex().h(16).px(6).flex_none().items_center().rounded(8).bg(t.selected)
          .text_size(S().label).text_color(t.foreground).child(String(g.calls.length))));
      if (!folded) box.children(g.calls.map((c) => this.renderCall(t, c, false)));
    }
    return box;
  }

  // The run's Pause / Resume / Stop, icons only, at the end of its head. Each opens a "control"
  // dialog to confirm; hd_dispatch.py does the work.
  controlButtons(t, r) {
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
    const look = { pause: ["pause-dot", "Pause run", t.foreground], resume: ["play-fill", "Resume run", t.accent], stop: ["square", "Stop run", t.ansi1] };
    const ops = controlOps(r);
    if (!ops.length) return [];
    return [h_flex().flex_none().gap(6).items_center().children(ops.map((op) => {
      const [name, tip, color] = look[op];
      return h_flex().id(`${op}-${r.dir}`).size(22).flex_none().justify_center().items_center().rounded(6).bg(color)
        .cursor_pointer().hover((s) => s.opacity(0.82)).tooltip(tip)
        .on_mouse_down("left", stop).on_click(confirm(op)).child(icon(name, op === "stop" ? 13 : 11, t.background));
    }))];
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
      .when(state === "stopped", (el) => el.child(action(`stopmd-${r.dir}`, "Summary", "file", t,
        (_e, cx) => this.showText(cx, `${r.id} · stopped`, () => loadStopReport(io(on), r), "No stop.md yet."))))
      .when(state === "handoff", (el) => el
        .child(action(`handoffmd-${r.dir}`, "Package", "file", t,
          (_e, cx) => this.showText(cx, `${r.id} · handoff`, () => loadHandoff(io(on), r), "No handoff.md yet.")))
        .child(action(`copyprompt-${r.dir}`, this.copied === r.dir ? "Copied" : "Copy prompt", "task", t, (_e, cx) => {
          cx.spawn(async (cx) => {
            const text = await loadHandoffPrompt(io(on), r);
            if (!text) return;
            cx.write_to_clipboard(text.trim());
            this.copied = r.dir; cx.notify();
            cx.timer.after(2000, (cx) => { if (this.copied === r.dir) { this.copied = null; cx.notify(); } });
          });
        }, { color: t.accent })));
  }

  // The run's background tasks, all the main agent's: a lighter list between the spend and the helpers.
  tasksOf(r) {
    const all = assignTasks(this.runs, this.bg.resolved, this.bg.sessions);
    return all[r.dir] ?? [];
  }

  renderBg(t, r, bg) {
    const z = S(), on = this.ctx?.on ?? null;
    const kindIcon = { shell: "terminal", monitor: "eye", agent: "bot" };
    const statusColor = { running: t.working, completed: t.muted, failed: t.ansi1, killed: t.ansi3, stopped: t.ansi3, lost: t.muted };
    const row = (task) => {
      const running = task.status === "running", age = fmtDur((task.ended || Date.now()) - (task.started || Date.now()));
      const word = running ? age : task.status === "completed" ? `done · ${age}` : task.status;
      const sub = running ? (task.event || task.tail?.[task.tail.length - 1] || "") : (task.status === "completed" ? "" : bgSummary(task));
      return v_flex().id(`bg-${task.id}`).flex_none().pl(28).pr(10).py(4).gap(1)
        .when(Boolean(task.output), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => running && task.kind !== "agent"
            ? openOverlay({ mod: "cc-dispatch", kind: "dialog", width: 860, height: 620,
              props: { role: "bgtask", title: task.title, output: task.output, on, task: { started: task.started, command: task.command } } })
            : this.showText(cx, `${task.title} · output`, () => loadOutput(io(on), task.output), "No output.",
              (text) => `~~~~\n${text.replace(/\s+$/, "")}\n~~~~`)))
        .child(h_flex().min_w(0).gap(8).items_center()
          .child(running && task.kind !== "agent" ? icon("ring", 11, t.working).spin(1400) : icon(kindIcon[task.kind] ?? "terminal", 11, running ? t.working : t.muted))
          .child(div().flex_1().min_w(0).truncate().text_size(z.label).text_color(running ? t.foreground : t.muted).child(task.title))
          .child(div().flex_none().text_size(z.label).text_color(statusColor[task.status] ?? t.muted).child(word)))
        .when(Boolean(sub), (el) => el.child(div().pl(19).truncate().font_family(mono()).text_size(z.label - 1).text_color(t.muted).child(sub)));
    };
    const box = v_flex().flex_none().py(4).border_t(1).border_color(t.border).bg(t.background)
      .child(h_flex().pl(28).pr(10).py(3).gap(6).items_center().text_size(z.label).text_color(t.muted)
        .child(div().flex_1().child("background · main agent"))
        .child(div().flex_none().child(bg.running.length ? `${bg.running.length} running` : "none running")));
    box.children(bg.running.map(row));
    box.children(bg.ended.map(row));
    // Newest ended first; "n earlier" shows BG_MORE more each click, "show fewer" folds back to the first few.
    const link = (id, text, fn) => div().id(id).flex_none().text_size(z.label).text_color(t.muted).cursor_pointer()
      .hover((s) => s.text_color(t.foreground)).on_click((_e, cx) => { fn(); cx.notify(); }).child(text);
    if (bg.hidden || bg.more) box.child(h_flex().pl(28).pr(10).py(3).gap(12).items_center()
      .when(bg.hidden > 0, (el) => el.child(link(`bg-more-${r.dir}`, `${bg.hidden} earlier · show ${Math.min(BG_MORE, bg.hidden)} more`,
        () => this.bgMore.set(r.dir, bg.more + BG_MORE))))
      .when(bg.more > 0, (el) => el.child(link(`bg-less-${r.dir}`, "show fewer", () => this.bgMore.delete(r.dir)))));
    return box;
  }

  // What a run has spent so far, under its head: time, commands, patched files, tokens split into
  // cached / new input / output, and for dev runs how many cards are merged.
  renderStats(t, r, s) {
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
      s.elapsed != null && cell(fmtDur(s.elapsed), r.live ? "elapsed" : "took"),
      s.known && cell(String(s.commands), "commands"),
      s.known && cell(String(s.files), "files patched"),
    ].filter(Boolean);
    const box = v_flex().flex_none().px(12).pt(8).pb(10).gap(10).border_t(1).border_color(t.border);
    if (cells.length) box.child(h_flex().gap(8).children(cells));
    if (s.cards) {
      const counts = cardCounts(s.cards), colors = CARD_COLORS(t);
      box.child(v_flex().gap(5)
        .child(line("cards", `${s.cards.merged}/${s.cards.total} merged`))
        .child(bar(counts.map(([st, n]) => [n, colors[st] ?? t.muted]), s.cards.total))
        .child(h_flex().gap(8).overflow_hidden().text_size(z.label).text_color(t.muted)
          .children(counts.map(([st, n]) => key(colors[st] ?? t.muted, `${n} ${CARD_WORDS[st] ?? st}`).flex_none()))));
    }
    if (s.tokens) {
      const k = s.tokens;
      box.child(v_flex().gap(5)
        .child(line("tokens", fmtTok(k.total)))
        .child(bar([[k.cached, t.ansi4], [k.fresh, t.ansi6], [k.output, t.ansi3]], k.total))
        .child(h_flex().flex_wrap().gap(10).text_size(z.label).text_color(t.muted)
          .child(key(t.ansi4, `cached ${fmtTok(k.cached)}`))
          .child(key(t.ansi6, `new input ${fmtTok(k.fresh)}`))
          .child(key(t.ansi3, `output ${fmtTok(k.output)}`))));
    }
    return box;
  }

  // `tagged`: show the stage tag (rows inside a stage group leave it to the group's header).
  renderCall(t, c, tagged = true) {
    const open = this.open === c.key, spent = this.stats.calls[c.key];
    const stage = callStage(c, this.stats.runs[c.runDir]?.status?.[c.call]);
    // The helper herdr has in front now (focused, or peeked/shown in a pane), as the Agents list marks it.
    const f = focused(), here = Boolean(c.address) && c.state === "live" && (f?.terminal === c.address || f?.shown === c.address || f?.agent === c.address);
    const live = c.state === "live";
    const tag = (text, color) => h_flex().h(15).px(4).flex_none().items_center().rounded(3).bg(t.selected)
      .font_family(mono()).text_size(S().label - 1.5).text_color(color ?? t.muted).child(text);
    // One line: the terminal dot, the name (white while its terminal is open, grey once closed), small
    // tags for mode·effort ("wh") and round ("r2"), a failure or retry word, and its tokens at the right.
    const row = h_flex().id(`call-${c.key}`).h(30).flex_none().pl(28).pr(10).gap(7).items_center().cursor_pointer()
      .bg(open || here ? t.raised : t.surface).hover((s) => s.bg(open || here ? t.raised : t.hover))
      .when(here, (el) => el.border_l(2).border_color(t.accent))
      .on_click((_e, cx) => { this.open = open ? null : c.key; cx.notify(); })
      .child(termDot(t, c))
      .child(div().min_w(0).flex_shrink(1).truncate().text_size(S().body).text_color(live ? t.foreground : t.muted).child(c.name))
      .children(callTags(c).map((x) => tag(x)))
      .when(Boolean(agentTag(c)), (el) => el.child(tag(agentTag(c).text, agentTag(c).weak ? t.ansi3 : t.muted)))
      .when(Boolean(c.handingTo), (el) => el.child(tag(`→ ${c.handingTo}`, t.accent)))
      .when(Boolean(c.failure && c.failure !== "exited" && c.failure !== "blocked"), (el) => el.child(tag(c.failure, t.ansi1)))
      .when(Boolean(c.retry), (el) => el.child(tag(c.retry.split(" ").pop(), t.ansi3)))
      .when(tagged, (el) => el.child(stageTag(t, stage)))
      .child(div().flex_1())
      .when(Boolean(spent?.tokens), (el) => el.child(div().flex_none().text_size(S().label).text_color(t.muted).child(fmtTok(spent.tokens.input + spent.tokens.output))));
    if (!open) return row;
    return v_flex().flex_none().bg(t.raised).child(row).child(this.renderActions(t, c));
  }

  renderActions(t, c) {
    const on = this.ctx?.on ?? null, live = c.state === "live";
    const ask = handoffAsk(c), to = ask ? this.receiver(c) : null;
    // Two rows of separate outlined buttons, both ending in a 28px square column so their edges line up.
    // Row one: Result (its report and, for write and net helpers, the worktree's changes), Task (its
    // rounds: events and task files), Peek (live only), then Clean up as an icon in the square. Row two,
    // when there is one: Ask (a message to its main agent) and Hand over…, half the width each. Empty
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
      cell(`result-${c.key}`, "Result", "file", (_e, cx) => this.showResult(cx, c, on, writes)),
      cell(`task-${c.key}`, "Task", "task", (_e, cx) => this.showText(cx, `${c.call} · task and rounds`, async () => {
        const files = io(on);
        const [events, tasks] = [await loadEvents(files, c), await loadTasks(files, c)];
        const text = Object.entries(tasks).reverse().map(([k, x]) => `==> task-${k}.md <==\n${x ?? "(missing)"}`).join("\n\n")
          + `\n\n==> events.jsonl <==\n${events ?? ""}`;
        return { text, markdown: roundsMarkdown(c, events, tasks), doc: taskDoc(c, events, tasks) };
      }, "No task file.")),
      live && cell(`peek-${c.key}`, "Peek", "eye", () => goTo(c.address, c.parent)),
    ], live && square(`kill-${c.key}`, "Clean up", "trash", () => openOverlay({
      mod: "cc-dispatch", kind: "dialog", width: 440, height: 220,
      props: { role: "cleanup", address: c.address, call: c.call, name: c.name } }), t.ansi1));
    const askIt = ask && to && cell(`ask-${c.key}`, "Ask", "send", () => openOverlay({
      mod: "cc-dispatch", kind: "dialog", width: 480, height: 300,
      props: { role: "handoff", address: to.address, name: to.program?.name ?? to.address, text: handoffText(c, ask) } }), t.accent);
    // Hand over: freeze it and start another agent (or a fresh session of the same one) on its task.
    const run = this.runs.find((r) => r.dir === c.runDir) ?? null;
    const parentLive = Boolean(c.parent && (terminals() ?? []).find((x) => x.address === c.parent && x.state === "live"));
    const handIt = canHandOver(c, run) && cell(`handover-${c.key}`, "Hand over…", "handover", () => openOverlay({
      mod: "cc-dispatch", kind: "dialog", width: 500, height: 360,
      props: { role: "handover", on, run: { dir: c.runDir, hd: run?.hd ?? c.hd, id: run?.id ?? baseName(c.runDir) },
        call: c.call, name: c.name, agent: c.agent, live, round: c.round, mode: c.mode, parentLive,
        log: `${c.agentDir}/handover.log` } }));
    const second = [askIt, handIt].filter(Boolean);
    const terminal = second.length ? grid([...second, null].slice(0, 2)) : null;
    const spend = callSpend(this.stats.calls[c.key]);
    const who = c.lost ? "Interrupted: its terminal vanished before it handed in a good report. Nothing is done about it until its main agent (or you) decides."
      : c.offline ? "Waiting for the network: it carries on by itself once the network is back, using up no retry."
      : c.handingTo ? `Handing over to ${agentLabel(c.handingTo)}: it is writing its handoff note`
      : weakIsolation(c) ? `${agentLabel(c.agent)} · weak isolation: no sandbox, only its task file's rules keep it in its folder` : null;
    return v_flex().pl(28).pr(10).pt(2).pb(10).gap(6)
      .when(Boolean(spend), (el) => el.child(div().pb(2).text_size(S().label).text_color(t.muted).child(spend)))
      .when(Boolean(who), (el) => el.child(div().pb(2).text_size(S().label).text_color(c.lost ? t.ansi1 : c.handingTo ? t.accent : t.ansi3).child(who)))
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
    this.showText(cx, `${c.call} · result (round ${c.round})`, async () => {
      const files = io(on);
      const { text, exists, path } = await loadReport(files, c);
      const older = await earlierReports(files, c);
      const diff = writes ? await loadDiff(files, c) : null;
      const head = [
        `verdict: ${c.report ?? "not checked yet (hd_dispatch.py collect checks it)"}`,
        `file: ${c.reportPath}`,
        path && path !== c.reportPath ? `read from the run folder's copy: ${path}` : null,
        `schema: ${c.schema}`,
        older.length ? `earlier rounds: ${older.join(", ")}` : null,
      ].filter(Boolean).join("\n");
      return { text: `${head}\n\n${exists ? text : "(no report written yet)"}${diff != null ? `\n\n==> worktree <==\n${diff}` : ""}`,
        markdown: resultMarkdown(c, exists ? text : null, older, diff), doc: resultDoc(c, exists ? text : null, older, diff) };
    }, "");
  }

  renderFooter(t) {
    const runs = this.split().mine;
    const live = runs.filter((r) => r.live).length;
    const helpers = runs.reduce((n, r) => n + r.calls.filter((c) => c.state === "live").length, 0);
    return h_flex().h(34).flex_none().px(14).items_center().border_t(1).border_color(t.border)
      .text_size(S().label).text_color(t.muted)
      .child(div().flex_1().truncate().child(runs.length
        ? `${runs.length} run${runs.length === 1 ? "" : "s"} · ${live} active · ${helpers} helper${helpers === 1 ? "" : "s"} live`
        : "No runs"))
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
      .child(entry(null, "All", { group: true, tone: "accent" }))
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

  renderDialog() {
    const t = theme(), p = blockProps() ?? {}, close = () => closeOverlay(p.overlay);
    if (p.role === "text") {
      const md = p.markdown ?? null, raw = !md || this.raw || md.length > MARKDOWN_LIMIT;
      const seg = (id, label, on, value) => h_flex().id(id).h(24).px(10).items_center().rounded(5).text_size(S().small)
        .bg(on ? t.raised : t.popover).text_color(on ? t.foreground : t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.raw = value; cx.notify(); }).child(label);
      const modes = md && md.length <= MARKDOWN_LIMIT ? h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border)
        .child(seg("rendered", "Rendered", !raw, false)).child(seg("source", "Source", raw, true)) : null;
      const body = raw ? monoBox(t, "out", p.text ?? "")
        : p.doc ? this.renderDoc(t, p)
        : div().id(`md-${p.title ?? ""}`).flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).rounded(8).border_1().border_color(t.border).bg(t.background)
          .text_size(S().body).text_color(t.foreground).child(TextView.markdown("md-view", md).selectable(true));
      return dialogFrame(t, "text", p.title ?? "", [body], [dialogButton("close", "Close", t, close, "primary")], close, modes);
    }
    if (p.role === "bgtask") {
      const md = this.live ? liveMarkdown(p.task ?? {}, this.live) : "Reading its processes…";
      const body = div().id("live").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).rounded(8).border_1().border_color(t.border).bg(t.background)
        .text_size(S().body).text_color(t.foreground).child(TextView.markdown("live-view", md).selectable(true));
      const stamp = h_flex().flex_none().gap(6).items_center().text_size(S().small).text_color(t.muted)
        .child(icon("ring", 11, t.working).spin(1400)).child(`live · every ${LIVE_POLL / 1000}s`);
      return dialogFrame(t, "bgtask", `${p.title ?? "task"} · live`, [body], [dialogButton("close", "Close", t, close, "primary")], close, stamp);
    }
    if (p.role === "handoff") {
      const agent = (agents() ?? []).find((a) => a.address === p.address) ?? null;
      const problem = !agent ? `${p.name} is no longer running. Nothing was sent.` : agent.status === "blocked" ? `${p.name} is waiting on a question; answer it first.` : this.failed;
      const go = (_e, cx) => {
        if (problem || this.sending) return;
        this.sending = true; cx.notify();
        cx.spawn(async (cx) => {
          const r = await hc(["send", p.address, p.text]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
          if (r.code === 0) { close(); goTo(p.address, null); return; }
          this.sending = false; this.failed = (r.stderr || r.stdout || "Could not send").trim().split("\n").pop(); cx.notify();
        });
      };
      return dialogFrame(t, "handoff", "Ask the main agent?", [
        note(t, `Sends this message to the main agent, ${p.name} (${p.address}). It decides what to do; nothing else changes.`),
        monoBox(t, "msg", p.text ?? ""),
        problem && note(t, problem, t.ansi1),
      ], [dialogButton("cancel", "Cancel", t, close), dialogButton("go", this.sending ? "Sending…" : "Send", t, go, "primary", !problem && !this.sending)], close);
    }
    if (p.role === "cleanup") {
      const go = (_e, cx) => {
        if (this.sending) return;
        this.sending = true; cx.notify();
        cx.spawn(async (cx) => {
          await hc(["kill", p.address]).catch(() => null);
          const r = await hc(["rm", p.address]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
          if (r.code === 0) { close(); return; }
          this.sending = false; this.failed = (r.stderr || "Could not remove it").trim().split("\n").pop(); cx.notify();
        });
      };
      return dialogFrame(t, "cleanup", `Clean up ${p.name}?`, [
        note(t, `Stops ${p.name} (${p.address}) and removes its terminal, like hd_dispatch.py cleanup. Its meta.json, task files and report stay, so the run keeps its history.`, t.foreground),
        note(t, "Its main agent is not told; it will see the helper as gone."),
        this.failed && note(t, this.failed, t.ansi1),
      ], [dialogButton("cancel", "Cancel", t, close), dialogButton("go", this.sending ? "Stopping…" : "Clean up", t, go, "danger", !this.sending)], close);
    }
    if (p.role === "handover") {
      const pick = this.pick ?? "codex", label = agentLabel(pick), weak = AGENTS[pick]?.isolation === "weak";
      const choice = (a) => h_flex().id(`to-${a}`).h(26).px(12).items_center().rounded(5).text_size(S().small)
        .bg(pick === a ? t.raised : t.popover).text_color(pick === a ? t.foreground : t.muted).cursor_pointer()
        .on_click((_e, cx) => { this.pick = a; cx.notify(); })
        .child(agentLabel(a) + (a === p.agent ? " (new session)" : ""));
      const picker = h_flex().flex_none().p(2).gap(2).rounded(7).border_1().border_color(t.border).children(Object.keys(AGENTS).map(choice));
      const go = (_e, cx) => {
        if (this.sending) return;
        this.sending = true; this.failed = null; cx.notify();
        cx.spawn(async (cx) => {
          const r = await handOver(io(p.on ?? null), p.run ?? {}, { call: p.call, hd: p.run?.hd }, pick)
            .catch((e) => ({ ok: false, text: String(e?.message ?? e) }));
          if (r.ok) { close(); return; }
          this.sending = false; this.failed = (r.text || "Could not run hd_dispatch.py").split("\n").slice(-2).join(" "); cx.notify();
        });
      };
      return dialogFrame(t, "handover", `Hand ${p.name} over?`, [
        h_flex().gap(10).items_center().text_size(S().body).text_color(t.foreground).child("To").child(picker),
        note(t, p.live
          ? `Stops ${p.name}: it gets up to 3 minutes to write a handoff note, then its terminal is closed.${p.mode !== "read" ? " Its worktree is saved as a snapshot first; nothing in it is undone." : ""}`
          : `${p.name}'s terminal is closed; what it left (session log, screen, report${p.mode !== "read" ? ", a snapshot of its worktree" : ""}) is packed up.`, t.foreground),
        note(t, `Then ${label} starts in the same folder on the same task and report as round ${(p.round ?? 1) + 1}, told to read the handoff package first.`, t.foreground),
        weak && note(t, `${label} has no sandbox here: only the task file's rules keep it in its folder.`, t.ansi3),
        note(t, p.parentLive ? "The main agent is told, and collects its report as usual."
          : "The main agent is not running, so nobody is told."),
        note(t, `Log: ${p.log}`),
        this.failed && note(t, this.failed, t.ansi1),
      ], [dialogButton("cancel", "Cancel", t, close), dialogButton("go", this.sending ? "Starting…" : `Hand over to ${label}`, t, go, "primary", !this.sending)], close);
    }
    if (p.role === "control") {
      const run = p.run ?? {}, op = p.op;
      const list = (names) => names?.length ? names.join(", ") : "none";
      const text = {
        pause: [
          `Presses the stop key of the helpers working now (${list(p.working)}). Their Codex sessions are kept, so Resume picks up where they were.`,
          "Helpers that already finished their turn are left as they are. Until you resume, the main agent cannot dispatch or send, and its wait reports nothing.",
        ],
        resume: [
          `Tells the held helpers (${list(p.held)}) to carry on with their task, not redoing what they did. Then the run goes on and the main agent collects as usual.`,
        ],
        stop: [
          `Asks every helper without a good report (${list([...(p.working ?? []), ...(p.held ?? []), ...(p.settled ?? [])])}) to stop and write what it has done so far into its report, giving them up to 3 minutes, then closes their terminals. Worktrees and the run folder stay.`,
          p.parentLive ? "Then the main agent gets stop.md, sums up what was done and what was not, and asks you what to do next. It dispatches nothing until you decide."
            : "The main agent is not running, so nobody is told; the summary is in stop.md.",
        ],
      }[op] ?? [];
      const title = { pause: `Pause ${run.id}?`, resume: `Resume ${run.id}?`, stop: `Stop ${run.id}?` }[op] ?? "";
      const label = { pause: "Pause", resume: "Resume", stop: "Stop run" }[op];
      const go = (_e, cx) => {
        if (this.sending) return;
        this.sending = true; this.failed = null; cx.notify();
        cx.spawn(async (cx) => {
          const r = await controlRun(io(p.on ?? null), run, op).catch((e) => ({ ok: false, text: String(e?.message ?? e) }));
          if (r.ok && !/RUN_CONTROL=|RUN_STOPPING/.test(r.text)) { close(); return; }
          this.sending = false;
          this.failed = r.ok ? `Nothing done: ${r.text.split("\n").pop()}` : (r.text || "Could not run hd_dispatch.py").split("\n").slice(-2).join(" ");
          cx.notify();
        });
      };
      return dialogFrame(t, "control", title, [
        ...text.map((x, i) => note(t, x, i === 0 ? t.foreground : t.muted)),
        this.failed && note(t, this.failed, t.ansi1),
      ], [dialogButton("cancel", "Cancel", t, close),
        dialogButton("go", this.sending ? "Working…" : label, t, go, op === "stop" ? "danger" : "primary", !this.sending)], close);
    }
    return div();
  }
}
