// The node driver on its own, with fake gsd-tools installs: a slow install must
// not push the load past loadGsd's exec timeout or leave processes behind.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { DRIVER } from "../../mods/gsd/data.js";
import { tempDir } from "./helpers.mjs";

let W, root;
const tool = (name) => join(W, name, "bin", "gsd-tools.cjs");
before(async () => {
  W = await tempDir("gsd-driver-");
  root = join(W, "proj");
  await mkdir(join(root, ".planning"), { recursive: true });
  const fake = async (name, body) => { await mkdir(join(W, name, "bin"), { recursive: true }); await writeFile(tool(name), body); };
  // Hangs, after noting its pid (to prove it was killed).
  await fake("slow", `require("fs").appendFileSync(${JSON.stringify(join(W, "slow.pids"))}, process.pid + "\\n"); setInterval(() => {}, 1000);\n`);
  // Answers at once, after noting that it ran.
  await fake("fast", `require("fs").appendFileSync(${JSON.stringify(join(W, "fast.ran"))}, process.argv[2] + "\\n");
process.stdout.write(JSON.stringify({ phases: [], milestones: [], count: 0, todos: [] }));\n`);
  // Fails after a while, without a timeout.
  await fake("failslow", `setTimeout(() => { process.stderr.write("Error: broken install\\n"); process.exit(1); }, 900);\n`);
});
after(async () => { if (W) await rm(W, { recursive: true, force: true }); });

function runDriver(source, tools) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    execFile(process.execPath, ["-e", source, root, "", ...tools], { timeout: 20000 }, (err, stdout) => {
      if (err) return reject(err);
      resolve({ ms: Date.now() - t0, out: JSON.parse(stdout) });
    });
  });
}
const withTimes = (step, budget) => {
  const s = DRIVER.replace("STEP_MS = 45000", `STEP_MS = ${step}`).replace("BUDGET_MS = 50000", `BUDGET_MS = ${budget}`);
  assert.notEqual(s, DRIVER, "the driver's time constants are where this test expects them");
  return s;
};
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("a timed-out install is not followed by the next one, and is killed", { timeout: 30000 }, async () => {
  const { ms, out } = await runDriver(withTimes(1500, 10000), [tool("slow"), tool("fast")]);
  for (const name of ["roadmap", "state", "todos"]) {
    assert.equal(out.results[name].ok, false, name);
    assert.deepEqual(out.results[name].failures.map((f) => [f.tool, f.error]), [[0, "timed out"]], name);
  }
  assert.ok(ms < 5000, `driver took ${ms} ms`);
  assert.equal(existsSync(join(W, "fast.ran")), false, "the second install never ran");
  await new Promise((r) => setTimeout(r, 200));
  const pids = (await readFile(join(W, "slow.pids"), "utf8")).trim().split("\n").map(Number);
  assert.equal(pids.length, 3);
  for (const pid of pids) assert.equal(alive(pid), false, `gsd-tools ${pid} still running`);
});

test("the whole driver stays inside its budget even when every install is slow", { timeout: 30000 }, async () => {
  await rm(join(W, "slow.pids"), { force: true });
  const { ms, out } = await runDriver(withTimes(5000, 2000), [tool("failslow"), tool("slow"), tool("fast")]);
  assert.ok(ms < 4500, `driver took ${ms} ms with a 2000 ms budget`);
  for (const name of ["roadmap", "state", "todos"]) {
    assert.equal(out.results[name].ok, false, name);
    assert.deepEqual(out.results[name].failures.map((f) => f.error), ["broken install", "timed out"], name);
  }
  assert.equal(existsSync(join(W, "fast.ran")), false);
  assert.equal(out.root, root, "the driver reports the exact root it was given");
});

test("a failing install still falls through to the next one", { timeout: 30000 }, async () => {
  const { out } = await runDriver(DRIVER, [tool("failslow"), tool("fast")]);
  assert.equal(out.results.roadmap.ok, true);
  assert.equal(out.results.roadmap.tool, 1);
  assert.deepEqual(out.results.roadmap.failures.map((f) => [f.tool, f.error]), [[0, "broken install"]]);
});
