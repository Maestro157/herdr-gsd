// Which gsd-tools installs and which node the script picks, with fake homes.
// The install order mirrors GSD's own resolver; legacy get-shit-done only when
// there is no gsd-core at all. Node: newest nvm version by number, and the
// login shell only as a bounded last resort.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile, rm, chmod, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCRIPT, parseScriptOutput } from "../../mods/gsd/data.js";
import { tempDir } from "./helpers.mjs";

const SHELLS = ["sh", ...(existsSync("/bin/dash") ? ["/bin/dash"] : [])];
let W;
const file = async (p, text = "", mode) => {
  await mkdir(join(p, ".."), { recursive: true });
  await writeFile(p, text);
  if (mode) await chmod(p, mode);
};
const install = (dir) => file(join(dir, "bin", "gsd-tools.cjs"), "// fake\n");
before(async () => { W = await tempDir("gsd-tools-pick-"); });
after(async () => { if (W) await rm(W, { recursive: true, force: true }); });

// Runs the whole script; the "driver" just prints the tool list it was given.
function tools(cwd, env, shell = "sh") {
  const out = execFileSync(shell, ["-c", SCRIPT, "gsd-panel", cwd, "N0", "process.stdout.write(JSON.stringify(process.argv.slice(3)))"],
    { env: { PATH: process.env.PATH, ...env } }).toString();
  const { info, driver } = parseScriptOutput(out, "N0");
  if (driver === null) return info;
  return JSON.parse(driver).map((t) => t.slice(W.length + 1));
}

test("gsd-tools order: project-local, CLAUDE_CONFIG_DIR or ~/.claude, CODEX_HOME or ~/.codex; never get-shit-done beside gsd-core", async () => {
  const home = join(W, "home"), proj = join(W, "proj");
  for (const d of [".claude/gsd-core", ".codex/gsd-core", ".alt-claude/gsd-core", ".alt-codex/gsd-core", ".gemini/get-shit-done", ".cursor/get-shit-done"]) await install(join(home, d));
  await mkdir(join(proj, ".planning"), { recursive: true });
  for (const d of ["gsd-core", ".claude/gsd-core", ".codex/gsd-core"]) await install(join(proj, d));
  for (const shell of SHELLS) {
    assert.deepEqual(tools(proj, { HOME: home }, shell), [
      "proj/gsd-core/bin/gsd-tools.cjs", "proj/.claude/gsd-core/bin/gsd-tools.cjs", "proj/.codex/gsd-core/bin/gsd-tools.cjs",
      "home/.claude/gsd-core/bin/gsd-tools.cjs", "home/.codex/gsd-core/bin/gsd-tools.cjs",
    ], shell);
    assert.deepEqual(tools(proj, { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".alt-claude"), CODEX_HOME: join(home, ".alt-codex") }, shell).slice(3), [
      "home/.alt-claude/gsd-core/bin/gsd-tools.cjs", "home/.alt-codex/gsd-core/bin/gsd-tools.cjs",
    ], `${shell}: the config-dir variables replace ~/.claude and ~/.codex, as in GSD`);
  }
});

test("gsd-tools: get-shit-done only without any gsd-core; one entry per path", async () => {
  const legacyHome = join(W, "legacy-home"), proj = join(W, "proj2");
  for (const d of [".gemini/get-shit-done", ".cursor/get-shit-done"]) await install(join(legacyHome, d));
  await mkdir(join(proj, ".planning"), { recursive: true });
  assert.deepEqual(tools(proj, { HOME: legacyHome }), ["legacy-home/.gemini/get-shit-done/bin/gsd-tools.cjs", "legacy-home/.cursor/get-shit-done/bin/gsd-tools.cjs"]);
  // A project at $HOME: its .claude/gsd-core is ~/.claude/gsd-core, listed once.
  const atHome = join(W, "at-home");
  await install(join(atHome, ".claude/gsd-core"));
  await mkdir(join(atHome, ".planning"), { recursive: true });
  assert.deepEqual(tools(atHome, { HOME: atHome }), ["at-home/.claude/gsd-core/bin/gsd-tools.cjs"]);
  assert.ok("notools" in tools(proj, { HOME: join(W, "empty-home") }));
});

