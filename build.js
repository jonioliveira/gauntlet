// Inlines src/core.js into src/engine.template.js at the // @@CORE@@ marker.
//
// Workflow scripts cannot import, so the pure logic is developed and tested as
// a normal ES module and pasted in whole at build time. This keeps one copy of
// the source of truth while leaving the shipped script self-contained.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"

const MARKER = "// @@CORE@@"

const core = readFileSync("src/core.js", "utf8")
  .replace(/^export\s+function\s/gm, "function ")

if (/^\s*export\s/m.test(core)) {
  throw new Error("build: src/core.js has an export form the stripper does not handle")
}

const template = readFileSync("src/engine.template.js", "utf8")
if (!template.includes(MARKER)) {
  throw new Error(`build: src/engine.template.js is missing the ${MARKER} marker`)
}

mkdirSync("dist", { recursive: true })
writeFileSync("dist/gauntlet.js", template.replace(MARKER, core.trim()))
console.log("built dist/gauntlet.js")
