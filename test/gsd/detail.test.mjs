// Click-through details: loadPhaseDetail (one exec, real gsd-tools on the
// synthetic "detail" fixture) and loadTodoDetail (readTextFile only), plus
// failure handling with fake io. Nothing under .planning/ may change.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, utimes, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  loadGsd, loadPhaseDetail, loadTodoDetail, buildPhaseDetail, parseDependsOn, parseRequirementIds, requirementInfo,
  sectionField, planTitle, parseTodoFile, PHASE_DRIVER,
} from "../../mods/gsd/data.js";
import { nodeIo, treeSnapshot, tempDir, copyFixture } from "./helpers.mjs";

const HOME = process.env.HOME ?? "";
const HAVE_TOOLS = [".claude/gsd-core", ".codex/gsd-core"].some((d) => existsSync(join(HOME, d, "bin/gsd-tools.cjs")))
  || (process.env.CLAUDE_CONFIG_DIR && existsSync(join(process.env.CLAUDE_CONFIG_DIR, "gsd-core/bin/gsd-tools.cjs")));
const T = { timeout: 60000, skip: HAVE_TOOLS ? false : "no gsd-core install found" };

let dir, root, snap;
const io = nodeIo();
before(async () => {
  if (!HAVE_TOOLS) return;
  dir = await tempDir("gsd-detail-");
  root = await copyFixture("detail", dir);
  // Phase 2.1: 42 plans; 02.1-01 depends on 02.1-42, so it runs last (wave 2).
  const bulk = join(root, ".planning/phases/02.1-bulk-fixes");
  await mkdir(bulk, { recursive: true });
  for (let i = 1; i <= 42; i++) {
    const n = String(i).padStart(2, "0");
    const deps = i === 1 ? '["02.1-42"]' : "[]";
    await writeFile(join(bulk, `02.1-${n}-PLAN.md`), `---\nphase: 02.1\nplan: ${n}\nwave: ${i === 1 ? 2 : 1}\ndepends_on: ${deps}\n---\n\n<objective>\nFix item ${n}. Then check it.\n</objective>\n`);
    if (i <= 3) await writeFile(join(bulk, `02.1-${n}-SUMMARY.md`), "---\nstatus: complete\n---\nDone.\n");
  }
  // Fixed mtimes; the verification report is the newest file, so it is not stale.
  const t = new Date("2026-06-01T10:00:00Z");
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      await utimes(p, t, t);
    }
  }
  await walk(root);
  const later = new Date(t.getTime() + 120000);
  await utimes(join(root, ".planning/phases/01-ingest/01-VERIFICATION.md"), later, later);
  snap = await loadGsd({ cwd: root, on: null }, io);
});
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

const phase = (id) => snap.phases.find((p) => p.id === id);
const ctx = () => ({ root: snap.root, on: null });

function assertPhaseShape(d) {
  for (const k of ["state", "error", "id", "name", "status", "goal", "dependsOn", "requirements", "successCriteria", "plans", "verification", "uat", "warnings", "loadedAt"])
    assert.ok(k in d, `missing ${k}`);
  assert.ok(["ok", "error"].includes(d.state));
  assert.ok(["done", "executing", "planned", "not_started"].includes(d.status));
  assert.equal(typeof d.id, "string");
  assert.equal(typeof d.name, "string");
  for (const k of ["dependsOn", "requirements", "successCriteria", "plans", "warnings"]) assert.ok(Array.isArray(d[k]), k);
  for (const p of d.plans) {
    assert.equal(typeof p.id, "string");
    assert.ok(p.title === null || typeof p.title === "string");
    assert.ok(p.wave === null || typeof p.wave === "number");
    assert.equal(typeof p.done, "boolean");
  }
  for (const r of d.requirements) assert.ok(typeof r.id === "string" && (r.text === null || typeof r.text === "string") && (r.done === null || typeof r.done === "boolean"));
  if (d.state === "error") assert.ok(typeof d.error === "string" && d.error.length > 0 && d.error.length <= 300);
  else assert.equal(d.error, null);
}

