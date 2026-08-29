import { test, expect } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

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

// ---- C3: publish is idempotent; a re-run resumes rather than duplicating ----
//
// Stubs shadow `orca` on PATH so the real Linear is never touched. Identifiers
// are handed out from a counter so the second run has something to skip.
function stubDir() {
  const dir = mkdtempSync(join(tmpdir(), "gan-pub-"))
  const log = join(dir, "calls.log")
  const counter = join(dir, "counter")
  writeFileSync(join(dir, "orca"), `#!/bin/sh
echo "orca $*" >> "${log}"
n=$(cat "${counter}" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "${counter}"
echo "{\\"result\\":{\\"identifier\\":\\"ZZZ-$n\\"}}"
exit 0
`)
  chmodSync(join(dir, "orca"), 0o755)
  const breakdown = join(dir, "epic-under-test.md")
  writeFileSync(breakdown, readFileSync(FIXTURE, "utf8"))
  return { dir, log, breakdown, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }
}

const saveIssueCalls = log =>
  readFileSync(log, "utf8").split("\n").filter(l => l.startsWith("orca linear save-issue"))

test("a re-run skips everything already in the manifest", async () => {
  const { dir, log, breakdown, env } = stubDir()

  const first = await $`bash bin/publish-epic.sh ${breakdown} --team JON`.env(env).text()
  expect(first).toContain("published:")
  expect(saveIssueCalls(log).length).toBe(3) // epic + two tasks

  const second = await $`bash bin/publish-epic.sh ${breakdown} --team JON`.env(env).text()
  expect(second).toContain("resuming from")
  expect(second).toContain("skip (already published): epic ZZZ-1")
  expect(second).toContain('skip (already published): "Add contact columns to the schema"')
  expect(second).toContain("skip (already related)")

  // The whole point: the second run writes nothing at all.
  expect(saveIssueCalls(log).length).toBe(3)
  const manifest = JSON.parse(readFileSync(join(dir, "published.json"), "utf8"))
  expect(manifest.epic).toBe("ZZZ-1")
  expect(manifest.tasks.length).toBe(2)
})

test("the epic is in the manifest before the first task can fail", async () => {
  // save-issue succeeds once (the epic) and then fails, which is the partial
  // failure the spec's recovery path is written for.
  const dir = mkdtempSync(join(tmpdir(), "gan-pub-"))
  const counter = join(dir, "counter")
  writeFileSync(join(dir, "orca"), `#!/bin/sh
n=$(cat "${counter}" 2>/dev/null || echo 0)
n=$((n+1))
echo $n > "${counter}"
[ "$n" -gt 1 ] && exit 1
echo "{\\"result\\":{\\"identifier\\":\\"ZZZ-$n\\"}}"
exit 0
`)
  chmodSync(join(dir, "orca"), 0o755)
  const breakdown = join(dir, "epic-under-test.md")
  writeFileSync(breakdown, readFileSync(FIXTURE, "utf8"))

  const r = await $`bash bin/publish-epic.sh ${breakdown} --team JON`
    .env({ ...process.env, PATH: `${dir}:${process.env.PATH}` }).nothrow().quiet()

  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toContain("Re-run the same command to resume")
  // The message points at a manifest — it must actually exist and name the epic.
  const manifest = JSON.parse(readFileSync(join(dir, "published.json"), "utf8"))
  expect(manifest.epic).toBe("ZZZ-1")
})

test("--write-id is stable across runs so a lost response cannot duplicate", async () => {
  const ids = out => out.split("\n")
    .filter(l => l.includes("--write-id"))
    .map(l => l.match(/--write-id (\S+)/)[1])

  const a = ids(await $`bash bin/publish-epic.sh ${FIXTURE} --dry-run --team JON`.text())
  const b = ids(await $`bash bin/publish-epic.sh ${FIXTURE} --dry-run --team JON`.text())

  expect(a.length).toBe(3)
  expect(a).toEqual(b)
  expect(new Set(a).size).toBe(3) // and distinct per title
  for (const id of a) expect(id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
})
