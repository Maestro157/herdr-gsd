// Failure handling with a fake `io`: loadGsd must never throw and must turn
// every failure into a Snapshot with state "error" (or "none").
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGsd, interpret, buildSnapshot } from "../../mods/gsd/data.js";

// A fake io whose exec answers with whatever `respond(nonce, args)` returns.
function fakeIo(respond) {
  const calls = [];
  return {
    calls,
    async exec(cmd, args, opts) {
      calls.push({ cmd, args, opts });
      const nonce = args[4];
      return respond(nonce, args, opts);
    },
    async readTextFile() { return null; },
  };
}
const ok = (stdout, stderr = "") => ({ code: 0, stdout, stderr });
const header = (n, root = "/srv/app", via = 0) => `@@gsd:${n} root ${root}\n@@gsd:${n} via ${via}\n@@gsd:${n} node /usr/bin/node\n@@gsd:${n} driver\n`;

const TOOLS = [
  { path: "/h/.claude/gsd-core/bin/gsd-tools.cjs", version: "1.21.0", label: "gsd-core 1.21.0 (~/.claude)" },
  { path: "/h/.codex/gsd-core/bin/gsd-tools.cjs", version: "1.8.0", label: "gsd-core 1.8.0 (~/.codex)" },
];
const roadmap = (over = {}) => ({
  error: null, scope: "complete", progress_scope: "complete", milestones: [{ heading: "v1.2 Billing", version: "v1.2" }],
  phases: [
    { number: "1", name: "Invoices", goal: "Send invoices", plan_count: 2, summary_count: 2, disk_status: "executed", roadmap_complete: true },
    { number: "2", name: "Dunning", goal: null, plan_count: 3, summary_count: 1, disk_status: "partial", roadmap_complete: false },
  ],
  phase_count: 2, completed_phases: 0, total_plans: 5, total_summaries: 3, progress_percent: 60, current_phase: "1", next_phase: null, ...over,
});
const driverOut = (over = {}) => JSON.stringify({
  driver: 1, node: "v20.0.0", tools: TOOLS,
  results: {
    roadmap: { ok: true, tool: 0, ms: 5, data: roadmap(), failures: [] },
    state: { ok: true, tool: 0, ms: 5, data: { current_phase: "2", current_phase_name: "Dunning", status: "executing" }, failures: [] },
    todos: { ok: true, tool: 0, ms: 5, data: { count: 0, todos: [] }, failures: [] },
  },
  files: { state: "---\nmilestone: v1.2\nmilestone_name: Billing\n---\n\n## Current Position\n\nPlan: 2 of 3\n", milestones: null, phaseDirs: ["01-invoices", "02-dunning"] },
  ...over,
});

function assertSnapshotShape(s) {
  for (const k of ["state", "error", "root", "planningRoot", "viaWorktree", "project", "milestone", "progress", "position", "phases", "todos", "shipped", "warnings", "loadedAt"])
    assert.ok(k in s, `missing ${k}`);
  assert.ok(["ok", "none", "error"].includes(s.state));
  assert.equal(typeof s.milestone.label, "string");
  assert.ok(s.milestone.label.length > 0);
  assert.ok(Array.isArray(s.phases) && Array.isArray(s.todos) && Array.isArray(s.shipped) && Array.isArray(s.warnings));
  assert.equal(typeof s.loadedAt, "number");
  if (s.state === "error") { assert.equal(typeof s.error, "string"); assert.ok(s.error.length > 0 && s.error.length <= 300); }
  else assert.equal(s.error, null);
}

