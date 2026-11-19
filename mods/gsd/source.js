// Where the panel's data comes from. The functions below are THE switch points
// between the fixtures in mock.js and the real data layer in data.js.
import { exec, readTextFile, checking } from "herdr";
import { mockSnapshot, mockPhaseDetail, mockTodoDetail } from "./mock.js";
import { locate, loadGsd } from "./data.js";
import * as data from "./data.js";   // the detail loaders, once data.js exports them

// The focused space's folder and machine, per the data layer's contract.
export { locate };

// ─── SWITCH POINTS ───────────────────────────────────────────────────────────
// Real data: `loadGsd(loc, io)`, `loadPhaseDetail(ctx, phase, io)`,
// `loadTodoDetail(ctx, todo, io)` from data.js, io = { exec, readTextFile }
// (none of them throws). Fixtures only for development: `herdr-app check`
// (which must not run programs) and a dev.json beside main.js with
// {"mock": "<fixture name>"} (everything) or {"detail": "mock" | "<fixture name>"} (details only).
export async function fetchSnapshot(loc, dev) {
  if (dev?.mock || checking()) return mockSnapshot(dev?.mock ?? "rich");
  return loadGsd({ cwd: loc.cwd, on: loc.on ?? null }, { exec, readTextFile });
}

const mocked = (dev) => dev?.mock || dev?.detail || checking();
const fixture = (dev) => (dev?.detail && dev.detail !== "mock" ? dev.detail : undefined);
const missing = (what) => `The data layer has no ${what} yet`;
// Development: {"probe": true} runs one short, recognisable process per fixture load, as the
// real loaders run one exec, so loads can be counted from outside (`ps`).
const probe = (dev, what) => (dev?.probe && !checking() ? exec("sh", ["-c", "sleep 0.3", "gsd-detail-probe", what]).catch(() => null) : null);

/** ctx: { root, on }: the snapshot's root and the space's machine. */
export async function fetchPhaseDetail(ctx, phase, dev) {
  if (mocked(dev)) { await probe(dev, `phase-${phase.id}`); return mockPhaseDetail(phase, fixture(dev)); }
  if (typeof data.loadPhaseDetail !== "function") return { ...mockPhaseDetail(phase, "minimal"), state: "error", error: missing("loadPhaseDetail") };
  return data.loadPhaseDetail({ root: ctx.root, on: ctx.on ?? null }, phase, { exec, readTextFile });
}

export async function fetchTodoDetail(ctx, todo, dev) {
  if (mocked(dev)) { await probe(dev, `todo-${todo.file}`); return mockTodoDetail(todo, fixture(dev)); }
  if (typeof data.loadTodoDetail !== "function") return { ...mockTodoDetail(todo, "empty"), state: "error", error: missing("loadTodoDetail") };
  return data.loadTodoDetail({ root: ctx.root, on: ctx.on ?? null }, todo, { exec, readTextFile });
}
