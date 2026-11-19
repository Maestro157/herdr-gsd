// node test/ui/visibility.test.mjs — the GSD column's per-space show/hide
// (gsd/visibility.js: the Brain every copy of the mod shares) against a
// simulated window: our layout.show/hide lands after a lag, a folder's load
// finishes when the test says so, the person can toggle the column at any time
// or click the GSD button, and one or more copies (the tab-bar button, the
// column) feed the brain on every tick.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Brain, PENDING_MS, JOIN_MS } from "../../mods/gsd/visibility.js";

class World {
  constructor({ hidden = true, lag = 300, callers = ["button", "column"] } = {}) {
    this.folders = { A: "/gsd-a", B: "/plain-b", C: "/gsd-c" };
    this.states = { "/gsd-a": "ok", "/plain-b": "none", "/gsd-c": "ok", "/plain-a2": "none", "/err": "error" };
    this.space = "A"; this.hidden = hidden; this.lag = lag; this.callers = callers;
    this.prefs = {}; this.now = 1000; this.queue = []; this.loads = {}; this.applied = []; this.writes = 0;
    this.brain = new Brain({ get: () => this.prefs, set: (p) => { this.prefs = p; this.writes++; } }, this.now - PENDING_MS);   // running for a while
  }
  get shown() { return !this.hidden; }
  get key() { return this.folders[this.space]; }
  see() { return { space: this.space, key: this.key, shown: !this.hidden, loaded: this.loads[this.key] ?? null, now: this.now }; }
  apply(want) { this.applied.push(want); this.queue.push({ want, at: this.now + this.lag }); }
  tick(ms = 100) {
    this.now += ms;
    this.queue = this.queue.filter((q) => (q.at <= this.now ? ((this.hidden = !q.want), false) : true));
    for (const _ of this.callers) {
      const out = this.brain.sync(this.see());
      if (out.apply !== undefined) this.apply(out.apply);
    }
  }
  wait(ms) { for (let t = 0; t < ms; t += 100) this.tick(100); }
  load() { this.loads[this.key] = { at: this.now, state: this.states[this.key] }; }
  goto(space) { this.space = space; this.wait(200); this.load(); this.wait(800); }
  user(show) { this.hidden = !show; this.wait(300); }                    // a key bound to layout.toggle:gsd, a drag
  click() { this.apply(this.brain.click(this.see()).apply); this.wait(300); }   // the GSD button
}

