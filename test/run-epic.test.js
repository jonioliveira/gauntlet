import { test, expect } from "bun:test"
import { $ } from "bun"
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// GAN_FAKE_LINEAR points the runner at a JSON fixture instead of the real CLI,
// so scheduling is testable without touching Linear.
const FIX = "test/fixtures/epic-state.json"

const dry = (args, fixture = FIX) =>
  $`bash bin/run-epic.sh ${{ raw: args }}`
    .env({ ...process.env, GAN_FAKE_LINEAR: fixture }).text()

test("dry-run simulates every wave, not just the first", async () => {
  const out = await dry("JON-1 --dry-run --max-parallel 3")
  // JON-3 is the only task with a dependency, so it is the only one whose
  // ordering the flag exists to show. It must appear, and only after JON-2.
  expect(out).toContain("JON-2")
  expect(out).toContain("JON-3")
  expect(out.indexOf("JON-3")).toBeGreaterThan(out.indexOf("JON-2"))
  expect(out).toContain("--- wave 1 ---")
  expect(out).toContain("--- wave 2 ---")
})

test("a dependent task lands in a later wave than its blocker", async () => {
  const out = await dry("JON-1 --dry-run --max-parallel 3")
  const waves = out.split(/^--- wave \d+ ---$/m).slice(1)
  expect(waves.length).toBe(2)
  expect(waves[0]).toContain("gan-JON-2")
  expect(waves[0]).toContain("gan-JON-5")
  expect(waves[0]).not.toContain("gan-JON-3")
  expect(waves[1]).toContain("gan-JON-3")
})

test("a done task is never planned", async () => {
  const out = await dry("JON-1 --dry-run --max-parallel 3")
  expect(out).not.toContain("gan-JON-4")
})

test("--max-parallel groups the plan into batches without truncating it", async () => {
  const one = await dry("JON-1 --dry-run --max-parallel 1")
  const three = await dry("JON-1 --dry-run --max-parallel 3")
  const starts = s => s.split("\n").filter(l => l.includes("herdr agent start"))

  // Same work either way — max-parallel is a grouping label in dry mode, not a cap
  // on what is shown. Showing 1 of 3 defeats the flag's entire purpose.
  expect(starts(one).length).toBe(3)
  expect(starts(three).length).toBe(3)

  // ...but the batching a live run would use IS visible.
  expect(one).toContain("-- batch 2 (max-parallel 1) --")
  expect(three).not.toContain("-- batch 2 (max-parallel 3) --")
})

test("dry-run prints the pane creation herdr agent start requires", async () => {
  const out = await dry("JON-1 --dry-run --max-parallel 3")
  expect(out).toContain("herdr tab create --cwd <worktree> --label gan-JON-2 --no-focus")
  expect(out).toContain("herdr agent start gan-JON-2 --kind claude --pane <pane-id>")
})

test("dry-run creates no worktree, pane, or Linear write", async () => {
  const out = await dry("JON-1 --dry-run --max-parallel 3")
  expect(out).toContain("(dry run")
  const wt = await $`orca worktree list`.nothrow().quiet()
  expect(wt.stdout.toString()).not.toContain("JON-2")
})

test("real mode fails loudly when no manifest names the epic", async () => {
  const r = await $`bash bin/run-epic.sh JON-does-not-exist --dry-run`.nothrow().quiet()
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toContain("publish first")
})

