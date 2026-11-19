// GSD: the focused space's GSD planning (.planning/) at a glance: milestone,
// progress, position, phases, todos and shipped milestones. Read-only.
//
// One mod, four roles, from where a copy sits:
// - "button" (props.role, a block in the tab bar): "GSD" and the milestone's
//   progress; a click shows or hides the column. It is always shown, so it is the
//   copy that keeps per-space show/hide working even before the column's own copy
//   has started (a copy only starts the first time its block shows).
// - "column" (props.role, or a gsd block without props): the panel. Shown on
//   spaces with .planning, hidden on others; the person's choice per space wins.
// - a window (mod.open gsd) or a pane: the panel, never hidden by itself.
// The copies share one load per change and one show/hide brain: module code runs
// once per source version and every copy of the mod shares it.
import { View, div } from "gpui-kit";
import { h_flex, VirtualListScrollHandle } from "gpui-base";
import { spaces, panes, focused, layout, props, run, theme, themes, checking, watchFolder, readTextFile, appHome, nextCommand, shared, setShared } from "herdr";
import { locate, fetchSnapshot, fetchPhaseDetail, fetchTodoDetail } from "./source.js";
import { mockSnapshot, mockPhaseDetail, mockTodoDetail } from "./mock.js";
import { panel, gsdButton } from "./ui.js";
import { positionPhase, findPhase, findTodo } from "./find.js";
import { Brain, JOIN_MS } from "./visibility.js";

const TICK_MS = 1000;            // notices space switches even while hidden (render may not run then)
const WATCHED_SAFETY_MS = 300000; // a watched local space: only catches what the watch missed
const LOCAL_SAFETY_MS = 60000;   // a local space whose watch could not start
const REMOTE_POLL_MS = 30000;    // another machine can't be watched
const QUIET_MS = 400, MAX_WAIT_MS = 2500;   // a GSD run writes many files at once
const MIN_GAP_MS = 5000;         // and keeps writing: a change reloads at most this often (a load is 4 node processes)
const REFRESH_JOIN_MS = 250;     // a refresh only joins a load that has just started (every shown copy gets the command)
const SLOW_MS = 300;             // a detail still loading after this says so (faster ones never flash a spinner)
const SECTIONS = { phases: false, todos: false, shipped: true, warnings: true };   // true = folded
const PREFS_KEY = "gsd.spaces";  // shared state: space id → "shown" | "hidden", the person's choice

// ── shared by every copy ────────────────────────────────────────────────────
// Only state the copies fill in; no host calls at the top level.
const copies = new Set();        // live copies, woken when a load they didn't ask for lands
const loads = new Map();         // folder key → its newest load: { at, done, snap, promise, next }
const cache = new Map();         // folder key → last good snapshot, shown dimmed on return
const watching = new Map();      // .planning root → how many copies watch it now
const brain = new Brain({ get: () => shared(PREFS_KEY), set: (p) => setShared(PREFS_KEY, p) });

/** The newest load of `ctx`'s folder that started at or after `since`: joins it if there is
 *  one, else starts one (after the running one: one load per folder at a time). Resolves
 *  with the load record; every copy is woken when it lands. */
function loadShared(ctx, since, dev, wait) {
  const rec = loads.get(ctx.key);
  if (rec && rec.at >= since) return rec.promise;
  if (rec && !rec.done) return (rec.next ??= rec.promise.then(() => loadShared(ctx, since, dev, wait)));
  const fresh = { at: Date.now(), done: false, snap: null, next: null };
  fresh.promise = (async () => {
    try {
      if (dev?.delay && wait) await wait(dev.delay);   // development: a slow project
      return (await fetchSnapshot({ cwd: ctx.cwd, on: ctx.on }, dev)) ?? { state: "error", error: "No answer from the planning reader" };
    } catch (e) { return { state: "error", error: message(e) }; }
  })().then((snap) => {
    Object.assign(fresh, { snap, done: true });
    for (const c of copies) c.wake?.();
    return fresh;
  });
  loads.delete(ctx.key); loads.set(ctx.key, fresh);
  for (const [k, r] of loads) { if (loads.size <= 32) break; if (r.done) loads.delete(k); }
  return fresh.promise;
}
const lastStart = (key) => loads.get(key)?.at ?? 0;

