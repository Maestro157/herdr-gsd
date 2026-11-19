// Data layer of the GSD panel: finds the focused space's GSD project (its
// `.planning/` folder) and reads its progress through the project's own
// `gsd-tools`. Plain ES module with no imports: Herdr injects `exec` and
// `readTextFile`, and `node --test` injects child_process/fs stand-ins.
//
// ─── One round-trip per load ────────────────────────────────────────────────
// `loadGsd` runs ONE `exec("sh", ["-c", SCRIPT, …])` on the space's machine.
// The same POSIX sh script runs locally and remotely (no bashisms, no GNU-only
// flags; paths travel as positional arguments, never inside the script text):
//   1. cd to the folder, resolve the project root (see SCRIPT), print it;
//   2. find node and every installed gsd-tools.cjs;
//   3. exec `node -e DRIVER root tools…`. The driver runs, in parallel,
//      `gsd-tools roadmap analyze`, `gsd-tools state-snapshot`, `gsd-tools list-todos`
//      (each `--cwd <root>`, falling through to the next install when one fails
//      or lacks the command, but not after a timeout; the whole driver finishes
//      within BUDGET_MS), reads STATE.md / MILESTONES.md / phases/ itself,
//      trims everything to what the panel shows and prints ONE JSON object.
// Every outcome is a marker line `@@gsd:<nonce> <word> …` (nonce = per load),
// so file content can never be mistaken for protocol.
//
// ─── Why these queries (measured on the largest projects on this machine) ──
// `planning inspect` (schema v1) was the first choice but is unusable here:
// 1.8–2.4 MB of JSON, 10–33 s on a 135-phase repo, because every phase runs
// `git log` for verification staleness, and it has no phase titles at all.
// `roadmap analyze` gives exactly the panel's view in 44 KB: the current
// milestone's phases in ROADMAP order (including ones with no directory yet),
// their titles, goals, plan/summary counts, disk status and checkbox.
// Its git calls (`git log`/`git diff` per verified phase, advisory "which files
// moved" detail only) are 85–95% of its time; the driver runs gsd-tools with no
// git on PATH, which gsd-tools treats as "git unavailable" and degrades
// gracefully. Output was byte-identical with and without git on the two
// biggest projects; time dropped from 6.8 s to 0.7 s.
// None of the three commands writes anything under `.planning/` (source read
// + recursive mtime snapshots before/after; see test/gsd). gsd-tools spills
// JSON over 50 KB through a temp file in os.tmpdir(), never in the project.
//
// ─── Semantics worth knowing ───────────────────────────────────────────────
// • phases = the CURRENT milestone's section of ROADMAP.md (gsd-tools'
//   `extractCurrentMilestoneScoped`), so a repo with 135 phase dirs shows the
//   59 phases of the running milestone, 40 of which may have no folder yet.
//   `scope` other than "complete" means gsd-tools could not cleanly window the
//   milestone; the list is then best-effort and a warning says so.
// • gsd-tools' own "complete" (disk_status "complete") requires a passing,
//   non-stale *-VERIFICATION.md. Most real phases are "executed" (all plans
//   summarised, verification missing/stale), so GSD alone would report 0/59.
//   The panel's rule (below) counts executed phases as done and reports GSD's
//   strict count separately as `progress.phases.verified` (null when an older
//   gsd-tools answered: before `scope` existed, "complete" meant executed).
// • plans completed / total / percent all come from roadmap analyze's totals for
//   the listed phases; percent is null when gsd-tools withholds its own
//   `progress_percent` (milestone directory scope not "complete") or when
//   ROADMAP.md lists phases gsd-tools cannot read. Never coerced to 0.
// • position comes from STATE.md as gsd-tools reads it (`state-snapshot`: the
//   same phase and status `planning inspect` reports as `active`), plus the
//   `Plan:` line of `## Current Position` (inspect's active.plan). The milestone
//   is STATE.md's frontmatter `milestone` / `milestone_name`, else the ROADMAP
//   milestone heading. (`state json` would canonicalise the name a little
//   better but recomputes progress from disk: +0.9 s CPU on a 135-phase repo.)
//   STATE.md is hand-edited and often inconsistent; values are shown as written,
//   except: the current phase's name is the ROADMAP's when the phase is listed,
//   and a bare snake_case status ("awaiting_next_milestone") gets spaces.
//   Names lose inline markdown (`code`, **bold**, _em_, [link](url)).

const MARK = "@@gsd:";
const EXEC_TIMEOUT = 60000;

// ─── locate ─────────────────────────────────────────────────────────────────

/** The focused folder, the way the shipped Changes panel finds it: the focused
 *  pane's cwd, else focused().cwd, else the active space's folder. `on` is the
 *  space's machine (null = this computer); a focused layout terminal block
 *  (pane === null) is on the machine its address names. */
export function locate(live) {
  const spaces = live?.spaces ?? [], panes = live?.panes ?? [], f = live?.focused ?? null;
  const space = spaces.find((s) => s.active);
  if (!space) return null;
  const pane = f?.pane ? panes.find((p) => p.pane === f.pane) : null;
  const on = f && f.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || space.folder;
  if (!cwd) return null;
  return { cwd, on, spaceId: space.id };
}

// ─── the script (POSIX sh) ──────────────────────────────────────────────────
// $1 folder, $2 nonce, $3 driver source, $4 one argument for the driver (JSON
// or empty). Paths are printed with printf, never
// echo: dash's and macOS sh's echo expand backslashes ("\c" ends the line).
// Git runs read-only: GIT_OPTIONAL_LOCKS=0
// is `--no-optional-locks` (accepted by git of any age), plus the Changes
// panel's fsmonitor / autoRefreshIndex flags. Only rev-parse and worktree list
// run, neither touches the index.
//
// Root rule (mirrors gsd-tools' own resolver, project-context.cjs):
//   in git:   walk up from the folder to the checkout's top for a .planning/;
//             none, and the checkout is a linked worktree → the same relative
//             folder in the main checkout (first `git worktree list` entry),
//             walking up to its top → viaWorktree;
//             still none → an ancestor above the checkout whose
//             .planning/config.json declares sub_repos / multiRepo (GSD workspace);
//   not git:  walk up to / (stopping after $HOME).
//
// gsd-tools, in GSD's own resolver order: the project's gsd-core, .claude/ and
// .codex/ installs, then ${CLAUDE_CONFIG_DIR:-~/.claude}/gsd-core, then
// ${CODEX_HOME:-~/.codex}/gsd-core. Legacy get-shit-done installs only when
// there is no gsd-core at all (their roadmap reading differs; the panel warns).
// node: PATH, then the newest nvm version, then fixed locations, and last the
// login shell's PATH (5 s at most; only a marked, absolute, executable path).
export const SCRIPT = `M="${MARK}$2"
D=$3
A=$4
GIT_OPTIONAL_LOCKS=0; GIT_TERMINAL_PROMPT=0; export GIT_OPTIONAL_LOCKS GIT_TERMINAL_PROMPT
cd "$1" 2>/dev/null || { echo "$M nocwd"; exit 0; }
here=$(pwd -P) || here=$1
H=$(cd "$HOME" 2>/dev/null && pwd -P) || H=$HOME
found=
via=0
g() { git -c core.fsmonitor=false -c diff.autoRefreshIndex=false "$@" 2>/dev/null; }
phys() { (cd "$1" 2>/dev/null && pwd -P); }
up() {
  d=$1
  while :; do
    if [ -d "$d/.planning" ]; then found=$d; return 0; fi
    if [ "$d" = "$2" ] || [ "$d" = / ] || [ -z "$d" ]; then return 1; fi
    if [ -z "$2" ] && [ "$d" = "$H" ]; then return 1; fi
    d=$(dirname "$d")
  done
}
nvm_node() {
  for c in "$HOME"/.nvm/versions/node/v*/bin/node; do
    if [ -x "$c" ]; then printf '%s\\n' "\${c#"$HOME/.nvm/versions/node/v"}"; fi
  done | sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
}
login_node() {
  case $SHELL in /*) ;; *) return 0 ;; esac
  [ -x "$SHELL" ] || return 0
  f=$(mktemp 2>/dev/null) || return 0
  "$SHELL" -lc 'printf "\\n@@gsdnode:%s\\n" "$(command -v node)"' </dev/null >"$f" 2>/dev/null &
  p=$!
  i=0
  while [ $i -lt 5 ] && kill -0 "$p" 2>/dev/null && ! grep -q '^@@gsdnode:' "$f"; do sleep 1; i=$((i+1)); done
  kill "$p" 2>/dev/null
  r=$(sed -n 's/^@@gsdnode://p' "$f" | tail -n 1)
  rm -f "$f"
  case $r in /*) if [ -f "$r" ] && [ -x "$r" ]; then printf '%s\\n' "$r"; fi ;; esac
}
top=
if command -v git >/dev/null 2>&1 && r=$(g rev-parse --show-toplevel --git-dir --git-common-dir) && [ -n "$r" ]; then
  top=$(printf '%s\\n' "$r" | sed -n 1p)
  gd=$(printf '%s\\n' "$r" | sed -n 2p)
  cm=$(printf '%s\\n' "$r" | sed -n 3p)
  top=$(phys "$top")
fi
if [ -n "$top" ]; then
  if ! up "$here" "$top"; then
    case $gd in /*) ;; *) gd=$here/$gd ;; esac
    case $cm in /*) ;; *) cm=$here/$cm ;; esac
    gd=$(phys "$gd"); cm=$(phys "$cm")
    if [ -n "$cm" ] && [ "$gd" != "$cm" ]; then
      main=$(g worktree list --porcelain | sed -n 's/^worktree //p' | sed -n 1p)
      [ -n "$main" ] && main=$(phys "$main")
      if [ -n "$main" ] && [ "$main" != "$top" ]; then
        rel=\${here#"$top"}
        if up "$main$rel" "$main"; then via=1; fi
      fi
    fi
    if [ -z "$found" ]; then
      d=$top
      while [ "$d" != / ] && [ "$d" != "$H" ]; do
        d=$(dirname "$d")
        if [ -d "$d/.planning" ] && grep -Eq '"(sub_repos|multiRepo)"' "$d/.planning/config.json" 2>/dev/null; then found=$d; break; fi
      done
    fi
  fi
else
  up "$here" ""
fi
[ -n "$found" ] || { echo "$M none"; exit 0; }
printf '%s\\n' "$M root $found"
echo "$M via $via"
N=$(command -v node 2>/dev/null) || N=
case $N in /*) ;; *) N= ;; esac
if [ -z "$N" ]; then
  v=$(nvm_node)
  if [ -n "$v" ]; then N=$HOME/.nvm/versions/node/v$v; fi
fi
if [ -z "$N" ]; then
  for c in "$HOME/.volta/bin/node" "$HOME/.local/share/mise/shims/node" "$HOME/.asdf/shims/node" "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node /snap/bin/node; do
    if [ -x "$c" ]; then N=$c; break; fi
  done
fi
[ -n "$N" ] || N=$(login_node)
[ -n "$N" ] || { echo "$M nonode"; exit 0; }
set --
for t in "$found/gsd-core" "$found/.claude/gsd-core" "$found/.codex/gsd-core" "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}/gsd-core" "\${CODEX_HOME:-$HOME/.codex}/gsd-core"; do
  t=$t/bin/gsd-tools.cjs
  dup=
  for x in "$@"; do if [ "$x" = "$t" ]; then dup=1; fi; done
  if [ -z "$dup" ] && [ -f "$t" ]; then set -- "$@" "$t"; fi
done
if [ $# -eq 0 ]; then
  for t in "$HOME/.claude" "$HOME/.codex" "$HOME/.gemini" "$HOME/.gemini/antigravity" "$HOME/.config/opencode" "$HOME/.copilot" "$HOME/.cursor"; do
    if [ -f "$t/get-shit-done/bin/gsd-tools.cjs" ]; then set -- "$@" "$t/get-shit-done/bin/gsd-tools.cjs"; fi
  done
fi
[ $# -gt 0 ] || { echo "$M notools"; exit 0; }
printf '%s\\n' "$M node $N"
echo "$M driver"
exec "$N" -e "$D" "$found" "$A" "$@"
`;

