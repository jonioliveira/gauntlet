// Decides which tasks may launch. Pure: the runner does the I/O, this decides.
//
// Two invariants live here and nowhere else:
//   1. An in-progress task is never runnable — otherwise the loop relaunches a
//      task already running, creating a second worktree, pane and pipeline.
//   2. Only a DONE blocker unblocks a dependent. A failed task is left in its
//      original state, so its dependents stay blocked with no skip logic.

export function runnable(issues, stateNames) {
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
