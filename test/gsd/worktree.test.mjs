// Root resolution with real git repos and `git worktree add` in a temp dir.
// Parity target: gsd-tools' own resolver (project-context.cjs), checked by
// hand for every layout below (see the data.js SCRIPT comment).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { SCRIPT, parseScriptOutput, loadGsd } from "../../mods/gsd/data.js";
import { nodeIo, treeSnapshot, tempDir } from "./helpers.mjs";

const HAVE_GIT = (() => { try { execFileSync("git", ["--version"]); return true; } catch { return false; } })();
const HAVE_TOOLS = existsSync(join(process.env.HOME ?? "", ".claude/gsd-core/bin/gsd-tools.cjs"));
const T = { timeout: 60000, skip: HAVE_GIT ? false : "git not installed" };

// Setup git runs without the user's global config (hooks, signing, default branch).
const SETUP_ENV = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const git = (cwd, ...args) => execFileSync("git", ["-c", "init.defaultBranch=main", ...args], { cwd, env: SETUP_ENV, stdio: "pipe" }).toString();

let W;
const L = {};
before(async () => {
  if (!HAVE_GIT) return;
  W = await tempDir("gsd-wt-");
  const file = async (p, text = "x\n") => { await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, text); };
  const repo = async (dir) => { await mkdir(dir, { recursive: true }); git(dir, "init", "-q"); };

  // A: .planning committed, so every worktree carries its own copy.
  L.committed = join(W, "repo committed");
  await repo(L.committed);
  await file(join(L.committed, ".planning/PROJECT.md"), "# A\n");
  await file(join(L.committed, "src/deep/f.txt"));
  git(L.committed, "add", "-A"); git(L.committed, "commit", "-qm", "init");
  L.committedWt = join(W, "wt-committed");
  git(L.committed, "worktree", "add", "-q", "-b", "feat", L.committedWt);

  // B: .planning ignored (only in the main checkout); a Herdr-style worktree path with spaces and an apostrophe.
  L.main = join(W, "it's main");
  await repo(L.main);
  await file(join(L.main, ".planning/PROJECT.md"), "# B\n");
  await file(join(L.main, ".gitignore"), ".planning/\n");
  await file(join(L.main, "src/deep/f.txt"));
  git(L.main, "add", "-A"); git(L.main, "commit", "-qm", "init");
  L.mainWt = join(W, "herdr worktrees", "it's main", "feature-x");
  await mkdir(join(L.mainWt, ".."), { recursive: true });
  git(L.main, "worktree", "add", "-q", "-b", "feature/x", L.mainWt);

  // C: a bare repository's linked worktree has no main checkout to fall back to.
  const seed = join(W, "seed");
  await repo(seed); await file(join(seed, "a.txt")); git(seed, "add", "-A"); git(seed, "commit", "-qm", "init");
  git(W, "clone", "-q", "--bare", seed, join(W, "bare.git"));
  L.bareWt = join(W, "bare-wt");
  git(join(W, "bare.git"), "worktree", "add", "-q", "-b", "w1", L.bareWt);

  // D: no git at all.
  L.plain = join(W, "plain");
  await mkdir(join(L.plain, ".planning"), { recursive: true });
  await mkdir(join(L.plain, "a/b/c"), { recursive: true });

  // E: a repo inside a folder with .planning: not that project unless it declares sub_repos.
  for (const [name, config] of [["ws-none", null], ["ws-sub", '{"sub_repos":["app"]}\n']]) {
    await mkdir(join(W, name, ".planning"), { recursive: true });
    if (config) await writeFile(join(W, name, ".planning/config.json"), config);
    const app = join(W, name, "app");
    await repo(app); await file(join(app, "a")); git(app, "add", "-A"); git(app, "commit", "-qm", "i");
  }
});
after(async () => { if (W) await rm(W, { recursive: true, force: true }); });

// Runs only the location part of the script (the driver just prints {}).
function resolve(dir) {
  const out = execFileSync("sh", ["-c", SCRIPT, "gsd-panel", dir, "N0", "process.stdout.write('{}')"]).toString();
  return parseScriptOutput(out, "N0").info;
}

test("checkout with its own .planning (committed planning shows up in every worktree)", T, () => {
  assert.equal(resolve(join(L.committed, "src/deep")).root, L.committed);
  const wt = resolve(join(L.committedWt, "src/deep"));
  assert.equal(wt.root, L.committedWt);
  assert.equal(wt.via, "0");
});

test("linked worktree without .planning → the main checkout's, viaWorktree", T, () => {
  assert.deepEqual([resolve(join(L.main, "src/deep")).root, resolve(join(L.main, "src/deep")).via], [L.main, "0"]);
  for (const dir of [L.mainWt, join(L.mainWt, "src/deep")]) {
    const r = resolve(dir);
    assert.equal(r.root, L.main, dir);
    assert.equal(r.via, "1", dir);
  }
});

test("bare repository worktree, repo under a non-workspace .planning, nothing at all → none", T, () => {
  assert.ok("none" in resolve(L.bareWt));
  assert.ok("none" in resolve(join(W, "ws-none/app")));
  assert.equal(resolve(join(W, "ws-sub/app")).root, join(W, "ws-sub"), "sub_repos workspace");
  assert.equal(resolve(join(L.plain, "a/b/c")).root, L.plain, "no git: plain walk-up");
});

test("git writes nothing and loadGsd reports viaWorktree end to end", { ...T, skip: T.skip || (HAVE_TOOLS ? false : "no gsd-tools") }, async () => {
  const gitDir = join(L.main, ".git");
  const beforeGit = await treeSnapshot(gitDir);
  const beforePlanning = await treeSnapshot(join(L.main, ".planning"));
  const s = await loadGsd({ cwd: join(L.mainWt, "src/deep"), on: null }, nodeIo());
  assert.equal(await treeSnapshot(gitDir), beforeGit, "nothing under .git changed");
  assert.equal(await treeSnapshot(join(L.main, ".planning")), beforePlanning, "nothing under .planning changed");
  assert.equal(s.state, "ok", s.error);
  assert.equal(s.root, L.main);
  assert.equal(s.planningRoot, join(L.main, ".planning"));
  assert.equal(s.viaWorktree, true);
  assert.equal(s.project, "it's main");
});
