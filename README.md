# gan-engine

Adversarial (GAN-style) pipelines for research and product definition, built on
Claude Code's Workflow tool and herdr panes.

A generator drafts, a rotating panel of critics attacks, the generator revises.
The loop ends only when a full panel pass finds nothing new.

## Install

    ./install.sh

Symlinks `skill/` to `~/.claude/skills/gan` and the built engine to
`~/.claude/workflows/gan-engine.js`.

## Use

    /gan research <question>   # evidence-backed findings, runs unattended
    /gan define <idea>         # a hardened spec, stops for your approval

## Research → tracked work → PRs

    /gan research "<question>"          # evidence-backed findings
    /gan decompose docs/spec/research/<slug>.md   # → epic + tasks, you approve
    bin/publish-epic.sh docs/spec/epics/<slug>/breakdown.md   # → Linear
    bin/run-epic.sh JON-<id> --dry-run  # see the plan
    bin/run-epic.sh JON-<id>            # run it

`install.sh` links `bin/` to `~/.claude/gan-bin`, so the skill can reach these
scripts from whichever repo it is running in.

Both scripts take `--dry-run`. `run-epic.sh --dry-run` simulates the *whole*
execution order — every wave, not just what is runnable right now — and prints
the exact commands each task would run.

`publish-epic.sh` is idempotent: if it stops part-way, fix the cause and re-run
the same command. Anything already in `published.json` is skipped, and each write
carries a stable `--write-id` so a lost response resolves rather than duplicates.

`run-epic.sh` opens one herdr tab per task, named `gan-<TASK-ID>` — kill it to
stop that task. Ctrl-C on the runner does not stop in-flight panes. A task that
fails is not retried within the same run; run the script again to retry it.

State names are per-team; resolve yours with `orca linear team states` and set
them explicitly rather than trusting the defaults:

| Variable | Default |
|---|---|
| `GAN_TODO_STATES` | `Todo` |
| `GAN_INPROGRESS_STATES` | `In Progress` |
| `GAN_DONE_STATES` | `Done` |
| `GAN_CANCELED_STATES` | `Canceled` |

Comparison is exact — case and whitespace matter. A wrong `GAN_TODO_STATES` means
a failed task cannot be released back out of in-progress (the runner warns on
stderr); a wrong `GAN_INPROGRESS_STATES` means every launched task still looks
runnable.

## Develop

    bun test        # unit tests for the pure loop logic
    bun run build   # regenerate dist/gan-engine.js

Loop logic lives in `src/core.js` and is unit-tested. The workflow body is
`src/engine.template.js`; `build.js` inlines the core into it because workflow
scripts cannot import.

Tune behaviour by editing `skill/configs/*.md`. Never add domain branching to
the engine.

- Design: [docs/spec/2026-08-24-gan-engine.md](docs/spec/2026-08-24-gan-engine.md)
- Plan: [docs/plans/2026-08-24-gan-engine.md](docs/plans/2026-08-24-gan-engine.md)
