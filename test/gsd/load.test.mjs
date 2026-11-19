// loadGsd end to end: the real sh script and the real gsd-tools on synthetic
// fixture projects copied into a temp dir. Also proves nothing is written
// under .planning/ (recursive mtime/size snapshots before and after).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { rm, utimes, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loadGsd } from "../../mods/gsd/data.js";
import { nodeIo, treeSnapshot, tempDir, copyFixture } from "./helpers.mjs";

const HOME = process.env.HOME ?? "";
const CANDIDATES = [
  ".claude/gsd-core", ".codex/gsd-core", ".claude/get-shit-done", ".codex/get-shit-done", ".gemini/get-shit-done",
  ".gemini/antigravity/get-shit-done", ".config/opencode/get-shit-done", ".copilot/get-shit-done", ".cursor/get-shit-done",
].map((d) => join(HOME, d, "bin/gsd-tools.cjs"));
const HAVE_TOOLS = CANDIDATES.some((p) => existsSync(p));
const skip = HAVE_TOOLS ? false : "no gsd-tools install found under $HOME";
const T = { timeout: 60000, skip };

let dir;
before(async () => { dir = await tempDir("gsd-load-"); });
after(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

// Fixed mtimes, so gsd-tools' verification staleness check (mtime-based when
// git is not available) gives the same answer on every checkout.
async function pinTimes(root) {
  const t = new Date("2026-11-01T10:00:00Z");
  async function walk(d) {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      await utimes(p, t, t);
    }
  }
  await walk(root);
  const verification = join(root, ".planning/phases/03-accounts/03-VERIFICATION.md");
  if (existsSync(verification)) { const later = new Date(t.getTime() + 120000); await utimes(verification, later, later); }
}

async function load(cwd, opts = {}) {
  return loadGsd({ cwd, on: null }, nodeIo(opts));
}

test("rich fixture: milestone, progress, position, phases, todos, shipped", T, async () => {
  const root = await copyFixture("rich", dir);
  await pinTimes(root);
  const beforeSnap = await treeSnapshot(join(root, ".planning"));
  const s = await load(join(root, ".planning", "phases"));   // a subfolder: walk-up finds the root
  const afterSnap = await treeSnapshot(join(root, ".planning"));
  assert.equal(afterSnap, beforeSnap, "nothing under .planning/ changed");

  assert.equal(s.state, "ok", s.error);
  assert.equal(s.error, null);
  assert.equal(s.root, root);
  assert.equal(s.planningRoot, join(root, ".planning"));
  assert.equal(s.viaWorktree, false);
  assert.equal(s.project, "rich");
  assert.deepEqual(s.milestone, { version: "v1.1", name: "Sync & Sharing", label: "v1.1 Sync & Sharing" });
  assert.deepEqual(s.position, { phase: "6", plan: "1 of 2 in current phase", status: "executing", phaseName: "Sharing links" });
  assert.deepEqual(
    s.phases.map((p) => [p.id, p.name, p.dir, p.status, p.plans, p.summaries, p.current]),
    [
      ["3", "Accounts", "03-accounts", "done", 2, 2, false],
      ["4", "Sync engine", "04-sync-engine", "done", 3, 3, false],
      ["5", "Conflict handling", "05-conflict-handling", "executing", 3, 1, false],
      ["6", "Sharing links", "06-sharing-links", "executing", 2, 0, true],
      ["6.1", "Release notes hotfix", "", "done", 0, 0, false],
      ["7", "Offline queue", "07-offline-queue", "not_started", 0, 0, false],
      ["8", "Launch polish", "08-launch-polish", "planned", 1, 0, false],
      ["9", "Usage metrics", "", "not_started", 0, 0, false],
    ],
    "the v1.1 window only (phase 1's folder belongs to the shipped v1.0)");
  assert.equal(s.phases[0].goal, "A user can sign up, sign in and sign out");
  assert.equal(s.phases[0].diskStatus, "complete", "passing VERIFICATION.md");
  assert.equal(s.phases[1].diskStatus, "executed");
  assert.deepEqual(s.progress, {
    phases: { completed: 3, total: 8, percent: 38, verified: 1 },
    plans: { completed: 6, total: 11, percent: 55 },
  });
  assert.deepEqual(s.todos, [
    { title: 'Fix "Share" button focus ring', file: ".planning/todos/pending/2026-11-14-share-button-focus.md", area: "ui", created: "2026-11-14", severity: "minor" },
    { title: "Add export to Markdown", file: ".planning/todos/pending/2026-11-12-add-export-to-markdown.md", area: "editor", created: "2026-11-12T09:30:00.000Z", severity: null },
    { title: "Investigate slow first sync", file: ".planning/todos/pending/2026-10-01-slow-first-sync.md", area: "general", created: "2026-10-01", severity: null },
    { title: "It's a single-quoted title", file: ".planning/todos/pending/legacy-captured.md", area: "docs", created: "2026-09-20", severity: null },
  ]);
  assert.deepEqual(s.shipped, [
    { version: "v1.0", name: "MVP", date: "2026-03-02" },
    { version: "v0.9", name: "Prototype", date: "2026-01-15" },
    { version: "v0.5", name: "Paper prototype", date: "2025-12-01" },
  ]);
  assert.deepEqual(s.warnings, []);
  assert.equal(typeof s.loadedAt, "number");
  assert.match(s.source.tool, /gsd/);
});