test("happy path through a fake io: one exec, contract shape", async () => {
  const io = fakeIo((n) => ok(header(n) + driverOut()));
  const s = await loadGsd({ cwd: "/srv/app/src", on: "vps" }, io);
  assertSnapshotShape(s);
  assert.equal(io.calls.length, 1, "one round-trip per load");
  assert.equal(io.calls[0].cmd, "sh");
  assert.equal(io.calls[0].args[0], "-c");
  assert.equal(io.calls[0].args[3], "/srv/app/src", "the folder travels as a positional argument");
  assert.equal(io.calls[0].opts.on, "vps");
  assert.equal(s.state, "ok");
  assert.equal(s.project, "app");
  assert.equal(s.planningRoot, "/srv/app/.planning");
  assert.equal(s.milestone.label, "v1.2 Billing");
  assert.deepEqual(s.position, { phase: "2", plan: "2 of 3", status: "executing", phaseName: "Dunning" });
  assert.deepEqual(s.phases.map((p) => [p.id, p.status, p.current, p.dir]), [["1", "done", false, "01-invoices"], ["2", "executing", true, "02-dunning"]]);
  assert.deepEqual(s.progress, { phases: { completed: 1, total: 2, percent: 50, verified: 0 }, plans: { completed: 3, total: 5, percent: 60 } });
});

test("exec rejects (timeout / unreachable / cannot start) → error naming the machine", async () => {
  const io = { async exec() { throw new Error("connection to vps timed out\nmore detail"); }, async readTextFile() { return null; } };
  const s = await loadGsd({ cwd: "/x", on: "vps" }, io);
  assertSnapshotShape(s);
  assert.equal(s.state, "error");
  assert.equal(s.error, "Could not run on vps: connection to vps timed out");
  const local = await loadGsd({ cwd: "/x", on: null }, io);
  assert.match(local.error, /this computer/);
});

test("exec throws synchronously, io missing, loc missing → still a Snapshot", async () => {
  const sync = { exec() { throw new TypeError("boom"); }, readTextFile() { return null; } };
  assert.equal((await loadGsd({ cwd: "/x" }, sync)).state, "error");
  const noIo = await loadGsd({ cwd: "/x" }, undefined);
  assertSnapshotShape(noIo);
  assert.equal(noIo.state, "error");
  assert.equal((await loadGsd(null, sync)).state, "none");
  assert.equal((await loadGsd({ cwd: "" }, sync)).state, "none");
});

test("script outcomes: nocwd, none, nonode, notools", async () => {
  const run = (body) => loadGsd({ cwd: "/x", on: "vps" }, fakeIo((n) => ok(body(n))));
  const nocwd = await run((n) => `@@gsd:${n} nocwd\n`);
  assert.equal(nocwd.state, "error");
  assert.equal(nocwd.error, "Folder not found on vps");
  const none = await run((n) => `@@gsd:${n} none\n`);
  assertSnapshotShape(none);
  assert.equal(none.state, "none");
  assert.equal(none.root, null);
  const nonode = await run((n) => `@@gsd:${n} root /srv/app\n@@gsd:${n} via 0\n@@gsd:${n} nonode\n`);
  assert.equal(nonode.state, "error");
  assert.equal(nonode.error, "Node.js not found on vps");
  assert.equal(nonode.root, "/srv/app", "the project is still named");
  const notools = await run((n) => `@@gsd:${n} root /srv/app\n@@gsd:${n} via 1\n@@gsd:${n} notools\n`);
  assert.equal(notools.error, "gsd-tools not found on vps");
  assert.equal(notools.viaWorktree, true);
});

