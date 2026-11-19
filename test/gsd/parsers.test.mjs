// Pure-function tests for gsd/data.js: no processes, no disk.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  locate, parseScriptOutput, parseMilestones, parseStateExcerpt, parseTodoHead, normalizeTodos, sortTodos,
  unquoteYaml, derivePhaseStatus, isUnderWay, phaseKey, dirKey, clampPercent, nameFromHeading, tidyMilestoneName,
  compareVersions, stripInlineMarkdown, SCRIPT, DRIVER, PHASE_DRIVER,
} from "../../mods/gsd/data.js";

// ─── locate ──────────────────────────────────────────────────────────────────

const space = (over = {}) => ({ id: "s1", active: true, folder: "/home/me/app", machine: null, ...over });

test("locate: focused pane's cwd wins over focused.cwd and the space folder", () => {
  const live = {
    spaces: [space({ id: "s0", active: false, folder: "/other" }), space()],
    panes: [{ pane: "p1", cwd: "/home/me/app/src" }],
    focused: { space: "s1", tab: "t", pane: "p1", terminal: "t1", cwd: "/elsewhere" },
  };
  assert.deepEqual(locate(live), { cwd: "/home/me/app/src", on: null, spaceId: "s1" });
});

test("locate: falls back to focused.cwd, then the space folder", () => {
  assert.equal(locate({ spaces: [space()], panes: [], focused: { pane: "p9", cwd: "/f" } }).cwd, "/f");
  assert.equal(locate({ spaces: [space()], panes: [], focused: null }).cwd, "/home/me/app");
  assert.equal(locate({ spaces: [space()], panes: [{ pane: "p1", cwd: null }], focused: { pane: "p1", cwd: null } }).cwd, "/home/me/app");
});

test("locate: on = the space's machine; a focused layout terminal block uses its address' machine", () => {
  const remote = space({ machine: "vps" });
  assert.equal(locate({ spaces: [remote], panes: [], focused: { pane: "p1", cwd: "/x" } }).on, "vps");
  assert.equal(locate({ spaces: [remote], panes: [], focused: { pane: null, terminal: "box/t7", cwd: "/x" } }).on, "box");
  assert.equal(locate({ spaces: [remote], panes: [], focused: { pane: null, terminal: "t7", cwd: "/x" } }).on, null);
});

test("locate: null without an active space or without any folder", () => {
  assert.equal(locate({ spaces: [space({ active: false })], panes: [], focused: null }), null);
  assert.equal(locate({ spaces: [space({ folder: "" })], panes: [], focused: null }), null);
  assert.equal(locate({}), null);
  assert.equal(locate(undefined), null);
});

// ─── script / driver protocol ────────────────────────────────────────────────

