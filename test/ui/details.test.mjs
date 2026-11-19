// node test/ui/details.test.mjs — the click-through details: the fixtures keep
// the data layer's PhaseDetail / TodoDetail contract, and the open-phase /
// open-todo commands (gsd/find.js) find the item a person means.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mockSnapshot, mockPhaseDetail, mockTodoDetail, DETAIL_FIXTURES } from "../../mods/gsd/mock.js";
import { findPhase, findTodo, positionPhase } from "../../mods/gsd/find.js";

const STATUSES = ["done", "executing", "planned", "not_started"];
const strOrNull = (v) => v === null || typeof v === "string";

function assertPhaseDetail(d) {
  assert.ok(["ok", "error"].includes(d.state)); assert.ok(strOrNull(d.error));
  assert.equal(typeof d.id, "string"); assert.equal(typeof d.name, "string"); assert.ok(STATUSES.includes(d.status));
  assert.ok(strOrNull(d.goal)); assert.ok(d.dependsOn.every((x) => typeof x === "string"));
  for (const r of d.requirements) { assert.equal(typeof r.id, "string"); assert.ok(strOrNull(r.text)); assert.ok([true, false, null].includes(r.done)); }
  assert.ok(d.successCriteria.every((x) => typeof x === "string"));
  for (const p of d.plans) { assert.equal(typeof p.id, "string"); assert.ok(strOrNull(p.title)); assert.ok(p.wave === null || Number.isInteger(p.wave)); assert.equal(typeof p.done, "boolean"); }
  for (const c of [d.verification, d.uat]) if (c !== null) { assert.ok(strOrNull(c.status)); assert.ok(strOrNull(c.detail)); }
  assert.ok(Array.isArray(d.warnings)); assert.equal(typeof d.loadedAt, "number");
}
function assertTodoDetail(d) {
  assert.ok(["ok", "error"].includes(d.state)); assert.ok(strOrNull(d.error)); assert.equal(typeof d.title, "string");
  for (const k of ["area", "created", "severity"]) assert.ok(strOrNull(d[k]), k);
  assert.ok(d.files.every((x) => typeof x === "string")); assert.equal(typeof d.path, "string");
  assert.equal(typeof d.body, "string"); assert.equal(typeof d.truncated, "boolean"); assert.equal(typeof d.loadedAt, "number");
}

const s = mockSnapshot("rich");
const current = s.phases.find((p) => p.current), unplanned = s.phases.find((p) => p.plans === 0);

test("phase fixtures keep the PhaseDetail contract", () => {
  for (const name of Object.keys(DETAIL_FIXTURES.phase)) assertPhaseDetail(mockPhaseDetail(current, name));
  assertPhaseDetail(mockPhaseDetail(unplanned));
});

test("the rich phase is big (40+ plans in waves, long criteria); a phase without plans gets the minimal one", () => {
  const rich = mockPhaseDetail(current);
  assert.ok(rich.plans.length >= 40);
  assert.ok(new Set(rich.plans.map((p) => p.wave)).size > 1);
  assert.ok(rich.successCriteria.some((c) => c.length > 100));
  const minimal = mockPhaseDetail(unplanned);
  assert.deepEqual([minimal.plans, minimal.requirements, minimal.successCriteria], [[], [], []]);
  assert.equal(mockPhaseDetail(current, "error").state, "error");
});

test("todo fixtures keep the TodoDetail contract: long markdown, empty, error", () => {
  for (const name of Object.keys(DETAIL_FIXTURES.todo)) assertTodoDetail(mockTodoDetail(s.todos[0], name));
  const long = mockTodoDetail(s.todos[0]).body;
  for (const part of [/^## /m, /^1\. /m, /^\s+- /m, /```/, /^\|.*\|$/m]) assert.match(long, part);
  assert.equal(mockTodoDetail(s.todos[0], "empty").body, "");
});

test("open-phase: by id (leading zeros don't matter), else the current phase", () => {
  const snap = { ...s, phases: [...s.phases, { ...current, id: "09.1", current: false }] };
  assert.equal(findPhase(snap, "")?.id, current.id);
  assert.equal(findPhase(snap, "23.1")?.id, "23.1");
  assert.equal(findPhase(snap, "9.1")?.id, "09.1");
  assert.equal(findPhase(snap, "999"), null);
  assert.equal(findPhase({ state: "none" }, ""), null);
  assert.equal(positionPhase(s)?.id, current.id);
});

test("open-todo: the n-th, the file named so before one that merely contains it, or any text", () => {
  const todos = ["2026-11-01-filler-33.md", "2026-11-01-filler-3.md", "2026-11-02-share-page-404.md"]
    .map((f, i) => ({ title: `Todo ${i}`, file: `.planning/todos/pending/${f}`, area: null, created: null }));
  const snap = { state: "ok", todos };
  assert.equal(findTodo(snap, "")?.file, todos[0].file);
  assert.equal(findTodo(snap, "2")?.file, todos[1].file);
  assert.equal(findTodo(snap, "filler-3")?.file, todos[1].file, "not filler-33");
  assert.equal(findTodo(snap, "share-page")?.file, todos[2].file);
  assert.equal(findTodo(snap, "todo 2")?.file, todos[2].file);
  assert.equal(findTodo(snap, "9"), null);
});
