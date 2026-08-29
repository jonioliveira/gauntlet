import { test, expect } from "bun:test"
import { $ } from "bun"

const FIXTURE = "test/fixtures/breakdown-ok.md"

test("dry-run emits the exact orca calls in dependency order", async () => {
  const out = await $`bash bin/publish-epic.sh ${FIXTURE} --dry-run --team JON`.text()
  const lines = out.split("\n").filter(l => l.startsWith("orca "))

  expect(lines[0]).toContain("save-issue")
  expect(lines[0]).toContain("--team JON")
  expect(lines[0]).toContain("EPIC")

  const schemaAt = lines.findIndex(l => l.includes("schema"))
  const pageAt = lines.findIndex(l => l.includes("unit page"))
  expect(schemaAt).toBeGreaterThan(0)
  expect(pageAt).toBeGreaterThan(schemaAt)

  expect(lines.some(l => l.includes("relation add") && l.includes("blocked-by"))).toBe(true)
})

test("dry-run writes nothing", async () => {
  await $`bash bin/publish-epic.sh ${FIXTURE} --dry-run --team JON`.quiet()
  const manifest = Bun.file("test/fixtures/published.json")
  expect(await manifest.exists()).toBe(false)
})

test("a cycle is rejected before any orca call", async () => {
  const r = await $`bash bin/publish-epic.sh test/fixtures/breakdown-cycle.md --dry-run --team JON`
    .nothrow().quiet()
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString().toLowerCase()).toContain("cycle")
  expect(r.stdout.toString()).not.toContain("orca linear save-issue")
})

test("a dangling dependency is rejected before any orca call", async () => {
  const r = await $`bash bin/publish-epic.sh test/fixtures/breakdown-dangling.md --dry-run --team JON`
    .nothrow().quiet()
  expect(r.exitCode).not.toBe(0)
  expect(r.stdout.toString()).not.toContain("orca linear save-issue")
})
