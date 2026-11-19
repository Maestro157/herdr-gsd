// When the GSD column shows and hides itself. Pure: no host calls, so the tests
// drive it exactly as the mod does.
//
// - A space with .planning shows the column, one without hides it.
// - The person's own show/hide wins and is remembered for that space, so a
//   column they closed never reopens there by itself, and one they opened on
//   a space without GSD stays open. A click on the GSD button is such a choice;
//   so is any other toggle (a key bound to layout.toggle:gsd, a drag).
// - Our own show/hide takes a moment to land; until it does (or PENDING_MS
//   pass) the old state isn't read as the person's choice.
//
// `Brain` is the one decision maker every copy of the mod shares (main.js keeps
// one per module): whichever copy runs (the always-shown tab-bar button, the
// column, a window) feeds it what the window shows now, so the decision works
// even when the column's own copy has never started.

export const PENDING_MS = 1500;
// A load counts as this folder's answer if it started at most this long before
// the folder became the shown one (copies notice a switch a moment apart).
export const JOIN_MS = 1000;
const MAX_PREFS = 300;

/** The logic's memory between steps. */
export function initial() {
  return { space: undefined, key: undefined, decided: false, expected: null, entry: null, pending: null };
}

/**
 * v:   the memory (changed in place).
 * see: { space, key, shown, pref, known, now }
 *      key: the folder shown; pref: "shown" | "hidden" | undefined (the person's choice for this space);
 *      known: the state of a finished load of this folder ("ok" | "none" | "error"), or null while loading.
 * Returns { remember?: boolean } to store as the person's choice for `space`,
 *         { apply?: boolean } to show (true) or hide (false) the column.
 */
export function step(v, see) {
  const out = {};
  if (see.space !== v.space || (!see.pref && see.key !== v.key)) {
    // Another space, or another folder in a space without a choice: decide again.
    // A change of ours still landing carries over, so it isn't read as the person's here.
    Object.assign(v, { space: see.space, key: see.key, decided: false, entry: see.shown });
  }
  if (v.pending) {
    if (see.shown !== v.pending.want && see.now < v.pending.until) return out;
    v.pending = null;
    v.expected = see.shown;
    if (!v.decided) v.entry = see.shown;   // undecided here: what the person may toggle starts now
  }
  if (!v.decided) {
    if (see.shown !== v.entry) {
      // Toggled by the person before we decided anything here.
      Object.assign(v, { decided: true, expected: see.shown });
      out.remember = see.shown;
      return out;
    }
    let want;
    if (see.pref) want = see.pref === "shown";
    else if (see.known) want = see.known !== "none";
    else return out;   // the first load here decides
    Object.assign(v, { decided: true, expected: want });
    if (want !== see.shown) {
      v.pending = { want, until: see.now + PENDING_MS };
      out.apply = want;
    }
    return out;
  }
  if (see.shown !== v.expected) {
    v.expected = see.shown;
    out.remember = see.shown;
  }
  return out;
}

/**
 * The shared decision maker. `store`: { get(): prefs | null, set(prefs) }, where
 * prefs maps a space id to "shown" | "hidden" (main.js: the app's shared state).
 */
export class Brain {
  constructor(store, now = Date.now()) {
    this.store = store;
    this.v = initial();
    // A new brain (the mod started or reloaded) may find the last build's show/hide still
    // landing: nothing counts as the person's choice until it would have landed.
    this.v.pending = { want: null, until: now + PENDING_MS };
    this.at = { key: undefined, since: 0 };
  }

  prefs() {
    const p = this.store.get();
    return p && typeof p === "object" && !Array.isArray(p) ? p : {};
  }

  remember(space, shown) {
    const p = { ...this.prefs() };
    delete p[space];
    p[space] = shown ? "shown" : "hidden";
    const keys = Object.keys(p);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_PREFS))) delete p[k];
    this.store.set(p);
  }

  /** Forgets the choices for these spaces (development and tests). */
  forget(spaces) {
    const p = { ...this.prefs() };
    for (const s of spaces) delete p[s];
    this.store.set(p);
  }

  /**
   * One step, from any copy. see: { space, key, shown, loaded, now }, all as the
   * window is now; loaded: the newest finished load of `key`, { at, state }, or null.
   * Returns { apply?: boolean }: show (true) or hide (false) the column.
   */
  sync(see) {
    if (see.key !== this.at.key) this.at = { key: see.key, since: see.now };
    const loaded = see.loaded;
    const known = loaded && loaded.at >= this.at.since - JOIN_MS ? loaded.state : null;
    const out = step(this.v, { space: see.space, key: see.key, shown: see.shown, pref: this.prefs()[see.space], known, now: see.now });
    if (out.remember !== undefined) this.remember(see.space, out.remember);
    return out.apply === undefined ? {} : { apply: out.apply };
  }

  /** The person clicked the GSD button: the other state, as their choice for this space. */
  click(see) {
    const want = !see.shown;
    this.remember(see.space, want);
    if (see.key !== this.at.key) this.at = { key: see.key, since: see.now };
    Object.assign(this.v, { space: see.space, key: see.key, decided: true, expected: want, entry: want,
      pending: { want, until: see.now + PENDING_MS } });
    return { apply: want };
  }
}