// ─── the driver (node -e; ES5-level so old remote nodes run it) ─────────────
// argv: root, one JSON argument (or ""), then gsd-tools.cjs candidates in
// preference order. DRIVER_COMMON holds the parts every driver shares: the
// environment, the time budget and `attempt` (install fallback); a driver body
// fills TRIM and CMDS, reads its files and calls start().
const DRIVER_COMMON = String.raw`
var cp = require("child_process"), fs = require("fs"), path = require("path");
var root = process.argv[1], tools = process.argv.slice(3), planning = path.join(root, ".planning");
var arg = {};
try { arg = JSON.parse(process.argv[2] || "{}") || {}; } catch (e) { arg = {}; }
var home = process.env.HOME || "";
var env = {};
Object.keys(process.env).forEach(function (k) { env[k] = process.env[k]; });
env.PATH = "/nonexistent/gsd-panel-no-git";
env.GIT_OPTIONAL_LOCKS = "0"; env.NO_COLOR = "1"; env.FORCE_COLOR = "0";
// v1 = gsd-tools' default: a payload-carried error ({error: ...}) still exits 0.
// v2 (or a typo) in the user's environment would turn those into failures.
env.GSD_EXIT_CONTRACT = "v1";
// Each gsd-tools run gets STEP_MS; the whole driver BUDGET_MS, safely inside
// loadGsd's EXEC_TIMEOUT so it always prints and reaps its own children.
var T0 = Date.now(), STEP_MS = 45000, BUDGET_MS = 50000;
function read(p, max) { try { var s = fs.readFileSync(p, "utf8"); return s.length > max ? s.slice(0, max) : s; } catch (e) { return null; } }
function first(s) {
  // The line that says what went wrong: "Error: ..." / "TypeError: ..." beats node's "file:line" stack header.
  var lines = String(s || "").split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
  var hit = lines.filter(function (l) { return /^(?:[A-Z]\w*)?Error\b[:\s]/.test(l) || /^gsd-tools: error/i.test(l); })[0];
  var line = hit || lines.filter(function (l) { return !/^(?:node:internal|at |\^|throw |gsd-tools: warning)/.test(l); })[0] || lines[0] || "";
  return line.replace(/^Error:\s*/, "").slice(0, 500);
}
function label(t) {
  var v = read(path.join(path.dirname(path.dirname(t)), "VERSION"), 64);
  var kind = /gsd-core/.test(t) ? "gsd-core" : /get-shit-done/.test(t) ? "get-shit-done" : "gsd-tools";
  var where = path.dirname(path.dirname(path.dirname(t)));
  if (home && where.indexOf(home) === 0) where = "~" + where.slice(home.length);
  return { path: t, version: v ? v.trim() : null, label: kind + (v ? " " + v.trim() : "") + " (" + where + ")" };
}
var out = { driver: 1, root: root, node: process.version, tools: tools.map(label), results: {}, files: {} };
// VERDICT: commands whose non-zero exit is an answer ("phase uat-passed" exits 1 for "not passed").
var TRIM = {}, CMDS = {}, VERDICT = {}, left = 0;
function finish() {
  if (--left > 0) return;
  process.stdout.write(JSON.stringify(out));
}
function attempt(name, i, failures) {
  var budget = BUDGET_MS - (Date.now() - T0);
  if (i >= tools.length || budget < 1000) { out.results[name] = { ok: false, failures: failures }; return finish(); }
  var t0 = Date.now();
  cp.execFile(process.execPath, [tools[i]].concat(CMDS[name], ["--cwd", root]),
    { cwd: root, env: env, timeout: Math.min(STEP_MS, budget), maxBuffer: 64 * 1024 * 1024, windowsHide: true },
    function (err, stdout, stderr) {
      var json = null;
      try { json = JSON.parse(stdout); } catch (e) {}
      var answered = !err || (VERDICT[name] && !err.killed && typeof err.code === "number");
      if (answered && json && typeof json === "object" && !Array.isArray(json)) {
        var data;
        try { data = TRIM[name](json); } catch (e) { data = null; }
        if (data) { out.results[name] = { ok: true, tool: i, ms: Date.now() - t0, data: data, failures: failures }; return finish(); }
      }
      var why = err && err.killed ? "timed out"
        : (first(stderr) || (err && typeof err.code === "number" ? "exit code " + err.code : first(err && err.message)) || "no JSON output");
      failures.push({ tool: i, ms: Date.now() - t0, error: why });
      // A project too slow for one install is too slow for the next: stop here.
      if (err && err.killed) { out.results[name] = { ok: false, failures: failures }; return finish(); }
      attempt(name, i + 1, failures);
    });
}
function start() {
  left = Object.keys(CMDS).length;
  if (!left) { left = 1; return finish(); }
  Object.keys(CMDS).forEach(function (name) { attempt(name, 0, []); });
}
`;

