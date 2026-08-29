import { test, expect } from "bun:test"
import { $ } from "bun"

// GAN_FAKE_LINEAR points the runner at a JSON fixture instead of the real CLI,
// so scheduling is testable without touching Linear.
const FIX = "test/fixtures/epic-state.json"

test("dry-run launches only unblocked tasks", async () => {
  const out = await $`bash bin/run-epic.sh JON-1 --dry-run --max-parallel 3`
    .env({ ...process.env, GAN_FAKE_LINEAR: FIX }).text()
  expect(out).toContain("JON-2")
  expect(out).not.toContain("JON-3")
})

test("dry-run respects --max-parallel", async () => {
  const out = await $`bash bin/run-epic.sh JON-1 --dry-run --max-parallel 1`
    .env({ ...process.env, GAN_FAKE_LINEAR: FIX }).text()
  const launches = out.split("\n").filter(l => l.includes("herdr agent start"))
  expect(launches.length).toBe(1)
})

test("dry-run creates no worktree, pane, or Linear write", async () => {
  const out = await $`bash bin/run-epic.sh JON-1 --dry-run --max-parallel 3`
    .env({ ...process.env, GAN_FAKE_LINEAR: FIX }).text()
  expect(out).toContain("(dry run")
  const wt = await $`orca worktree list`.nothrow().quiet()
  expect(wt.stdout.toString()).not.toContain("JON-2")
})

test("real mode fails loudly when no manifest names the epic", async () => {
  const r = await $`bash bin/run-epic.sh JON-does-not-exist --dry-run`.nothrow().quiet()
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toContain("publish first")
})
