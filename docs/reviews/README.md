# Reviews

Artifacts from the adversarial build of this engine, preserved because they carry
decisions the code cannot.

- `2026-08-25-final-review.md` — whole-branch review (opus). Found 2 Critical and 6
  Important defects that six task-scoped reviews all missed, because each saw only one
  task's diff. Also triages all 20 deferred minor findings into promote / do-while-open /
  follow-up / no-action, and judges the `converged` semantic.
- `2026-08-25-final-rereview.md` — verification of the fix wave. 7 of 8 addressed; I6
  (`bun test` vs a stale `dist/`) parked, see below.

## Resolved: I6 (stale `dist/`)

`package.json` has `"pretest": "bun run build"`, but Bun's `bun test` subcommand does not
run package.json lifecycle hooks — only `bun run test` does. So `pretest` alone left a
bare `bun test` passing green against a previously built artifact.

Closed by a freshness assertion in `test/build.test.js`: if any of `src/core.js`,
`src/engine.template.js` or `build.js` is newer than `dist/gan-engine.js`, the suite fails
with `build output is not stale — run \`bun run build\``. Both invocations are now honest —
`bun run test` rebuilds and passes, bare `bun test` fails loudly rather than lying.

---

## research → Linear → SDLC (2026-08-29)

- `2026-08-29-rts-final-review.md` — whole-branch review (opus). Found 3 Critical and
  11 Important defects that six task-scoped reviews all passed, because each judged a
  diff against its brief while the brief (the plan) under-implemented the spec. Also
  triages all 14 deferred minors and carries a first-live-run checklist.
- `2026-08-29-rts-final-fix-report.md` — the fix wave. Notable: it **corrected the
  review's own suggested fix** for C1 (`herdr tab create` has no `--json` flag, and the
  pane id is at `.result.root_pane.pane_id`, not `.paneId`), verified with one live
  invocation.
- `2026-08-29-rts-final-rereview.md` — verification. All findings addressed, no new
  defects.

## Known residuals — parked, not fixed

| # | What | Why it matters |
|---|---|---|
| I5 | The runner does not intersect runnable tasks against the manifest's task list | A Linear sub-issue of the epic added by hand would be launched into a full pipeline. Whether it *should* be is a product decision. |
| I10 | Repo binding is implicit in the caller's cwd | `bin/run-epic.sh` must be run from inside the target repo. Failure is loud. |
| — | `--max-parallel` is not validated | `0` or a non-integer spins on a live run (dry mode degrades gracefully). |
| — | `--base-branch main` is hardcoded | Visible in the dry-run plan; change it for a repo whose default branch differs. |

Plus eleven follow-up minors triaged in the final review.