// The details of a phase or a todo, the same way: "<folder key>|phase|<id>" or "|todo|<file>"
// → its newest load. One load per item at a time; copies showing the same item share it.
const details = new Map();
function loadDetailShared(key, run, since) {
  const rec = details.get(key);
  if (rec && rec.at >= since) return rec.promise;
  if (rec && !rec.done) return (rec.next ??= rec.promise.then(() => loadDetailShared(key, run, since)));
  const fresh = { at: Date.now(), done: false, data: null, next: null };
  fresh.promise = (async () => {
    try { return (await run()) ?? { state: "error", error: "No answer from the planning reader" }; }
    catch (e) { return { state: "error", error: message(e) }; }
  })().then((data) => {
    Object.assign(fresh, { data, done: true });
    for (const c of copies) c.wake?.();
    return fresh;
  });
  details.delete(key); details.set(key, fresh);
  for (const [k, r] of details) { if (details.size <= 32) break; if (r.done) details.delete(k); }
  return fresh.promise;
}
// When the window started showing this folder, as the first copy to notice saw it: a
// load started since then is this folder's answer for every copy (a hidden copy notices
// a switch only on its next tick).
let shownKey = { key: undefined, at: 0 };
function noticed(key) {
  if (key !== shownKey.key) shownKey = { key, at: Date.now() };
  return shownKey.at;
}
const shownSince = (key) => (key === shownKey.key ? shownKey.at : Date.now());

const isGsd = (b) => b?.type === "block" && b.content?.mod === "gsd";
const isButton = (b) => isGsd(b) && b.content.props?.role === "button";
function findBlock(node, test) {
  if (test(node)) return node;
  for (const child of node?.children ?? []) { const found = findBlock(child, test); if (found) return found; }
  return null;
}
function parentOf(node, target) {
  for (const child of node?.children ?? []) {
    if (child === target) return node;
    const found = parentOf(child, target);
    if (found) return found;
  }
  return null;
}
function readJSON(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) ?? "null"); return v && typeof v === "object" && !Array.isArray(v) ? v : fallback; }
  catch { return fallback; }
}
const message = (e) => String(e?.message ?? e ?? "Unknown error").replace(/^Error: /, "").split("\n")[0].slice(0, 300);

