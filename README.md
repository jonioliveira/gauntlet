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

Both scripts take `--dry-run`. `run-epic.sh` opens one herdr pane per task,
named `gan-<TASK-ID>` — kill a pane to stop that task. Ctrl-C on the runner does
not stop in-flight panes.

State names are per-team; resolve yours with `orca linear team states` and set
`GAN_DONE_STATES`, `GAN_CANCELED_STATES`, `GAN_INPROGRESS_STATES` if they differ
from the defaults (`Done`, `Canceled`, `In Progress`).

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
