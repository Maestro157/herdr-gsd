// Fixture snapshots in the data layer's Snapshot shape, for `herdr-app check`
// and for looking at the panel in every state. Nothing here reads the disk.
// Every name in here is invented.

const pct = (done, total) => (total > 0 ? Math.round((done / total) * 100) : null);

// A small seeded generator, so a fixture is the same on every load.
function rng(seed) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x9e3779b9) >>> 0) / 4294967296);
}

const WORDS = ["Auth", "Billing", "Search", "Sync", "Sharing", "Analytics", "Uploads", "Inbox", "Reminders",
  "Notifications", "Onboarding", "Workflow", "Jobs", "Webhooks", "Exports", "Reporting", "Tracking", "Imports"];
const VERBS = ["Hardening", "Wiring", "Cleanup", "Rework", "Migration", "Gap closure", "Polish", "Reliability", "Rollout"];
const AREAS = ["backend", "frontend", "infra", "sync", "ai", "docs", null, "tests", null];
const TODO_VERBS = ["Fix", "Add", "Remove", "Document", "Investigate", "Backfill", "Tighten", "Split", "Cache", "Retry"];
const TODO_THINGS = ["stale search ranking", "duplicate webhook deliveries", "the share link redirect", "slow notebook list query",
  "missing unsubscribe header", "flaky background job test", "orphaned attachment uploads", "rate limiter metrics",
  "export column order", "digest email copy", "workspace switcher focus", "token masking in logs"];