export default class Gsd extends View {
  init(_props, cx) {
    this.width = 360;
    this.sections = { ...SECTIONS, ...readJSON("sections", {}) };
    this.view = { doneOpen: false, todosAll: false, phasesAll: false };   // per folder, not remembered
    this.ctx = null; this.snap = null; this.fresh = false; this.stale = false; this.seenAt = -1; this.switchedAt = 0;
    this.loading = false; this.again = null; this.needsLoad = false; this.lastError = null; this.loadedAt = null;
    this.watch = null; this.debounce = null; this.firstPoke = null; this.dirty = false;
    this.dev = null; this.gallery = null;
    this.detail = null;                                  // the phase or todo open in place of the list (this copy's)
    this.listScroll = VirtualListScrollHandle.new();     // the list's position, kept while a detail is open
    if (checking()) {
      // A check draws the fixtures and starts nothing.
      this.ctx = { key: "check", cwd: "/check", on: null }; this.snap = mockSnapshot("rich"); this.fresh = true; this.loadedAt = Date.now();
      return;
    }
    copies.add(this);
    cx.spawn(async (cx) => {
      // dev.json beside main.js (development only, never shipped): {"mock": "<fixture>"}, {"loc": {"cwd": "/a/folder"}},
      // {"delay": ms}, {"sections": {"warnings": false}}, {"watchOnly": "button"}, {"forget": ["<space id>"]}
      // or {"gallery": [["rich", 360], ...]}. Absent, this is one failed read at start.
      try { this.dev = JSON.parse((await readTextFile(`${appHome()}/mods/gsd/dev.json`)) ?? "null"); } catch { this.dev = null; }
      if (this.dev?.sections) this.sections = { ...this.sections, ...this.dev.sections };   // shown folded/open, not saved
      if (Array.isArray(this.dev?.forget)) brain.forget(this.dev.forget);
      if (this.dev?.gallery && props()?.role !== "button") this.gallery = this.dev.gallery.map(([name, width, ui, look]) => {
        const snap = mockSnapshot(name);
        return { name, width, look, snap, detail: ui?.detail ? galleryDetail(snap, ui.detail) : null,
          ui: { doneOpen: false, todosAll: false, phasesAll: false, ...ui, collapsed: { ...SECTIONS, ...ui?.collapsed } } };
      });
      this.started = true;
      this.observe(cx);
      cx.notify();
    });
    // Another copy's load of this folder landed: take it (no load of our own).
    cx.spawn(async (cx) => {
      for (;;) {
        await new Promise((resolve) => { this.wake = resolve; });
        this.catchUp(cx);
      }
    });
    // Keys (keys.json, or `herdr-app do gsd.<command>`), delivered to every shown copy:
    // "refresh" reloads (one load for all of them), "toggle" is the GSD button's click,
    // "open-phase[:<id>]" (the current phase without an id), "open-todo[:<n> | :<text>]"
    // (the n-th pending todo, or the first whose title or file has the text) and "back"
    // are the panel's clicks.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = String(await nextCommand());
        const at = c.search(/[:\s]/), name = at < 0 ? c : c.slice(0, at), arg = at < 0 ? "" : c.slice(at + 1).trim();
        if (name === "refresh") this.refresh(cx);
        else if (name === "toggle" && this.leads()) this.toggleColumn(cx);
        else if (this.role() !== "button" && !this.gallery) {
          if (name === "open-phase") this.openDetail("phase", findPhase(this.snap, arg), cx);
          else if (name === "open-todo") this.openDetail("todo", findTodo(this.snap, arg), cx);
          else if (name === "back") this.back(cx);
          else if (name === "dev-scroll" && this.dev) { this.listScroll.scroll_to_item(Number(arg) || 0); cx.notify(); }   // development
          else if (name === "dev-item" && this.dev) this.item(arg, cx);   // development: a list row's click (sec:todos, more:todos, ph:3, …)
        }
      }
    });
    cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  async close() { copies.delete(this); this.stopWatch(); this.debounce?.cancel(); }

  // ── where we are ──────────────────────────────────────────────────────────
  role() {
    const p = props();
    if (p?.overlay) return "window";
    if (p?.role === "button" || p?.role === "column") return p.role;
    return findBlock(layout(), (b) => isGsd(b) && !b.content.props?.role) ? "column" : "pane";
  }
  /** The layout's GSD column (the first gsd block that isn't the button), or null. */
  columnNode() { return findBlock(layout(), (b) => isGsd(b) && !isButton(b)); }
  /** This copy's layout block, or null for a window or a pane (nothing to hide). */
  node() {
    const r = this.role();
    return r === "button" ? findBlock(layout(), isButton) : r === "column" ? this.columnNode() : null;
  }
  /** The copy that acts on "toggle": the button when the layout has one, else the column. */
  leads() {
    return this.role() === (findBlock(layout(), isButton) ? "button" : "column");
  }
  // Whether anyone can see this copy: a window always; a block unless hidden; a pane
  // only while its tab is the shown one (a pane copy can't tell which gsd pane it
  // is, so any shown gsd pane counts).
  shown() {
    const r = this.role();
    if (r === "window") return true;
    if (r === "pane") {
      const mine = panes().filter((p) => p.mod === "gsd");
      if (!mine.length) return true;
      const space = spaces().find((s) => s.active), tab = space?.tabs.find((x) => x.active)?.id;
      return mine.some((p) => p.tab === tab);
    }
    const n = this.node();
    return n ? !n.hidden : true;
  }

  /** The focused space and its folder, as the window is now (dev.json's loc wins). */
  where() {
    const live = { spaces: spaces(), panes: panes(), focused: focused() };
    const loc = this.dev?.loc ?? locate(live);
    return { loc, space: loc?.spaceId || live.spaces.find((s) => s.active)?.id || null, key: loc ? JSON.stringify([loc.cwd, loc.on ?? null]) : "" };
  }

  observe(cx) {
    if (!this.started) return;
    const w = this.where();
    this.space = w.space;
    noticed(w.key);
    if (w.key !== this.ctx?.key) this.switchTo(w.key, w.loc, cx);
    this.syncVisibility(w);
  }

  switchTo(key, loc, cx) {
    this.ctx = { key, cwd: loc?.cwd ?? null, on: loc?.on ?? null };
    this.stopWatch();
    this.debounce?.cancel(); this.debounce = null; this.firstPoke = null;   // the last folder's pending reload
    this.view = { doneOpen: false, todosAll: false, phasesAll: false };
    this.detail = null;   // another folder: its list, not the last one's detail
    // Never the previous folder's data: this folder's last good one, dimmed, or nothing.
    const cached = cache.get(key);
    this.snap = cached ?? null; this.stale = Boolean(cached); this.fresh = false; this.lastError = null; this.loadedAt = cached?.loadedAt ?? null;
    this.seenAt = -1; this.switchedAt = Date.now();
    this.dirty = true;
    if (!key) { this.snap = { ...mockSnapshot("none") }; this.fresh = true; return; }
    // Unseen, load only what deciding to show the column needs (a column without a
    // choice for this space); everything else loads when it shows.
    const decides = this.role() === "column" && !brain.prefs()[this.space];
    if (!this.shown() && !decides) { this.needsLoad = true; return; }
    // A folder seen before is watched from its cached root before the load starts, so
    // that load already covers what the watch could have missed: no second load.
    if (cached) this.updateWatch(cx, false);
    // Copies notice a switch a moment apart: a load another copy started since serves all.
    this.requestLoad(cx, Math.min(shownSince(key), Date.now() - JOIN_MS));
  }

  // ── loading ───────────────────────────────────────────────────────────────
  // A snapshot read after `since`, shared with every copy; this copy waits for one at a time.
  requestLoad(cx, since = Date.now()) {
    if (!this.ctx?.key) return;
    if (this.loading) { this.again = Math.max(this.again ?? since, since); return; }
    this.needsLoad = false;
    const ctx = this.ctx, dev = this.dev;
    this.loading = true; this.dirty = true;
    cx.spawn(async (cx) => {
      const rec = await loadShared(ctx, since, dev, (ms) => cx.sleep(ms));
      this.loading = false;
      if (ctx === this.ctx && rec.at > this.seenAt) this.accept(rec, cx);
      if (this.again !== null) {
        const again = this.again; this.again = null;
        if (this.shown() || !this.fresh) this.requestLoad(cx, again); else this.needsLoad = true;
      }
      this.syncVisibility();
      cx.notify();
    });
  }

  // Woken by a load that landed (maybe another copy's): take it when it is this folder's, newer
  // than what we have, and not from before we came to this folder.
  catchUp(cx) {
    const rec = this.ctx?.key ? loads.get(this.ctx.key) : null;
    let changed = false;
    if (rec?.done && rec.at > this.seenAt && rec.at >= Math.min(this.switchedAt - JOIN_MS, shownSince(this.ctx.key))) {
      this.accept(rec, cx);
      this.syncVisibility();
      changed = true;
    }
    // The open item's details, loaded by another copy showing it too.
    const det = this.detail, drec = det ? details.get(det.key) : null;
    if (drec?.done && drec.at > det.seenAt && drec.at >= det.openedAt - JOIN_MS) { this.takeDetail(det, drec); changed = true; }
    if (changed) cx.notify();
  }

  accept(rec, cx) {
    const snap = rec.snap;
    this.seenAt = rec.at; this.needsLoad = false;
    const good = this.snap?.state === "ok" ? this.snap : cache.get(this.ctx.key);
    if (snap.state === "error" && good) {
      // Keep the last good data and say what went wrong.
      this.snap = good; this.lastError = snap.error || "Could not read the planning files";
    } else {
      this.snap = snap; this.lastError = null;
      this.loadedAt = snap.loadedAt || Date.now();
      if (snap.state !== "error") {
        cache.delete(this.ctx.key); cache.set(this.ctx.key, snap);
        if (cache.size > 24) cache.delete(cache.keys().next().value);
      }
      if (this.detail) this.followDetail(rec, cx);
    }
    this.stale = false; this.fresh = true;
    this.updateWatch(cx);
  }

  // A local, shown, GSD folder is watched; everything else is not.
  // `reload`: the watch starts after the last load did, which may have missed a change.
  updateWatch(cx, reload = true) {
    const s = this.snap;
    let root = !this.dev?.mock && this.shown() && !this.ctx?.on && s?.state === "ok" && s.planningRoot ? s.planningRoot : null;
    if (this.dev?.watchOnly && this.role() !== this.dev.watchOnly) root = null;   // development: prove copies share loads
    // A watch that failed is tried again, at most once a minute (each try reloads once).
    const retry = this.watch?.failed && Date.now() - this.watch.at > LOCAL_SAFETY_MS;
    if (root === (this.watch?.root ?? null) && !retry) return;
    this.stopWatch();
    if (!root) return;
    // Another copy watching this folder has kept the shared loads current: nothing to catch up on.
    if ((watching.get(root) ?? 0) > 0) reload = false;
    const w = { root, live: true, handle: null };
    this.watch = w; watching.set(root, (watching.get(root) ?? 0) + 1);
    cx.spawn(async (cx) => {
      try {
        while (w.live) {
          w.handle = watchFolder(root);
          // Idle watches can be reclaimed: reload once whenever a watch starts.
          if (reload) this.poke(cx);
          reload = true;
          await w.handle;
        }
      } catch {
        // Too many watches or an unwatchable tree: the safety timer keeps it fresh.
        if (this.watch === w) { this.stopWatch(); this.watch = { root, live: false, handle: null, failed: true, at: Date.now() }; }
      }
    });
  }

  stopWatch() {
    const w = this.watch;
    if (!w) return;
    if (w.live) { const n = (watching.get(w.root) ?? 1) - 1; if (n > 0) watching.set(w.root, n); else watching.delete(w.root); }
    w.live = false;
    w.handle?.cancel();
    this.watch = null;
  }

  // Debounced reload: after QUIET_MS without changes, at most MAX_WAIT_MS after the first,
  // and never sooner than MIN_GAP_MS after the last load of this folder (by any copy) started.
  // Copies watching the same folder fire together and share one load.
  poke(cx) {
    const now = Date.now();
    this.firstPoke ??= now;
    this.debounce?.cancel();
    const wait = Math.max(0, Math.min(QUIET_MS, this.firstPoke + MAX_WAIT_MS - now), lastStart(this.ctx?.key) + MIN_GAP_MS - now);
    this.debounce = cx.timer.after(wait, (cx) => {
      const since = this.firstPoke ?? Date.now();
      this.debounce = null; this.firstPoke = null;
      if (this.shown()) this.requestLoad(cx, since);
      cx.notify();
    });
  }

  tick(cx) {
    this.observe(cx);
    if (this.ctx?.key && !this.gallery) {
      const shown = this.shown();
      if (shown && this.needsLoad) this.requestLoad(cx, Date.now() - JOIN_MS);
      // While shown: remote spaces poll, local ones have a slow safety reload (one for all copies).
      const every = this.ctx.on ? REMOTE_POLL_MS : this.watch?.live ? WATCHED_SAFETY_MS : LOCAL_SAFETY_MS;
      if (shown && !this.loading && !this.dev?.mock && Date.now() - lastStart(this.ctx.key) > every) this.requestLoad(cx, Date.now() - every);
      // Hidden: no watch. Shown again: the watch comes back.
      if (!shown && this.watch) this.stopWatch();
      if (shown && !this.watch && this.snap?.state === "ok" && this.fresh) this.updateWatch(cx);
      // An open detail whose project changed while nobody could see it.
      if (shown && this.detail && this.detail.needs !== null) { const since = this.detail.needs; this.detail.needs = null; this.requestDetail(cx, since); }
    }
    if (this.dirty) { this.dirty = false; cx.notify(); }
  }

  // ── show and hide per space ───────────────────────────────────────────────
  // Every copy feeds the one shared brain what the window shows now; see visibility.js.
  syncVisibility(w = this.where()) {
    if (!this.started || this.gallery) return;
    const col = this.columnNode();
    if (!col || !w.space) return;
    const rec = w.key ? loads.get(w.key) : null;
    const loaded = !w.key ? { at: Date.now(), state: "none" } : rec?.done ? { at: rec.at, state: rec.snap?.state ?? "error" } : null;
    const out = brain.sync({ space: w.space, key: w.key, shown: !col.hidden, loaded, now: Date.now() });
    if (out.apply !== undefined) run(out.apply ? "layout.show" : "layout.hide", { id: col.id });
  }

  // The GSD button (or "gsd.toggle"): show or hide the column, as the person's choice for this space.
  toggleColumn(cx) {
    const col = this.columnNode(), w = this.where();
    if (!col || !w.space) return;
    const out = brain.click({ space: w.space, key: w.key, shown: !col.hidden, now: Date.now() });
    run(out.apply ? "layout.show" : "layout.hide", { id: col.id });
    cx.notify();
  }

  // ── details ───────────────────────────────────────────────────────────────
  // A phase or todo opens in place of the list; Back returns to the list as it was. The
  // open item is this copy's; its loads are shared with copies showing the same item.
  openDetail(kind, item, cx) {
    if (!item || this.snap?.state !== "ok" || !this.ctx?.key) return;
    const ref = kind === "phase" ? String(item.id) : String(item.file);
    const det = { kind, ref, item, key: `${this.ctx.key}|${kind}|${ref}`, data: null, error: null,
      loading: false, slow: false, seenAt: -1, again: null, needs: null, openedAt: Date.now() };
    this.detail = det;
    // What another copy (or an earlier visit) loaded shows at once; a load newer than the
    // folder's last change needs no new one.
    const known = details.get(det.key);
    if (known?.done) this.takeDetail(det, known, true);
    this.requestDetail(cx, lastStart(this.ctx.key));
    // Fast loads never flash a spinner: it shows only once this one is slow.
    cx.timer.after(SLOW_MS, (cx) => { if (this.detail === det && det.loading && !det.data) { det.slow = true; cx.notify(); } });
    cx.notify();
  }

  back(cx) {
    if (!this.detail) return;
    this.detail = null;
    cx.notify();
  }

  retryDetail(cx) {
    if (!this.detail) return;
    this.requestDetail(cx, Date.now());
    cx.notify();
  }

  // One detail load at a time for this copy; a later request runs once after it.
  requestDetail(cx, since) {
    const det = this.detail;
    if (!det) return;
    if (det.loading) { det.again = Math.max(det.again ?? since, since); return; }
    det.loading = true;
    const ctx = { root: this.snap?.root, on: this.ctx?.on ?? null }, dev = this.dev, item = det.item;
    cx.spawn(async (cx) => {
      const run = async () => {
        if (dev?.delay) await cx.sleep(dev.delay);   // development: a slow project
        return det.kind === "phase" ? fetchPhaseDetail(ctx, item, dev) : fetchTodoDetail(ctx, item, dev);
      };
      const rec = await loadDetailShared(det.key, run, since);
      det.loading = false;
      if (this.detail !== det) return;   // went back, opened another item or another folder: not ours any more
      this.takeDetail(det, rec);
      if (det.again !== null) { const again = det.again; det.again = null; this.requestDetail(cx, again); }
      cx.notify();
    });
  }

  takeDetail(det, rec, early = false) {
    if (rec.at <= det.seenAt) return;
    det.seenAt = early ? -1 : rec.at;   // an earlier visit's load shows, but doesn't count as this one's
    const d = rec.data;
    // A failed refresh keeps what was shown and says so.
    if (d?.state === "error" && det.data?.state === "ok") det.error = d.error || "Could not read the details";
    else { det.data = d; det.error = null; }
  }

  // The project changed on disk (a new snapshot): the open item follows it, once per snapshot
  // load (so with the same floor and coalescing), or closes when it is gone.
  followDetail(rec, cx) {
    const det = this.detail, s = this.snap;
    const item = det.kind === "phase" ? (s.phases ?? []).find((p) => String(p.id) === det.ref) : (s.todos ?? []).find((x) => String(x.file) === det.ref);
    if (!item) { this.detail = null; return; }
    det.item = item;
    if (this.shown()) this.requestDetail(cx, rec.at); else det.needs = rec.at;
  }

  // ── clicks ────────────────────────────────────────────────────────────────
  refresh(cx) {
    if (this.gallery) return;
    this.requestLoad(cx, Date.now() - REFRESH_JOIN_MS);
    if (this.detail) this.requestDetail(cx, Date.now() - REFRESH_JOIN_MS);
    cx.notify();
  }

  item(key, cx, ui = null) {
    const own = !ui;
    if (own && !this.gallery && /^(ph|td):\d+$/.test(key)) {
      const i = Number(key.slice(3)), s = this.snap;
      this.openDetail(key.startsWith("ph") ? "phase" : "todo", key.startsWith("ph") ? s?.phases?.[i] : s?.todos?.[i], cx);
      return;
    }
    ui ??= { collapsed: this.sections, ...this.view };
    if (key.startsWith("sec:")) {
      const name = key.slice(4), folded = ui.collapsed[name] ?? SECTIONS[name];
      ui.collapsed[name] = !folded;
      if (own) try { localStorage.setItem("sections", JSON.stringify(this.sections)); } catch {}
    } else if (key === "grp:done") ui.doneOpen = !ui.doneOpen;
    else if (key === "more:todos") ui.todosAll = !ui.todosAll;
    else if (key === "more:phases") ui.phasesAll = !ui.phasesAll;
    else return;
    if (own) { this.view.doneOpen = ui.doneOpen; this.view.todosAll = ui.todosAll; this.view.phasesAll = ui.phasesAll; }
    cx.notify();
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  frame() {
    // A block in a padded row (like the Files panel's) is a card; anywhere else
    // (a column at the window's edge, a pane, a window) the frame is the host's.
    const root = layout(), n = this.node(), parent = n ? parentOf(root, n) : null;
    return { card: Boolean(n && (parent?.padding || parent?.gap)), docked: Boolean(n) };
  }

  render(cx) {
    this.observe(cx);
    this.dirty = false;   // this render draws it
    const t = theme();
    if (this.gallery) return this.renderGallery(t);
    if (this.role() === "button") {
      const col = this.columnNode();
      return gsdButton({ snap: this.snap, lastError: this.lastError, on: Boolean(col && !col.hidden),
        onClick: (cx) => this.toggleColumn(cx) }, t);
    }
    const f = this.frame();
    return h_flex().id("gsd").size_full().min_w(0)
      .on_size_change((size, cx) => { if (Math.abs(size.width - this.width) >= 1) { this.width = size.width; cx.notify(); } })
      .child(panel({
        id: "gsd", snap: this.snap, stale: this.stale, loading: this.loading, lastError: this.lastError, loadedAt: this.loadedAt,
        cwd: this.ctx?.cwd, ui: { collapsed: this.sections, ...this.view }, width: this.width,
        card: f.card, bg: f.docked && !f.card ? t.chrome : t.background, listScroll: this.listScroll, detail: this.detail,
        onRefresh: (cx) => this.refresh(cx), onItem: (key, cx) => this.item(key, cx),
        onOpen: (kind, item, cx) => this.openDetail(kind, item, cx), onBack: (cx) => this.back(cx), onRetry: (cx) => this.retryDetail(cx),
      }, t));
  }

  renderGallery(t) {
    return h_flex().id("gsd-gallery").size_full().min_w(0).p(8).gap(8).bg(t.canvas).overflow_x_scrollbar()
      .children(this.gallery.map((g, i) => { const tt = (g.look && themes().find((x) => x.name === g.look)?.colors) || t; return div().w(g.width).h_full().flex_none().child(panel({
        id: `g${i}`, snap: g.snap, stale: false, loading: false, lastError: g.name === "rich" && i > 0 ? "git exited 128: not a git repository" : null,
        loadedAt: Date.now() - 125000, cwd: "/home/dev/projects/plain-folder", ui: g.ui, width: g.width, card: true, bg: tt.background,
        detail: g.detail, onRefresh: () => {}, onItem: (key, cx) => this.item(key, cx, g.ui), onOpen: () => {}, onBack: () => {}, onRetry: () => {},
      }, tt)); }));
  }
}

// Development (dev.json gallery): a detail drawn from the fixtures. spec: { kind, fixture?, id? | index?, loading? }
function galleryDetail(snap, spec) {
  const phase = spec.kind === "phase";
  const item = phase ? (spec.id ? snap.phases.find((p) => String(p.id) === String(spec.id)) : positionPhase(snap)) : snap.todos[spec.index ?? 0];
  if (!item) return null;
  const data = spec.loading ? null : phase ? mockPhaseDetail(item, spec.fixture) : mockTodoDetail(item, spec.fixture);
  for (const k of spec.omit ?? []) if (data) data[k] = Array.isArray(data[k]) ? [] : null;   // to see what's further down
  return { kind: spec.kind, ref: phase ? String(item.id) : String(item.file), item, key: "gallery", data, error: spec.refreshFailed ? "gsd-tools timed out" : null,
    loading: Boolean(spec.loading), slow: true, seenAt: 0, again: null, needs: null, openedAt: 0 };
}
