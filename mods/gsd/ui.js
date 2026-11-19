// Draws one GSD panel from a snapshot. It keeps no state: main.js owns the
// snapshot, the folded sections and the handlers, and passes them in `m`.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, v_virtual_list, Scrollbar } from "gpui-base";
import { detailView } from "./detail.js";
import { positionPhase } from "./find.js";

const icon = (name) => `mods/gsd/${name}.svg`;
const TODO_PREVIEW = 8, PHASE_PREVIEW = 12;

// Each status has its own shape as well as its own color.
const STATUS = {
  done: { icon: "st-done", color: (t) => t.ansi2 },
  executing: { icon: "st-executing", color: (t) => t.working },
  planned: { icon: "st-planned", color: (t) => t.accent },
  not_started: { icon: "st-not-started", color: (t) => t.dim },
};
const statusOf = (s) => STATUS[s] ?? STATUS.not_started;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-07-18…" → "18 Jul" this year, "Jul '25" before.
export function shortDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  if (!m) return value ? String(value).slice(0, 10) : "";
  const month = MONTHS[Number(m[2]) - 1] ?? m[2];
  return Number(m[1]) === new Date().getFullYear() ? `${Number(m[3])} ${month}` : `${month} '${m[1].slice(2)}`;
}

// When the last good load was, as a clock time: true without any redraw. "14:32" today,
// "17 Nov 14:32" on another day; `full` for the tooltip ("Updated 18 Nov 2026, 14:32:05").
const two = (n) => String(n).padStart(2, "0");
export function clock(ms, full = false) {
  const d = new Date(ms), now = new Date(), time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  if (full) return `Updated ${date} ${d.getFullYear()}, ${time}:${two(d.getSeconds())}`;
  return d.toDateString() === now.toDateString() ? time : `${date} ${time}`;
}

const clip = (text, n) => (text && text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text ?? "");

// A warning row wraps: its height from an estimate of the lines it needs at this
// width (11.5 px text at about 7 px a character, word wrap included), at most 8.
const WARN_LINE = 15;
function warnRow(text, width) {
  const perLine = Math.max(16, Math.floor((width - 47) / 7)), max = 8;
  const lines = Math.min(max, Math.max(1, Math.ceil(String(text).length / perLine)));
  return { h: lines * WARN_LINE + 8, data: { text: clip(String(text), perLine * max), lines } };
}

