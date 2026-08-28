---
name: gan
description: Run an adversarial generate-and-attack pipeline that hardens work against a rotating panel of critics. Use when the user types /gan research <question> or /gan define <idea>, or asks to research something rigorously, stress-test a draft, or turn a rough product idea into a spec that has survived criticism.
---

# GAN — adversarial research and product definition

A generator drafts; a rotating panel of critics attacks; the generator revises.
The loop ends only when a full panel pass finds nothing new.

## Usage

- `/gan research <question>` — evidence-backed findings, runs unattended
- `/gan define <idea>` — a hardened spec, stops for the user's approval
- `/gan decompose <research-doc>` — a Linear epic and its tasks, stops for your approval

## What to do

1. **Parse the subcommand.** `research`, `define`, or `decompose`. If none is given, ask which one — do not
   guess.

2. **Compute a slug.** Kebab-case, 2–4 words, derived from the input
   (e.g. "should we adopt tRPC" -> `adopt-trpc`). It names the herdr pane and
   must stay stable across resumes, so write it down and reuse it.

3. **Read the matching config** — `configs/research.md`, `configs/product.md`, or
   `configs/decompose.md` from this skill's directory. It holds the generator
   framing, the lenses, and the preflight agents as prose.

4. **Confirm the output path with the user** before running. Research goes to
   `docs/spec/research/<slug>.md`, product definition to
   `docs/spec/<YYYY-MM-DD>-<slug>.md`, both relative to the repo they are in.
   If the current directory is not a git repo, ask where output should land.

5. **Resolve the engine path.** Run `echo $HOME` with Bash and use
   `<that value>/.claude/workflows/gan-engine.js` as the `scriptPath`.
   `scriptPath` is a JSON string, not a shell word — nothing expands `~`, so it
   must be a fully-expanded absolute path. If that file does not exist, the user
   has not run `./install.sh` yet; tell them so and stop, rather than falling
   back to a path inside the repo.

6. **Call the Workflow tool** with that `scriptPath` and an `args`
   object built from the config, in exactly this shape:

   `{slug, input, preflight: [...], generator: {...}, lenses: [...],
     termination: {...}, output: {path}}`

   Pass `args` as a real JSON object, never a JSON-encoded string.

7. **When it returns**, report `converged`, `rounds`, and the count of
   `issuesRaised`. If `converged` is false, say so plainly — the draft is
   unfinished, not merely long.

   **Always report `unresolved`, even when `converged` is true.** It holds the
   critiques a critic raised again after the generator had already been shown
   them — direct evidence the generator refused a critique rather than fixed
   it. `converged` means the loop stopped finding anything *new*, not that
   every objection was answered, so a run can converge with a blocking issue
   outstanding. If `unresolved` is non-empty, list each entry's `claim` and say
   which ones the generator declined to address; if it is empty, say so — that
   is the difference between a draft that survived criticism and one that
   merely outlasted it.

8. **Write the draft** to the agreed output path.
   - `research`: write it, then summarise the findings.
   - `define`: do **not** write it yet. Show the user the draft and the issues
     that were raised, and ask for approval first. This checkpoint exists
     because no critic can judge whether it is the right product to build.
   - `decompose`: do **not** publish yet. Show the user the breakdown and the issues
     that were raised, and ask for approval. On approval, run
     `bin/publish-epic.sh <breakdown-path>` — never call `orca linear` by hand.

## Notes

- The engine is rebuilt with `bun run build` in `~/workspace/gan-engine` after
  any change to `src/`. A stale `dist/` is the most likely cause of an edit
  appearing to have no effect.
- Tune lenses by editing the config markdown. Never add domain branching to the
  engine — if `gan-engine.js` ever needs to know which domain it is running,
  the shared engine was the wrong call.