const cases = {
  "GSD space shows the hidden column once its load finishes"() {
    const w = new World({ hidden: true });
    w.wait(500);
    assert.equal(w.shown, false, "waits for the load before deciding");
    w.load(); w.wait(800);
    assert.equal(w.shown, true);
    assert.deepEqual(w.prefs, {}, "our own change is not the person's choice");
  },
  "non-GSD space hides it, GSD space shows it again"() {
    const w = new World({ hidden: false });
    w.load(); w.wait(500);
    assert.equal(w.shown, true);
    w.goto("B"); assert.equal(w.shown, false);
    w.goto("A"); assert.equal(w.shown, true);
    assert.deepEqual(w.prefs, {});
  },
  "column never started: the button alone decides, also after a reload with the column hidden"() {
    const w = new World({ hidden: true, callers: ["button"] });
    w.space = "B"; w.load(); w.wait(1000);
    assert.equal(w.shown, false, "plain space: stays hidden");
    w.brain = new Brain({ get: () => w.prefs, set: (p) => { w.prefs = p; } }, w.now);   // a fresh start (Herdr or the mod restarted)
    w.wait(PENDING_MS + 100);                       // a new brain reads nothing as a choice until then
    w.goto("A");
    assert.equal(w.shown, true, "GSD space: shown by the button's copy alone");
    assert.deepEqual(w.prefs, {});
  },
  "a click on the button is the person's choice for that space"() {
    const w = new World({ hidden: false });
    w.load(); w.wait(500);
    w.click();
    assert.equal(w.shown, false);
    assert.deepEqual(w.prefs, { A: "hidden" });
    assert.equal(w.writes, 1, "remembered once, the landing of the click is not a second choice");
    w.goto("C"); assert.equal(w.shown, true, "another GSD space still shows it");
    w.goto("A"); w.wait(3000);
    assert.equal(w.shown, false, "never reopened for A");
    w.click();
    assert.equal(w.shown, true);
    assert.deepEqual(w.prefs, { A: "shown" });
  },
  "a click on a plain space keeps the column open there"() {
    const w = new World({ hidden: false });
    w.load(); w.wait(500);
    w.goto("B"); assert.equal(w.shown, false);
    w.click();
    assert.equal(w.shown, true);
    assert.deepEqual(w.prefs, { B: "shown" });
    w.goto("A"); w.goto("B"); w.wait(2000);
    assert.equal(w.shown, true, "still open on B when coming back");
  },
  "a click while our own change is landing acts on what the person sees, and is theirs"() {
    const w = new World({ hidden: false, lag: 600 });
    w.load(); w.wait(300);
    w.space = "B"; w.wait(100); w.load(); w.wait(100);   // B decides to hide; lands in 600 ms
    assert.deepEqual(w.applied, [false]);
    w.click();                                         // still drawn open: the click closes it
    w.wait(2000);
    assert.equal(w.shown, false);
    assert.deepEqual(w.prefs, { B: "hidden" });
    w.click();                                         // and the next click opens it, for good
    w.goto("A"); w.goto("B"); w.wait(2000);
    assert.equal(w.shown, true);
    assert.deepEqual(w.prefs, { B: "shown" });
  },
  "an outside toggle (a key bound to layout.toggle:gsd) is the person's choice too"() {
    const w = new World({ hidden: false });
    w.load(); w.wait(500);
    w.user(false);
    assert.deepEqual(w.prefs, { A: "hidden" });
    w.goto("B"); w.goto("C"); assert.equal(w.shown, true);
    w.goto("A"); w.wait(3000);
    assert.equal(w.shown, false, "never reopened for A");
  },
  "a column the person opens on a non-GSD space stays open there"() {
    const w = new World({ hidden: false });
    w.load(); w.wait(500);
    w.goto("B"); assert.equal(w.shown, false);
    w.user(true);
    assert.equal(w.prefs.B, "shown");
    w.wait(3000); assert.equal(w.shown, true, "left open (quiet empty state)");
    w.goto("A"); assert.equal(w.shown, true);
    w.goto("B"); assert.equal(w.shown, true, "still open on B when coming back");
  },
  "our own pending change is never taken for the person's"() {
    const w = new World({ hidden: false, lag: 900 });   // slower than a tick, faster than PENDING_MS
    w.load(); w.wait(300);
    w.goto("B"); w.wait(PENDING_MS + 500);
    assert.equal(w.shown, false);
    assert.deepEqual(w.prefs, {});
  },
  "a toggle before the first load decides is the person's choice"() {
    const w = new World({ hidden: true });
    w.wait(300);
    w.user(true);                          // opened while we were still loading
    assert.equal(w.prefs.A, "shown");
    w.states["/gsd-a"] = "none"; w.load(); w.wait(1000);
    assert.equal(w.shown, true, "even a 'none' result doesn't close what they opened");
  },
  "a different folder in a space without a choice decides again"() {
    const w = new World({ hidden: true });
    w.load(); w.wait(800);
    assert.equal(w.shown, true);
    w.folders.A = "/plain-a2"; w.wait(200); w.load(); w.wait(800);
    assert.equal(w.shown, false, "cd into a folder without .planning hides it");
  },
  "a space with a choice ignores folder changes"() {
    const w = new World({ hidden: false });
    w.load(); w.wait(300); w.user(true); w.user(false); w.user(true);
    assert.equal(w.prefs.A, "shown");
    w.folders.A = "/plain-a2"; w.wait(200); w.load(); w.wait(800);
    assert.equal(w.shown, true);
  },
  "an error still shows the column, so the message can be read"() {
    const w = new World({ hidden: true });
    w.folders.A = "/err"; w.load(); w.wait(800);
    assert.equal(w.shown, true);
  },
  "a load from before the folder became the shown one doesn't decide"() {
    const w = new World({ hidden: true });
    w.loads["/gsd-a"] = { at: w.now - 60000, state: "none" };   // an old answer for A's folder
    w.wait(1000);
    assert.equal(w.applied.length, 0, "waits for a load of its own");
    w.load(); w.wait(800);
    assert.equal(w.shown, true);
    assert.ok(JOIN_MS > 0);
  },
  "our change still landing when the person moves on is not their choice for the next space"() {
    const w = new World({ hidden: false, lag: 300 });
    w.load(); w.wait(300);
    w.space = "B"; w.wait(100); w.load(); w.wait(100);     // B decides to hide; it lands in 300 ms
    assert.deepEqual(w.applied, [false]);
    w.space = "C"; w.wait(100);                            // moved on before it landed, C still loading
    w.wait(500); w.load(); w.wait(1000);
    assert.deepEqual(w.prefs, {}, "no fake choice for C");
    assert.equal(w.shown, true, "C has .planning: shown");
  },
  "fast switching with two copies feeding the brain: no fake choices, no fighting"() {
    for (const lag of [50, 250, 700]) {
      const w = new World({ hidden: false, lag });
      w.load(); w.wait(300);
      for (let i = 0; i < 12; i++) {
        w.space = ["B", "A", "C"][i % 3];
        w.wait(100); w.load(); w.wait(100);
      }
      w.wait(3000);
      const applies = w.applied.length;
      assert.equal(w.space, "C"); assert.equal(w.shown, true, `lag ${lag}: settles shown on a GSD space`);
      assert.deepEqual(w.prefs, {}, `lag ${lag}: no fake choices from quick switching`);
      assert.ok(applies <= 12, `lag ${lag}: at most one change per switch (${applies})`);
      assert.ok(w.applied.every((x, i) => i === 0 || x !== w.applied[i - 1]), `lag ${lag}: never the same change twice in a row`);
      w.wait(5000);
      assert.equal(w.applied.length, applies, `lag ${lag}: quiet once settled`);
    }
  },
  "a reloaded mod (a fresh brain, no loads yet) doesn't take the last build's change, still landing, for the person's"() {
    const w = new World({ hidden: true, lag: 600 });
    w.load(); w.wait(200);                       // decides to show; lands in 600 ms
    assert.deepEqual(w.applied, [true]);
    w.brain = new Brain({ get: () => w.prefs, set: (p) => { w.prefs = p; } }, w.now);   // the mod reloads
    w.loads = {};                                // the new module has loaded nothing yet
    w.wait(900); w.load(); w.wait(2000);
    assert.deepEqual(w.prefs, {}, "no fake choice");
    assert.equal(w.shown, true);
  },
  "two copies don't apply the same decision twice"() {
    const one = new World({ hidden: true, callers: ["button"] }), two = new World({ hidden: true, callers: ["button", "column"] });
    for (const w of [one, two]) { w.load(); w.wait(800); w.goto("B"); w.goto("A"); w.goto("C"); }
    assert.deepEqual(two.applied, one.applied);
  },
  "choices stay bounded"() {
    const w = new World({ hidden: false });
    for (let i = 0; i < 320; i++) w.brain.remember(`s${i}`, i % 2 === 0);
    assert.equal(Object.keys(w.prefs).length, 300);
    assert.equal(w.prefs.s319, "hidden"); assert.equal(w.prefs.s0, undefined);
  },
};

for (const [name, fn] of Object.entries(cases)) test(name, fn);