// The scrolling part, as rows of known height: what a virtual list needs.
export function buildRows(snap, ui, width = 360) {
  const rows = [];
  const push = (key, kind, h, data = {}) => rows.push({ key, kind, h, data });
  const folded = ui.collapsed ?? {};
  let warnings = snap.warnings ?? [];

  const phases = snap.phases ?? [];
  if (!phases.length) {
    // No phases: when a warning says why (no ROADMAP.md, unreadable phase headings), say it here.
    const why = warnings.find((w) => /no phases|phase list|ROADMAP\.md lists/i.test(w)) ?? warnings.find((w) => /roadmap/i.test(w));
    push("empty:phases", "empty", 30, { text: why ? "No phases" : "No phases in the roadmap yet" });
    if (why) {
      const r = warnRow(why, width);
      push("why:phases", "warn", r.h, r.data);
      warnings = warnings.filter((w) => w !== why);
    }
  } else {
    const open = !folded.phases;
    push("sec:phases", "sec", 30, { label: "Phases", count: String(phases.length), open });
    if (open) {
      // Finished phases fold into one row so the current one is in view; the current
      // phase never folds away, even when it reads as done.
      const all = phases.map((p, i) => ({ p, i })), folds = (p) => p.status === "done" && !p.current;
      const old = all.filter(({ p }) => folds(p)), rest = all.filter(({ p }) => !folds(p));
      const idWidth = Math.min(56, Math.max(20, Math.max(...phases.map((p) => String(p.id ?? "").length)) * 6.6 + 4));
      if (old.length) {
        push("grp:done", "group", 26, { count: old.length, open: Boolean(ui.doneOpen) });
        if (ui.doneOpen) for (const { p, i } of old) push(`ph:${i}`, "phase", 26, { p, idWidth, inner: true });
      }
      // A long tail of upcoming phases folds too, so the todos stay within reach;
      // the current phase is always in the part that shows.
      const current = rest.findIndex(({ p }) => p.current);
      const keep = Math.max(PHASE_PREVIEW, current + 3);
      const shown = ui.phasesAll || rest.length <= keep + 2 ? rest : rest.slice(0, keep);
      for (const { p, i } of shown) push(`ph:${i}`, "phase", 26, { p, idWidth });
      if (rest.length > keep + 2) push("more:phases", "more", 26, { text: ui.phasesAll ? "Show fewer" : `${rest.length - keep} more phases` });
    }
  }

  const todos = snap.todos ?? [];
  if (!todos.length) push("empty:todos", "empty", 30, { text: "No pending todos" });
  else {
    const open = !folded.todos;
    push("sec:todos", "sec", 30, { label: "Pending todos", count: String(todos.length), open });
    if (open) {
      const n = ui.todosAll ? todos.length : Math.min(todos.length, TODO_PREVIEW);
      for (let i = 0; i < n; i++) push(`td:${i}`, "todo", 26, { todo: todos[i] });
      if (todos.length > TODO_PREVIEW) push("more:todos", "more", 26, { text: ui.todosAll ? "Show fewer" : `Show all ${todos.length}` });
    }
  }

  const shipped = snap.shipped ?? [];
  if (shipped.length) {
    // Shipped milestones start folded: folded.shipped is true unless opened.
    const open = folded.shipped === false;
    push("sec:shipped", "sec", 30, { label: "Shipped", count: String(shipped.length), open });
    if (open) shipped.forEach((s, i) => push(`sh:${i}`, "ship", 26, { s }));
  }

  if (warnings.length) {
    const open = folded.warnings === false;
    push("sec:warnings", "sec", 30, { label: warnings.length === 1 ? "1 warning" : `${warnings.length} warnings`, open, warn: true });
    if (open) warnings.forEach((w, i) => { const r = warnRow(w, width); push(`wa:${i}`, "warn", r.h, r.data); });
  }
  push("end", "end", 10);
  return rows;
}

function rowElement(r, t, narrow) {
  const d = r.data;
  switch (r.kind) {
    case "sec":
      return h_flex().w_full().h(30).flex_none().pt(8).px(8).gap(6).items_center().text_size(11.5).font_medium()
        .text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .when(Boolean(d.warn), (el) => el.child(svg(icon("warning")).size(11).flex_none().text_color(t.blocked)))
        .child(div().min_w(0).truncate().child(d.label))
        .when(!d.warn, (el) => el.child(div().flex_none().font_normal().text_size(11).child(d.count)))
        .child(div().flex_1())
        .child(svg(icon(d.open ? "chevron-down" : "chevron-right")).size(11).flex_none());
    case "group":
      return h_flex().w_full().h(26).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer()
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .child(svg(icon("st-done")).size(13).flex_none().text_color(statusOf("done").color(t)))
        .child(div().flex_1().min_w(0).truncate().child(`${d.count} done`))
        .child(svg(icon(d.open ? "chevron-down" : "chevron-right")).size(11).flex_none().text_color(t.dim));
    case "phase": {
      const p = d.p, st = statusOf(p.status), quiet = p.status === "done" || p.status === "not_started";
      // Opens the phase's details: the hover and pointer of the Changes panel's file rows.
      return h_flex().w_full().h(26).flex_none().pl(d.inner ? 20 : 8).pr(8).gap(8).items_center().rounded(7)
        .cursor_pointer().when(Boolean(p.current), (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .child(svg(icon(st.icon)).size(13).flex_none().text_color(st.color(t)))
        .child(div().w(d.idWidth).flex_none().truncate().text_size(11.5).text_color(p.current ? t.foreground : t.dim).child(String(p.id ?? "")))
        .child(div().flex_1().min_w(0).truncate().text_color(p.current ? t.foreground : quiet ? t.muted : t.foreground)
          .when(Boolean(p.current), (el) => el.font_medium()).child(p.name || p.dir || ""))
        .when(p.plans > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`${p.summaries}/${p.plans}`)));
    }
    case "todo": {
      const todo = d.todo, date = shortDate(todo.created);
      return h_flex().w_full().h(26).flex_none().px(8).gap(8).items_center().rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
        .child(div().flex_1().min_w(0).truncate().child(todo.title || todo.file || ""))
        .when(Boolean(todo.area) && !narrow, (el) => el.child(div().max_w(96).min_w(0).flex_shrink(1).truncate().text_size(11).text_color(t.dim).child(todo.area)))
        .when(Boolean(date), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(date)));
    }
    case "more":
      return h_flex().w_full().h(26).flex_none().px(8).items_center().rounded(7).cursor_pointer().text_size(12)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).child(d.text);
    case "ship": {
      const s = d.s;
      return h_flex().w_full().h(26).flex_none().px(8).gap(8).items_center()
        .child(div().flex_none().text_size(12).font_medium().text_color(t.muted).child(s.version || ""))
        .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(s.name || ""))
        .when(Boolean(s.date), (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(shortDate(s.date))));
    }
    case "warn":
      return h_flex().w_full().h(r.h).flex_none().px(8).gap(8).items_start().pt(4)
        .child(div().pt(2).flex_none().child(svg(icon("warning")).size(11).text_color(t.blocked)))
        .child(div().flex_1().min_w(0).max_h(d.lines * WARN_LINE).overflow_hidden().text_size(11.5).line_height(1.3).text_color(t.muted).child(d.text));
    case "empty":
      return h_flex().w_full().h(30).flex_none().pt(8).px(8).items_center().text_size(12).text_color(t.dim)
        .child(div().min_w(0).truncate().child(d.text));
    default:
      return div().w_full().h(r.h).flex_none();
  }
}