// The snapshot driver: roadmap analyze + state-snapshot + list-todos, plus
// STATE.md, MILESTONES.md and the phases/ listing read directly.
export const DRIVER = DRIVER_COMMON + String.raw`
TRIM = {
  roadmap: function (j) {
    return {
      error: j.error || null, scope: j.scope, progress_scope: j.progress_scope,
      phases: Array.isArray(j.phases) ? j.phases.map(function (p) {
        return { number: p.number, name: p.name, goal: typeof p.goal === "string" ? p.goal.slice(0, 600) : null,
          plan_count: p.plan_count, summary_count: p.summary_count, disk_status: p.disk_status, roadmap_complete: p.roadmap_complete };
      }) : null,
      milestones: Array.isArray(j.milestones) ? j.milestones.slice(0, 5) : [],
      phase_count: j.phase_count, completed_phases: j.completed_phases, total_plans: j.total_plans,
      total_summaries: j.total_summaries, progress_percent: j.progress_percent, current_phase: j.current_phase, next_phase: j.next_phase,
      missing_phase_details: Array.isArray(j.missing_phase_details) ? j.missing_phase_details.slice(0, 100) : null
    };
  },
  state: function (j) {
    var o = {};
    ["error", "milestone", "milestone_name", "current_phase", "current_phase_name", "current_plan", "status"].forEach(function (k) {
      if (j[k] !== undefined) o[k] = typeof j[k] === "string" ? j[k].slice(0, 2000) : j[k];
    });
    return o;
  },
  todos: function (j) {
    return { count: j.count, todos: Array.isArray(j.todos) ? j.todos.slice(0, 5000).map(function (t) {
      var o = { file: t.file, path: t.path, title: t.title, area: t.area, created: t.created, severity: t.severity };
      if (t.title === "Untitled" || t.created === "unknown" || !t.title || !t.created)
        o.head = read(path.join(root, t.path || path.join(".planning", "todos", "pending", String(t.file))), 2048);
      return o;
    }) : null };
  }
};
var st = read(path.join(planning, "STATE.md"), 1048576);
if (st !== null) {
  var fm = "", pos = "", m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(\r?\n|$)/.exec(st);
  if (m) fm = m[1].slice(0, 16384);
  var at = st.search(/^#{2,3}[ \t]+Current Position[ \t]*$/m);
  if (at >= 0) { var rest = st.slice(at); var end = rest.slice(3).search(/^#{1,2}[ \t]/m); pos = (end < 0 ? rest : rest.slice(0, end + 3)).slice(0, 4096); }
  out.files.state = (fm ? "---\n" + fm + "\n---\n\n" : "") + pos;
} else out.files.state = null;
var ms = read(path.join(planning, "MILESTONES.md"), 8388608);
out.files.milestones = ms === null ? null : ms.split(/\r?\n/).filter(function (l) {
  return /^\s{0,3}#{1,6}\s/.test(l) || /^\s*[-*+]\s+(\[[xX ]\]\s*)?(\u2705|\*\*v\d)/.test(l);
}).slice(0, 3000).map(function (l) { return l.slice(0, 400); }).join("\n");
try { out.files.phaseDirs = fs.readdirSync(path.join(planning, "phases")).slice(0, 5000); } catch (e) { out.files.phaseDirs = null; }
CMDS = { roadmap: ["roadmap", "analyze"], state: ["state-snapshot"], todos: ["list-todos"] };
start();
`;

// The phase-detail driver. arg = { phase: "<id>", dir: "<folder under phases/>" | "" }.
// gsd-tools: roadmap get-phase, phase-plan-index, verification status <dir>,
// phase uat-passed (the last two only when the folder / a UAT file exists).
// Read directly: the folder listing, each PLAN's frontmatter title / plan_name /
// wave, the verification report's status / score, each UAT file's status and
// the checklist and table lines of REQUIREMENTS.md.
export const PHASE_DRIVER = DRIVER_COMMON + String.raw`
var id = String(arg.phase || ""), dir = String(arg.dir || "");
if (!/^[^\/\\]+$/.test(dir) || dir === "." || dir === "..") dir = "";
var pdir = dir ? path.join(planning, "phases", dir) : null, list = null;
if (pdir) { try { list = fs.readdirSync(pdir).sort(); } catch (e) { list = null; } }
function fmFields(text, keys) {
  var m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text || ""), o = {};
  if (!m) return null;
  keys.forEach(function (k) { var r = new RegExp("^" + k + ":[ \\t]*(.*)$", "m").exec(m[1]); if (r) o[k] = r[1].slice(0, 400); });
  return o;
}
out.files.dir = list === null ? null : dir;
out.files.plans = {};
out.files.summaries = [];
out.files.verification = null;
out.files.uat = [];
(list || []).forEach(function (f) {
  if (/-PLAN\.md$/i.test(f)) out.files.plans[f] = fmFields(read(path.join(pdir, f), 8192), ["title", "plan_name", "wave"]) || {};
  else if (/-SUMMARY\.md$/i.test(f)) out.files.summaries.push(f);
});
// The phase's own report ("75.4-VERIFICATION.md") before longer variants.
var ver = (list || []).filter(function (f) { return /-VERIFICATION\.md$/i.test(f); });
ver.sort(function (a, b) { return a.length - b.length || (a < b ? -1 : 1); });
if (ver.length) out.files.verification = { file: ver[0], fm: fmFields(read(path.join(pdir, ver[0]), 8192), ["status", "score", "verified"]) };
(list || []).filter(function (f) { return /-UAT\.md$/i.test(f); }).slice(0, 10).forEach(function (f) {
  out.files.uat.push({ file: f, fm: fmFields(read(path.join(pdir, f), 8192), ["status"]) });
});
var rq = read(path.join(planning, "REQUIREMENTS.md"), 4194304);
out.files.requirements = rq === null ? null : (function () {
  var keep = [], last = -1;
  rq.split(/\r?\n/).forEach(function (l) {
    if (/^\s*[-*+]\s+\[[ xX]\]/.test(l)) { keep.push(l); last = keep.length - 1; }
    else if (/^\s*\|/.test(l)) { keep.push(l); last = -1; }
    // A hard-wrapped requirement: indented text lines continue the checklist line above.
    else if (last >= 0 && /^\s+\S/.test(l) && !/^\s*(?:[-*+]\s|\d+[.)]\s|#|>)/.test(l)) keep[last] += " " + l.trim();
    else last = -1;
  });
  return keep.slice(0, 5000).map(function (l) { return l.slice(0, 1500); });
})();
TRIM = {
  getphase: function (j) {
    return { found: j.found, phase_number: j.phase_number, phase_name: j.phase_name,
      goal: typeof j.goal === "string" ? j.goal.slice(0, 4000) : null,
      success_criteria: Array.isArray(j.success_criteria) ? j.success_criteria.slice(0, 100).map(function (c) { return String(c).slice(0, 2000); }) : null,
      section: typeof j.section === "string" ? j.section.slice(0, 30000) : null };
  },
  plans: function (j) {
    return { error: j.error || null, plans: Array.isArray(j.plans) ? j.plans.slice(0, 1000).map(function (p) {
      return { id: p.id, wave: p.wave, objective: typeof p.objective === "string" ? p.objective.slice(0, 600) : null, has_summary: p.has_summary };
    }) : null };
  },
  verification: function (j) { return { status: j.status, next_action: typeof j.next_action === "string" ? j.next_action.slice(0, 400) : null }; },
  uat: function (j) {
    return { passed: j.passed, uat_files: Array.isArray(j.uat_files) ? j.uat_files.slice(0, 20) : null,
      checks: Array.isArray(j.checks) ? j.checks.slice(0, 2000).map(function (c) { return { file: c.file, result: c.result }; }) : null };
  }
};
if (/^[A-Za-z0-9][\w.-]*$/.test(id)) {
  CMDS.getphase = ["roadmap", "get-phase", id];
  CMDS.plans = ["phase-plan-index", id];
  if (list !== null) CMDS.verification = ["verification", "status", path.join(".planning", "phases", dir)];
  if (out.files.uat.length) { CMDS.uat = ["phase", "uat-passed", id]; VERDICT.uat = true; }
}
start();
`;

// ─── load ───────────────────────────────────────────────────────────────────

/** Never throws: every failure is a Snapshot with state "error". */
export async function loadGsd(loc, io) {
  const t0 = Date.now();
  const where = loc?.on ? loc.on : "this computer";
  try {
    if (!loc || !loc.cwd) return emptySnapshot("none", null, t0);
    const nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    let r;
    try {
      r = await io.exec("sh", ["-c", SCRIPT, "gsd-panel", String(loc.cwd), nonce, DRIVER, ""], { on: loc.on ?? null, timeout: EXEC_TIMEOUT });
    } catch (e) {
      return emptySnapshot("error", `Could not run on ${where}: ${shortError(e)}`, t0);
    }
    return interpret(r, nonce, where, t0);
  } catch (e) {
    return emptySnapshot("error", `GSD panel failed: ${shortError(e)}`, t0);
  }
}

/** Turns the script's stdout into a Snapshot. Exported for tests. */
export function interpret(r, nonce, where, t0 = Date.now()) {
  const { info, driver } = parseScriptOutput(r?.stdout ?? "", nonce);
  const stderr = firstLine(r?.stderr);
  if (info.nocwd !== undefined) return emptySnapshot("error", `Folder not found on ${where}`, t0);
  if (info.none !== undefined) return emptySnapshot("none", null, t0);
  if (info.root === undefined) {
    return emptySnapshot("error", `Planning lookup failed on ${where}${stderr ? `: ${stderr}` : r?.code ? ` (exit ${r.code})` : ""}`, t0);
  }
  const base = emptySnapshot("ok", null, t0);
  setRoot(base, info.root);
  base.viaWorktree = info.via === "1";
  const fail = (msg) => Object.assign(base, { state: "error", error: msg });
  if (info.nonode !== undefined) return fail(`Node.js not found on ${where}`);
  if (info.notools !== undefined) return fail(`gsd-tools not found on ${where}`);
  if (driver === null) return fail(`gsd-tools did not run on ${where}${stderr ? `: ${stderr}` : ""}`);
  let d;
  try { d = JSON.parse(driver); } catch { d = null; }
  if (!d || typeof d !== "object") return fail(`gsd-tools query failed on ${where}${stderr ? `: ${stderr}` : ""}`);
  // The driver's argv is exact; a marker line is not when the folder name has a newline.
  if (typeof d.root === "string" && d.root) setRoot(base, d.root);
  return buildSnapshot(base, d);
}