// ---- C2: a failing task must not be relaunched forever ----
//
// Stubs shadow `orca` and `herdr` on PATH so the live loop runs with no real
// call. The fixture uses a team key that does not exist, so even a stub that
// somehow failed to shadow could not mutate anything.
function stubEnv(orcaBody) {
  const dir = mkdtempSync(join(tmpdir(), "gan-stub-"))
  const log = join(dir, "calls.log")
  writeFileSync(join(dir, "orca"), `#!/bin/sh\necho "orca $*" >> "${log}"\n${orcaBody}\n`)
  writeFileSync(join(dir, "herdr"), `#!/bin/sh\necho "herdr $*" >> "${log}"\nexit 1\n`)
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho "gh $*" >> "${log}"\nexit 1\n`)
  for (const f of ["orca", "herdr", "gh"]) chmodSync(join(dir, f), 0o755)

  const fixture = join(dir, "state.json")
  writeFileSync(fixture, JSON.stringify([
    { id: "ZZZ-9001", state: "Todo", blockedBy: [] },
    { id: "ZZZ-9002", state: "Todo", blockedBy: ["ZZZ-9001"] },
  ]))
  return { dir, log, fixture }
}

test("a task that fails is not relaunched for the rest of the run", async () => {
  // Every worktree create fails, so both claim-and-launch attempts fail. The
  // fixture state never changes, so without an attempted-set the runner would
  // claim, fail, release and re-claim the same task forever.
  const { dir, log, fixture } = stubEnv(
    `case "$1 $2" in "worktree create") exit 1 ;; esac\nexit 0`)

  const r = await $`bash bin/run-epic.sh ZZZ-9000 --max-parallel 3`
    .env({ ...process.env, PATH: `${dir}:${process.env.PATH}`, GAN_FAKE_LINEAR: fixture })
    .nothrow().quiet()

  expect(r.exitCode).not.toBe(0)
  const out = r.stdout.toString()
  expect(out).toContain("launched: 1, failed: 1")
  expect(out).toContain("(ZZZ-9001)")

  // One claim, one worktree attempt — not an unbounded stream of them.
  const calls = readFileSync(log, "utf8").split("\n")
  expect(calls.filter(l => l.startsWith("orca worktree create")).length).toBe(1)
}, 20000)

test("a failing task leaves its dependents blocked rather than looping", async () => {
  const { dir, fixture } = stubEnv(
    `case "$1 $2" in "worktree create") exit 1 ;; esac\nexit 0`)

  const r = await $`bash bin/run-epic.sh ZZZ-9000 --max-parallel 3`
    .env({ ...process.env, PATH: `${dir}:${process.env.PATH}`, GAN_FAKE_LINEAR: fixture })
    .nothrow().quiet()

  // ZZZ-9002 is blocked by ZZZ-9001, which never reached done. It must never launch.
  expect(r.stdout.toString()).not.toContain("ZZZ-9002")
}, 20000)

test("a claim that cannot be written is reported, not retried", async () => {
  // save-issue fails outright: the claim branch must record the task as attempted
  // too, or the loop spins as fast as list-issues can answer.
  const { dir, log, fixture } = stubEnv(
    `case "$1 $2" in "linear save-issue") exit 1 ;; esac\nexit 0`)

  const r = await $`bash bin/run-epic.sh ZZZ-9000 --max-parallel 3`
    .env({ ...process.env, PATH: `${dir}:${process.env.PATH}`, GAN_FAKE_LINEAR: fixture })
    .nothrow().quiet()

  expect(r.exitCode).not.toBe(0)
  expect(r.stdout.toString()).toContain("(ZZZ-9001)")
  expect(r.stderr.toString()).toContain("could not claim")
  const claims = readFileSync(log, "utf8").split("\n")
    .filter(l => l.startsWith("orca linear save-issue ZZZ-9001"))
  expect(claims.length).toBe(1)
}, 20000)

test("the stubs really shadowed the real CLIs", async () => {
  const { dir, log, fixture } = stubEnv(`exit 1`)
  await $`bash bin/run-epic.sh ZZZ-9000 --max-parallel 1`
    .env({ ...process.env, PATH: `${dir}:${process.env.PATH}`, GAN_FAKE_LINEAR: fixture })
    .nothrow().quiet()
  expect(existsSync(log)).toBe(true)
  expect(readFileSync(log, "utf8")).toContain("orca linear save-issue ZZZ-9001")
}, 20000)

// ---- C1 / I1 / I3 / I6: run_task's live path, with orca and herdr stubbed ----
//
// Every one of these calls was unexercised by construction before: the older
// tests all set --dry-run, so run_task never ran at all.
function liveStub({ worktreeJson, tabJson, agentStatus }) {
  const dir = mkdtempSync(join(tmpdir(), "gan-live-"))
  const log = join(dir, "calls.log")
  const wt = join(dir, "worktree")
  mkdirSync(wt)
  writeFileSync(join(dir, "orca"), `#!/bin/sh
echo "orca $*" >> "${log}"
case "$1 $2" in "worktree create") echo '${worktreeJson.replace("__WT__", wt)}' ;; esac
exit 0
`)
  writeFileSync(join(dir, "herdr"), `#!/bin/sh
echo "herdr $*" >> "${log}"
case "$1 $2" in
  "tab create") echo '${tabJson}' ;;
  "agent get") echo '{"result":{"agent":{"agent_status":"${agentStatus}"}}}' ;;
esac
exit 0
`)
  writeFileSync(join(dir, "gh"), `#!/bin/sh\necho https://example.test/pr/1\n`)
  for (const f of ["orca", "herdr", "gh"]) chmodSync(join(dir, f), 0o755)

  const fixture = join(dir, "state.json")
  writeFileSync(fixture, JSON.stringify([{ id: "ZZZ-9001", state: "Todo", blockedBy: [] }]))
  return {
    dir, log, wt, fixture,
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GAN_FAKE_LINEAR: fixture },
  }
}

const live = env => $`bash bin/run-epic.sh ZZZ-9000 --max-parallel 1`.env(env).nothrow().quiet()

