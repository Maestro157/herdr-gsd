// node test/ui/layout.test.mjs — scripts/main-gsd-layout.mjs builds the personal
// layout main-gsd from the shipped main layout (test/ui/fixtures/main.json is a
// copy of Herdr 0.1.16's) plus the GSD column and its tab-bar button.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { buildLayout, BUTTON_WIDTH } from "../../scripts/main-gsd-layout.mjs";

const main = JSON.parse(readFileSync(new URL("./fixtures/main.json", import.meta.url), "utf8"));
const find = (node, id) => node?.id === id ? node : (node?.children ?? []).map((c) => find(c, id)).find(Boolean) ?? null;
const strip = (node, ids) => ({ ...node, children: node.children?.filter((c) => !ids.includes(c.id)).map((c) => (c.children ? strip(c, ids) : c)) });
const ids = (node, out = []) => { if (node?.id) out.push(node.id); for (const c of node?.children ?? []) ids(c, out); return out; };

test("records where it came from, first, like layout.clone", () => {
  const out = buildLayout(main, "0.1.16");
  assert.deepEqual(Object.keys(out).slice(0, 2), ["id", "cloned_from"]);
  assert.deepEqual(out.cloned_from, { name: "main", version: "0.1.16" });
});

test("the GSD column follows the Files/Changes panel", () => {
  const body = find(buildLayout(main, "1"), "work-body");
  assert.deepEqual(body.children.map((c) => c.id), ["main", "panel", "gsd"]);
  assert.deepEqual(body.children[2], { id: "gsd", type: "block", size: { px: 368 }, min: 280, max: 720, content: { mod: "gsd", props: { role: "column" } } });
});

test("the tab bar becomes a row of the same height: tabs (flexible), then the GSD button (fixed), both drag the window", () => {
  const out = buildLayout(main, "1"), work = find(out, "work");
  const row = work.children[0];
  assert.equal(row.id, "tab-row"); assert.equal(row.type, "row");
  assert.deepEqual(row.size, find(main, "tabs").size);
  assert.equal(row.resizable, false);
  const [tabs, gsd] = row.children;
  assert.equal(row.children.length, 2);
  assert.deepEqual(tabs, { ...find(main, "tabs"), size: { weight: 1 }, window_drag: true });
  assert.deepEqual(gsd, { id: "gsd-button", type: "block", size: { px: BUTTON_WIDTH }, window_drag: true, content: { mod: "gsd", props: { role: "button" } } });
});

test("every id is there once", () => {
  const order = ids(buildLayout(main, "1"));
  assert.equal(new Set(order).size, order.length);
});

test("everything else is the shipped layout, untouched", () => {
  const out = buildLayout(main, "1");
  const back = structuredClone(out);
  delete back.cloned_from;
  const work = find(back, "work");
  work.children[0] = work.children[0].children[0];
  work.children[0].size = find(main, "tabs").size;
  assert.deepEqual(strip(back, ["gsd"]), strip(main, []));
});

test("pure and repeatable: the same input gives the same output, and the input is not changed", () => {
  const before = JSON.stringify(main);
  assert.equal(JSON.stringify(buildLayout(main, "1")), JSON.stringify(buildLayout(main, "1")));
  assert.equal(JSON.stringify(main), before);
});

test("refuses a layout it can't place things in, or one that already has them", () => {
  assert.throws(() => buildLayout(buildLayout(main, "1"), "1"), /already has/);
  const taken = structuredClone(main);
  find(taken, "work-body").children.push({ id: "gsd", type: "block", content: { mod: "files" } });
  assert.throws(() => buildLayout(taken, "1"), /already has a node "gsd"/);
  const noTabs = structuredClone(main);
  find(noTabs, "work").children.shift();
  assert.throws(() => buildLayout(noTabs, "1"), /changed shape/);
  assert.throws(() => buildLayout({}, "1"), /no root/);
  assert.throws(() => buildLayout(main, ""), /version/);
});
