// Test helpers: an `io` with Herdr's exec/readTextFile signatures built on
// child_process + fs (`on` is ignored: everything runs on this computer).
import { execFile } from "node:child_process";
import { readFile, readdir, stat, cp, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function nodeIo({ env } = {}) {
  const calls = [];
  return {
    calls,
    exec(cmd, args = [], opts = {}) {
      calls.push({ cmd, args, opts });
      return new Promise((resolve, reject) => {
        execFile(cmd, args, { cwd: opts.cwd, env: env ?? process.env, timeout: opts.timeout ?? 30000, maxBuffer: 8 * 1024 * 1024 },
          (err, stdout, stderr) => {
            // Herdr rejects on timeout and when the program cannot start; a non-zero exit resolves.
            if (err && (err.killed || typeof err.code !== "number")) return reject(err);
            resolve({ code: err ? err.code : 0, stdout: String(stdout), stderr: String(stderr) });
          });
      });
    },
    async readTextFile(path) {
      try { return await readFile(path, "utf8"); } catch (e) { if (e.code === "ENOENT") return null; throw e; }
    },
  };
}

/** Recursive listing with mtimes and sizes: equal before/after means nothing was written. */
export async function treeSnapshot(dir) {
  const out = [];
  async function walk(d) {
    const s = await stat(d);
    out.push(`${s.mtimeMs} ${s.size} ${s.isDirectory() ? "d" : "f"} ${d.slice(dir.length)}`);
    if (s.isDirectory()) for (const e of (await readdir(d)).sort()) await walk(join(d, e));
  }
  await walk(dir);
  return out.join("\n");
}

/** A fresh physical temp dir (macOS /var → /private/var resolved, like `pwd -P`). */
export async function tempDir(prefix = "gsd-test-") {
  return realpath(await mkdtemp(join(tmpdir(), prefix)));
}

/** Copies a fixture project into a temp dir, keeping mtimes. Returns the copy's path. */
export async function copyFixture(name, into) {
  const src = new URL(`./fixtures/${name}`, import.meta.url).pathname;
  const dest = join(into, name);
  await cp(src, dest, { recursive: true, preserveTimestamps: true });
  return dest;
}

