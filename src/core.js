// Pure loop logic for the GAN engine.
//
// Every function here must be safe to inline verbatim into a Claude Code
// Workflow script: no imports, no I/O, no non-deterministic operations.
// `build.js` strips the `export` keywords and pastes this file in whole.

export function lensesFor(lenses, perRound, round, full) {
  const K = perRound == null ? lenses.length : perRound
  if (full || K >= lenses.length) return lenses
  const out = []
  for (let i = 0; i < K; i++) {
    out.push(lenses[(round * K + i) % lenses.length])
  }
  return out
}

export function freshIssues(results, seen) {
  const out = []
  for (const result of results) {
    const issues = (result && result.issues) || []
    for (const issue of issues) {
      if (!issue || typeof issue.id !== "string" || issue.id.length === 0) continue
      if (seen.has(issue.id)) continue
      if (out.some(o => o.id === issue.id)) continue
      out.push(issue)
    }
  }
  return out
}

export function advance(state, freshCount) {
  if (freshCount === 0) {
    // A clean round is weak evidence when only a subset of lenses ran, so the
    // next round escalates to the full set before convergence is allowed.
    return { dry: state.dry + 1, round: state.round + 1, full: true }
  }
  return { dry: 0, round: state.round + 1, full: false }
}

export function shouldContinue(state, termination, budgetRemaining) {
  if (state.dry >= termination.dryRounds) return false
  if (state.round >= termination.maxRounds) return false
  if (budgetRemaining !== null && budgetRemaining <= termination.budgetFloor) return false
  return true
}