function setRoot(s, root) {
  s.root = root;
  s.planningRoot = `${root.replace(/\/+$/, "")}/.planning`;
  s.project = root.replace(/\/+$/, "").split("/").pop() || root;
}

/** Splits stdout into marker values and the driver's JSON text. */
export function parseScriptOutput(stdout, nonce) {
  const mark = `${MARK}${nonce} `, info = {};
  const lines = String(stdout).split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, "");
    if (!line.startsWith(mark)) continue;
    const rest = line.slice(mark.length), sp = rest.indexOf(" ");
    const key = sp < 0 ? rest : rest.slice(0, sp), value = sp < 0 ? "" : rest.slice(sp + 1);
    if (key === "driver") return { info, driver: lines.slice(i + 1).join("\n").trim() };
    info[key] = value;
  }
  return { info, driver: null };
}

// ─── snapshot assembly ──────────────────────────────────────────────────────

const CMD_LABEL = { roadmap: "roadmap analyze", state: "state-snapshot", todos: "list-todos" };

/** `base` carries root/project; `d` is the driver's JSON. Exported for tests. */
export function buildSnapshot(base, d) {
  const s = base, warnings = s.warnings;
  const tools = Array.isArray(d.tools) ? d.tools : [];
  const results = d.results ?? {}, files = d.files ?? {};
  const toolName = (i) => tools[i]?.label ?? "gsd-tools";
  const rel = (msg) => relError(msg, s.root);

  // Which install answered, and what failed on the way.
  for (const name of ["roadmap", "state", "todos"]) {
    const res = results[name];
    if (!res) continue;
    const failures = Array.isArray(res.failures) ? res.failures : [];
    if (res.ok && failures.length) {
      const f = failures[0];
      warnings.push(clip(`${CMD_LABEL[name]} failed with ${toolName(f.tool)}: ${rel(f.error)} \u2014 used ${toolName(res.tool)}`, 300));
    } else if (!res.ok && name !== "roadmap") {
      warnings.push(clip(`${CMD_LABEL[name]} failed: ${rel(failures[0]?.error ?? "no gsd-tools answered")}`, 300));
    }
  }
  const roadmapRes = results.roadmap;
  if (!roadmapRes?.ok) {
    s.state = "error";
    s.error = clip(`gsd-tools failed: ${rel(roadmapRes?.failures?.[0]?.error ?? "no answer")}`, 300);
    return s;
  }
  const served = tools[roadmapRes.tool] ?? null;
  s.source = { tool: served?.label ?? null, path: served?.path ?? null, version: served?.version ?? null, node: d.node ?? null };
  if (/get-shit-done/.test(served?.path ?? ""))
    warnings.push(clip(`No gsd-core install found: these numbers come from the legacy ${served.label} and may be incomplete`, 300));

  const R = roadmapRes.data ?? {};
  const st = results.state?.ok ? results.state.data ?? {} : {};
  const excerpt = parseStateExcerpt(files.state);
  const noRoadmap = typeof R.error === "string" && /ROADMAP/i.test(R.error);

  // Milestone: STATE.md's milestone as gsd-tools reads it, else ROADMAP's heading.
  const version = cleanValue(st.milestone) ?? cleanValue(excerpt.milestone) ?? cleanValue(R.milestones?.[0]?.version);
  let name = null;
  if (cleanValue(st.milestone) || cleanValue(excerpt.milestone)) name = tidyMilestoneName(cleanValue(st.milestone_name) ?? cleanValue(excerpt.milestoneName));
  if (!name && version) {
    const heading = (Array.isArray(R.milestones) ? R.milestones : []).find((m) => m && m.version === version)?.heading;
    name = nameFromHeading(heading, version);
  }
  if (name && version && name === version) name = null;
  s.milestone = { version, name, label: version && name ? `${version} ${name}` : version || name || (noRoadmap ? "No roadmap" : "Roadmap") };

  // Position.
  const phaseId = cleanValue(st.current_phase) ?? cleanValue(excerpt.currentPhase);
  const status = cleanValue(st.status) ?? cleanValue(excerpt.status);
  const stateName = cleanValue(st.current_phase_name) ?? cleanValue(excerpt.currentPhaseName);
  s.position = {
    phase: phaseId ? clip(String(phaseId), 200) : null,
    plan: cleanValue(excerpt.plan) ? clip(cleanValue(excerpt.plan), 400) : cleanValue(st.current_plan) ? clip(String(st.current_plan), 400) : null,
    // A bare snake_case word ("awaiting_next_milestone") reads better with spaces; anything else as written.
    status: status ? clip(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(status) ? status.replace(/_/g, " ") : String(status), 1000) : null,
    phaseName: stateName ? stripInlineMarkdown(stateName) : null,
  };

  // Phases.
  if (R.error) warnings.push(noRoadmap ? "No ROADMAP.md in .planning \u2014 no phases to show" : clip(`roadmap analyze: ${rel(R.error)}`, 300));
  if (!Array.isArray(R.phases) && !R.error) warnings.push("Unexpected roadmap analyze output (no phase list)");
  if (R.scope && R.scope !== "complete" && Array.isArray(R.phases) && R.phases.length)
    warnings.push(`ROADMAP milestone window is "${R.scope}": the phase list is best-effort`);
  const dirs = Array.isArray(files.phaseDirs) ? files.phaseDirs : [];
  const dirByKey = new Map();
  for (const dir of dirs) {
    const k = dirKey(dir);
    if (k && !dirByKey.has(k)) dirByKey.set(k, dir);
  }
  const currentKey = phaseId ? phaseKey(phaseId) : null;
  const underWay = isUnderWay(status);
  const raw = Array.isArray(R.phases) ? R.phases.filter((p) => p && p.number !== undefined && p.number !== null) : [];
  s.phases = raw.map((p) => {
    const id = String(p.number), key = phaseKey(id), current = currentKey !== null && key === currentKey;
    const plans = count(p.plan_count), summaries = count(p.summary_count);
    const diskStatus = typeof p.disk_status === "string" ? p.disk_status : null;
    const title = cleanValue(p.name) && stripInlineMarkdown(cleanValue(p.name));
    return {
      id, name: title || `Phase ${id}`, dir: dirByKey.get(key) ?? "",
      status: derivePhaseStatus({ plans, summaries, diskStatus, checked: p.roadmap_complete === true }, { current, underWay }),
      plans, summaries, current, goal: cleanValue(p.goal),
      diskStatus, checked: p.roadmap_complete === true,
    };
  });
  // Checklist phases with no detail section gsd-tools can read (e.g. "##### Phase 1:")
  // are invisible to it; say so unless gsd-tools synthesised them anyway.
  const known = new Set(s.phases.map((p) => phaseKey(p.id)));
  const unread = (Array.isArray(R.missing_phase_details) ? R.missing_phase_details : []).map(String).filter((x) => !known.has(phaseKey(x)));
  if (unread.length) {
    const list = unread.length > 6 ? `${unread.slice(0, 6).join(", ")}, \u2026` : unread.join(", ");
    warnings.push(`ROADMAP.md lists ${unread.length === 1 ? "phase" : "phases"} ${list} without a "### Phase N: Name" section gsd-tools can read`);
  }
  if (!s.phases.some((p) => p.current)) {
    const guess = s.phases.find((p) => p.status === "executing");
    if (guess && !phaseId) guess.current = true;
  }
  // The current phase's name is the ROADMAP's when it is listed (STATE.md's copy is often stale).
  const listed = currentKey !== null ? s.phases.find((p) => phaseKey(p.id) === currentKey) : null;
  if (listed && listed.name !== `Phase ${listed.id}`) s.position.phaseName = listed.name;

  // Progress. Counts and percentages rest on the phases gsd-tools could read:
  // with unread ones in ROADMAP.md (`unread`) they are unknown, not zero.
  const roadmapOk = Array.isArray(R.phases) && !R.error && !unread.length;
  const done = s.phases.filter((p) => p.status === "done").length;
  const phaseScopeOk = roadmapOk && (R.scope === undefined || R.scope === null || R.scope === "complete");
  const totalPlans = count(R.total_plans ?? s.phases.reduce((n, p) => n + p.plans, 0));
  const totalSums = count(R.total_summaries ?? s.phases.reduce((n, p) => n + p.summaries, 0));
  const plansDone = Math.min(totalSums, totalPlans);
  // One source for completed, total and percent; null stays null when gsd-tools withholds it.
  const plansPercent = !roadmapOk || R.progress_percent === null ? null : clampPercent(plansDone, totalPlans);
  if (roadmapOk && R.progress_percent === null && (s.phases.length || totalPlans))
    warnings.push("No plan percentage: GSD cannot tell which phase folders belong to the current milestone");
  s.progress = {
    // gsd-tools without `scope` (gsd-core 1.8, get-shit-done 1.30/1.38 measured) calls every
    // fully summarised phase "complete": its completed_phases is not a verified count.
    phases: { completed: done, total: s.phases.length, percent: phaseScopeOk ? clampPercent(done, s.phases.length) : null,
      verified: typeof R.completed_phases === "number" && R.scope !== undefined ? R.completed_phases : null },
    plans: { completed: plansDone, total: totalPlans, percent: plansPercent },
  };

  // Todos.
  const todoRes = results.todos;
  if (todoRes?.ok && Array.isArray(todoRes.data?.todos)) s.todos = normalizeTodos(todoRes.data.todos);
  else if (todoRes?.ok) warnings.push("Unexpected list-todos output (no todo list)");

  // Shipped milestones.
  const parsed = parseMilestones(files.milestones);
  s.shipped = parsed.shipped;
  if (parsed.present && !parsed.shipped.length) warnings.push("MILESTONES.md: no shipped milestones recognised");
  return s;
}

