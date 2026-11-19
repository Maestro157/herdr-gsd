// The details of one phase or one todo, drawn in the panel in place of the
// list (like the Changes panel shows a file's diff in place). Keeps no state:
// main.js owns the open detail and passes it in `m.detail`.
//   m.detail: { kind: "phase" | "todo", ref, item (the list's entry), data (PhaseDetail | TodoDetail | null),
//               error (a failed refresh over shown data), loading, slow (loading long enough to say so) }
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Scrollbar, TextView } from "gpui-base";

const icon = (name) => `mods/gsd/${name}.svg`;
const STATUS = {
  done: { icon: "st-done", label: "Done", color: (t) => t.ansi2 },
  executing: { icon: "st-executing", label: "Executing", color: (t) => t.working },
  planned: { icon: "st-planned", label: "Planned", color: (t) => t.accent },
  not_started: { icon: "st-not-started", label: "Not started", color: (t) => t.dim },
};
const statusOf = (s) => STATUS[s] ?? STATUS.not_started;
const MAX_PLANS = 150;   // a plain list: more than this shows a count instead
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function day(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ""));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1] ?? m[2]} ${m[1]}` : value ? String(value).slice(0, 24) : "";
}
const words = (s) => String(s ?? "").replace(/[_-]+/g, " ").trim();
const clip = (text, n) => (text && text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text ?? "");
const stop = (_e, cx) => cx.stop_propagation();

function section(t, label, count, ...children) {
  return v_flex().w_full().min_w(0).gap(5)
    .child(h_flex().gap(6).items_center().text_size(11.5).font_medium().text_color(t.dim)
      .child(label).when(count !== null && count !== undefined, (el) => el.child(div().font_normal().text_size(11).child(String(count)))))
    .children(children.flat().filter(Boolean));
}
const para = (t, text, color) => div().w_full().min_w(0).text_size(12.5).line_height(1.4).text_color(color ?? t.foreground).child(text);

// A done mark: true → done, false → open, null/undefined → unknown (nothing drawn, same width).
function mark(t, done) {
  if (done === true) return svg(icon("st-done")).size(13).flex_none().text_color(t.ansi2);
  if (done === false) return svg(icon("st-not-started")).size(13).flex_none().text_color(t.dim);
  return div().w(13).h(13).flex_none();
}

function backRow(m, t) {
  const d = m.detail;
  return h_flex().h(36).flex_none().pl(8).pr(14).gap(6).items_center().border_b(1).border_color(t.border)
    .child(h_flex().id(`${m.id}-back`).h(24).pl(4).pr(8).gap(3).items_center().rounded(6).text_size(12).text_color(t.muted)
      .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); m.onBack(cx); })
      .child(svg(icon("chevron-left")).size(13)).child("Back"))
    .child(div().flex_1())
    .when(Boolean(d.loading && d.data), (el) => el.child(svg(icon("spinner")).size(11).text_color(t.dim).spin(900)))
    .child(div().text_size(11).text_color(t.dim).child(d.kind === "phase" ? "Phase" : "Todo"));
}

function refreshFailed(m, t) {
  return h_flex().w_full().gap(6).items_center().px(8).py(5).rounded(6).bg(t.blocked + "14")
    .child(svg(icon("warning")).size(11).flex_none().text_color(t.blocked))
    .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.muted).child(`Refresh failed · ${m.detail.error}`))
    .child(div().id(`${m.id}-detail-retry-note`).flex_none().text_size(11.5).cursor_pointer().hover((s) => s.text_color(t.accent))
      .on_mouse_down("left", stop).on_click((_e, cx) => m.onRetry(cx)).child("Retry"));
}

// ── phase ───────────────────────────────────────────────────────────────────

function phaseHead(t, item, data) {
  const status = data?.status ?? item.status, st = statusOf(status);
  const plans = data?.plans?.length ? data.plans : null;
  const done = plans ? plans.filter((p) => p.done).length : item.summaries;
  const total = plans ? plans.length : item.plans;
  const sub = [`Phase ${data?.id ?? item.id}`, st.label, total > 0 ? `${Math.min(done, total)}/${total} plans` : "no plans yet"].join(" · ");
  return h_flex().w_full().min_w(0).gap(8).items_start()
    .child(div().pt(2).flex_none().child(svg(icon(st.icon)).size(14).text_color(st.color(t))))
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().w_full().min_w(0).text_size(13.5).font_medium().line_height(1.35).child(data?.name || item.name || `Phase ${item.id}`))
      .child(div().text_size(11.5).text_color(t.dim).child(sub)));
}

function planRows(t, plans) {
  const waves = plans.some((p) => p.wave !== null && p.wave !== undefined);
  const idWidth = Math.min(80, Math.max(28, Math.max(...plans.map((p) => String(p.id ?? "").length)) * 6.4 + 4));
  const rows = [];
  let wave;
  plans.slice(0, MAX_PLANS).forEach((p, i) => {
    if (waves && p.wave !== wave) {
      wave = p.wave;
      const inWave = plans.filter((x) => x.wave === wave);
      rows.push(h_flex().h(22).pt(4).gap(6).items_center().text_size(11).text_color(t.dim)
        .child(wave === null || wave === undefined ? "No wave" : `Wave ${wave}`)
        .child(div().text_size(10.5).child(`${inWave.filter((x) => x.done).length}/${inWave.length}`)));
    }
    rows.push(h_flex().w_full().min_w(0).h(24).gap(8).items_center()
      .child(mark(t, Boolean(p.done)))
      .child(div().w(idWidth).flex_none().truncate().text_size(11.5).text_color(t.dim).child(String(p.id ?? i + 1)))
      .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(p.done ? t.muted : t.foreground).child(p.title || "")));
  });
  if (plans.length > MAX_PLANS) rows.push(div().h(22).text_size(11.5).text_color(t.dim).child(`${plans.length - MAX_PLANS} more plans`));
  return rows;
}

function checkRow(t, label, c) {
  if (!c || (!c.status && !c.detail)) return null;
  const status = words(c.status) || "unknown";
  const color = /pass|complete|approved|done/i.test(status) ? t.ansi2 : /gap|fail|reject|block/i.test(status) ? t.blocked : t.muted;
  return section(t, label, null,
    div().text_size(12.5).text_color(color).child(status),
    c.detail ? para(t, clip(c.detail, 600), t.muted).text_size(12) : null);
}

function phaseBody(m, t) {
  const { item, data } = m.detail;
  const d = data?.state === "ok" ? data : null;
  const parts = [phaseHead(t, item, d)];
  if (m.detail.error && d) parts.push(refreshFailed(m, t));
  if (!d) return parts;
  if (d.goal) parts.push(section(t, "Goal", null, para(t, d.goal)));
  // Entries are bare ids ("24") or ROADMAP's own words ("Phase 75.3 (sequence; …)").
  if (d.dependsOn?.length) parts.push(section(t, "Depends on", null, para(t, d.dependsOn.map((x) => (/^[\w.]+$/.test(String(x)) ? `Phase ${x}` : String(x))).join(", "), t.muted)));
  const reqWidth = Math.min(84, Math.max(36, Math.max(0, ...(d.requirements ?? []).map((r) => String(r.id ?? "").length)) * 6.8 + 4));
  const idsOnly = d.requirements?.length && d.requirements.every((r) => !r.text && (r.done === null || r.done === undefined));
  if (idsOnly) parts.push(section(t, "Requirements", d.requirements.length, para(t, d.requirements.map((r) => r.id).join(", "), t.muted)));
  else if (d.requirements?.length) parts.push(section(t, "Requirements", d.requirements.length, d.requirements.map((r) =>
    h_flex().w_full().min_w(0).gap(8).items_start()
      .child(div().pt(2).flex_none().child(mark(t, r.done)))
      .child(div().w(reqWidth).flex_none().truncate().pt(1).text_size(11.5).font_medium().text_color(t.muted).child(String(r.id ?? "")))
      .child(div().flex_1().min_w(0).text_size(12.5).line_height(1.4).text_color(r.done ? t.muted : t.foreground).child(r.text || "")))));
  if (d.successCriteria?.length) parts.push(section(t, "Success criteria", d.successCriteria.length, d.successCriteria.map((c, i) =>
    h_flex().w_full().min_w(0).gap(8).items_start()
      .child(div().w(16).flex_none().text_right().text_size(11.5).pt(1).text_color(t.dim).child(`${i + 1}.`))
      .child(div().flex_1().min_w(0).text_size(12.5).line_height(1.4).child(c)))));
  if (d.plans?.length) parts.push(section(t, "Plans", `${d.plans.filter((p) => p.done).length}/${d.plans.length}`, planRows(t, d.plans)));
  parts.push(checkRow(t, "Verification", d.verification), checkRow(t, "UAT", d.uat));
  if (parts.length === (m.detail.error ? 2 : 1)) parts.push(div().text_size(12).text_color(t.dim).child("Nothing planned for this phase yet"));
  if (d.warnings?.length) parts.push(v_flex().gap(4).children(d.warnings.map((w) => h_flex().w_full().min_w(0).gap(6).items_start()
    .child(div().pt(2).flex_none().child(svg(icon("warning")).size(11).text_color(t.blocked)))
    .child(div().flex_1().min_w(0).text_size(11.5).line_height(1.35).text_color(t.muted).child(clip(w, 300))))));
  return parts;
}

// ── todo ────────────────────────────────────────────────────────────────────

function todoBody(m, t) {
  const { item, data, ref } = m.detail;
  const d = data?.state === "ok" ? data : null;
  const severity = d?.severity;
  const meta = [d?.area ?? item.area, day(d?.created ?? item.created), severity].filter(Boolean);
  const parts = [v_flex().w_full().min_w(0).gap(3)
    .child(div().w_full().min_w(0).text_size(13.5).font_medium().line_height(1.35).child(d?.title || item.title || item.file))
    .when(meta.length > 0, (el) => el.child(h_flex().gap(6).text_size(11.5).text_color(t.dim).children(meta.map((x, i) =>
      div().when(x === severity && /high|critical|urgent|blocker/i.test(x), (e) => e.text_color(t.blocked)).child(i ? `· ${x}` : x)))))];
  if (m.detail.error && d) parts.push(refreshFailed(m, t));
  if (!d) return parts;
  if (d.files?.length) parts.push(section(t, "Files", d.files.length, d.files.map((f) =>
    div().w_full().min_w(0).text_size(12).text_color(t.muted).text_ellipsis_start().whitespace_nowrap().overflow_hidden().child(f))));
  // The body as markdown. A clipping box: nothing the renderer draws may widen the column.
  parts.push(d.body && d.body.trim()
    ? div().w_full().min_w(0).overflow_hidden().text_size(12.5).child(TextView.markdown(`${m.id}-md-${ref}`, d.body).selectable(true).scrollable(false))
    : div().text_size(12).text_color(t.dim).child("No notes in this todo"));
  parts.push(v_flex().w_full().min_w(0).gap(2).pt(2)
    .when(Boolean(d.truncated), (el) => el.child(div().text_size(11).text_color(t.muted).child("The file is longer: showing its beginning")))
    .when(Boolean(d.path), (el) => el.child(div().w_full().min_w(0).text_size(11).text_color(t.dim).text_ellipsis_start().whitespace_nowrap().overflow_hidden().child(d.path))));
  return parts;
}

/** The detail view: a back row, then the phase or todo, scrolling; or its loading / error state. */
export function detailView(m, t) {
  const det = m.detail, data = det.data;
  const parts = det.kind === "phase" ? phaseBody(m, t) : todoBody(m, t);
  const failed = data?.state === "error";
  if (!data && det.loading && det.slow) parts.push(h_flex().gap(8).items_center().pt(6).text_size(12).text_color(t.dim)
    .child(svg(icon("spinner")).size(13).spin(900)).child(det.kind === "phase" ? "Reading the phase…" : "Reading the todo…"));
  if (failed) parts.push(v_flex().w_full().min_w(0).gap(8).pt(4).items_start()
    .child(h_flex().w_full().min_w(0).gap(6).items_start()
      .child(div().pt(2).flex_none().child(svg(icon("warning")).size(12).text_color(t.blocked)))
      .child(div().flex_1().min_w(0).text_size(12).line_height(1.4).text_color(t.muted).child(clip(data.error || "Could not read the details", 400))))
    .child(div().id(`${m.id}-detail-retry`).h(26).px(12).flex().items_center().rounded(7).border_1().border_color(t.border).text_size(12)
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_mouse_down("left", stop).on_click((_e, cx) => m.onRetry(cx))
      .child(det.loading ? "Retrying…" : "Retry")));
  const scrollId = `${m.id}-detail-${det.kind}-${det.ref}`;
  return v_flex().flex_1().min_h(0).min_w(0)
    .child(backRow(m, t))
    .child(div().flex_1().min_h(0).relative()
      // flex_none: each part keeps its full height and the area scrolls (a flex child would shrink
      // to fit, and the markdown view, which has no minimum height, would be cut off).
      .child(v_flex().id(scrollId).absolute().inset_0().overflow_y_scroll().px(14).pt(12).pb(18).gap(16).children(parts.filter(Boolean).map((p) => p.flex_none())))
      .child(Scrollbar.vertical(scrollId).absolute().inset_0()));
}