test("garbage, empty output, non-zero exit, spoofed markers", async () => {
  const s1 = await loadGsd({ cwd: "/x" }, fakeIo(() => ({ code: 127, stdout: "", stderr: "sh: 1: git: Permission denied\n" })));
  assert.equal(s1.state, "error");
  assert.equal(s1.error, "Planning lookup failed on this computer: sh: 1: git: Permission denied");
  const s2 = await loadGsd({ cwd: "/x" }, fakeIo(() => ({ code: 2, stdout: "", stderr: "" })));
  assert.equal(s2.error, "Planning lookup failed on this computer (exit 2)");
  const spoof = await loadGsd({ cwd: "/x" }, fakeIo(() => ok("@@gsd:WRONG none\n")));
  assert.equal(spoof.state, "error", "markers without this load's nonce are ignored");
  const noJson = await loadGsd({ cwd: "/x" }, fakeIo((n) => ({ code: 1, stdout: header(n) + "<html>", stderr: "SyntaxError: Unexpected token '.'\n" })));
  assert.equal(noJson.state, "error");
  assert.equal(noJson.error, "gsd-tools query failed on this computer: SyntaxError: Unexpected token '.'");
  assert.equal(noJson.root, "/srv/app");
  const noDriver = await loadGsd({ cwd: "/x" }, fakeIo((n) => ok(`@@gsd:${n} root /srv/app\n@@gsd:${n} via 0\n`)));
  assert.equal(noDriver.state, "error");
  assert.match(noDriver.error, /did not run/);
  const arrayJson = await loadGsd({ cwd: "/x" }, fakeIo((n) => ok(header(n) + "[1,2]")));
  assertSnapshotShape(arrayJson);
});

test("roadmap analyze failed on every install → error with gsd-tools' reason (path shortened)", () => {
  const d = JSON.parse(driverOut());
  d.results.roadmap = { ok: false, failures: [
    { tool: 0, error: 'Verification report "/srv/app/.planning/phases/09.1-x/09.1-VERIFICATION.md" has status "pending", which is outside the closed set. Recovery: set it.' },
    { tool: 1, error: "Unknown command: roadmap" },
  ] };
  const s = interpret(ok(header("n") + JSON.stringify(d)), "n", "vps");
  assertSnapshotShape(s);
  assert.equal(s.state, "error");
  assert.equal(s.error, 'gsd-tools failed: Verification report "09.1-VERIFICATION.md" has status "pending", which is outside the closed set');
});

test("a later install answered → ok, with a warning naming both installs", () => {
  const d = JSON.parse(driverOut());
  d.results.roadmap.tool = 1;
  d.results.roadmap.failures = [{ tool: 0, error: "Error-ish: boom" }];
  const s = interpret(ok(header("n") + JSON.stringify(d)), "n", "vps");
  assert.equal(s.state, "ok");
  assert.equal(s.source.version, "1.8.0");
  assert.deepEqual(s.warnings, ["roadmap analyze failed with gsd-core 1.21.0 (~/.claude): Error-ish: boom — used gsd-core 1.8.0 (~/.codex)"]);
});

test("state-snapshot / list-todos failing everywhere are warnings, not errors", () => {
  const d = JSON.parse(driverOut());
  d.results.state = { ok: false, failures: [{ tool: 0, error: "STATE.md unreadable" }] };
  d.results.todos = { ok: false, failures: [{ tool: 0, error: "timed out" }] };
  const s = interpret(ok(header("n") + JSON.stringify(d)), "n", "here");
  assert.equal(s.state, "ok");
  assert.deepEqual(s.warnings, ["state-snapshot failed: STATE.md unreadable", "list-todos failed: timed out"]);
  assert.equal(s.position.phase, null, "no frontmatter current_phase either");
  assert.equal(s.position.plan, "2 of 3", "STATE excerpt still read by the driver");
  assert.deepEqual(s.todos, []);
});

