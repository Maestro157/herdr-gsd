// Makes `node --test test/gsd/` work on every Node version.
// Node 22+ resolves a directory argument as a module and runs this file as
// the one test file (process.argv[1] is then the directory); Node 20 searches
// the directory itself and never runs this file. When a plain `node --test`
// discovers this file by name it does nothing, so no test runs twice.
const { basename } = require("node:path");
if (basename(process.argv[1] || "") !== "index.js") {
  const { readdirSync } = require("node:fs");
  for (const f of readdirSync(__dirname).filter((n) => n.endsWith(".test.mjs")).sort()) import(`./${f}`);
}