test("phase with plans, verification and UAT: every field from GSD, nothing written", T, async () => {
  assert.equal(snap.state, "ok", snap.error);
  const before = await treeSnapshot(join(root, ".planning"));
  const d = await loadPhaseDetail(ctx(), phase("1"), io);
  assert.equal(await treeSnapshot(join(root, ".planning")), before, "nothing under .planning/ changed");
  assertPhaseShape(d);
  assert.equal(d.state, "ok", d.error);
  assert.equal(d.id, "1");
  assert.equal(d.name, "Ingest");
  assert.equal(d.status, "done");
  assert.equal(d.goal, "Bank statement files are imported without manual steps");
  assert.deepEqual(d.dependsOn, []);
  assert.deepEqual(d.requirements, [
    { id: "ING-01", text: "Import CSV files from the bank portal", done: true },
    { id: "ING-02", text: "Reject malformed files with a reason", done: false },
    { id: "ING-03", text: null, done: true },
  ], "the wrapped Requirements line is read whole; ING-03 only in the traceability table");
  assert.deepEqual(d.successCriteria, ["A CSV file from the bank appears as transactions within a minute", "A broken file is rejected with a clear message"]);
  assert.deepEqual(d.plans.map((p) => [p.id, p.title, p.wave, p.done]), [
    ["01-01", "Parse the bank's CSV export into transactions.", 1, true],
    ["01-02", "Upload endpoint for csv_import", 1, true],
  ], "frontmatter title when present, else the objective's first sentence");
  assert.equal(d.plans[0].file, ".planning/phases/01-ingest/01-01-PLAN.md");
  assert.deepEqual({ status: d.verification.status, detail: d.verification.detail }, { status: "passed", detail: "4/4 must-haves verified" });
  assert.deepEqual({ status: d.uat.status, detail: d.uat.detail, passed: d.uat.passed }, { status: "complete", detail: "2 pass, 1 issue", passed: false },
    "UAT's exit 1 (not passed) is an answer, not a failure");
  assert.deepEqual(d.warnings, []);
});

test("decimal phase with 42 plans: execution order by wave, counts, no verification, under a second or so", T, async () => {
  const t0 = Date.now();
  const d = await loadPhaseDetail(ctx(), phase("2.1"), io);
  const ms = Date.now() - t0;
  assertPhaseShape(d);
  assert.equal(d.state, "ok", d.error);
  assert.equal(d.name, "Bulk fixes");
  assert.equal(d.plans.length, 42);
  assert.equal(d.plans.filter((p) => p.done).length, 3);
  assert.equal(d.plans[0].id, "02.1-02");
  assert.equal(d.plans[41].id, "02.1-01", "02.1-01 waits for 02.1-42 (wave 2)");
  assert.equal(d.plans[41].wave, 2);
  assert.equal(d.plans[0].title, "Fix item 02.");
  assert.equal(d.status, "executing");
  assert.deepEqual(d.dependsOn, ["Phase 1", "Phase 2"]);
  assert.deepEqual(d.requirements, [], "TBD");
  assert.equal(d.verification, null);
  assert.equal(d.uat, null);
  assert.ok(ms < 5000, `took ${ms} ms`);
});

test("phase with a folder but no verification, and a phase with no folder yet", T, async () => {
  const two = await loadPhaseDetail(ctx(), phase("2"), io);
  assert.equal(two.state, "ok", two.error);
  assert.equal(two.status, "planned");
  assert.deepEqual(two.plans.map((p) => [p.id, p.done]), [["02-01", false]]);
  assert.equal(two.verification, null);
  // REV-01 is hard-wrapped over three lines in the fixture: the indented lines belong to it.
  assert.deepEqual(two.requirements, [{ id: "REV-01", text: "Approve or reject an import from the review queue, with the reviewer's name recorded", done: false }]);
  const three = phase("3");
  assert.equal(three.dir, "");
  const d = await loadPhaseDetail(ctx(), three, io);
  assertPhaseShape(d);
  assert.equal(d.state, "ok", d.error);
  assert.equal(d.name, "Export");
  assert.equal(d.goal, "Statements can be exported as PDF");
  assert.deepEqual(d.plans, []);
  assert.equal(d.status, "not_started");
  assert.deepEqual(d.dependsOn, ["Phase 2.1"]);
  assert.deepEqual(d.requirements, []);
  assert.equal(d.requirementsNote, "Covered by the export notes in CONTEXT.md, no IDs yet");
  assert.equal(d.verification, null);
  assert.deepEqual(d.warnings, []);
});

test("a phase ROADMAP.md does not describe: snapshot facts and a warning", T, async () => {
  const d = await loadPhaseDetail(ctx(), { id: "9", name: "Ghost", dir: "", status: "not_started" }, io);
  assert.equal(d.state, "ok");
  assert.equal(d.name, "Ghost");
  assert.deepEqual(d.warnings, ["ROADMAP.md has no section for phase 9"]);
});