const counts = (p) => (p?.total > 0 ? `${p.completed}/${p.total}` : "–");

// countWidth: the same for both bars, so their ends line up.
function bar(t, label, p, countWidth) {
  const known = typeof p?.percent === "number" && Number.isFinite(p.percent);
  // 0 of 0 is nothing to measure, not 0% progress: drawn like unknown, with a dash.
  const measured = known && p.total > 0;
  const value = Math.max(0, Math.min(100, measured ? p.percent : 0));
  const tip = typeof p?.verified === "number" && p.total > 0 ? `${p.completed} done, ${p.verified} verified, of ${p.total}` : null;
  return h_flex().id(`bar-${label}`).h(18).gap(8).items_center().text_size(11.5).when(Boolean(tip), (el) => el.tooltip(tip))
    .child(div().w(42).flex_none().text_color(t.dim).child(label))
    // Unknown is drawn as a dashed outline, never as an empty (0%) bar.
    .child(measured
      ? div().flex_1().min_w(0).h(5).rounded(3).bg(t.border).child(div().h_full().rounded(3).w(`${value}%`).bg(t.accent))
      : div().flex_1().min_w(0).h(5).rounded(3).border_1().border_dashed().border_color(t.input))
    .child(div().w(countWidth).flex_none().text_right().text_color(t.muted).child(p?.total > 0 ? counts(p) : ""))
    .child(div().w(34).flex_none().text_right().text_color(measured ? t.foreground : t.dim).child(measured ? `${Math.round(p.percent)}%` : known ? "–" : "n/a"));
}

function header(m, t) {
  const s = m.snap, ok = s?.state === "ok", narrow = m.width < 330;
  const stop = (_e, cx) => cx.stop_propagation();
  const when = !ok ? "" : m.loading ? "updating…" : m.loadedAt ? (narrow ? clock(m.loadedAt) : `updated ${clock(m.loadedAt)}`) : "";
  return h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
    .child(div().flex_none().font_semibold().child("GSD"))
    .when(ok && Boolean(s.project), (el) => el.child(div().min_w(0).flex_shrink(1).truncate().text_size(12).text_color(t.dim).child(s.project)))
    .when(ok && Boolean(s.viaWorktree), (el) => el.child(h_flex().id(`${m.id}-worktree`).flex_none().h(18).px(5).gap(4).items_center().rounded(4)
      .border_1().border_color(t.border).text_size(10).text_color(t.muted)
      .tooltip(`Linked worktree: planning comes from the main checkout${s.root ? ` (${s.root})` : ""}`)
      .child(svg(icon("branch")).size(10)).when(!narrow, (el) => el.child("worktree"))))
    .child(div().flex_1().min_w(0))
    .when(Boolean(when), (el) => el.child(div().id(`${m.id}-updated`).flex_none().text_size(11).text_color(t.dim)
      .when(Boolean(m.loadedAt) && !m.loading, (el) => el.tooltip(clock(m.loadedAt, true))).child(when)))
    .child(div().id(`${m.id}-refresh`).size(24).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim)
      .cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).tooltip(m.loading ? "Reading .planning…" : "Refresh")
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); m.onRefresh(cx); })
      .child(m.loading ? svg(icon("spinner")).size(13).spin(900) : svg(icon("refresh")).size(13)));
}