test("missing and extra fields: odd roadmap shapes never throw", () => {
  const shapes = [
    {}, { phases: null }, { phases: "x" }, { phases: [null, 1, "a", { number: null }, { number: 3 }] },
    { error: "ROADMAP.md not found", phases: [] }, { phases: [], progress_percent: "NaN", total_plans: -4, extra: { deep: true } },
    { phases: [{ number: 7, name: "", goal: 42, plan_count: "2", summary_count: null, disk_status: 5, roadmap_complete: "yes" }] },
  ];
  for (const R of shapes) {
    const d = JSON.parse(driverOut());
    d.results.roadmap.data = R;
    const s = interpret(ok(header("n") + JSON.stringify(d)), "n", "here");
    assertSnapshotShape(s);
    assert.equal(s.state, "ok", JSON.stringify(R));
    for (const p of s.phases) {
      assert.equal(typeof p.id, "string");
      assert.equal(typeof p.name, "string");
      assert.equal(typeof p.dir, "string");
      assert.ok(["done", "executing", "planned", "not_started"].includes(p.status));
      assert.ok(Number.isInteger(p.plans) && Number.isInteger(p.summaries));
    }
  }
  const d = JSON.parse(driverOut());
  d.results.roadmap.data = { phases: [{ number: 7, name: "", plan_count: "2", summary_count: null }] };
  const s = interpret(ok(header("n") + JSON.stringify(d)), "n", "here");
  assert.deepEqual(s.phases.map((p) => [p.id, p.name, p.plans, p.summaries, p.status]), [["7", "Phase 7", 2, 0, "planned"]]);
  const none = JSON.parse(driverOut());
  none.results.roadmap.data = { error: "ROADMAP.md not found", phases: [] };
  const sn = interpret(ok(header("n") + JSON.stringify(none)), "n", "here");
  assert.deepEqual(sn.warnings, ["No ROADMAP.md in .planning — no phases to show"]);
  assert.equal(sn.progress.phases.percent, null);
  assert.equal(sn.progress.plans.percent, null);
});

test("null percents stay null; best-effort scope is flagged", () => {
  const d = JSON.parse(driverOut());
  d.results.roadmap.data = roadmap({ progress_percent: null, progress_scope: "unscoped", scope: "truncated" });
  const s = interpret(ok(header("n") + JSON.stringify(d)), "n", "here");
  assert.equal(s.progress.plans.percent, null);
  assert.equal(s.progress.phases.percent, null);
  assert.equal(s.progress.plans.completed, 3);
  assert.deepEqual(s.warnings, [
    'ROADMAP milestone window is "truncated": the phase list is best-effort',
    "No plan percentage: GSD cannot tell which phase folders belong to the current milestone",
  ]);
  const old = JSON.parse(driverOut());
  old.results.roadmap.data = roadmap({ progress_percent: undefined, scope: undefined, progress_scope: undefined });
  const so = interpret(ok(header("n") + JSON.stringify(old)), "n", "here");
  assert.equal(so.progress.plans.percent, 60, "older gsd-tools without the field: computed like gsd-tools");
  assert.equal(so.progress.phases.percent, 50);
  assert.equal(so.progress.phases.verified, null, "older gsd-tools' completed_phases counts unverified phases");
  assert.equal(s.progress.phases.verified, 0, "a scoped answer keeps its verified count");
});

const snap = (over = {}, mutate = () => {}) => {
  const d = JSON.parse(driverOut());
  d.results.roadmap.data = roadmap(over);
  mutate(d);
  return interpret(ok(header("n") + JSON.stringify(d)), "n", "here");
};

test("plans: completed, total and percent come from one source", () => {
  const s = snap({ total_plans: 10, total_summaries: 4, progress_percent: 92 });
  assert.deepEqual(s.progress.plans, { completed: 4, total: 10, percent: 40 }, "not gsd-tools' 92 from another phase set");
  assert.deepEqual(snap({ total_plans: 10, total_summaries: 4, progress_percent: null, progress_scope: "unscoped" }).progress.plans,
    { completed: 4, total: 10, percent: null }, "a withheld percentage stays null");
  assert.equal(snap({ total_plans: 3, total_summaries: 5 }).progress.plans.percent, 100);
});

test("unreadable ROADMAP phases make both percentages unknown, not zero", () => {
  const s = snap({ phases: [], phase_count: 0, total_plans: 0, total_summaries: 0, progress_percent: 0, missing_phase_details: ["1", "2", "3"] });
  assert.equal(s.progress.phases.percent, null);
  assert.equal(s.progress.plans.percent, null);
  assert.match(s.warnings.join("|"), /lists phases 1, 2, 3 without/);
  const partial = snap({ missing_phase_details: ["3"] });
  assert.equal(partial.progress.phases.percent, null, "some phases unreadable: the readable ones are not the whole milestone");
  assert.equal(snap().progress.phases.percent, 50, "all readable: a number");
});