test("todo with frontmatter: fields, files, body without the duplicate heading", T, async () => {
  const todo = snap.todos.find((t) => t.file.endsWith("2026-06-01-dedupe-imports.md"));
  const before = await treeSnapshot(join(root, ".planning"));
  const d = await loadTodoDetail(ctx(), todo, io);
  assert.equal(await treeSnapshot(join(root, ".planning")), before);
  assert.deepEqual(d, {
    state: "ok", error: null, title: "Dedupe repeated imports #12", area: "ingest", created: "2026-06-01T09:00:00.000Z", severity: "major",
    files: ["src/ingest/parser.ts:40-80", "src/ingest/upload.ts"], path: join(root, ".planning/todos/pending/2026-06-01-dedupe-imports.md"),
    body: "## Problem\n\nUploading the same file twice books every row twice.\n\n## Solution\n\nTBD", truncated: false,
    loadedAt: d.loadedAt, elapsedMs: d.elapsedMs,
  });
});

test("todo without frontmatter: heading as title (dropped from the body), **Created:** date", T, async () => {
  const todo = snap.todos.find((t) => t.file.endsWith("legacy-note.md"));
  const d = await loadTodoDetail(ctx(), todo, io);
  assert.equal(d.state, "ok", d.error);
  assert.equal(d.title, "Check the export fonts");
  assert.equal(d.created, "2026-05-20");
  assert.deepEqual(d.files, []);
  assert.equal(d.body, "**Created:** 2026-05-20\n\nThe PDF uses a fallback font on some systems.");
});

// ─── fake io ─────────────────────────────────────────────────────────────────

const PHASE = { id: "75.4", name: "Hardening", dir: "75.4-hardening", status: "executing", plans: 3, summaries: 1, current: true };

test("loadPhaseDetail never throws: rejection, timeout, garbage, bad input", async () => {
  const rejecting = (msg) => ({ async exec() { throw Object.assign(new Error(msg), { killed: /timed out/.test(msg) }); }, async readTextFile() { return null; } });
  for (const [msg, expected] of [["connection refused\nmore", "Could not run on vps: connection refused"], ["timed out after 60000 ms", "Could not run on vps: timed out after 60000 ms"]]) {
    const d = await loadPhaseDetail({ root: "/srv/app", on: "vps" }, PHASE, rejecting(msg));
    assertPhaseShape(d);
    assert.deepEqual([d.state, d.error, d.id, d.name, d.status], ["error", expected, "75.4", "Hardening", "executing"]);
  }
  const garbage = { async exec(cmd, args) { return { code: 0, stdout: `@@gsd:${args[4]} root /srv/app\n@@gsd:${args[4]} via 0\n@@gsd:${args[4]} driver\n<html>`, stderr: "" }; } };
  assert.match((await loadPhaseDetail({ root: "/srv/app", on: null }, PHASE, garbage)).error, /^gsd-tools query failed on this computer/);
  const moved = { async exec(cmd, args) { return { code: 0, stdout: `@@gsd:${args[4]} none\n`, stderr: "" }; } };
  assert.equal((await loadPhaseDetail({ root: "/srv/app", on: null }, PHASE, moved)).error, "No .planning folder in /srv/app any more");
  assert.equal((await loadPhaseDetail({ root: "/srv/app" }, { id: "-rf" }, garbage)).error, 'Phase "-rf" cannot be looked up');
  assert.equal((await loadPhaseDetail(null, PHASE, garbage)).error, "No phase selected");
  assert.equal((await loadPhaseDetail({ root: "/srv/app" }, PHASE, undefined)).state, "error");
  const sync = { exec() { throw new TypeError("boom"); } };
  assert.equal((await loadPhaseDetail({ root: "/srv/app" }, PHASE, sync)).state, "error");
});

test("loadPhaseDetail passes the phase as one JSON argument and runs one exec", async () => {
  const calls = [];
  const fake = { async exec(cmd, args, opts) { calls.push({ cmd, args, opts }); return { code: 0, stdout: "", stderr: "" }; } };
  await loadPhaseDetail({ root: "/srv/my app", on: "vps" }, { ...PHASE, dir: "../../etc" }, fake);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "sh");
  assert.equal(calls[0].args[3], "/srv/my app");
  assert.equal(calls[0].args[5], PHASE_DRIVER);
  assert.deepEqual(JSON.parse(calls[0].args[6]), { phase: "75.4", dir: "" }, "a dir that is not one folder name is dropped");
  assert.equal(calls[0].opts.on, "vps");
});

const base = () => ({ state: "ok", error: null, id: "75.4", name: "Hardening", status: "executing", goal: null, dependsOn: [], requirements: [],
  successCriteria: [], plans: [], verification: null, uat: null, warnings: [], loadedAt: 0 });
