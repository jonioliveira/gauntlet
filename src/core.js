// Pure loop logic for the GAN engine.
//
// Every function here must be safe to inline verbatim into a Claude Code
// Workflow script: no imports, no I/O, no Date.now(), no Math.random().
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