test("plan-percentage warning: only when there is something to count, in plain words", () => {
  const empty = snap({ phases: [], total_plans: 0, total_summaries: 0, progress_percent: null, progress_scope: "unscoped" });
  assert.deepEqual(empty.warnings, []);
  assert.equal(empty.progress.plans.percent, null);
  const some = snap({ progress_percent: null, progress_scope: "unscoped" });
  assert.deepEqual(some.warnings, ["No plan percentage: GSD cannot tell which phase folders belong to the current milestone"]);
  assert.doesNotMatch(some.warnings[0], /scope|gsd-tools/);
});

test("milestone label: \"No roadmap\" without ROADMAP.md, \"Roadmap\" without a milestone", () => {
  const none = (roadmapOver) => snap(roadmapOver, (d) => { d.files.state = null; d.results.state.data = {}; }).milestone.label;
  assert.equal(none({ error: "ROADMAP.md not found", milestones: [], phases: [] }), "No roadmap");
  assert.equal(none({ milestones: [] }), "Roadmap");
  assert.equal(snap({ error: "ROADMAP.md not found", milestones: [], phases: [] }).milestone.label, "v1.2 Billing", "STATE.md's milestone still wins");
});

test("position.phaseName: the ROADMAP name when the current phase is listed, STATE.md's otherwise", () => {
  const withState = (stateData, over) => snap(over, (d) => { d.results.state.data = stateData; }).position.phaseName;
  assert.equal(withState({ current_phase: "2", current_phase_name: "EXECUTED, awaiting UAT", status: "verifying" }), "Dunning");
  assert.equal(withState({ current_phase: "9", current_phase_name: "Old work", status: "verifying" }), "Old work", "not in the list");
  assert.equal(withState({ current_phase: "02", current_phase_name: "x" }), "Dunning", "09 and 9 are one phase");
  const synthesized = { phases: [{ number: "2", name: "Phase 2", plan_count: 1, summary_count: 0 }] };
  assert.equal(withState({ current_phase: "2", current_phase_name: "Real name" }, synthesized), "Real name", "a placeholder name does not win");
  assert.equal(withState({ status: "executing" }), null, "no current phase, no name");
});

test("position.status: a bare snake_case word gets spaces, everything else stays as written", () => {
  const status = (v) => snap({}, (d) => { d.results.state.data = { status: v }; d.files.state = null; }).position.status;
  assert.equal(status("awaiting_next_milestone"), "awaiting next milestone");
  assert.equal(status("in_progress"), "in progress");
  for (const v of ["executing", "Ready_to_plan", "Phase 3 done: see foo_bar", "phase_complete — verify", "EXECUTING_NOW"]) assert.equal(status(v), v);
});

test("names from ROADMAP.md lose inline markdown, keep snake_case and emoji", () => {
  const s = snap({
    milestones: [{ heading: "v1.2 **Billing** `core` — 🚧 IN PROGRESS", version: "v1.2" }],
    phases: [
      { number: "1", name: "**Wire** `acme_router` into _the_ [proxy](https://example.com/x) 🚀", plan_count: 1, summary_count: 1 },
      { number: "2", name: "__init__ cleanup for snake_case_ids", plan_count: 1, summary_count: 0 },
    ],
  }, (d) => { d.files.state = "---\nmilestone: v1.2\n---\n"; d.results.state.data = { current_phase: "1", current_phase_name: "x" }; });
  assert.deepEqual(s.phases.map((p) => p.name), ["Wire acme_router into the proxy 🚀", "init cleanup for snake_case_ids"]);
  assert.equal(s.milestone.label, "v1.2 Billing core");
  assert.equal(s.position.phaseName, "Wire acme_router into the proxy 🚀");
});

