// Opt-in smoke run over real GSD projects (read-only). Skipped unless GSD_SMOKE
// lists folders, ":"-separated; an entry ending in "/*" means every subfolder
// of it that has a .planning/:
//
//   GSD_SMOKE="$HOME/work/*:$HOME/projects/notes" node --test test/gsd/smoke.test.mjs
//
// Prints one row per project and checks each loads as state "ok" with a sane
// shape, and that the click-through details load too: the current phase (else
// the first executing one, else the first) and the first todo. As an extra signal it compares a recursive mtime/size listing of each
// .planning/ before and after; agents working in those repos can change files
// concurrently, so differences are reported, not failed on (the hard read-only
// proof is in load.test.mjs on fixture copies).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadGsd, loadPhaseDetail, loadTodoDetail } from "../../mods/gsd/data.js";
import { nodeIo, treeSnapshot } from "./helpers.mjs";

const spec = process.env.GSD_SMOKE ?? "";
const folders = spec.split(":").filter(Boolean).flatMap((entry) => {
  if (!entry.endsWith("/*")) return [entry];
  const parent = entry.slice(0, -2);
  return readdirSync(parent).map((n) => join(parent, n))
    .filter((p) => statSync(p).isDirectory() && existsSync(join(p, ".planning"))).sort();
});

test("smoke: every listed real project loads", { skip: folders.length ? false : "set GSD_SMOKE to run", timeout: 600000 }, async (t) => {
  const rows = [];
  const failures = [];
  for (const folder of folders) {
    const planning = join(folder, ".planning");
    const before = existsSync(planning) ? await treeSnapshot(planning) : null;
    const t0 = Date.now();
    const s = await loadGsd({ cwd: folder, on: null }, nodeIo());
    const ms = Date.now() - t0;
    const pick = s.phases.find((p) => p.current) ?? s.phases.find((p) => p.status === "executing") ?? s.phases[0] ?? null;
    const t1 = Date.now();
    const pd = pick ? await loadPhaseDetail({ root: s.root, on: null }, pick, nodeIo()) : null;
    const pdMs = Date.now() - t1;
    const td = s.todos[0] ? await loadTodoDetail({ root: s.root, on: null }, s.todos[0], nodeIo()) : null;
    const after = existsSync(planning) ? await treeSnapshot(planning) : null;
    let changed = 0;
    if (before !== after) {
      const a = new Set(before.split("\n")), b = new Set(after.split("\n"));
      changed = [...b].filter((l) => !a.has(l)).length + [...a].filter((l) => !b.has(l)).length;
    }
    rows.push({ project: folder.split("/").pop(), state: s.state, milestone: s.milestone.label, phases: s.phases.length,
      done: s.progress.phases.completed, plansPct: s.progress.plans.percent, todos: s.todos.length, shipped: s.shipped.length,
      ms, changed, tool: s.source?.tool ?? "-", warnings: s.warnings.join(" | ") || "-", error: s.error ?? "-",
      phaseDetail: pd ? `${pd.id} ${pd.state} ${pdMs}ms ${pd.plans.length}p ${pd.requirements.length}r ${pd.successCriteria.length}sc v=${pd.verification?.status ?? "-"} u=${pd.uat?.status ?? "-"} w=${pd.warnings.length}` : "-",
      todoDetail: td ? `${td.state} ${td.body.length}${td.truncated ? "T" : ""}` : "-", detailError: [pd?.error, td?.error].filter(Boolean).join(" | ") || "-" });
    try {
      assert.equal(s.state, "ok", `${folder}: ${s.error}`);
      assert.equal(s.root, folder);
      assert.equal(typeof s.milestone.label, "string");
      for (const p of s.phases) {
        assert.ok(["done", "executing", "planned", "not_started"].includes(p.status));
        assert.ok(p.id && typeof p.name === "string" && typeof p.dir === "string");
        assert.ok(Number.isInteger(p.plans) && Number.isInteger(p.summaries));
      }
      for (const x of s.todos) assert.ok(typeof x.title === "string" && x.title && typeof x.file === "string");
      for (const m of s.shipped) assert.match(m.version, /^v\d/);
      if (pd) {
        assert.equal(pd.state, "ok", `${folder} phase ${pick.id}: ${pd.error}`);
        assert.ok(["done", "executing", "planned", "not_started"].includes(pd.status));
        for (const k of ["dependsOn", "requirements", "successCriteria", "plans", "warnings"]) assert.ok(Array.isArray(pd[k]), k);
        for (const p of pd.plans) assert.ok(typeof p.id === "string" && typeof p.done === "boolean" && (p.wave === null || typeof p.wave === "number"));
        assert.ok(pd.verification === null || "status" in pd.verification);
        assert.ok(pd.uat === null || "status" in pd.uat);
      }
      if (td) {
        assert.equal(td.state, "ok", `${folder} todo ${s.todos[0].file}: ${td.error}`);
        assert.ok(typeof td.title === "string" && td.title && typeof td.body === "string" && td.body.length <= 20000 && Array.isArray(td.files));
      }
      for (const k of ["phases", "plans"]) {
        const pr = s.progress[k];
        assert.ok(pr.percent === null || (pr.percent >= 0 && pr.percent <= 100));
        assert.ok(pr.completed <= pr.total || k === "phases");
      }
    } catch (e) { failures.push(e.message); }
  }
  const cols = ["project", "state", "phases", "done", "plansPct", "todos", "shipped", "ms", "changed", "phaseDetail", "todoDetail", "milestone", "tool", "warnings", "error", "detailError"];
  const lines = [cols.join("\t"), ...rows.map((r) => cols.map((c) => String(r[c])).join("\t"))];
  t.diagnostic(`\n${lines.join("\n")}`);
  if (process.env.GSD_SMOKE_OUT) (await import("node:fs")).writeFileSync(process.env.GSD_SMOKE_OUT, JSON.stringify(rows, null, 1));
  assert.deepEqual(failures, []);
});