function emptySnapshot(state, error, t0) {
  return {
    state, error: error ?? null, root: null, planningRoot: null, viaWorktree: false, project: null,
    milestone: { version: null, name: null, label: state === "ok" ? "Roadmap" : "No milestone" },
    progress: { phases: { completed: 0, total: 0, percent: null, verified: null }, plans: { completed: 0, total: 0, percent: null } },
    position: { phase: null, plan: null, status: null, phaseName: null },
    phases: [], todos: [], shipped: [], warnings: [], source: null,
    loadedAt: Date.now(), elapsedMs: Date.now() - t0,
  };
}

// ─── details (click-through) ────────────────────────────────────────────────

const PHASE_STATUSES = ["done", "executing", "planned", "not_started"];
const DETAIL_CMD = { getphase: "roadmap get-phase", plans: "phase-plan-index", verification: "verification status", uat: "phase uat-passed" };
const TODO_BODY_MAX = 20000;

function emptyPhaseDetail(phase, t0) {
  return {
    state: "ok", error: null, id: phase?.id !== undefined && phase?.id !== null ? String(phase.id) : "",
    name: typeof phase?.name === "string" ? phase.name : "",
    status: PHASE_STATUSES.includes(phase?.status) ? phase.status : "not_started",
    goal: cleanValue(phase?.goal), dependsOn: [], requirements: [], successCriteria: [], plans: [],
    verification: null, uat: null, warnings: [], loadedAt: Date.now(), elapsedMs: Date.now() - t0,
  };
}

/** One phase's details for the click-through view: ONE exec of SCRIPT with
 *  PHASE_DRIVER (same install order, fallback, time budget and no-git rules as
 *  loadGsd). Never throws: every failure is a PhaseDetail with state "error"
 *  that still carries the phase's id, name and status from the snapshot. */
export async function loadPhaseDetail(ctx, phase, io) {
  const t0 = Date.now();
  const where = ctx?.on ? ctx.on : "this computer";
  const s = emptyPhaseDetail(phase, t0);
  const fail = (msg) => Object.assign(s, { state: "error", error: clip(msg, 300), loadedAt: Date.now(), elapsedMs: Date.now() - t0 });
  try {
    if (!ctx?.root || !phase || phase.id === undefined || phase.id === null) return fail("No phase selected");
    const id = String(phase.id).trim();
    if (!/^[A-Za-z0-9][\w.-]*$/.test(id)) return fail(`Phase "${clip(id, 40)}" cannot be looked up`);
    const dir = typeof phase.dir === "string" && /^[^/\\]+$/.test(phase.dir) && phase.dir !== "." && phase.dir !== ".." ? phase.dir : "";
    const nonce = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    let r;
    try {
      r = await io.exec("sh", ["-c", SCRIPT, "gsd-panel", String(ctx.root), nonce, PHASE_DRIVER, JSON.stringify({ phase: id, dir })],
        { on: ctx.on ?? null, timeout: EXEC_TIMEOUT });
    } catch (e) {
      return fail(`Could not run on ${where}: ${shortError(e)}`);
    }
    const { info, driver } = parseScriptOutput(r?.stdout ?? "", nonce);
    const stderr = firstLine(r?.stderr);
    if (info.nocwd !== undefined) return fail(`Project folder not found on ${where}`);
    if (info.none !== undefined) return fail(`No .planning folder in ${ctx.root} any more`);
    if (info.root === undefined) return fail(`Planning lookup failed on ${where}${stderr ? `: ${stderr}` : r?.code ? ` (exit ${r.code})` : ""}`);
    if (info.nonode !== undefined) return fail(`Node.js not found on ${where}`);
    if (info.notools !== undefined) return fail(`gsd-tools not found on ${where}`);
    if (driver === null) return fail(`gsd-tools did not run on ${where}${stderr ? `: ${stderr}` : ""}`);
    let d;
    try { d = JSON.parse(driver); } catch { d = null; }
    if (!d || typeof d !== "object") return fail(`gsd-tools query failed on ${where}${stderr ? `: ${stderr}` : ""}`);
    const root = typeof d.root === "string" && d.root ? d.root : info.root;
    if (root.replace(/\/+$/, "") !== String(ctx.root).replace(/\/+$/, "")) return fail(`No .planning folder in ${ctx.root} any more`);
    buildPhaseDetail(s, d, phase, root);
    return Object.assign(s, { loadedAt: Date.now(), elapsedMs: Date.now() - t0 });
  } catch (e) {
    return fail(`GSD panel failed: ${shortError(e)}`);
  }
}

/** `s` is an emptyPhaseDetail; `d` the phase driver's JSON. Exported for tests. */
export function buildPhaseDetail(s, d, phase = {}, root = "") {
  const tools = Array.isArray(d?.tools) ? d.tools : [];
  const results = d?.results ?? {}, files = d?.files ?? {};
  const toolName = (i) => tools[i]?.label ?? "gsd-tools";
  const ok = (k) => (results[k]?.ok ? results[k].data ?? {} : null);
  for (const k of Object.keys(DETAIL_CMD)) {
    const res = results[k];
    if (!res) continue;
    const failures = Array.isArray(res.failures) ? res.failures : [];
    if (res.ok && failures.length)
      s.warnings.push(clip(`${DETAIL_CMD[k]} failed with ${toolName(failures[0].tool)}: ${relError(failures[0].error, root)} — used ${toolName(res.tool)}`, 300));
    else if (!res.ok) s.warnings.push(clip(`${DETAIL_CMD[k]} failed: ${relError(failures[0]?.error ?? "no gsd-tools answered", root)}`, 300));
  }
  const served = results.getphase?.ok ? tools[results.getphase.tool] : null;
  if (served) s.source = served.label ?? null;
  const phaseDir = typeof files.dir === "string" && files.dir ? files.dir : null;
  s.dir = phaseDir ?? (typeof phase?.dir === "string" ? phase.dir : "");
  const inDir = (f) => (phaseDir && f ? `.planning/phases/${phaseDir}/${f}` : null);

  // ROADMAP.md: gsd-tools' section of this phase.
  const G = ok("getphase");
  if (G && G.found === false) s.warnings.push(`ROADMAP.md has no section for phase ${s.id}`);
  if (G && G.found !== false) {
    if (cleanValue(G.phase_name)) s.name = stripInlineMarkdown(cleanValue(G.phase_name));
    if (cleanValue(G.goal)) s.goal = stripInlineMarkdown(cleanValue(G.goal)).replace(/\s+/g, " ").trim();
    s.successCriteria = (Array.isArray(G.success_criteria) ? G.success_criteria : [])
      .map((c) => stripInlineMarkdown(String(c)).replace(/\s+/g, " ").trim()).filter(Boolean);
    const section = typeof G.section === "string" ? G.section : "";
    s.dependsOn = parseDependsOn(sectionField(section, "Depends on|Dependencies"));
    const req = parseRequirementIds(sectionField(section, "Requirements?"));
    s.requirements = req.ids.map((rid) => ({ id: rid, ...requirementInfo(files.requirements, rid) }));
    if (req.note) s.requirementsNote = req.note;
  }

  // Plans: gsd-tools' plan index (execution order = wave, then plan id); the
  // folder listing only when the index is unavailable.
  const P = ok("plans");
  const heads = files.plans && typeof files.plans === "object" ? files.plans : {};
  const names = Object.keys(heads);
  const headFor = (pid) => names.find((n) => n === `${pid}-PLAN.md`) ?? names.find((n) => n.startsWith(`${pid}-`) && /-PLAN\.md$/i.test(n)) ?? null;
  let rows = null;
  if (P && Array.isArray(P.plans) && (P.plans.length || !names.length)) {
    rows = P.plans.filter((p) => p && p.id !== undefined && p.id !== null).map((p) => {
      const f = headFor(String(p.id)), fm = (f && heads[f]) || {};
      return { id: String(p.id), title: planTitle(fm, p.objective), wave: toWave(p.wave) ?? toWave(unquoteYaml(fm.wave ?? null)), done: p.has_summary === true, file: inDir(f) };
    });
  } else if (names.length) {
    if (P) s.warnings.push("phase-plan-index listed no plans; they are read from the phase folder");
    const sums = new Set(Array.isArray(files.summaries) ? files.summaries : []);
    rows = names.slice().sort().map((f) => {
      const pid = f.replace(/-PLAN\.md$/i, ""), fm = heads[f] || {};
      return { id: pid, title: planTitle(fm, null), wave: toWave(unquoteYaml(fm.wave ?? null)), done: sums.has(`${pid}-SUMMARY.md`), file: inDir(f) };
    });
  }
  s.plans = (rows ?? []).map((p, i) => [p, i])
    .sort((a, b) => (a[0].wave ?? Infinity) - (b[0].wave ?? Infinity) || a[1] - b[1]).map((x) => x[0]);

  // Verification: gsd-tools' verdict (passed / stale / gaps_found / …), the
  // report's own score; the report's frontmatter status when gsd-tools has none.
  const V = ok("verification"), vf = files.verification && typeof files.verification === "object" ? files.verification : null;
  const vfm = vf?.fm ?? {};
  const score = cleanValue(unquoteYaml(vfm.score ?? null));
  if (V && cleanValue(V.status) && !/^(?:missing|phase_dir_not_found)$/.test(V.status))
    s.verification = { status: cleanValue(V.status), detail: score, next: cleanValue(V.next_action), file: inDir(vf?.file) };
  else if (vf) s.verification = { status: cleanValue(unquoteYaml(vfm.status ?? null)), detail: score, next: null, file: inDir(vf.file) };

  // UAT: the session file's own status, gsd-tools' per-test results and verdict.
  const uatFiles = (Array.isArray(files.uat) ? files.uat : []).filter((u) => u && typeof u.file === "string");
  if (uatFiles.length) {
    const U = ok("uat");
    const main = uatFiles.find((u) => /^[\w.]+-UAT\.md$/i.test(u.file)) ?? uatFiles[0];
    const counts = {};
    for (const c of Array.isArray(U?.checks) ? U.checks : []) {
      const k = cleanValue(c?.result) ?? "unknown";
      counts[k] = (counts[k] ?? 0) + 1;
    }
    const order = ["pass", "issue", "pending", "skipped", "blocked"];
    const rank = (k) => (order.includes(k) ? order.indexOf(k) : order.length);
    const keys = Object.keys(counts).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1));
    s.uat = {
      status: cleanValue(unquoteYaml(main.fm?.status ?? null)) ?? (U ? (U.passed === true ? "passed" : "not passed") : null),
      detail: keys.length ? keys.map((k) => `${counts[k]} ${k}`).join(", ") : null,
      passed: U ? U.passed === true : null,
      files: uatFiles.map((u) => inDir(u.file)).filter(Boolean),
    };
  }

  // Status: the snapshot's rule on these fresh counts; unknown counts keep the snapshot's.
  if (P || names.length) {
    s.status = derivePhaseStatus(
      { plans: s.plans.length, summaries: s.plans.filter((p) => p.done).length, diskStatus: s.verification?.status === "passed" ? "complete" : null, checked: phase?.checked === true },
      { current: phase?.current === true, underWay: phase?.status === "executing" });
  }
  return s;
}

