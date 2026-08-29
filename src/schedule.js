// Decides which tasks may launch. Pure: the runner does the I/O, this decides.
//
// Two invariants live here and nowhere else:
//   1. An in-progress task is never runnable — otherwise the loop relaunches a
//      task already running, creating a second worktree, pane and pipeline.
//   2. Only a DONE blocker unblocks a dependent. A failed task is left in its
//      original state, so its dependents stay blocked with no skip logic.

export function runnable(issues, stateNames) {
  // `new Set(undefined)` is an empty Set, not an error, and an empty set silently
  // inverts this function's guarantees: an empty `inProgress` makes a running task
  // look runnable again (duplicate pipeline), and an empty `done` means nothing ever
  // unblocks (silent stall). Both are worse than a crash, so refuse them.
  for (const key of ["done", "inProgress"]) {
    if (!Array.isArray(stateNames[key]) || stateNames[key].length === 0) {
      throw new Error(`runnable: stateNames.${key} must be a non-empty array of state names`)
    }
  }
  if (!Array.isArray(stateNames.canceled)) {
    throw new Error("runnable: stateNames.canceled must be an array")
  }

  const done = new Set(stateNames.done)
  const canceled = new Set(stateNames.canceled)
  const inProgress = new Set(stateNames.inProgress)
  const stateOf = new Map(issues.map(i => [i.id, i.state]))

  return issues.filter(issue => {
    if (done.has(issue.state)) return false
    if (canceled.has(issue.state)) return false
    if (inProgress.has(issue.state)) return false
    return (issue.blockedBy || []).every(id => {
      const s = stateOf.get(id)
      return s !== undefined && done.has(s)
    })
  })
}

// CLI entry so the runner can ask "what may launch now?" from bash.
// `bun src/schedule.js runnable <state.json> <done> <canceled> <inProgress>`
// prints one id per line. State names are comma-separated.
if (import.meta.main) {
  const [cmd, path, done, canceled, inProgress] = process.argv.slice(2)
  if (cmd !== "runnable" || !path) {
    console.error("usage: bun src/schedule.js runnable <state.json> <done> <canceled> <inProgress>")
    process.exit(2)
  }
  const issues = JSON.parse(await Bun.file(path).text())
  const split = s => (s || "").split(",").map(x => x.trim()).filter(Boolean)
  const ready = runnable(issues, {
    done: split(done), canceled: split(canceled), inProgress: split(inProgress),
  })
  for (const issue of ready) console.log(issue.id)
}
