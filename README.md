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
