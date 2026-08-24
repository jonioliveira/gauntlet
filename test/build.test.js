import { test, expect } from "bun:test"
import { readFileSync, existsSync } from "node:fs"

const OUT = "dist/gan-engine.js"

test("build output exists", () => {
  expect(existsSync(OUT)).toBe(true)
})

test("build output is self-contained — meta is the only export", () => {
  const src = readFileSync(OUT, "utf8")
  expect(src).not.toMatch(/^\s*import\s/m)
  expect((src.match(/^export /gm) || []).length).toBe(1)
  expect(src).not.toMatch(/\brequire\s*\(/)
})

test("build output keeps meta as the first statement", () => {
  const src = readFileSync(OUT, "utf8")
  expect(src.trimStart().startsWith("export const meta")).toBe(true)
})

test("build output inlines every core function", () => {
  const src = readFileSync(OUT, "utf8")
  for (const fn of ["lensesFor", "freshIssues", "advance", "shouldContinue"]) {
    expect(src).toContain(`function ${fn}(`)
  }
})

test("build output contains no forbidden non-determinism", () => {
  const src = readFileSync(OUT, "utf8")
  // Strip full-line // comments: the constraint forbids CALLS, and core.js's
  // header comment legitimately names the very APIs it avoids. Trailing
  // comments after code are left alone, so a real call is still caught.
  const code = src.replace(/^\s*\/\/.*$/gm, "")
  expect(code).not.toMatch(/Math\.random\s*\(/)
  expect(code).not.toMatch(/Date\.now\s*\(/)
})

test("build output parses as JavaScript", () => {
  const src = readFileSync(OUT, "utf8")
  // `export const meta` is legal only in a module, so parse as one.
  expect(() => new Function(`return async () => { ${src.replace(/^export /, "")} }`))
    .not.toThrow()
})