function errorNote(m, t) {
  return h_flex().flex_none().px(14).py(6).gap(6).items_center().bg(t.blocked + "14").border_b(1).border_color(t.border)
    .child(svg(icon("warning")).size(11).flex_none().text_color(t.blocked))
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).tooltip(m.lastError).child(`Refresh failed · ${m.lastError}`))
    .child(div().id(`${m.id}-retry-note`).flex_none().text_size(11.5).text_color(t.foreground).cursor_pointer().hover((s) => s.text_color(t.accent))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => m.onRefresh(cx)).child("Retry"));
}

function summary(s, t, m) {
  const pos = s.position ?? {};
  // The ROADMAP title when the phase is listed (STATE.md's name is often a slug or a note), else STATE's.
  const listed = positionPhase(s);
  const phaseName = pos.phase ? listed?.name || pos.phaseName : null;
  const lines = [
    ["Phase", pos.phase ? (phaseName ? `${pos.phase} · ${phaseName}` : String(pos.phase)) : null],
    ["Plan", pos.plan],
    ["Status", pos.status],
  ].filter(([, v]) => v !== null && v !== undefined && String(v).trim() !== "");
  const countWidth = Math.max(counts(s.progress?.phases).length, counts(s.progress?.plans).length) * 6.6 + 2;
  return v_flex().flex_none()
    .child(v_flex().px(14).pt(10).pb(10).gap(6).border_b(1).border_color(t.border)
      .child(div().truncate().text_size(12.5).font_medium().child(s.milestone?.label || "No milestone"))
      .child(bar(t, "Phases", s.progress?.phases, countWidth))
      .child(bar(t, "Plans", s.progress?.plans, countWidth)))
    .when(lines.length > 0, (el) => el.child(v_flex().px(14).py(8).gap(3).border_b(1).border_color(t.border).children(lines.map(([k, v]) => {
      const text = String(v).replace(/\s+/g, " ").trim();
      const opens = k === "Phase" && Boolean(listed);   // the listed phase opens its details
      return h_flex().id(`pos-${k}`).gap(8).items_start().text_size(12).mx(-6).px(6).rounded(6)
        .when(opens, (el) => el.cursor_pointer().hover((st) => st.bg(t.hover))
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click((_e, cx) => m.onOpen("phase", listed, cx)))
        .child(div().w(42).flex_none().pt(1).text_size(11.5).text_color(t.dim).child(k))
        .child(k === "Status"
          ? div().id(`pos-status`).flex_1().min_w(0).max_h(33).overflow_hidden().line_height(1.35).text_color(t.muted).tooltip(clip(text, 900)).child(clip(text, 200))
          : div().flex_1().min_w(0).truncate().child(text));
    }))));
}

function centered(t, ...children) {
  return v_flex().flex_1().min_h(0).px(20).pt(36).gap(8).items_center().text_size(12.5).children(children.filter(Boolean));
}

/** The tab-bar button: "GSD" and the milestone's phase progress, drawn like the tab bar's
 *  Files/Changes buttons (selected while the column shows). Its block has a fixed width, so
 *  loading and errors only change what's inside. Without GSD planning: just the bar.
 *  `m`: { snap, lastError, on, onClick(cx) } */