test("a legacy get-shit-done answer is flagged", () => {
  const s = snap({}, (d) => { d.tools = [{ path: "/h/.gemini/get-shit-done/bin/gsd-tools.cjs", version: "1.30.0", label: "get-shit-done 1.30.0 (~/.gemini)" }]; });
  assert.equal(s.state, "ok");
  assert.deepEqual(s.warnings, ["No gsd-core install found: these numbers come from the legacy get-shit-done 1.30.0 (~/.gemini) and may be incomplete"]);
  assert.deepEqual(snap().warnings, [], "gsd-core answers carry no such warning");
});

test("the driver's root wins over a marker line cut short by a newline in the folder name", () => {
  const d = JSON.parse(driverOut());
  d.root = "/srv/new\nline app";
  const s = interpret(ok(header("n", "/srv/new") + JSON.stringify(d)), "n", "here");
  assert.equal(s.state, "ok");
  assert.equal(s.root, "/srv/new\nline app");
  assert.equal(s.planningRoot, "/srv/new\nline app/.planning");
  assert.equal(s.project, "new\nline app");
});

test("milestone label fallbacks", () => {
  const label = (files, roadmapOver = {}, state = {}) => {
    const d = JSON.parse(driverOut());
    d.files.state = files;
    d.results.roadmap.data = roadmap(roadmapOver);
    d.results.state.data = state;
    return interpret(ok(header("n") + JSON.stringify(d)), "n", "here").milestone;
  };
  assert.deepEqual(label("---\nmilestone: v3.1\nmilestone_name: Secure Charts\n---\n"), { version: "v3.1", name: "Secure Charts", label: "v3.1 Secure Charts" });
  assert.deepEqual(label("---\nmilestone: v1.2\n---\n"), { version: "v1.2", name: "Billing", label: "v1.2 Billing" }, "name from the ROADMAP heading");
  assert.deepEqual(label(null), { version: "v1.2", name: "Billing", label: "v1.2 Billing" });
  assert.deepEqual(label("---\nmilestone: none\nmilestone_name: null\n---\n", { milestones: [] }), { version: null, name: null, label: "Roadmap" });
  assert.deepEqual(label("---\nmilestone: v1.0\n---\n", { milestones: [] }), { version: "v1.0", name: null, label: "v1.0" });
  assert.deepEqual(label("---\nmilestone: v2.4\nmilestone_name: Adopt X (Phases 132-143) — IN PROGRESS\n---\n"), { version: "v2.4", name: "Adopt X", label: "v2.4 Adopt X" });
});

test("buildSnapshot never trusts the driver blindly", () => {
  const base = () => ({ state: "ok", error: null, root: "/r", planningRoot: "/r/.planning", viaWorktree: false, project: "r",
    milestone: { version: null, name: null, label: "Roadmap" }, progress: {}, position: {}, phases: [], todos: [], shipped: [], warnings: [], loadedAt: 0 });
  for (const d of [{}, { results: null }, { results: { roadmap: { ok: true } } }, { results: { roadmap: { ok: true, data: null } }, files: null }]) {
    const s = buildSnapshot(base(), d);
    assert.ok(["ok", "error"].includes(s.state));
    assert.ok(Array.isArray(s.phases));
  }
});

test("checklist phases gsd-tools could not read are named in a warning", () => {
  const d = JSON.parse(driverOut());
  d.results.roadmap.data = roadmap({ phases: [], missing_phase_details: ["1", "2", "3", "4", "5", "6", "7", "8"] });
  const s = interpret(ok(header("n") + JSON.stringify(d)), "n", "here");
  assert.deepEqual(s.warnings, ['ROADMAP.md lists phases 1, 2, 3, 4, 5, 6, … without a "### Phase N: Name" section gsd-tools can read']);
  const synthesized = JSON.parse(driverOut());
  synthesized.results.roadmap.data = roadmap({ missing_phase_details: ["01", "2"] });
  assert.deepEqual(interpret(ok(header("n") + JSON.stringify(synthesized)), "n", "here").warnings, [], "phases gsd-tools synthesised from the checklist are not missing");
});