test("empty project (.planning with no ROADMAP/STATE/todos): ok, nothing to show, one warning", T, async () => {
  const root = await copyFixture("empty", dir);
  const beforeSnap = await treeSnapshot(join(root, ".planning"));
  const s = await load(root);
  assert.equal(await treeSnapshot(join(root, ".planning")), beforeSnap);
  assert.equal(s.state, "ok", s.error);
  assert.deepEqual(s.phases, []);
  assert.deepEqual(s.todos, []);
  assert.deepEqual(s.shipped, []);
  assert.deepEqual(s.milestone, { version: null, name: null, label: "No roadmap" }, "no ROADMAP.md: not \"Roadmap\"");
  assert.deepEqual(s.progress.phases, { completed: 0, total: 0, percent: null, verified: null });
  assert.deepEqual(s.progress.plans, { completed: 0, total: 0, percent: null });
  assert.deepEqual(s.warnings, ["No ROADMAP.md in .planning — no phases to show"]);
});

test("between milestones: gsd-tools withholds the percentage → null, not 0", T, async () => {
  const root = await copyFixture("between-milestones", dir);
  const beforeSnap = await treeSnapshot(join(root, ".planning"));
  const s = await load(root);
  assert.equal(await treeSnapshot(join(root, ".planning")), beforeSnap);
  assert.equal(s.state, "ok", s.error);
  assert.equal(s.progress.plans.percent, null);
  assert.equal(s.progress.phases.percent, null);
  assert.deepEqual(s.milestone, { version: null, name: null, label: "Roadmap" });
  assert.equal(s.position.status, "awaiting next milestone", "a bare snake_case status gets spaces");
  assert.equal(s.position.plan, null, "'(none)' is a placeholder");
  assert.deepEqual(s.shipped.map((m) => m.version), ["v1.1", "v1.0"]);
  assert.equal(s.todos.length, 1);
  assert.deepEqual(s.warnings, [], "nothing to count between milestones: no plan-percentage warning");
});

test("no .planning anywhere up the tree → none; a folder that is gone → error", T, async () => {
  const plain = join(dir, "no-planning", "deep", "er");
  await mkdir(plain, { recursive: true });
  const s = await load(plain);
  assert.equal(s.state, "none");
  assert.equal(s.root, null);
  assert.equal(s.error, null);
  const gone = await load(join(dir, "does-not-exist"));
  assert.equal(gone.state, "error");
  assert.equal(gone.error, "Folder not found on this computer");
});