test("SCRIPT and DRIVER are plain ASCII and the script has no bashisms we know of", () => {
  assert.doesNotMatch(SCRIPT, /[^\x00-\x7f]/);
  assert.doesNotMatch(DRIVER, /[^\x00-\x7f]/);
  assert.doesNotMatch(PHASE_DRIVER, /[^\x00-\x7f]/);
  assert.doesNotMatch(DRIVER + PHASE_DRIVER, /`|\$\{/, "no template syntax inside the drivers");
  assert.doesNotMatch(SCRIPT, /\[\[|\$'|^\s*function\s|^\s*local\s|\bpushd\b|^\s*source\s|<<<|readlink -f|\brealpath\b|\$\{[A-Za-z_]+\/\//m);
  assert.match(SCRIPT, /GIT_OPTIONAL_LOCKS=0/);
  assert.match(SCRIPT, /core\.fsmonitor=false/);
});

test("parseScriptOutput: markers need the nonce; text after `driver` is the JSON", () => {
  const out = [
    "@@gsd:abc root /a b/it's",
    "@@gsd:zzz root /spoofed",
    "@@gsd:abc via 1",
    "@@gsd:abc node /usr/bin/node",
    "@@gsd:abc driver",
    '{"x":1,',
    '"y":"@@gsd:abc none"}',
  ].join("\n");
  const { info, driver } = parseScriptOutput(out, "abc");
  assert.deepEqual(info, { root: "/a b/it's", via: "1", node: "/usr/bin/node" });
  assert.deepEqual(JSON.parse(driver), { x: 1, y: "@@gsd:abc none" });
  assert.deepEqual(parseScriptOutput("@@gsd:abc none\n", "abc"), { info: { none: "" }, driver: null });
  assert.deepEqual(parseScriptOutput("", "abc"), { info: {}, driver: null });
});

// ─── phase status ────────────────────────────────────────────────────────────

test("derivePhaseStatus: the documented rule", () => {
  const s = (plans, summaries, diskStatus = null, checked = false, ctx) => derivePhaseStatus({ plans, summaries, diskStatus, checked }, ctx);
  assert.equal(s(2, 2, "complete"), "done");
  assert.equal(s(3, 1, "complete"), "done", "a passing verification wins over missing summaries");
  assert.equal(s(3, 3, "executed"), "done");
  assert.equal(s(0, 1, "empty"), "done", "a backfilled summary without a plan");
  assert.equal(s(0, 0, "no_directory", true), "done", "ticked, nothing on disk");
  assert.equal(s(3, 1, "partial", true), "executing", "a tick never hides unfinished work");
  assert.equal(s(3, 1, "partial"), "executing");
  assert.equal(s(2, 0, "planned"), "planned");
  assert.equal(s(2, 0, "planned", false, { current: true, underWay: true }), "executing");
  assert.equal(s(2, 0, "planned", false, { current: true, underWay: false }), "planned");
  assert.equal(s(2, 0, "planned", false, { current: false, underWay: true }), "planned");
  assert.equal(s(0, 0, "discussed", false, { current: true, underWay: true }), "not_started");
  assert.equal(s(0, 0, "no_directory"), "not_started");
});

test("isUnderWay: executing / in progress, not 'Ready to execute'", () => {
  for (const v of ["executing", "EXECUTING", "In Progress", "in_progress", "implementing"]) assert.equal(isUnderWay(v), true, v);
  for (const v of ["Ready to execute", "planning", "verifying", "Awaiting next milestone", null, undefined, 3]) assert.equal(isUnderWay(v), false, String(v));
});

test("phaseKey / dirKey: zero padding and decimals", () => {
  assert.equal(phaseKey("09.1"), "9.1");
  assert.equal(phaseKey("9.1"), "9.1");
  assert.equal(phaseKey("01"), "1");
  assert.equal(phaseKey("1a"), "1A");
  assert.equal(dirKey("01-local-editor"), "1");
  assert.equal(dirKey("131.1-pill-live-activity"), "131.1");
  assert.equal(dirKey("09.1-phase-9-live"), "9.1");
  assert.equal(dirKey("07"), "7");
  assert.equal(dirKey("notes"), null);
  assert.equal(dirKey("GSD.02-01-one"), null);
});

test("clampPercent follows gsd-tools: 0 for an empty denominator, capped at 100", () => {
  assert.equal(clampPercent(0, 0), 0);
  assert.equal(clampPercent(1, 3), 33);
  assert.equal(clampPercent(2, 3), 67);
  assert.equal(clampPercent(5, 4), 100);
});

// ─── STATE.md ────────────────────────────────────────────────────────────────

test("parseStateExcerpt: frontmatter values and the Current Position block", () => {
  const text = [
    "---",
    "gsd_state_version: '1.0'",
    "milestone: v2.0",
    'milestone_name: "Public Launch"',
    "current_phase: 16",
    "status: executing",
    "progress:",
    "  percent: 67",
    "---",
    "",
    "# Project State",
    "",
    "## Current Position",
    "",
    "Phase: 16 (editor-core) — EXECUTING",
    "Plan: 4 of 5",
    "Status: Ready to execute",
    "",
    "## Decisions",
    "",
    "Plan: this is not the position",
  ].join("\n");
  const s = parseStateExcerpt(text);
  assert.equal(s.milestone, "v2.0");
  assert.equal(s.milestoneName, "Public Launch");
  assert.equal(s.currentPhase, "16");
  assert.equal(s.status, "executing", "frontmatter first, as gsd-tools does");
  assert.equal(s.plan, "4 of 5");
});

test("parseStateExcerpt: body-only STATE.md, bold labels, frontmatter plan wins", () => {
  const body = "# State\n\n## Current Position\n\n**Phase:** 3 of 9 (Accounts)\n**Plan:** 03-02\n**Status:** In progress\n";
  const s = parseStateExcerpt(body);
  assert.equal(s.currentPhase, "3");
  assert.equal(s.plan, "03-02");
  assert.equal(s.status, "In progress");
  assert.equal(parseStateExcerpt("---\nplan: 7 of 7\n---\n## Current Position\nPlan: 1 of 7\n").plan, "7 of 7");
  assert.deepEqual(parseStateExcerpt(null), { milestone: null, milestoneName: null, currentPhase: null, currentPhaseName: null, status: null, plan: null });
  assert.equal(parseStateExcerpt("no sections at all\nPlan: 1\n").plan, null, "Plan: outside Current Position is ignored");
});

test("parseStateExcerpt: a frontmatter placeholder does not hide the Current Position line", () => {
  const text = "---\nmilestone: v3.0\nstatus: unknown\ncurrent_phase: none\ncurrent_plan: null\n---\n\n## Current Position\n\nPhase: 23 (Agents)\nPlan: 0 of 3 in current phase\nStatus: Ready to plan\n";
  const s = parseStateExcerpt(text);
  assert.equal(s.status, "Ready to plan");
  assert.equal(s.currentPhase, "23");
  assert.equal(s.plan, "0 of 3 in current phase");
  assert.equal(s.milestone, "v3.0");
  assert.equal(parseStateExcerpt("---\nstatus: executing\n---\n## Current Position\nStatus: Ready\n").status, "executing", "a real value still wins");
});

// ─── todos ───────────────────────────────────────────────────────────────────

test("unquoteYaml: double, single, plain", () => {
  assert.equal(unquoteYaml('"Fix \\"Share\\" button"'), 'Fix "Share" button');
  assert.equal(unquoteYaml("'It''s fine'"), "It's fine");
  assert.equal(unquoteYaml("plain value"), "plain value");
  assert.equal(unquoteYaml("value # a comment"), "value");
  assert.equal(unquoteYaml("Follow up on PR #15", false), "Follow up on PR #15", "no comment stripping when asked");
  assert.equal(unquoteYaml(null), null);
  assert.equal(unquoteYaml(undefined), null);
});

test("normalizeTodos: ' #42' in a plain title is part of it (gsd-tools reads titles by regex)", () => {
  const [t] = normalizeTodos([{ file: "2026-01-02-x.md", path: ".planning/todos/pending/2026-01-02-x.md", title: "Fix login loop #42 after token refresh", area: "auth", created: "2026-01-02" }]);
  assert.equal(t.title, "Fix login loop #42 after token refresh");
});

test("parseTodoHead: frontmatter title/created/captured, markdown heading, **Created:**", () => {
  assert.deepEqual(parseTodoHead("---\ntitle: 'A b'\ncreated: 2026-01-02\n---\n# Other\n"), { title: "A b", created: "2026-01-02" });
  assert.deepEqual(parseTodoHead("---\ntype: todo\ncaptured: 2026-07-12\n---\n\n# **Bold** heading\n"), { title: "Bold heading", created: "2026-07-12" });
  assert.deepEqual(parseTodoHead("# BUG-12 — duplicate rows\n\n**Created:** 2026-06-17 (re-filed)\n"), { title: "BUG-12 — duplicate rows", created: "2026-06-17" });
  assert.deepEqual(parseTodoHead("just text"), { title: null, created: null });
  assert.deepEqual(parseTodoHead(null), { title: null, created: null });
});

test("normalizeTodos: gsd-tools rows → contract rows, fallbacks, newest first", () => {
  const rows = [
    { file: "2026-11-12-a.md", path: ".planning/todos/pending/2026-11-12-a.md", title: "A", area: "editor", created: "2026-11-12T09:30:00.000Z" },
    { file: "2026-11-14-b.md", path: ".planning/todos/pending/2026-11-14-b.md", title: '"Quoted \\"B\\""', area: "ui", created: "2026-11-14", severity: "minor" },
    { file: "2026-10-01-c.md", path: ".planning/todos/pending/2026-10-01-c.md", title: "Untitled", area: "general", created: "unknown", head: "# Heading C\n\n**Created:** 2026-10-01\n" },
    { file: "d.md", title: "Untitled", area: "general", created: "unknown", head: "nothing useful" },
    { file: "2026-12-01-e.md", path: ".planning/todos/pending/2026-12-01-e.md", title: "E", area: "x", created: "unknown" },
    null,
  ];
  const todos = normalizeTodos(rows);
  assert.deepEqual(todos.map((t) => t.title), ["E", 'Quoted "B"', "A", "Heading C", "d"]);
  assert.equal(todos[0].created, "2026-12-01", "date from the file name");
  assert.equal(todos[3].created, "2026-10-01");
  assert.equal(todos[4].created, null);
  assert.equal(todos[4].file, ".planning/todos/pending/d.md");
  assert.equal(todos[1].severity, "minor");
  assert.equal(todos[2].severity, null);
  for (const t of todos) assert.deepEqual(Object.keys(t).sort(), ["area", "created", "file", "severity", "title"]);
});

test("sortTodos: undated last, ties by file name descending", () => {
  const out = sortTodos([
    { file: "b.md", created: null }, { file: "2026-01-01-x.md", created: null },
    { file: "z.md", created: "2026-02-01" }, { file: "a.md", created: "2026-02-01" }, { file: "c.md", created: null },
  ]);
  assert.deepEqual(out.map((t) => t.file), ["z.md", "a.md", "2026-01-01-x.md", "c.md", "b.md"]);
});

// ─── MILESTONES.md ───────────────────────────────────────────────────────────

test("parseMilestones: gsd-core's writer format, newest first by date", () => {
  const text = [
    "# Milestones",
    "",
    "## v3.0 Third Region (Shipped: 2026-05-11)",
    "**Phases completed:** 4 phases",
    "## v1.0 Core Services (Shipped: 2026-04-14)",
    "## v2.8 Speed & Tooling (Shipped: 2026-03-16)",
    "### Known Gaps",
    "- v2.8.1 patch shipped later (a detail bullet)",
    "## v2.10 Ten (Shipped: 2026-03-16)",
  ].join("\n");
  const { shipped, present } = parseMilestones(text);
  assert.equal(present, true);
  assert.deepEqual(shipped, [
    { version: "v3.0", name: "Third Region", date: "2026-05-11" },
    { version: "v1.0", name: "Core Services", date: "2026-04-14" },
    { version: "v2.10", name: "Ten", date: "2026-03-16" },
    { version: "v2.8", name: "Speed & Tooling", date: "2026-03-16" },
  ]);
});

test("parseMilestones: closed/wrapped/backfilled/partial variants, superseded skipped", () => {
  const text = [
    "# Project Milestones: Example",
    "## v1.14 Hardening Pass — SUPERSEDED 2026-06-16 by v2.0",
    "## v1.13 Storage Rewrite (Shipped: 2026-05-24)",
    "## v1.11 Mail & Exports (Wrapped: 2026-05-07 — rolled forward to v1.12)",
    "## v1.19 Offline Model (Closed — partial: 2026-06-12)",
    "## v1.13b Landing (Shipped: 2026-04-17 — partial)",
    "## v2.1 Phase Details — Cleanup Round (Shipped: 2026-06-21)",
    "## v1.5 Roadmap: Lantern (Backfilled: 2026-06-14)",
    "## v2.2 Sync Rework — closed as-is (Closed: 2026-07-11)",
    "## Folded: other-repo v1.0 (shipped 2026-06-11)",
    "## v0.1 Undated entry",
  ].join("\n");
  const byVersion = Object.fromEntries(parseMilestones(text).shipped.map((e) => [e.version, e]));
  assert.equal(byVersion["v1.14"], undefined, "superseded is not shipped");
  assert.deepEqual(byVersion["v1.13"], { version: "v1.13", name: "Storage Rewrite", date: "2026-05-24" });
  assert.deepEqual(byVersion["v1.11"], { version: "v1.11", name: "Mail & Exports", date: "2026-05-07" });
  assert.deepEqual(byVersion["v1.19"], { version: "v1.19", name: "Offline Model", date: "2026-06-12" });
  assert.equal(byVersion["v2.1"].name, "Phase Details — Cleanup Round");
  assert.equal(byVersion["v1.5"].name, "Roadmap: Lantern");
  assert.equal(byVersion["v2.2"].name, "Sync Rework", "a trailing status note is not part of the name");
  assert.deepEqual(byVersion["v1.0"], { version: "v1.0", name: "Folded: other-repo", date: "2026-06-11" });
  assert.deepEqual(byVersion["v0.1"], { version: "v0.1", name: "Undated entry", date: null });
  const order = parseMilestones(text).shipped.map((e) => e.version);
  assert.equal(order[order.length - 1], "v0.1", "undated entries sort last");
});

test("parseMilestones: a milestone absorbed into another one was not shipped", () => {
  const text = [
    "# Milestones",
    "## v0.4 Docs Site (Shipped: 2026-03-01)",
    "## v0.5 Rebrand — Blue Sky (Absorbed into v0.6: 2026-07-03)",
    "**Status:** Absorbed, not shipped as a standalone milestone.",
    "## v0.3 Search (Shipped: 2026-02-01 — absorbed the v0.2.1 hotfix)",
  ].join("\n");
  assert.deepEqual(parseMilestones(text).shipped.map((e) => e.version), ["v0.4", "v0.3"]);
});

test("parseMilestones: older emoji headings and ROADMAP-style bullets", () => {
  const headings = "# Milestones\n\n### ✅ v1.1 Security — SHIPPED 2025-12-10\n### ✅ v1.0 MVP — SHIPPED 2025-11-25\n### 🚧 v1.2 Next (In Progress)\n";
  assert.deepEqual(parseMilestones(headings).shipped, [
    { version: "v1.1", name: "Security", date: "2025-12-10" },
    { version: "v1.0", name: "MVP", date: "2025-11-25" },
  ]);
  const bullets = "# Milestones\n\n- ✅ **v1.0 MVP** - Phases 1-4 (shipped 2026-01-10)\n- 🚧 **v1.1 Sync** - Phases 5-6 (in progress)\n- [x] ✅ **v0.9 Beta** — Phases 1-2 (shipped 2025-12-01)\n";
  assert.deepEqual(parseMilestones(bullets).shipped, [
    { version: "v1.0", name: "MVP", date: "2026-01-10" },
    { version: "v0.9", name: "Beta", date: "2025-12-01" },
  ]);
});

test("parseMilestones: missing file, empty file, unparseable file", () => {
  assert.deepEqual(parseMilestones(null), { shipped: [], present: false });
  assert.deepEqual(parseMilestones(""), { shipped: [], present: false });
  assert.deepEqual(parseMilestones("# Milestones\n\nNothing shipped yet, see ROADMAP.\n"), { shipped: [], present: true });
  assert.deepEqual(parseMilestones("## \u0000\u0001 binary-ish ###\n## v\n"), { shipped: [], present: true });
});

test("compareVersions: numeric per segment", () => {
  assert.equal(compareVersions("v1.10", "v1.9"), 1);
  assert.equal(compareVersions("v2", "v2.0"), -1);
  assert.equal(compareVersions("v1.2", "v1.2"), 0);
});

// ─── milestone names ─────────────────────────────────────────────────────────

test("stripInlineMarkdown: code, emphasis and links go, snake_case and emoji stay", () => {
  assert.equal(stripInlineMarkdown("**Bold** __strong__ *em* _em_ `code` [text](https://x.y/z)"), "Bold strong em em code text");
  assert.equal(stripInlineMarkdown("Router proxy + acme_router"), "Router proxy + acme_router");
  assert.equal(stripInlineMarkdown("`snake_case_id` and __dunder__ 🚀 ✅"), "snake_case_id and dunder 🚀 ✅");
  assert.equal(stripInlineMarkdown("***both***"), "both");
  assert.equal(stripInlineMarkdown("2 * 3 * 4 and C# & a_b"), "2 * 3 * 4 and C# & a_b");
  assert.equal(stripInlineMarkdown(null), null);
});

test("milestone names keep word-internal underscores (headings and MILESTONES.md)", () => {
  assert.equal(nameFromHeading("v2.3 Introduce **acme_core** (Phases 1-4)", "v2.3"), "Introduce acme_core");
  assert.deepEqual(parseMilestones("## v1.0 Wire `acme_router` (Shipped: 2026-01-01)\n").shipped, [{ version: "v1.0", name: "Wire acme_router", date: "2026-01-01" }]);
  assert.deepEqual(parseTodoHead("# Retry in acme_router\n"), { title: "Retry in acme_router", created: null });
});

test("nameFromHeading / tidyMilestoneName strip progress decorations", () => {
  assert.equal(nameFromHeading("Milestone v1.4 — Quiet Fixes (Phases 31-48) — 🚧 IN PROGRESS", "v1.4"), "Quiet Fixes");
  assert.equal(nameFromHeading("🚧 v2.3 Shared Kit (Wave B) (In Progress)", "v2.3"), "Shared Kit (Wave B)");
  assert.equal(nameFromHeading("v2.0 Phase Details — Public Launch", "v2.0"), "Public Launch");
  assert.equal(nameFromHeading("v3.0 Something", "v9.9"), null);
  assert.equal(nameFromHeading(undefined, "v1"), null);
  assert.equal(tidyMilestoneName("Go-live & first users (MVP) — ◆ CURRENT"), "Go-live & first users (MVP)");
  assert.equal(tidyMilestoneName("Adopt X + v2.3 Tail (Phases 132-143) — IN PROGRESS"), "Adopt X + v2.3 Tail");
  assert.equal(tidyMilestoneName("Billing"), "Billing");
  assert.equal(tidyMilestoneName(""), null);
});