/** A plan's title: its frontmatter `title` (or `plan_name`) when it has one,
 *  else the first sentence of its objective as gsd-tools reads it (the first
 *  line of the PLAN's <objective>). */
export function planTitle(fm, objective) {
  const own = cleanValue(unquoteYaml(fm?.title ?? null, false)) ?? cleanValue(unquoteYaml(fm?.plan_name ?? null, false));
  const text = own ?? (typeof objective === "string" ? objective : null);
  if (!text) return null;
  const t = stripInlineMarkdown(text).replace(/\s+/g, " ").trim();
  if (!t) return null;
  if (own) return clip(t, 200);
  const m = /^(.{8,}?[.!?])(?=\s|$)/.exec(t);
  return clip(m && m[1].length <= 200 ? m[1] : t, 200);
}

function toWave(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** A `**Label**: value` field of a ROADMAP phase section, continued over
 *  wrapped lines (`label` is a regex alternation, e.g. "Requirements?"). */
export function sectionField(section, label) {
  if (typeof section !== "string") return null;
  const lines = section.split(/\r?\n/);
  const re = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?\\*\\*(?:${label})(?:\\*\\*[ \\t]*:|:\\*\\*)[ \\t]*(.*)$`, "i");
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (!m) continue;
    const parts = [m[1]];
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (!l.trim() || /^[ \t]*(?:[-*][ \t]+)?\*\*[^*]+\*\*/.test(l) || /^[ \t]*(?:#|<|(?:\d+\.|[-*+])[ \t])/.test(l) || /^[ \t]*Plans:/i.test(l)) break;
      parts.push(l.trim());
    }
    return parts.join(" ").replace(/\s+/g, " ").trim() || null;
  }
  return null;
}

/** "Phase 1, Phase 2" → ["Phase 1", "Phase 2"]; "Nothing (first phase)" → [];
 *  "Phase 75.3 (why …). Also …" → ["Phase 75.3"]: the phases the field names
 *  before any prose. A field naming no phase stays one string, as written. */
export function parseDependsOn(value) {
  const v = typeof value === "string" ? stripInlineMarkdown(value).replace(/\s+/g, " ").trim() : "";
  if (!v || /^(?:nothing|none|n\/a|no dependenc\w*|[-\u2013\u2014]+)(?=\s|\(|,|;|\.|$)/i.test(v)) return [];
  let t = v;
  for (let i = 0; i < 3; i++) t = t.replace(/\([^()]*\)/g, " ");
  const refs = [];
  for (const part of t.split(/\.\s/)[0].split(/\s*(?:,|;|&|\+|\band\b)\s*/i)) {
    const m = /^(?:Phases?\s+([A-Za-z]?\d+[A-Za-z]?(?:\.\d+)*)|(\d+[A-Za-z]?(?:\.\d+)*))(?![\w.])/i.exec(part.trim());
    if (m) refs.push(`Phase ${m[1] ?? m[2]}`);
    else if (refs.length) break;
  }
  return refs.length ? [...new Set(refs)] : [clip(v, 120)];
}

const isRequirementId = (t) => /^[A-Za-z][\w.-]*$/.test(t) && !/^(?:tbd|none)$/i.test(t)
  && (/\d/.test(t) || /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$/.test(t));

/** The Requirements field, the way GSD reads it (a comma list of IDs, "TBD" =
 *  none). A field that opens with prose ("No new IDs; …") gives no IDs, only `note`. */
export function parseRequirementIds(value) {
  const v = typeof value === "string" ? stripInlineMarkdown(value).replace(/[[\]]/g, "").replace(/\s+/g, " ").trim() : "";
  if (!v || /^(?:tbd|none|n\/a|[-\u2013\u2014]+)$/i.test(v)) return { ids: [], note: null };
  const ids = [];
  let prose = false;
  for (const part of v.split(/\s*,\s*/).filter(Boolean)) {
    const lead = /^(\S+?)(?=$|[\s(:;])/.exec(part);
    if (lead && isRequirementId(lead[1])) ids.push(lead[1]);
    else if (!ids.length) return { ids: [], note: clip(v, 300) };
    else prose = true;
  }
  return { ids: [...new Set(ids)], note: prose ? clip(v, 300) : null };
}

/** A requirement's text and checkbox from REQUIREMENTS.md: the checklist line
 *  ("- [x] **ID**: text") first, else the traceability table's status cell. */
export function requirementInfo(lines, id) {
  const out = { text: null, done: null };
  if (!Array.isArray(lines) || typeof id !== "string" || !id) return out;
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const check = new RegExp(`^\\s*[-*+]\\s+\\[([ xX])\\]\\s*(?:\\*\\*|__)?${esc}(?:\\*\\*|__)?(?![\\w-])\\s*[:\\-–—]?\\s*(.*)$`);
  for (const l of lines) {
    const m = check.exec(String(l));
    if (m) return { text: cleanValue(stripInlineMarkdown(m[2]).replace(/\s+/g, " ").trim()), done: m[1] !== " " };
  }
  for (const l of lines) {
    if (!/^\s*\|/.test(String(l))) continue;
    const cells = String(l).split("|").slice(1, -1).map((c) => stripInlineMarkdown(c).trim());
    if (!cells.includes(id)) continue;
    const status = cells[cells.length - 1] ?? "";
    if (/\b(?:complete[d]?|done|satisfied|shipped|validated|verified|met)\b|✅/i.test(status)) out.done = true;
    else if (/\b(?:pending|in progress|planned|not started|open|todo|blocked|partial|deferred)\b/i.test(status)) out.done = false;
    return out;
  }
  return out;
}

/** A todo's file, read with io.readTextFile (no exec). Never throws. */
export async function loadTodoDetail(ctx, todo, io) {
  const t0 = Date.now();
  const where = ctx?.on ? ctx.on : "this computer";
  const file = typeof todo?.file === "string" ? todo.file : "";
  const root = String(ctx?.root ?? "").replace(/\/+$/, "");
  const s = {
    state: "ok", error: null, title: cleanValue(todo?.title) ?? (file.split("/").pop() || "").replace(/\.md$/i, ""),
    area: cleanValue(todo?.area), created: cleanValue(todo?.created), severity: cleanValue(todo?.severity),
    files: [], path: !file ? "" : file.startsWith("/") ? file : `${root}/${file.replace(/^\.\//, "")}`,
    body: "", truncated: false, loadedAt: 0, elapsedMs: 0,
  };
  const finish = (state, error) => Object.assign(s, { state, error: error ? clip(error, 300) : null, loadedAt: Date.now(), elapsedMs: Date.now() - t0 });
  try {
    if (!file || (!root && !file.startsWith("/"))) return finish("error", "No todo selected");
    let text;
    try {
      text = await io.readTextFile(s.path, { on: ctx?.on ?? null });
    } catch (e) {
      return finish("error", `Could not read the todo on ${where}: ${shortError(e)}`);
    }
    if (text === null || text === undefined) return finish("error", "This todo's file is gone: it was probably just completed or moved");
    const t = parseTodoFile(String(text));
    const head = parseTodoHead(String(text));
    const f = (k) => cleanValue(unquoteYaml(t.fields[k] ?? null, false));
    s.title = f("title") ?? s.title ?? head.title;
    if (!s.title) s.title = (file.split("/").pop() || "").replace(/\.md$/i, "");
    s.area = f("area") ?? s.area;
    s.created = f("created") ?? f("captured") ?? f("date") ?? s.created ?? head.created;
    s.severity = f("severity") ?? s.severity;
    s.files = t.files;
    let body = t.body.replace(/^(?:[ \t]*\r?\n)+/, "");
    const h = /^#{1,3}[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(body);
    const norm = (x) => stripInlineMarkdown(String(x)).replace(/\s+/g, " ").trim().toLowerCase();
    if (h && norm(h[1]) === norm(s.title)) body = body.slice(h[0].length).replace(/^(?:[ \t]*\r?\n)+/, "");
    body = body.replace(/\s+$/, "");
    if (body.length > TODO_BODY_MAX) {
      let cut = body.lastIndexOf("\n", TODO_BODY_MAX);
      if (cut < TODO_BODY_MAX - 2000) cut = TODO_BODY_MAX;
      body = body.slice(0, cut).replace(/\s+$/, "");
      s.truncated = true;
    }
    s.body = body;
    return finish("ok", null);
  } catch (e) {
    return finish("error", `GSD panel failed: ${shortError(e)}`);
  }
}

/** A todo file's frontmatter fields (raw strings), its `files:` list and the body after it. */
export function parseTodoFile(text) {
  const out = { fields: {}, files: [], body: typeof text === "string" ? text : "" };
  const fm = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(out.body);
  if (!fm) return out;
  out.body = out.body.slice(fm[0].length);
  const lines = fm[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const value = m[2].trim();
    if (m[1] !== "files") { out.fields[m[1]] = value; continue; }
    if (value && value !== "[]") {
      out.files = value.replace(/^\[|\]$/g, "").split(",").map((x) => cleanValue(unquoteYaml(x.trim(), false))).filter(Boolean);
    } else {
      for (let j = i + 1; j < lines.length && /^[ \t]+-[ \t]*\S/.test(lines[j]); j++) {
        const v = cleanValue(unquoteYaml(lines[j].replace(/^[ \t]+-[ \t]*/, ""), false));
        if (v) out.files.push(v);
      }
    }
  }
  return out;
}

// ─── rules ──────────────────────────────────────────────────────────────────

/** Phase status, in order:
 *   done        gsd-tools disk_status "complete" (passing, non-stale VERIFICATION.md),
 *               or every plan has a summary (summaries ≥ plans, at least one summary:
 *               gsd-tools' "executed"), or ticked in ROADMAP with no plans/summaries
 *               on disk at all (archived or hand-closed phases);
 *   executing   some but not all plans have summaries (gsd-tools' "partial"), or it
 *               is STATE.md's current phase, has plans, and STATE's status says work
 *               is running ("executing", "in progress", "implementing");
 *   planned     plans exist, no summaries;
 *   not_started no plans (no folder, or only CONTEXT/RESEARCH: "discussed",
 *               "researched", "empty").
 *  A ticked checkbox never overrides disk evidence of unfinished work. */
export function derivePhaseStatus({ plans, summaries, diskStatus, checked }, { current = false, underWay = false } = {}) {
  if (diskStatus === "complete") return "done";
  if (summaries > 0 && summaries >= plans) return "done";
  if (checked && plans === 0 && summaries === 0) return "done";
  if (summaries > 0) return "executing";
  if (plans > 0) return current && underWay ? "executing" : "planned";
  return "not_started";
}

export function isUnderWay(status) {
  return typeof status === "string" && /\bexecuting\b|\bin[\s_-]?progress\b|\bimplementing\b|\bworking\b/i.test(status);
}

/** gsd-tools' clampPercent: 0 for an empty denominator, capped at 100. */
export function clampPercent(done, total) {
  if (!total || total <= 0) return 0;
  return Math.min(100, Math.round((done / total) * 100));
}

/** "09.1" and "9.1" are one phase; "1a" and "1A" too. */
export function phaseKey(id) {
  return String(id).trim().split(".").map((seg) => (/^\d+$/.test(seg) ? String(parseInt(seg, 10)) : seg.replace(/^0+(?=\d)/, "").toUpperCase())).join(".");
}

/** The phase id a directory name starts with ("01-auth" → "1", "131.1-pill" → "131.1"). */
export function dirKey(dir) {
  const m = /^([A-Za-z]?\d+[A-Za-z]?(?:\.\d+)*)(?:-|$)/.exec(String(dir));
  return m ? phaseKey(m[1]) : null;
}

// ─── parsers ────────────────────────────────────────────────────────────────

/** STATE.md (whole file, or the driver's frontmatter + Current Position excerpt). */
export function parseStateExcerpt(text) {
  const out = { milestone: null, milestoneName: null, currentPhase: null, currentPhaseName: null, status: null, plan: null };
  if (typeof text !== "string" || !text) return out;
  const fmMatch = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  const fm = {};
  if (fmMatch) {
    for (const line of fmMatch[1].split(/\r?\n/)) {
      const m = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
      if (m) fm[m[1]] = unquoteYaml(m[2]);
    }
  }
  const body = fmMatch ? text.slice(fmMatch[0].length) : text;
  const at = body.search(/^#{2,3}[ \t]+Current Position[ \t]*$/m);
  let section = "";
  if (at >= 0) {
    const rest = body.slice(at), end = rest.slice(3).search(/^#{1,2}[ \t]/m);
    section = end < 0 ? rest : rest.slice(0, end + 3);
  }
  const field = (label) => {
    const m = new RegExp(`^[ \\t]*(?:[-*][ \\t]+)?(?:\\*\\*)?${label}(?:\\*\\*)?[ \\t]*:(?:\\*\\*)?[ \\t]*(.+)$`, "im").exec(section);
    return m ? m[1].trim() : null;
  };
  // A placeholder in the frontmatter ("status: unknown") must not hide the body's line.
  out.milestone = cleanValue(fm.milestone);
  out.milestoneName = cleanValue(fm.milestone_name);
  out.currentPhase = cleanValue(fm.current_phase);
  out.currentPhaseName = cleanValue(fm.current_phase_name);
  out.status = cleanValue(fm.status) ?? field("Status");
  out.plan = cleanValue(fm.plan) ?? cleanValue(fm.current_plan) ?? field("Plan");
  if (!out.currentPhase) {
    const p = field("Phase");
    const m = p && /^([A-Za-z]?\d+[A-Za-z]?(?:\.\d+)*)\b/.exec(p);
    if (m) out.currentPhase = m[1];
  }
  return out;
}

/** Pending todos, newest first. `file` is relative to the project root. */
export function normalizeTodos(list) {
  const todos = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const file = typeof t.path === "string" && t.path ? t.path : `.planning/todos/pending/${t.file ?? ""}`;
    // list-todos reads `title:` etc. by regex, so " #42" is part of the value, as in GSD.
    let title = cleanValue(unquoteYaml(t.title, false));
    let created = cleanValue(unquoteYaml(t.created, false));
    if (title === "Untitled") title = null;
    if (created === "unknown") created = null;
    if ((!title || !created) && typeof t.head === "string") {
      const h = parseTodoHead(t.head);
      title = title ?? h.title;
      created = created ?? h.created;
    }
    created = created ?? dateFromName(t.file ?? file);
    const base = String(t.file ?? file).split("/").pop().replace(/\.md$/i, "");
    todos.push({
      title: title ?? base, file, area: cleanValue(unquoteYaml(t.area, false)), created,
      severity: cleanValue(unquoteYaml(t.severity, false)),
    });
  }
  return sortTodos(todos);
}

export function sortTodos(todos) {
  const time = (t) => {
    const v = Date.parse(t.created ?? "") || Date.parse(dateFromName(t.file) ?? "");
    return Number.isFinite(v) ? v : -Infinity;
  };
  return todos.map((t) => [time(t), t]).sort((a, b) => (b[0] - a[0]) || (a[1].file < b[1].file ? 1 : a[1].file > b[1].file ? -1 : 0)).map((x) => x[1]);
}

/** Title / created date from a todo file's head when it has no `title:`/`created:`. */
export function parseTodoHead(text) {
  const out = { title: null, created: null };
  if (typeof text !== "string") return out;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  const fmField = (k) => {
    if (!fm) return null;
    const m = new RegExp(`^${k}:[ \\t]*(.+)$`, "m").exec(fm[1]);
    return m ? cleanValue(unquoteYaml(m[1])) : null;
  };
  out.title = fmField("title");
  out.created = fmField("created") ?? fmField("captured") ?? fmField("date");
  const body = fm ? text.slice(fm[0].length) : text;
  if (!out.title) {
    const h = /^#{1,3}[ \t]+(.+?)[ \t#]*$/m.exec(body);
    if (h) out.title = stripInlineMarkdown(h[1]).trim() || null;
  }
  if (!out.created) {
    const c = /\*\*(?:Created|Captured|Date)(?::\*\*|\*\*:)[ \t]*(\d{4}-\d{2}-\d{2}[^\s,;)]*)/i.exec(body);
    if (c) out.created = c[1];
  }
  return out;
}

/** Shipped milestones from MILESTONES.md, newest first. Tolerant of every
 *  format seen in the wild:
 *    ## v1.2 Name (Shipped: 2026-01-10)            gsd-core's writer
 *    ## v1.2 Name (Shipped: 2026-01-10 — partial)  (Closed: …) (Wrapped: …) (Backfilled: …)
 *    ## ✅ v1.0 MVP — SHIPPED 2026-01-10           older hand-written
 *    ## Folded: other-repo v1.0 (shipped 2026-06-11)
 *    - ✅ **v1.0 MVP** - Phases 1-4 (shipped 2026-01-10)   ROADMAP-style list
 *  Level-2 headings with a version are entries (level 3 only when there are no
 *  level-2 entries); "superseded"/"abandoned"/"in progress" ones are skipped.
 *  `present` is false when there is no file (null text). */
export function parseMilestones(text) {
  if (typeof text !== "string") return { shipped: [], present: false };
  const lines = text.split(/\r?\n/);
  const candidates = { 2: [], 3: [], bullet: [] };
  for (const raw of lines) {
    const h = /^\s{0,3}(#{2,3})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) { candidates[h[1].length].push(h[2]); continue; }
    const b = /^\s*[-*+]\s+(?:\[[xX ]\]\s*)?(.+)$/.exec(raw);
    if (b && (/^\u2705/.test(b[1]) || /^\*\*v\d[^*]*\*\*.*\bshipped\b/i.test(b[1]))) candidates.bullet.push(b[1]);
  }
  let pick = candidates[2].map(entryFromLine).filter(Boolean);
  if (!pick.length) pick = candidates[3].map(entryFromLine).filter(Boolean);
  if (!pick.length) pick = candidates.bullet.map(entryFromLine).filter(Boolean);
  const seen = new Set(), shipped = [];
  for (const e of pick) {
    const k = `${e.version}|${e.date ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    shipped.push(e);
  }
  shipped.sort((a, b) => {
    if (a.date && b.date && a.date !== b.date) return a.date < b.date ? 1 : -1;
    if (a.date && !b.date) return -1;
    if (!a.date && b.date) return 1;
    return compareVersions(b.version, a.version);
  });
  return { shipped, present: text.trim().length > 0 };
}

const STATUS_WORDS = "shipped|closed|wrapped|backfilled|completed?|released|archived|done|folded|delivered";

function entryFromLine(line) {
  let text = stripInlineMarkdown(String(line)).replace(/[\u2705\u2714\u2611\u{1F680}\u{1F389}]\uFE0F?/gu, "").replace(/\s+/g, " ").trim();
  // Logged but not shipped: superseded / abandoned always; "in progress",
  // "planned", "absorbed into vX" (or \ud83d\udea7 / \ud83d\udccb) unless a shipped-like word is there too.
  if (/\b(?:supersed|abandon|cancel+ed)\w*/i.test(text)) return null;
  const shippedWord = new RegExp(`\\b(?:${STATUS_WORDS})\\b`, "i").test(text);
  if (!shippedWord && (/\b(?:in progress|not started|planned|active|current|absorbed)\b/i.test(text) || /[\u{1F6A7}\u{1F4CB}]/u.test(text))) return null;
  const v = /(^|[\s(:\[])(v\d+(?:\.\d+)*)(?=$|[\s:,)\]\u2014\u2013-])/i.exec(text);
  if (!v) return null;
  const version = v[2].replace(/^V/, "v");
  const dateMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  const date = dateMatch ? dateMatch[1] : null;
  const before = text.slice(0, v.index + v[1].length).trim();
  let after = text.slice(v.index + v[0].length);
  after = after
    .replace(new RegExp(`\\s*\\((?=[^()]*(?:\\d{4}-\\d{2}-\\d{2}|\\b(?:${STATUS_WORDS})\\b))[^()]*\\)`, "gi"), " ")
    .replace(new RegExp(`\\s*[\u2014\u2013-]+\\s*(?:${STATUS_WORDS})\\b.*$`, "i"), "")
    .replace(/\s*[\u2014\u2013-]+\s*Phases?\s+[\d.]+(?:\s*[-\u2013\u2014]\s*[\d.]+)?\s*$/i, "")
    .replace(/\(\s*\)/g, "")
    .replace(/^[\s:\u2014\u2013-]+|[\s:\u2014\u2013-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const prefix = before.replace(/^(?:Milestone|Release)\s*/i, "").replace(/[\s:\u2014\u2013-]+$/g, "").trim();
  return { version, name: after || prefix || null, date };
}

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/i, "").split(".").map(Number), pb = String(b).replace(/^v/i, "").split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? -1, y = pb[i] ?? -1;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** ROADMAP milestone heading → name: "Milestone v1.4 — Fixes (Phases 31-48) — 🚧 IN PROGRESS" → "Fixes". */
export function nameFromHeading(heading, version) {
  if (typeof heading !== "string") return null;
  let t = stripInlineMarkdown(heading).replace(/^\s*#+\s*/, "").replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\uFE0F?/gu, "").trim();
  const at = version ? t.indexOf(version) : -1;
  if (at >= 0) t = t.slice(at + version.length);
  else if (version) return null;
  return tidyMilestoneName(t);
}

/** Drops progress decorations from a milestone name: "(Phases 132-143) — IN PROGRESS",
 *  "— ◆ CURRENT", "(In Progress)", a leading "Phase Details —". */
export function tidyMilestoneName(name) {
  if (typeof name !== "string") return null;
  const t = stripInlineMarkdown(name).replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u25C6\u25C7]\uFE0F?/gu, "")
    .replace(/\((?:Phases?\b|In Progress|Active|Current)[^)]*\)/gi, "")
    .replace(/\s[\u2014\u2013-]+\s*(?:IN PROGRESS|ACTIVE|CURRENT|PLANNED)\b.*$/i, "")
    .replace(/^\s*(?:Phase Details|Roadmap)\s*[\u2014\u2013:-]+\s*/i, "")
    .replace(/^[\s:\u2014\u2013-]+|[\s:\u2014\u2013-]+$/g, "").replace(/\s+/g, " ").trim();
  return t || null;
}

/** Inline markdown off a name: `code`, **bold**, __bold__, *em*, _em_ and
 *  [text](url) become plain text. Underscores inside a word (acme_router),
 *  emoji and every other character stay. */
export function stripInlineMarkdown(text) {
  if (typeof text !== "string") return text;
  let t = text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/`/g, "");
  for (let i = 0; i < 3; i++) {
    const next = t.replace(/(^|\W)(\*\*|__|\*|_)(\S(?:[\s\S]*?\S)?)\2(?!\w)/g, "$1$3");
    if (next === t) break;
    t = next;
  }
  return t.replace(/\*\*/g, "");
}

/** Strips YAML scalar quoting: "a \"b\"" → a "b"; 'it''s' → it's. A plain
 *  value loses a trailing " # comment" unless `comments` is false. */
export function unquoteYaml(value, comments = true) {
  if (typeof value !== "string") return value ?? null;
  const v = value.trim();
  if (v.length >= 2 && v[0] === '"' && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v[0] === "'" && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return comments ? v.replace(/\s+#.*$/, "") : v;
}

/** Placeholders STATE.md and ROADMAP use for "nothing" become null. */
function cleanValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s || /^(?:[\u2014\u2013-]+|\(?none\)?|null|n\/a|unknown|~)$/i.test(s)) return null;
  return s;
}

function count(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function dateFromName(file) {
  const m = /(?:^|\/)(\d{4}-\d{2}-\d{2})/.exec(String(file ?? ""));
  return m ? m[1] : null;
}

function clip(s, n) {
  s = String(s);
  return s.length > n ? `${s.slice(0, n - 1)}\u2026` : s;
}

/** The line of an error output that says what went wrong ("SyntaxError: …"
 *  rather than node's "[eval]:3" / "node:internal/…" stack header). */
function firstLine(s) {
  const lines = String(s ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const hit = lines.find((l) => /^(?:[A-Z]\w*)?Error\b[:\s]/.test(l))
    ?? lines.find((l) => !/^(?:node:internal|\[eval\]|at |\^|throw )/.test(l)) ?? lines[0] ?? "";
  return clip(hit, 200);
}

/** gsd-tools errors name absolute paths and add a "Recovery: …" paragraph; keep the gist. */
function relError(msg, root) {
  return String(msg ?? "").split(`${root}/`).join("").replace(/(?:\.planning\/)?phases\/[^/"\s]+\//g, "")
    .replace(/\.\s+Recovery:[\s\S]*$/, "").replace(/\s+/g, " ").trim();
}

function shortError(e) {
  return firstLine(e?.message ?? e) || "unknown error";
}