const TOOLS = [{ path: "/h/.claude/gsd-core/bin/gsd-tools.cjs", label: "gsd-core 1.21.0 (~/.claude)" }, { path: "/h/.codex/gsd-core/bin/gsd-tools.cjs", label: "gsd-core 1.8.0 (~/.codex)" }];

test("buildPhaseDetail: failed commands fall back to what the files say, with warnings", () => {
  const d = buildPhaseDetail(base(), {
    tools: TOOLS,
    results: {
      getphase: { ok: true, tool: 0, data: { found: true, phase_name: "Hardening `jobs`", goal: "Jobs run once", success_criteria: ["**Once** per row"], section: "**Depends on:** Phase 75.3 (claims rows). More prose.\n**Requirements**: H10, H11" } },
      plans: { ok: false, failures: [{ tool: 0, error: "Error-ish" }, { tool: 1, error: "Unknown command: phase-plan-index" }] },
      verification: { ok: false, failures: [{ tool: 0, error: 'Verification report "/srv/app/.planning/phases/75.4-hardening/75.4-VERIFICATION.md" has status "pending". Recovery: fix it.' }] },
      uat: { ok: false, failures: [{ tool: 0, error: "Unknown command" }] },
    },
    files: {
      dir: "75.4-hardening", summaries: ["75.4-01-SUMMARY.md"],
      plans: { "75.4-01-PLAN.md": { wave: "1", title: "'Claim rows'" }, "75.4-02-PLAN.md": { wave: "2" }, "75.4-03-PLAN.md": { wave: "1", plan_name: "Leases" } },
      verification: { file: "75.4-VERIFICATION.md", fm: { status: "pending", score: "3/5" } },
      uat: [{ file: "75.4-UAT.md", fm: { status: "testing" } }],
      requirements: ["- [x] **H10**: Rows are claimed", "| H11 | Phase 75.4 | Pending |"],
    },
  }, PHASE, "/srv/app");
  assert.equal(d.name, "Hardening jobs");
  assert.deepEqual(d.successCriteria, ["Once per row"]);
  assert.deepEqual(d.dependsOn, ["Phase 75.3"]);
  assert.deepEqual(d.requirements, [{ id: "H10", text: "Rows are claimed", done: true }, { id: "H11", text: null, done: false }]);
  assert.deepEqual(d.plans.map((p) => [p.id, p.title, p.wave, p.done]), [["75.4-01", "Claim rows", 1, true], ["75.4-03", "Leases", 1, false], ["75.4-02", null, 2, false]]);
  assert.deepEqual({ status: d.verification.status, detail: d.verification.detail }, { status: "pending", detail: "3/5" }, "the report's own status when gsd-tools refuses it");
  assert.deepEqual({ status: d.uat.status, detail: d.uat.detail, passed: d.uat.passed }, { status: "testing", detail: null, passed: null });
  assert.equal(d.status, "executing", "1 of 3 summarised");
  assert.deepEqual(d.warnings, [
    "phase-plan-index failed: Error-ish",
    'verification status failed: Verification report "75.4-VERIFICATION.md" has status "pending"',
    "phase uat-passed failed: Unknown command",
  ]);
});

test("buildPhaseDetail: unknown plan data keeps the snapshot's status", () => {
  const d = buildPhaseDetail(base(), { results: { plans: { ok: false, failures: [] } }, files: { dir: null } }, PHASE, "/srv/app");
  assert.equal(d.status, "executing");
  assert.deepEqual(d.plans, []);
});

