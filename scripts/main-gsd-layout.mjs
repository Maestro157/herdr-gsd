#!/usr/bin/env node
// Builds a personal layout `main-gsd` from Herdr's shipped `main` layout plus two
// insertions, and nothing else:
//   - the GSD column (block "gsd") right after the Files/Changes panel in "work-body";
//   - the GSD button at the right of the tab bar: the "tabs" block becomes a row
//     ("tab-row", same height) of the tabs block (flexible width) and the button
//     ("gsd-button", fixed width), both dragging the window.
// It records `cloned_from: {name: "main", version}` with the app's version, as
// Herdr's own layout.clone does. Safe to re-run, e.g. after a Herdr update, to
// re-base on the new `main`: the same input gives the same file (rewritten only
// when it differs; a replaced, different file is kept as main-gsd.json.old-<time>).
// It never writes anything but layouts/main-gsd.json (and that .old copy).
// Clicks (sizes, shown/hidden) live in layouts/.state/ and are not touched.
//
//   node scripts/main-gsd-layout.mjs [--dry-run]     (HERDR_APP_HOME picks the home)
import { readFileSync, writeFileSync, renameSync, existsSync, copyFileSync, statSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const NAME = "main-gsd";
export const BUTTON_WIDTH = 92;
const COLUMN = { id: "gsd", type: "block", size: { px: 368 }, min: 280, max: 720, content: { mod: "gsd", props: { role: "column" } } };
const BUTTON = { id: "gsd-button", type: "block", size: { px: BUTTON_WIDTH }, window_drag: true, content: { mod: "gsd", props: { role: "button" } } };

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}

/** The personal layout for a shipped `main` layout object and an app version. Pure: `main` is not changed. */
export function buildLayout(main, version) {
  if (!main || typeof main !== "object" || main.id !== "root") throw new Error("layouts/main.json has no root node");
  if (!version) throw new Error("no Herdr version to record in cloned_from");
  const out = structuredClone(main);
  delete out.cloned_from;
  for (const id of ["gsd", "gsd-button", "tab-row"]) if (find(out, id)) throw new Error(`layouts/main.json already has a node "${id}"`);
  const work = find(out, "work"), tabs = work?.children?.find((c) => c.id === "tabs");
  const body = find(out, "work-body"), panel = body?.children?.find((c) => c.id === "panel");
  if (work?.type !== "column" || tabs?.type !== "block" || body?.type !== "row" || !panel) {
    throw new Error('layouts/main.json changed shape: expected a "work" column holding a "tabs" block, and a "work-body" row holding "panel"');
  }
  const row = {
    id: "tab-row", type: "row", size: structuredClone(tabs.size ?? { px: 42 }), resizable: false,
    children: [{ ...tabs, size: { weight: 1 }, window_drag: true }, structuredClone(BUTTON)],
  };
  work.children[work.children.indexOf(tabs)] = row;
  body.children.splice(body.children.indexOf(panel) + 1, 0, structuredClone(COLUMN));
  const { id, ...rest } = out;
  return { id, cloned_from: { name: "main", version }, ...rest };
}

/** The running app's version, as `herdr-app --version` prints it ("herdr-app 0.1.16"). */
export function appVersion() {
  const text = execFileSync("herdr-app", ["--version"], { encoding: "utf8", timeout: 10000 });
  const m = /(\d+\.\d+\.\d+[^\s]*)/.exec(text);
  if (!m) throw new Error(`unexpected \`herdr-app --version\` output: ${text.trim()}`);
  return m[1];
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main(argv) {
  const dry = argv.includes("--dry-run");
  const home = process.env.HERDR_APP_HOME || join(homedir(), ".config", "herdr-app");
  const dir = join(home, "layouts"), src = join(dir, "main.json"), dest = join(dir, `${NAME}.json`), errFile = join(dir, `${NAME}.error`);
  const shipped = JSON.parse(readFileSync(src, "utf8"));
  let version;
  try { version = appVersion(); }
  catch (e) {
    // No herdr-app on PATH: keep the version the existing file records, if any.
    version = existsSync(dest) ? JSON.parse(readFileSync(dest, "utf8"))?.cloned_from?.version : null;
    if (!version) throw new Error(`cannot read Herdr's version (${e.message})`);
    console.warn(`warning: herdr-app --version failed, keeping cloned_from version ${version}`);
  }
  const text = `${JSON.stringify(buildLayout(shipped, version), null, 2)}\n`;
  if (dry) { process.stdout.write(text); return; }
  const before = existsSync(dest) ? readFileSync(dest, "utf8") : null;
  if (before === text) { console.log(`${dest}: up to date (main ${version})`); return; }
  if (before !== null) {
    const keep = `${dest}.old-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(dest, keep);
    console.log(`kept the previous file as ${keep}`);
  }
  const errBefore = existsSync(errFile) ? statSync(errFile).mtimeMs : null;
  const tmp = join(dir, `.${NAME}.json.tmp-${process.pid}`);   // hidden: Herdr ignores it
  writeFileSync(tmp, text);
  renameSync(tmp, dest);
  console.log(`wrote ${dest} (main ${version})`);
  // Herdr checks a layout edit at once; an invalid one keeps the last good layout and says why.
  await wait(1500);
  if (existsSync(errFile) && statSync(errFile).mtimeMs !== errBefore) {
    console.error(`Herdr rejected it (${errFile}):\n${readFileSync(errFile, "utf8")}`);
    process.exitCode = 1;
  }
}

// Run as a script (also through a symlinked path: the real file is what is compared), not when imported.
const invoked = () => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return ""; } };
if (process.argv[1] && import.meta.url === invoked()) {
  main(process.argv.slice(2)).catch((e) => { console.error(`main-gsd layout: ${e.message}`); process.exitCode = 1; });
}
