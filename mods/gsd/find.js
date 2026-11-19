// Finding a phase or a todo in a snapshot: for the "Phase …" line and for the
// open-phase / open-todo commands. Pure (no host calls), so the tests use it as is.

/** The phase the current position names, when the list has it. */
export function positionPhase(s) {
  const pos = s?.position ?? {};
  return pos.phase ? (s.phases ?? []).find((p) => p.current) ?? (s.phases ?? []).find((p) => String(p.id) === String(pos.phase)) ?? null : null;
}

/** By id ("75.4", "09.1" = "9.1"); without one, the current phase, else the first one executing. */
export function findPhase(s, arg) {
  const phases = s?.state === "ok" ? s.phases ?? [] : [];
  if (!arg) return positionPhase(s) ?? phases.find((p) => p.status === "executing") ?? null;
  const norm = (x) => String(x).split(".").map((seg) => seg.replace(/^0+(?=\d)/, "")).join(".").toLowerCase();
  return phases.find((p) => String(p.id) === arg) ?? phases.find((p) => norm(p.id) === norm(arg)) ?? null;
}

/** The n-th pending todo (from 1), or the one whose file is named so ("…-share-page-404"),
 *  else the first whose file or title contains the text; without an argument, the first. */
export function findTodo(s, arg) {
  const todos = s?.state === "ok" ? s.todos ?? [] : [];
  if (!arg) return todos[0] ?? null;
  if (/^\d+$/.test(arg)) return todos[Number(arg) - 1] ?? null;
  const a = arg.toLowerCase(), base = (t) => String(t.file).toLowerCase().split("/").pop().replace(/\.md$/, "");
  return todos.find((t) => base(t) === a || base(t).endsWith(`-${a}`))
    ?? todos.find((t) => String(t.file).toLowerCase().includes(a) || String(t.title).toLowerCase().includes(a)) ?? null;
}