test("a pane is created in the task's worktree and handed to herdr agent start", async () => {
  const s = liveStub({
    worktreeJson: '{"result":{"path":"__WT__"}}',
    tabJson: '{"result":{"root_pane":{"pane_id":"w9:p1"},"tab":{"tab_id":"w9:t1"}}}',
    agentStatus: "idle",
  })
  const r = await live(s.env)
  expect(r.exitCode).toBe(0)

  const calls = readFileSync(s.log, "utf8")
  // herdr does not create the pane, and --pane is required, not optional.
  expect(calls).toContain(`herdr tab create --cwd ${s.wt} --label gan-ZZZ-9001 --no-focus`)
  expect(calls).toContain("herdr agent start gan-ZZZ-9001 --kind claude --pane w9:p1")
  // --worktree takes a selector; a bare id matches nothing and the worktree leaks.
  expect(calls).toContain("orca worktree rm --worktree name:ZZZ-9001 --json")
  expect(calls).toContain("herdr tab close w9:t1")
})

test("a pane that cannot be created fails the task instead of starting nothing", async () => {
  const s = liveStub({
    worktreeJson: '{"result":{"path":"__WT__"}}',
    tabJson: '{"result":{}}',
    agentStatus: "idle",
  })
  const r = await live(s.env)
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toContain("no pane id")
  expect(readFileSync(s.log, "utf8")).not.toContain("herdr agent start")
})

test("a worktree path of null is a failure, not a literal \"null\" directory", async () => {
  const s = liveStub({
    worktreeJson: "{}",
    tabJson: '{"result":{"root_pane":{"pane_id":"w9:p1"},"tab":{"tab_id":"w9:t1"}}}',
    agentStatus: "idle",
  })
  const r = await live(s.env)
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toContain("worktree create failed")
  expect(readFileSync(s.log, "utf8")).not.toContain("herdr tab create")
})

test("an agent parked at a human gate is not marked done", async () => {
  const s = liveStub({
    worktreeJson: '{"result":{"path":"__WT__"}}',
    tabJson: '{"result":{"root_pane":{"pane_id":"w9:p1"},"tab":{"tab_id":"w9:t1"}}}',
    agentStatus: "blocked",
  })
  const r = await live(s.env)
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toContain("BLOCKED at a human gate")

  const calls = readFileSync(s.log, "utf8")
  // Nothing was built: no done transition, no cleanup, and the claim stays put
  // so a re-run does not relaunch it straight back into the same gate.
  expect(calls).not.toContain("--state Done")
  expect(calls).not.toContain("worktree rm")
  expect(calls).not.toContain("tab close")
  expect(calls).not.toContain("--state Todo")
})

// ---- I4: a state Linear cannot describe must be loud, not a full fan-out ----
function fetchStub(issuesJson) {
  const dir = mkdtempSync(join(tmpdir(), "gan-fetch-"))
  writeFileSync(join(dir, "orca"), `#!/bin/sh\necho '${issuesJson}'\nexit 0\n`)
  chmodSync(join(dir, "orca"), 0o755)
  const manifest = join(dir, "published.json")
  writeFileSync(manifest, JSON.stringify({
    epic: "ZZZ-9000",
    tasks: [{ title: "a", id: "ZZZ-9001" }, { title: "b", id: "ZZZ-9002" }],
    relations: [{ child: "ZZZ-9002", parent: "ZZZ-9001" }],
  }))
  return { manifest, env: { ...process.env, PATH: `${dir}:${process.env.PATH}` } }
}

test("a null state aborts rather than making every task runnable", async () => {
  const s = fetchStub('{"result":{"issues":[{"identifier":"ZZZ-9001","state":null}]}}')
  const r = await $`bash bin/run-epic.sh ${s.manifest} --dry-run`.env(s.env).nothrow().quiet()
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString()).toContain("no .state.name")
  expect(r.stdout.toString()).not.toContain("herdr agent start")
})

test("the manifest's edges become blockedBy against Linear's live states", async () => {
  const s = fetchStub('{"result":{"issues":[' +
    '{"identifier":"ZZZ-9001","state":{"name":"Todo"}},' +
    '{"identifier":"ZZZ-9002","state":{"name":"Todo"}}]}}')
  const r = await $`bash bin/run-epic.sh ${s.manifest} --dry-run`.env(s.env).nothrow().quiet()
  expect(r.exitCode).toBe(0)
  const waves = r.stdout.toString().split(/^--- wave \d+ ---$/m).slice(1)
  expect(waves.length).toBe(2)
  expect(waves[0]).toContain("gan-ZZZ-9001")
  expect(waves[1]).toContain("gan-ZZZ-9002")
})