function phase(id, name, status, plans, summaries, extra = {}) {
  return { id: String(id), name, dir: `${String(id).padStart(2, "0")}-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
    status, plans, summaries, current: false, goal: null, ...extra };
}

function day(offset) {
  const d = new Date(Date.UTC(2026, 10, 17) - offset * 86400000);
  return d.toISOString().slice(0, 10);
}

function base(over) {
  return {
    state: "ok", error: null, root: "/home/dev/work/lumen-notes", planningRoot: "/home/dev/work/lumen-notes/.planning",
    viaWorktree: false, project: "lumen-notes", milestone: { version: null, name: null, label: "Roadmap" },
    progress: { phases: { completed: 0, total: 0, percent: null }, plans: { completed: 0, total: 0, percent: null } },
    position: { phase: null, plan: null, status: null }, phases: [], todos: [], shipped: [], warnings: [],
    loadedAt: Date.now(), ...over,
  };
}

// Progress straight from the phase list, as the data layer would report it.
function withProgress(snap) {
  const done = snap.phases.filter((p) => p.status === "done").length;
  const plans = snap.phases.reduce((n, p) => n + p.plans, 0), sums = snap.phases.reduce((n, p) => n + Math.min(p.summaries, p.plans), 0);
  snap.progress = { phases: { completed: done, total: snap.phases.length, percent: pct(done, snap.phases.length) },
    plans: { completed: sums, total: plans, percent: pct(sums, plans) } };
  return snap;
}

function rich() {
  const phases = [
    phase(14, "Launch Bug Fixes and Stabilization", "done", 3, 3),
    phase(15, "Shared Notebooks Frontend and Permissions Dashboard", "done", 3, 3),
    phase(16, "Search Index Rebuild", "done", 5, 5),
    phase(17, "Offline Sync and Conflict Hints", "done", 6, 6),
    phase(18, "Calendar Tasks and Template Builder", "done", 5, 5),
    phase(19, "Session Handling and Rate Limiter Gap Closure", "done", 4, 4),
    phase(20, "Reminder Engine Runtime Wiring", "done", 3, 3),
    phase(21, "Digest Emails and Bounce Alerts", "done", 2, 2),
    phase(22, "Tech Debt Sweep", "done", 2, 2),
    phase(23, "Attachment Uploads", "done", 6, 6),
    phase("23.1", "Upload signature check hotfix", "done", 1, 1),
    phase(24, "Voice Memos & Transcription", "done", 3, 3),
    phase(25, "Voice Memo Search Integration", "done", 4, 4),
    phase(26, "Public Share Pages", "executing", 4, 2, { current: true, goal: "Every shared notebook gets a public read-only page with view counts." }),
    phase(27, "Critical Fixes — Memo Upload & Background Jobs", "planned", 2, 0),
    phase(28, "Share Page Service Wiring", "planned", 3, 0),
    phase(29, "Import from Plain Markdown Folders", "not_started", 0, 0),
    phase(30, "Sharing Correctness", "not_started", 0, 0),
    phase(31, "Usage Funnel Snapshots", "not_started", 0, 0),
    phase(32, "On-call Runbook", "not_started", 0, 0, { dir: "" }),
  ];
  const todos = [
    ["Guess notebook icon from its first heading", "sync", 0],
    ["Usage snapshots table has no writer and no reader yet", "backend", 1],
    ["Storage API audit: remaining slice", "backend", 3],
    ["Retry policy for mail provider 429s", "backend", 4],
    ["Share page preview image fallback", "frontend", 6],
    ["Document the share-link resolver", "docs", 9],
    ["Workspace switcher loses focus after delete", "frontend", 12],
    ["Background worker memory ceiling", "infra", 15],
    ["Token masking in structured logs", null, 21],
    ["Digest email copy", "frontend", 30],
    ["Notebook query is slow above 50k notes", "backend", 41],
  ].map(([title, area, d], i) => ({ title, file: `.planning/todos/pending/${day(d)}-todo-${i}.md`, area, created: day(d) }));
  return withProgress(base({
    milestone: { version: "v1.2", name: "Public Sharing", label: "v1.2 Public Sharing" },
    position: { phase: "26", phaseName: "Public Share Pages", plan: "26-03", status: "executing" },
    phases, todos,
    shipped: [
      { version: "v1.1", name: "Collaboration Basics", date: "2026-04-10" },
      { version: "v1.0", name: "MVP", date: "2026-03-10" },
    ],
    warnings: ["ROADMAP.md lists phase 23.1 but no plan for it was found in phases/"],
  }));
}

function huge() {
  const r = rng(135);
  const phases = [];
  for (let i = 1; i <= 135; i++) {
    const id = i % 17 === 0 ? `${i - 1}.1` : String(i);
    const name = `${WORDS[Math.floor(r() * WORDS.length)]} ${VERBS[Math.floor(r() * VERBS.length)]}`;
    const plans = 1 + Math.floor(r() * 8);
    const status = i <= 110 ? "done" : i === 111 ? "executing" : i <= 114 ? "planned" : "not_started";
    const summaries = status === "done" ? plans : status === "executing" ? Math.floor(plans / 2) : 0;
    phases.push(phase(id, name, status, status === "not_started" ? 0 : plans, summaries, { current: i === 111 }));
  }
  const todos = [];
  for (let i = 0; i < 264; i++) {
    const title = `${TODO_VERBS[Math.floor(r() * TODO_VERBS.length)]} ${TODO_THINGS[Math.floor(r() * TODO_THINGS.length)]}`;
    const d = Math.floor(i * 0.9);
    todos.push({ title, file: `.planning/todos/pending/${day(d)}-t${i}.md`, area: AREAS[i % AREAS.length], created: i % 23 === 7 ? null : day(d) });
  }
  const shipped = [];
  for (let v = 12; v >= 1; v--) shipped.push({ version: `v1.${v}`, name: v % 4 === 0 ? null : `${WORDS[v % WORDS.length]} ${VERBS[v % VERBS.length]}`, date: day(200 - v * 12) });
  return withProgress(base({
    milestone: { version: "v1.13", name: "Team Workspaces (self-hosted)", label: "v1.13 Team Workspaces (self-hosted)" },
    position: { phase: "111", plan: "111-02", status: "executing" },
    phases, todos, shipped,
    warnings: ["3 phase directories are not in ROADMAP.md", "STATE.md frontmatter has no milestone", "todos/pending has 2 files without a title"],
  }));
}

function nullPercents() {
  const s = rich();
  s.project = "half-migrated";
  s.progress = { phases: { completed: 3, total: 20, percent: null }, plans: { completed: 47, total: 61, percent: null } };
  s.milestone = { version: null, name: null, label: "Roadmap" };
  s.position = { phase: "26", plan: null, status: null };
  s.warnings = ['ROADMAP milestone window is "fallback": the phase list is best-effort', 'gsd-tools withholds the plan percentage (phase directory scope "fallback")'];
  return s;
}

// What the data layer reports for a project whose ROADMAP gsd-tools can't read:
// no phases, a warning saying why, and todos and shipped milestones all the same.
function noRoadmap() {
  const s = rich();
  s.project = "notes-sidecar";
  s.milestone = { version: "v2.0", name: null, label: "v2.0" };
  s.phases = [];
  s.progress = { phases: { completed: 0, total: 0, percent: null, verified: null }, plans: { completed: 0, total: 0, percent: null } };
  s.position = { phase: "4", plan: null, status: "Ready to plan" };
  s.todos = s.todos.slice(0, 3);
  s.warnings = ["No ROADMAP.md in .planning — no phases to show",
    "roadmap analyze failed with gsd-core 1.4.2 (~/.claude): Unknown command: roadmap — used get-shit-done 1.30.0 (~/.claude)"];
  return s;
}

function longText() {
  const s = rich();
  const long = "Hardening: background work, syncing and AI correctness across every queue, worker and provider fallback path, including the parts nobody remembers";
  s.project = "an-extremely-long-project-name-that-keeps-going-well-past-any-sidebar-width";
  s.milestone = { version: "v1.6", name: "Team Workspaces (self-hosted) and a deliberately long milestone name to test truncation", label: "v1.6 Team Workspaces (self-hosted) and a deliberately long milestone name to test truncation" };
  s.position = { phase: "75.4", phaseName: long, plan: "75.4-03-a-very-long-plan-identifier", status: "Phase 69 (markdown folder import for shared notebooks) SEALED 2026-08-19 — executed 9/9, verified 15/15, UAT 8/8, human verification 5/5, status passed. The last human item (link preview narrowing in prod) was closed by measurement rather than left open: prod holds ZERO public notebooks, so no share token can resolve. Follow-ups were filed as todos for the next milestone: the preview cache needs a size cap, the importer should skip hidden folders, and the share page should say when a notebook was unpublished instead of showing a bare 404. None of these block the milestone audit." };
  s.phases = s.phases.map((p, i) => (i % 3 === 0 ? { ...p, name: `${p.name} — ${long}` } : p));
  s.phases.push(phase("75.4", long, "executing", 12, 3));
  s.phases = s.phases.map((p) => ({ ...p, current: p.id === "75.4" }));
  s.todos = s.todos.map((t, i) => (i % 2 === 0 ? { ...t, title: `${t.title}: ${long}`, area: "a-very-long-area-name-for-testing" } : t));
  s.warnings = [`${long}. ${long}.`, "Short warning"];
  s.viaWorktree = true;
  return withProgress(s);
}

export const FIXTURES = {
  rich,
  huge,
  empty: () => base({ project: "fresh-start", progress: { phases: { completed: 0, total: 0, percent: 0 }, plans: { completed: 0, total: 0, percent: 0 } } }),
  nullpct: nullPercents,
  noroadmap: noRoadmap,
  none: () => base({ state: "none", root: null, planningRoot: null, project: null, milestone: { version: null, name: null, label: "No milestone" } }),
  error: () => base({ state: "error", error: "Could not read .planning/STATE.md: permission denied", planningRoot: null, project: null, milestone: { version: null, name: null, label: "No milestone" } }),
  worktree: () => ({ ...rich(), viaWorktree: true, root: "/home/dev/.herdr/worktrees/lumen-notes/fix-login" }),
  long: longText,
};

/** A fresh copy of one fixture, by name (unknown names give "rich"). */
export function mockSnapshot(name) {
  return (FIXTURES[name] ?? FIXTURES.rich)();
}

// ── details (PhaseDetail / TodoDetail) ──────────────────────────────────────

const PLAN_TOPICS = ["schema", "API route", "share token", "rate limit", "page shell", "view counter", "preview image",
  "cache headers", "access log", "unpublish flow", "error page", "e2e test", "docs", "metrics", "rollout flag"];

function richPhase(phase) {
  const r = rng(26);
  const plans = [];
  const waves = [9, 11, 10, 8, 6];
  let n = 0;
  waves.forEach((count, w) => {
    for (let i = 0; i < count; i++) {
      n++;
      const topic = PLAN_TOPICS[Math.floor(r() * PLAN_TOPICS.length)];
      plans.push({ id: `${phase.id}-${String(n).padStart(2, "0")}`, title: n % 13 === 0 ? null
        : `${["Add", "Wire", "Harden", "Test", "Document"][n % 5]} the ${topic}${n % 7 === 0 ? " for notebooks shared with a whole workspace, including the ones nobody opened yet" : ""}`,
        wave: w + 1, done: w < 2 || (w === 2 && i < 4) });
    }
  });
  return {
    state: "ok", error: null, id: phase.id, name: phase.name, status: phase.status,
    goal: phase.goal || "Every shared notebook gets a public read-only page with view counts, a preview image for link unfurls, and a way to take it down again that also clears every cache the page went through.",
    dependsOn: ["24", "25"],
    requirements: [
      { id: "SHARE-01", text: "A notebook owner can publish a read-only page", done: true },
      { id: "SHARE-02", text: "The page shows how often it was viewed, without tracking who viewed it", done: true },
      { id: "SHARE-03", text: "Link previews show the notebook's title and first image", done: false },
      { id: "SHARE-04", text: "Unpublishing removes the page and every cached copy within a minute", done: null },
      { id: "SHARE-05", text: null, done: null },
      { id: "SEC-11", text: "Share tokens can't be guessed or enumerated, and an expired token says so instead of returning a bare 404", done: false },
    ],
    successCriteria: [
      "Publishing a notebook gives a link that opens without signing in, in every supported browser, on a phone as well as a desktop.",
      "The view count goes up once per visit and never shows who visited.",
      "A link pasted into a chat shows the notebook's title and first image within a few seconds.",
      "After unpublishing, the link answers with a clear 'no longer shared' page within one minute, including through the CDN.",
      "Nothing about a private notebook (title, size, owner) can be learned from its share URL.",
    ],
    plans,
    verification: { status: "gaps_found", detail: "2 of 5 criteria not met yet: link previews (SHARE-03) and the unpublish cache flush (SHARE-04) still fail their checks." },
    uat: { status: "pending", detail: null },
    warnings: ["26-07-PLAN.md has no wave; listed last"],
    loadedAt: Date.now(),
  };
}

function minimalPhase(phase) {
  return { state: "ok", error: null, id: phase.id, name: phase.name, status: phase.status, goal: phase.goal ?? null,
    dependsOn: [], requirements: [], successCriteria: [], plans: [], verification: null, uat: null, warnings: [], loadedAt: Date.now() };
}

const TODO_BODY = `## Problem

The share page answers with a **bare 404** once a notebook is unpublished, so people who follow an old link think the site is broken. It also leaks *timing*: an unpublished page answers faster than one that never existed.

## What to do

1. Keep a tombstone for unpublished share tokens
   - store the token hash, not the token
   - expire it after 90 days
2. Answer with a friendly "no longer shared" page and a \`410 Gone\` status
3. Make both answers take the same time

### Where

- \`api/share/resolve.ts\` — the lookup
- \`web/pages/share/[token].tsx\` — the page

\`\`\`ts
// resolve.ts: the one place a token turns into a notebook
export async function resolveShareToken(token: string, db: Db): Promise<ShareTarget | ShareTombstone | null> { return (await db.shares.findByHash(hashToken(token))) ?? (await db.tombstones.findByHash(hashToken(token))); }
\`\`\`

| Case | Today | Wanted | Notes |
|------|-------|--------|-------|
| never existed | 404 | 404 | same timing as 410 |
| unpublished | 404 | 410 + page | tombstone hit |
| expired tombstone | 404 | 404 | after 90 days |

> Related: the CDN keeps the old 200 for up to a minute — see the unpublish flush todo.

See also [the share design note](https://example.com/notes/share-design).
`;

export const DETAIL_FIXTURES = {
  phase: { rich: richPhase, minimal: minimalPhase,
    error: (phase) => ({ ...minimalPhase(phase), state: "error", error: "gsd-tools roadmap get-phase failed: ROADMAP.md has no section for this phase" }) },
  todo: {
    long: (todo) => ({ state: "ok", error: null, title: todo.title, area: todo.area ?? "backend", created: todo.created ?? "2026-11-12", severity: "high",
      files: ["api/share/resolve.ts", "web/pages/share/[token].tsx", "infra/cdn/purge-rules-for-share-pages-and-preview-images.yaml"],
      path: todo.file || ".planning/todos/pending/2026-11-12-share-page-404.md", body: TODO_BODY, truncated: true, loadedAt: Date.now() }),
    empty: (todo) => ({ state: "ok", error: null, title: todo.title, area: todo.area ?? null, created: todo.created ?? null, severity: null,
      files: [], path: todo.file || ".planning/todos/pending/2026-11-17-empty.md", body: "", truncated: false, loadedAt: Date.now() }),
    error: (todo) => ({ state: "error", error: "Could not read .planning/todos/pending/2026-11-12-share-page-404.md: no such file", title: todo.title,
      area: null, created: null, severity: null, files: [], path: todo.file || "", body: "", truncated: false, loadedAt: Date.now() }),
  },
};

/** A phase's details from the fixtures: `name` picks one, else a phase without plans gets the minimal one. */
export function mockPhaseDetail(phase, name) {
  const pick = DETAIL_FIXTURES.phase[name] ?? (phase.plans > 0 ? richPhase : minimalPhase);
  return pick(phase);
}

/** A todo's details from the fixtures: `name` picks one, else the long markdown one. */
export function mockTodoDetail(todo, name) {
  return (DETAIL_FIXTURES.todo[name] ?? DETAIL_FIXTURES.todo.long)(todo);
}