// A function of the script, run on its own.
function scriptFunction(name, patch = (s) => s) {
  const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?\\n\\}$`, "m").exec(SCRIPT);
  assert.ok(m, `${name}() is in SCRIPT`);
  return patch(m[0]);
}
const call = (shell, fn, name, env) => execFileSync(shell, ["-c", `${fn}\n${name}`], { env: { PATH: process.env.PATH, ...env } }).toString().trim();

test("nvm: the newest version by number, not by text order", async () => {
  const home = join(W, "nvm-home");
  for (const v of ["v9.11.2", "v22.1.0", "v22.10.0", "v18.20.4", "v4.9.1"]) await file(join(home, ".nvm/versions/node", v, "bin/node"), "", 0o755);
  await file(join(home, ".nvm/versions/node/v23.0.0/bin/node"), "", 0o644);   // not executable
  for (const shell of SHELLS) {
    assert.equal(call(shell, scriptFunction("nvm_node"), "nvm_node", { HOME: home }), "22.10.0/bin/node", shell);
    assert.equal(call(shell, scriptFunction("nvm_node"), "nvm_node", { HOME: join(W, "no-nvm") }), "", shell);
  }
});

test("login shell: only a marked, absolute, executable path; noise and hangs are ignored", async () => {
  const bin = join(W, "login-bin");
  await file(join(bin, "node"), "", 0o755);
  await file(join(W, "not-exec", "node"), "", 0o644);
  // A login shell whose profile prints noise (one line even an absolute executable path), then runs the command.
  const shellWith = async (name, body) => { const p = join(W, "shells", name); await file(p, `#!/bin/sh\n${body}\n`, 0o755); return p; };
  const noisy = await shellWith("noisy", `echo "Welcome back"\necho /bin/sh\nprintf 'no newline'\nPATH=${bin}:$PATH; export PATH\nexec /bin/sh -c "$2"`);
  const relative = await shellWith("relative", `echo "@@gsdnode:node"`);
  const notExec = await shellWith("notexec", `echo "@@gsdnode:${join(W, "not-exec", "node")}"`);
  const pidFile = join(W, "hang.pid");
  const hang = await shellWith("hang", `echo $$ > ${pidFile}\nexec sleep 30`);
  const fn = scriptFunction("login_node");
  for (const shell of SHELLS) {
    assert.equal(call(shell, fn, "login_node", { SHELL: noisy, HOME: W }), join(bin, "node"), shell);
    assert.equal(call(shell, fn, "login_node", { SHELL: relative, HOME: W }), "", `${shell}: relative path`);
    assert.equal(call(shell, fn, "login_node", { SHELL: notExec, HOME: W }), "", `${shell}: not executable`);
    assert.equal(call(shell, fn, "login_node", { SHELL: "", HOME: W }), "", `${shell}: empty SHELL`);
    assert.equal(call(shell, fn, "login_node", { SHELL: "zsh", HOME: W }), "", `${shell}: SHELL not absolute`);
  }
  // A profile that hangs: the wait is bounded (1 s here instead of 5) and the shell is killed.
  const quick = scriptFunction("login_node", (s) => s.replace("[ $i -lt 5 ]", "[ $i -lt 1 ]"));
  assert.notEqual(quick, fn);
  const t0 = Date.now();
  assert.equal(call("sh", quick, "login_node", { SHELL: hang, HOME: W }), "");
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
  const pid = Number((await readFile(pidFile, "utf8")).trim());
  await new Promise((r) => setTimeout(r, 200));
  assert.throws(() => process.kill(pid, 0), "the hanging login shell was killed");
});
