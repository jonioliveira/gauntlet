# gauntlet

Adversarial (GAN-style) pipelines for research and product definition, built on
Claude Code's Workflow tool and herdr panes.

A generator drafts, a rotating panel of critics attacks, the generator revises.
The loop ends only when a full panel pass finds nothing new.

## Prerequisites

`orca` (Linear + worktrees), `herdr` (panes), `bun`, `jq`, and **bash 3.2+** —
macOS's stock bash is fine and is what this is written against.

**Per target repo:** `bin/run-epic.sh` sends `/run-sdlc` to an agent, and that
skill comes from [builders](../builders), which installs per repository:

```bash
cd <target-repo>
cp -R ~/workspace/builders/bundles/generic/.agent/skills .agent/skills
cp ~/workspace/builders/bundles/generic/AGENTS.template.md .
# fill in AGENTS.md: verify command, ADR source, and gate-policy
```

Skip this and the runner works perfectly right up to the point where the agent
has no `/run-sdlc` skill — which surfaces as a per-task pipeline failure, not as
a setup error.

## Install

    ./install.sh

Symlinks `skill/` to `~/.claude/skills/gauntlet` and the built engine to
`~/.claude/workflows/gauntlet.js`.

## Use

    /gauntlet research <question>   # evidence-backed findings, runs unattended
    /gauntlet define <idea>         # a hardened spec, stops for your approval

## Research → tracked work → PRs

    /gauntlet research "<question>"          # evidence-backed findings
    /gauntlet decompose docs/spec/research/<slug>.md   # → epic + tasks, you approve
    bin/publish-epic.sh docs/spec/epics/<slug>/breakdown.md   # → Linear
    bin/run-epic.sh JON-<id> --dry-run  # see the plan
    bin/run-epic.sh JON-<id>            # run it

`install.sh` links `bin/` to `~/.claude/gauntlet-bin`, so the skill can reach these
scripts from whichever repo it is running in.

Both scripts take `--dry-run`. `run-epic.sh --dry-run` simulates the *whole*
execution order — every wave, not just what is runnable right now — and prints
the exact commands each task would run.

`publish-epic.sh` is idempotent: if it stops part-way, fix the cause and re-run
the same command. Anything already in `published.json` is skipped, and each write
carries a stable `--write-id` so a lost response resolves rather than duplicates.

`run-epic.sh` opens one herdr tab per task, named `gauntlet-<TASK-ID>` — kill it to
stop that task. Ctrl-C on the runner does not stop in-flight panes. A task that
fails is not retried within the same run; run the script again to retry it.

State names are per-team; resolve yours with `orca linear team states` and set
them explicitly rather than trusting the defaults:

| Variable | Default |
|---|---|
| `GAUNTLET_TODO_STATES` | `Todo` |
| `GAUNTLET_INPROGRESS_STATES` | `In Progress` |
| `GAUNTLET_DONE_STATES` | `Done` |
| `GAUNTLET_CANCELED_STATES` | `Canceled` |

Comparison is exact — case and whitespace matter. A wrong `GAUNTLET_TODO_STATES` means
a failed task cannot be released back out of in-progress (the runner warns on
stderr); a wrong `GAUNTLET_INPROGRESS_STATES` means every launched task still looks
runnable.

## Develop

    bun test        # unit tests for the pure loop logic
    bun run build   # regenerate dist/gauntlet.js

Loop logic lives in `src/core.js` and is unit-tested. The workflow body is
`src/engine.template.js`; `build.js` inlines the core into it because workflow
scripts cannot import.

Tune behaviour by editing `skill/configs/*.md`. Never add domain branching to
the engine.

- Design: [docs/spec/2026-08-24-gan-engine.md](docs/spec/2026-08-24-gan-engine.md)
- Plan: [docs/plans/2026-08-24-gan-engine.md](docs/plans/2026-08-24-gan-engine.md)
