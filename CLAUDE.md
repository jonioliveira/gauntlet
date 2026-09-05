# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`gauntlet` runs adversarial generate-and-attack loops: a generator drafts, a rotating
panel of critic agents attacks, the generator revises. The loop ends only when a full
panel pass finds nothing new. It ships as a Claude Code **skill** (`skill/`) that calls a
Claude Code **Workflow script** (`dist/gauntlet.js`), plus two bash orchestrators in
`bin/` that carry a decompose result into Linear and then into per-task pipelines.

## Commands

```bash
bun run build           # regenerate dist/gauntlet.js from src/
bun run test            # build, then run the full suite  (pretest hook)
bun test                # run the suite WITHOUT rebuilding — see staleness note below
bun test test/core.test.js          # one file
bun test -t "a done task"           # one test by name
./install.sh            # build + symlink skill/, dist/, bin/ into ~/.claude
```

`dist/` is gitignored and untracked — a fresh clone must build before anything works.

**`bun test` does not run `pretest`.** Only `bun run test` does. To keep a bare
`bun test` from passing green against a stale artifact, `test/build.test.js` asserts
`dist/gauntlet.js` is newer than `src/core.js`, `src/engine.template.js` and `build.js`.
A failure reading `build output is not stale` means run `bun run build`, not that you
broke something.

`install.sh` symlinks rather than copies, so edits to `skill/` and `bin/` take effect
immediately. Edits to `src/` do **not** — they need `bun run build`. A stale `dist/` is
the most likely cause of an engine edit appearing to have no effect.

Shell scripts are tested by driving their `--dry-run` paths through `bun:test`, with
`GAUNTLET_FAKE_LINEAR=<fixture.json>` standing in for the real `orca linear` CLI.

## Architecture

Three layers that only ever meet through files:

**1. The engine — `src/core.js` + `src/engine.template.js` → `dist/gauntlet.js`**

Workflow scripts cannot `import`, so `build.js` splices `src/core.js` into
`src/engine.template.js` at the `// @@CORE@@` marker and strips the `export` keywords.
That is why `src/core.js` must contain **no imports, no I/O, and no `Date.now()` or
`Math.random()`** — it has to be safe to inline verbatim and deterministic under unit
test. `test/build.test.js` enforces all of this on the built artifact.

The engine is **domain-agnostic and must stay that way.** Lenses, generator framing and
preflight agents are prose in `skill/configs/{research,product,decompose}.md`, read by
the skill and passed in as `args`. If `gauntlet.js` ever needs to know which domain it
is running, the shared engine was the wrong call — tune the config, never add branching.

Loop semantics worth knowing before touching `src/core.js`:
- `lensesFor` rotates a subset of critics per round; a dry round escalates to the *full*
  panel before convergence is allowed (`advance` sets `full: true`).
- `converged` means the loop stopped finding anything **new** — not that every objection
  was answered. `unresolved` (a critique re-raised after the generator had already been
  shown it) is the separate, load-bearing signal, and the skill must always report it.
- A malformed critic reply is filtered out rather than counted, because a silent failure
  would otherwise be a vote for convergence. All critics failing is a hard abort.

**2. The publisher — `src/breakdown.js` + `bin/publish-epic.sh`**

`breakdown.js` parses and validates the canonical `# EPIC: / ## TASK:` markdown, then
topologically sorts it (Kahn). Pass 0 validates and writes nothing, so cycles and
dangling references are caught before a single Linear issue exists. Its parser rules
matter: a field runs until the *next* `**Field:**` marker, so an unrecognised marker
silently truncates the field above it — hence `unknownFields` and the validator that
rejects them. A `### TASK:` at the wrong depth is likewise collected and rejected rather
than silently absorbed into the previous task.

`publish-epic.sh` is idempotent. `published.json` is both the resume record and, because
`orca linear` has **no relation-read verb**, the only machine-readable copy of the
dependency graph — `bin/run-epic.sh` reads its edges. Each write carries a `--write-id`
derived deterministically from the breakdown slug + title, so a lost response resolves
rather than duplicates. Never derive that id from the clock or a random source.

**3. The runner — `src/schedule.js` + `bin/run-epic.sh`**

Linear holds all the state; the runner asks `runnable` what may launch rather than
tracking its own graph. Per task it claims the issue, creates an `orca` worktree, opens a
herdr tab named `gauntlet-<TASK-ID>`, and sends `/run-sdlc <TASK-ID>` to a Claude agent
in it (that skill comes from the separate **builders** repo and must be installed in each
target repo — see README).

The failure policy is deliberate and has no skip logic: a failed task is **never** moved
to done, so its dependents never unblock. A failure releases the claim so a *fresh* run
can retry; an `ATTEMPTED` list stops the same run relaunching it in an unbounded loop.
Two cases intentionally keep the claim instead: a pipeline blocked at a human gate
(nothing was built), and a success whose done-transition failed (re-running would redo
completed work).

`runnable` throws on an empty `done` or `inProgress` state list rather than defaulting.
`new Set(undefined)` is a silently empty set, and an empty `inProgress` makes a running
task look runnable again — a duplicate worktree, pane and pipeline. A crash is better.

## Constraints

- **bash 3.2** (macOS stock) is the target. No `declare -A` — associative maps are held
  as JSON strings through `jq`. No `wait -n` — the runner waits on a whole batch rather
  than keeping a sliding window. These are decisions, not oversights.
- Linear state names are **per-team and compared exactly** (case and whitespace).
  `GAUNTLET_TODO_STATES`, `GAUNTLET_INPROGRESS_STATES`, `GAUNTLET_DONE_STATES`,
  `GAUNTLET_CANCELED_STATES`, `GAUNTLET_LINEAR_TEAM`. Resolve real names with
  `orca linear team states`.
- Both `bin/` scripts must run from inside the target repo — repo binding is implicit in
  the caller's cwd. The skill reaches them via `$HOME/.claude/gauntlet-bin`, never a
  relative `bin/`, because it runs in the user's repo which has no `bin/` of its own.
- The generator runs in a long-lived herdr pane and transports its document through
  `/tmp/gauntlet-<slug>-r<N>.md`, never pane scrollback (which truncates and wraps).
  It degrades to a background agent on `PANE_UNAVAILABLE`.

## Docs

`docs/spec/` and `docs/plans/` are the design record; `docs/reviews/` holds adversarial
review artifacts and a parked-residuals table worth reading before "fixing" something
that looks wrong. These deliberately still say `gan-engine` / `/gan` / `GAN_*` — that was
the project's name until 2026-09-03 and the documents are records of decisions taken at
the time. **Do not rewrite them.** `docs/reviews/README.md` carries the rename table.

Commits follow conventional-commit prefixes (`feat(scope):`, `fix(scope):`, `docs:`).
