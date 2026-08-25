# Reviews

Artifacts from the adversarial build of this engine, preserved because they carry
decisions the code cannot.

- `2026-08-25-final-review.md` — whole-branch review (opus). Found 2 Critical and 6
  Important defects that six task-scoped reviews all missed, because each saw only one
  task's diff. Also triages all 20 deferred minor findings into promote / do-while-open /
  follow-up / no-action, and judges the `converged` semantic.
- `2026-08-25-final-rereview.md` — verification of the fix wave. 7 of 8 addressed; I6
  (`bun test` vs a stale `dist/`) parked, see below.

## Known open item

`package.json` has `"pretest": "bun run build"`, but Bun's `bun test` subcommand does not
run package.json lifecycle hooks — only `bun run test` does. Verified: with `dist/`
removed, `bun test` fails 6 tests while `bun run test` rebuilds and passes.

**Use `bun run test`, not `bun test`.** A bare `bun test` after editing `src/` will pass
against the previously built artifact.