test("parsers for the phase section", () => {
  assert.equal(sectionField("**Goal**: x\n**Requirements**: A-1, B-2,\n  C-3\n**Plans**: 3", "Requirements?"), "A-1, B-2, C-3");
  assert.equal(sectionField("**Depends on:** Phase 4\n", "Depends on"), "Phase 4");
  assert.equal(sectionField("**Goal**: x", "Requirements?"), null);
  assert.deepEqual(parseDependsOn("Phase 89, 90, 91, 92 complete (Phase 94 + x)"), ["Phase 89", "Phase 90", "Phase 91", "Phase 92"]);
  assert.deepEqual(parseDependsOn("86"), ["Phase 86"]);
  assert.deepEqual(parseDependsOn("Nothing (first phase)"), []);
  assert.deepEqual(parseDependsOn("the v2 launch"), ["the v2 launch"], "no phase named: the text as written");
  assert.deepEqual(parseRequirementIds("H10, H14, FU-OBJ"), { ids: ["H10", "H14", "FU-OBJ"], note: null });
  assert.deepEqual(parseRequirementIds("TRUTH-01 P0, TRUTH-02"), { ids: ["TRUTH-01", "TRUTH-02"], note: null });
  assert.deepEqual(parseRequirementIds("No new IDs; covers H10, H11"), { ids: [], note: "No new IDs; covers H10, H11" });
  assert.deepEqual(parseRequirementIds("None mapped — areas: text, motion"), { ids: [], note: "None mapped — areas: text, motion" });
  assert.deepEqual(parseRequirementIds("TBD"), { ids: [], note: null });
  assert.deepEqual(requirementInfo(["- [ ] **AB-1**: x", "- [x] **AB-10**: y"], "AB-10"), { text: "y", done: true });
  assert.deepEqual(requirementInfo(["| AB-2 | Phase 1 | ✅ |"], "AB-2"), { text: null, done: true });
  assert.deepEqual(requirementInfo([], "AB-3"), { text: null, done: null });
  assert.equal(planTitle({}, "Make the **import** idempotent. Then add a test."), "Make the import idempotent.");
  assert.equal(planTitle({ title: '"A `b` c"' }, "ignored"), "A b c");
  assert.equal(planTitle({}, null), null);
});

// ─── todo detail with fake io ─────────────────────────────────────────────────

const TODO = { title: "From the snapshot", file: ".planning/todos/pending/x.md", area: "general", created: "2026-01-01", severity: null };
const reader = (text) => ({ calls: [], async readTextFile(path, opts) { this.calls.push([path, opts]); return typeof text === "function" ? text() : text; } });

test("todo detail: missing file, read failure, no selection", async () => {
  const gone = await loadTodoDetail({ root: "/srv/app", on: "vps" }, TODO, reader(null));
  assert.deepEqual([gone.state, gone.error, gone.title, gone.path], ["error", "This todo's file is gone: it was probably just completed or moved", "From the snapshot", "/srv/app/.planning/todos/pending/x.md"]);
  const failing = await loadTodoDetail({ root: "/srv/app", on: "vps" }, TODO, reader(() => { throw new Error("permission denied"); }));
  assert.equal(failing.error, "Could not read the todo on vps: permission denied");
  assert.equal((await loadTodoDetail({ root: "/srv/app" }, null, reader("x"))).error, "No todo selected");
  assert.equal((await loadTodoDetail({ root: "/srv/app" }, TODO, undefined)).state, "error");
  const r = reader("---\ntitle: T\n---\nbody\n");
  await loadTodoDetail({ root: "/srv/app/", on: "vps" }, TODO, r);
  assert.deepEqual(r.calls, [["/srv/app/.planning/todos/pending/x.md", { on: "vps" }]]);
});

test("todo detail: body capped at 20,000 characters on a line boundary", async () => {
  const body = Array.from({ length: 2000 }, (_, i) => `line ${i} ${"x".repeat(20)}`).join("\n");
  const d = await loadTodoDetail({ root: "/srv/app" }, TODO, reader(`---\ntitle: Big\n---\n${body}\n`));
  assert.equal(d.truncated, true);
  assert.ok(d.body.length <= 20000 && d.body.length > 18000, String(d.body.length));
  assert.ok(body.startsWith(d.body) && body[d.body.length] === "\n", "cut at a line end");
  const small = await loadTodoDetail({ root: "/srv/app" }, TODO, reader("---\ntitle: Small\n---\nok\n"));
  assert.deepEqual([small.truncated, small.body, small.title], [false, "ok", "Small"]);
});

test("todo detail: files variants, file values win over the snapshot's, a different heading stays", async () => {
  assert.deepEqual(parseTodoFile("---\nfiles: [a.ts, \"b c.ts\"]\n---\n").files, ["a.ts", "b c.ts"]);
  assert.deepEqual(parseTodoFile("---\nfiles: []\n---\n").files, []);
  assert.deepEqual(parseTodoFile("---\nfiles:\n  - a.ts:1-2\n  - 'b.ts'\narea: x\n---\n").files, ["a.ts:1-2", "b.ts"]);
  const d = await loadTodoDetail({ root: "/srv/app" }, TODO, reader("---\ntitle: Real title\narea: ui # not a comment here\nseverity: minor\n---\n\n# Background\n\nText\n"));
  assert.deepEqual([d.title, d.area, d.severity, d.created, d.body], ["Real title", "ui # not a comment here", "minor", "2026-01-01", "# Background\n\nText"]);
});