export function gsdButton(m, t) {
  const bar = h_flex().size_full().min_w(0).pr(10).items_center().bg(t.chrome).border_b(1).border_color(t.border);
  const s = m.snap;
  // The button is always there, so the bar never has an unexplained gap: dimmed
  // while the space has no .planning (or it isn't read yet), and still a toggle.
  const none = !s || s.state === "none";
  const ph = s?.progress?.phases, pl = s?.progress?.plans;
  // The same rules as the panel's bars: no figure for unknown or nothing-to-count.
  const measured = !none && s.state === "ok" && typeof ph?.percent === "number" && Number.isFinite(ph.percent) && ph.total > 0;
  const failed = !none && (s.state === "error" || Boolean(m.lastError));
  const tip = !s ? "GSD: reading the planning files…"
    : none ? "No GSD planning in this space"
    : s.state === "ok"
    ? [s.milestone?.label, ph?.total > 0 ? `phases ${counts(ph)}` : null, pl?.total > 0 ? `plans ${counts(pl)}` : null, failed ? "refresh failed" : null].filter(Boolean).join(" · ")
    : clip(`GSD: ${s.error || "could not read the planning files"}`, 200);
  return bar.child(h_flex().id("gsd-button").h(26).px(8).gap(5).flex_none().items_center().rounded(6).text_size(12)
    .bg(m.on ? t.selected : t.chrome).text_color(m.on ? t.foreground : none ? t.dim : t.muted).hover((st) => st.bg(t.hover))
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_click((_e, cx) => { cx.stop_propagation(); m.onClick(cx); })
    .tooltip(tip)
    .child("GSD")
    .when(measured, (el) => el.child(div().text_color(m.on ? t.muted : t.dim).child(`${Math.round(ph.percent)}%`)))
    .when(failed, (el) => el.child(svg(icon("warning")).size(11).flex_none().text_color(t.blocked))));
}

/** One panel. `m`: { id, snap, stale, loading, lastError, loadedAt, cwd, ui, width, card, bg, listScroll,
 *  detail (see detail.js) | null, onRefresh(cx), onItem(key, cx), onOpen(kind, item, cx), onBack(cx), onRetry(cx) } */
export function panel(m, t) {
  const s = m.snap, narrow = m.width < 330;
  let body;
  if (!s) body = centered(t, svg(icon("spinner")).size(16).text_color(t.dim).spin(900), div().text_color(t.dim).child("Reading .planning…"));
  else if (s.state === "none") body = centered(t,
    svg(icon("folder")).size(18).text_color(t.dim),
    div().text_color(t.muted).child("No GSD planning here"),
    m.cwd ? div().w_full().text_center().text_size(11).text_color(t.dim).text_ellipsis_start().whitespace_nowrap().overflow_hidden().child(m.cwd) : null,
    div().pt(2).text_size(11).text_color(t.dim).child("Shows a project's .planning folder"));
  else if (s.state === "error") body = centered(t,
    svg(icon("warning")).size(16).text_color(t.blocked),
    div().w_full().text_center().text_color(t.muted).max_h(120).overflow_hidden().child(clip(s.error || "Could not read the planning files", 400)),
    div().id(`${m.id}-retry`).mt(4).h(26).px(12).flex().items_center().rounded(7).border_1().border_color(t.border).text_size(12)
      .cursor_pointer().hover((st) => st.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => m.onRefresh(cx)).child("Retry"));
  else if (m.detail) body = detailView(m, t);
  else {
    // The list keeps its scroll position in `m.listScroll` while a detail is open.
    const rows = buildRows(s, m.ui, m.width), listId = `${m.id}-rows`;
    body = v_flex().flex_1().min_h(0).when(Boolean(m.stale), (el) => el.opacity(0.5))
      .child(summary(s, t, m))
      .child(div().flex_1().min_h(0).relative()
        .child(v_virtual_list(listId, rows.length, rows.map((r) => r.h), (i) => rows[i].key,
          (range) => rows.slice(range.start, range.end).map((r) => rowElement(r, t, narrow)))
          .size_full().px(6).when(Boolean(m.listScroll), (el) => el.track_scroll(m.listScroll)).on_item_click((key, cx) => m.onItem(key, cx)))
        .child(Scrollbar.vertical(listId).absolute().inset_0()));
  }
  return v_flex().size_full().min_h(0).min_w(0).overflow_hidden().bg(m.bg).text_color(t.foreground).text_size(13)
    .when(Boolean(m.card), (el) => el.rounded(10).border_1().border_color(t.border))
    .child(header(m, t))
    .when(Boolean(m.lastError) && s?.state === "ok", (el) => el.child(errorNote(m, t)))
    .child(body);
}