test("paths with spaces, apostrophes, $ and backticks travel safely", T, async () => {
  const odd = join(dir, "it's a \"repo\" $HOME `x`");
  await mkdir(odd, { recursive: true });
  const root = await copyFixture("empty", odd);
  const sub = join(root, "src; echo pwned");
  await mkdir(sub, { recursive: true });
  const s = await load(sub);
  assert.equal(s.state, "ok", s.error);
  assert.equal(s.root, root);
  assert.equal(s.project, "empty");
});

// sh's and dash's echo expand backslashes ("\c" even swallowed the next marker);
// a newline splits the marker line. The root must still come back exact.
for (const shell of ["sh", "/bin/dash"]) {
  const missing = shell !== "sh" && !existsSync(shell) ? `${shell} not installed` : false;
  test(`${shell}: folder names with backslashes or a newline keep their exact root`, { ...T, skip: T.skip || missing }, async () => {
    for (const name of ["back\\nslash", "back\\cslash \\\\ two", "new\nline"]) {
      const parent = join(dir, shell.replace(/\W/g, ""), name);
      await mkdir(parent, { recursive: true });
      const root = await copyFixture("empty", parent);
      const io = nodeIo();
      const viaShell = { ...io, exec: (cmd, args, opts) => io.exec(cmd === "sh" ? shell : cmd, args, opts) };
      const s = await loadGsd({ cwd: root, on: null }, viaShell);
      assert.equal(s.state, "ok", `${JSON.stringify(name)}: ${s.error}`);
      assert.equal(s.root, root, JSON.stringify(name));
      assert.equal(s.planningRoot, join(root, ".planning"));
      assert.equal(s.viaWorktree, false);
      assert.deepEqual(s.warnings, ["No ROADMAP.md in .planning — no phases to show"]);
    }
  });
}

test("GSD_EXIT_CONTRACT in the environment does not turn answers into failures", T, async () => {
  const root = await copyFixture("empty", await tempDir("gsd-exit-"));
  for (const value of ["v2", "bogus"]) {
    const s = await load(root, { env: { ...process.env, GSD_EXIT_CONTRACT: value } });
    assert.equal(s.state, "ok", s.error);
    assert.deepEqual(s.warnings, ["No ROADMAP.md in .planning — no phases to show"], `${value}: no fallback to another install`);
  }
});

test("gsd-tools missing → distinct error (HOME without any install)", T, async () => {
  const root = await copyFixture("empty", await tempDir("gsd-notools-"));
  const fakeHome = await tempDir("gsd-home-");
  const env = { ...process.env, HOME: fakeHome };
  delete env.CLAUDE_CONFIG_DIR; delete env.CODEX_HOME;
  const s = await load(root, { env });
  assert.equal(s.state, "error");
  assert.equal(s.error, "gsd-tools not found on this computer");
  assert.equal(s.root, root);
});

const SYSTEM_NODE = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node", "/snap/bin/node"].some((p) => existsSync(p));
test("node missing → distinct error", { timeout: 60000, skip: SYSTEM_NODE ? "a system-wide node exists, the script would find it" : false }, async () => {
  const root = await copyFixture("empty", await tempDir("gsd-nonode-"));
  const fakeHome = await tempDir("gsd-home-");
  const s = await load(root, { env: { HOME: fakeHome, PATH: "/usr/bin:/bin" } });
  assert.equal(s.state, "error");
  assert.equal(s.error, "Node.js not found on this computer");
});

test("an older-style project folder without git, nested deep: walk-up stops at the first .planning", T, async () => {
  const outer = join(dir, "outer");
  await mkdir(join(outer, ".planning"), { recursive: true });
  await writeFile(join(outer, ".planning", "PROJECT.md"), "# Outer\n");
  const inner = await copyFixture("empty", outer);
  const s = await load(join(inner, ".planning"));
  assert.equal(s.root, inner, "the nearest .planning wins");
});
