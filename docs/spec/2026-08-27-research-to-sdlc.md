# Research → Linear → SDLC

**Date:** 2026-08-27
**Status:** Design approved; implementation not started
**Builds on:** `docs/spec/2026-08-24-gan-engine.md`

## Problem

`/gan research` produces an evidence-backed findings document. `builders`
(`~/workspace/builders`) takes a tracker ticket through seven stages to a reviewed
draft PR. Both ends exist; nothing joins them. Turning research into tracked,
buildable work is done by hand, one ticket at a time.

## Non-goals

- **Building an SDLC.** Builders already is one: `gather-context` →
  `check-architecture` → `plan-implementation` → `implement-plan` →
  `verify-changes` → `pr-review` → `pr-describe-draft`. This spec feeds it.
- **Modifying the GAN engine.** `decompose` is a third domain config beside
  `research` and `product`. `src/` does not change.
- **Modifying builders.** It is consumed, not edited.
- **A generic project-management layer.** One path: research → epic → tasks →
  pipelines → draft PRs.

## What already exists

| Capability | Where |
|---|---|
| Adversarial generate-and-attack loop | `dist/gan-engine.js`, this repo |
| Ticket → draft PR, 7 stages | `~/workspace/builders/.agent/skills/run-sdlc` |
| Multi-repo ticket split | builders `decompose-ticket` (different axis — repos, not epics) |
| Linear read/write, authenticated | `orca linear` (team `JON`) |
| Issue dependencies | `orca linear relation add --type blocks\|blocked-by` |
| Worktree isolation | `orca worktree create/rm` |
| Visible, interruptible agent panes | `herdr agent start/prompt/read` |

Linear is reachable through the Orca CLI rather than an MCP. No tracker MCP is
connected, and none is required.

## Architecture

```
/gan decompose docs/spec/research/<slug>.md
        │
        ├─ A. GAN engine (unchanged) — third domain config
        │     generator → 5 rotating critics → converge
        │     draft = canonical markdown breakdown
        │
        ├─ B. Publish — orca linear save-issue / relation add
        │     epic issue + N child tasks + blocked-by edges
        │
        └─ C. Runner — bin/run-epic.sh
              query Linear for unblocked → orca worktree + herdr pane
              → builders run-sdlc → draft PR → attach to Linear
```

Three pieces with one direction of dependency: A produces a document, B turns it
into Linear state, C reads Linear state. C never parses A's output, and B is the
only writer.

## A. The decompose domain

### Why the draft is markdown, not JSON

Linear needs structure, so the obvious choice is a JSON draft. Rejected: the draft
is revised by a model across up to five rounds, and one malformed brace in round
three kills the run. Markdown survives revision, stays readable to critics, and
matches how `research` and `product` already behave. Publish extracts structure at
the end, once, where a parse failure is recoverable and visible.

### Canonical draft format

```markdown
# EPIC: <title>

<summary — what this epic delivers, drawn from the research>

## TASK: <title>

**Estimate:** <points>
**Depends on:** <task title> | none
**Description:** <what and why>
**Acceptance criteria:**
- <criterion>
```

`## TASK:` sections are ordered but order carries no meaning — `Depends on:` is
the only ordering signal.

### Config

- **generator:** opus / xhigh, pane `true`
- **role:** "You turn research into buildable work. Every task you write must
  trace to something the research established. You would rather write four honest
  tasks than eight speculative ones."
- **task:** "Break the research below into one epic and its tasks, in the
  canonical format. Each task must be independently buildable, carry acceptance
  criteria a reviewer could check, and declare its dependencies."

| Lens | Attack | Model |
|---|---|---|
| `missing-work` | What work does this breakdown not account for? Name the specific gap. | sonnet / low |
| `granularity` | Which tasks are too large to estimate, or too small to justify a pipeline run? | sonnet / low |
| `dependencies` | What ordering is unstated? What breaks if these run in the given order? | sonnet / low |
| `unsupported` | What scope here is **not** justified by the research? Quote the claim it rests on, or flag it. | opus / medium |
| `feasibility` | What is expensive or hard in **this** repo? Cite `file:line`. | sonnet / low, `general-purpose` |

`unsupported` gets opus for the same reason `problem-fit` does in the product
config: it is the lens that stops the breakdown inventing work the research never
justified, and a cheap model rubber-stamps it. It is what makes this a
research-driven decomposer rather than a generic backlog generator.

- **termination:** `dryRounds: 2`, `maxRounds: 5`, `lensesPerRound: 3` (defaults)
- **checkpoint:** `before-final` — publishing creates real Linear issues and then
  fans out into N pipeline runs. That is the least reversible action in this
  system, so the breakdown is approved before anything is written.

## B. Publish

### Two passes, because relations need ids

Dependencies are written by title; Linear relations need ids.

**Pass 0 — validate. Writes nothing.**
- Parse the draft into an epic and tasks.
- Every `Depends on:` names a task in this breakdown, else STOP.
- The dependency graph is acyclic, else STOP.

A dangling reference or a cycle is caught before a single issue exists. The
alternative is discovering it after creating seven issues with no clean way back.

**Pass 1 — create.**
```
orca linear save-issue --team JON --title "<epic>" --body-file <f> --json
  → capture epic id
for each task, in file order:
  orca linear save-issue --team JON --parent-id <epic> --title "<task>" \
     --body-file <f> --estimate <n> --json
  → append {title, id} to the manifest
```
`--parent-id` gives epic→task hierarchy natively: both are issues, differing only
in parentage.

**Pass 2 — relate.**
```
for each task with dependencies:
  orca linear relation add <task-id> --related <dep-id> --type blocked-by
```

### Partial failure and idempotency

Publishing N issues is N chances to fail, and Linear has no transaction. Publish
maintains a manifest as it goes:

```
docs/spec/epics/<slug>/published.json
{ "epic": "JON-41",
  "tasks":     [ {"title": "…", "id": "JON-42"} ],
  "relations": [ ["JON-43", "JON-42"] ] }
```

- **On failure: stop, do not roll back.** Report exactly what was created. Silent
  rollback of issues the user cannot see is worse than orphans they are told about.
- **On re-run:** anything in the manifest is skipped. Publishing twice is safe.
- `--write-id <uuid>` covers a write whose response was lost, where a naive retry
  would duplicate the issue.

## C. The runner

```
bin/run-epic.sh <EPIC-ID> [--max-parallel 3] [--dry-run]

until no task changes state:
  edges  = published.json .relations          ← the graph
  state  = orca linear list-issues --parent-id <EPIC-ID> --json
             → .result.issues[] | {identifier, state.name}
  runnable = tasks where
             state ∉ {done, canceled, in-progress}
             and every blocking task IS done
  for each runnable task, while running < max-parallel:
      orca linear save-issue <TASK-ID> --state <in-progress-state>   ← claim it FIRST
      orca worktree create --name <TASK-ID> --linear-issue <TASK-ID>
      herdr agent start     gan-<TASK-ID>   (in that worktree)
      herdr agent prompt    "/run-sdlc <TASK-ID>" --wait
      on success: orca linear attach --current --url <pr>
                  orca linear save-issue <TASK-ID> --state <done-state>
                  orca worktree rm
      on failure: comment the failure; move back out of in-progress;
                  keep the worktree
```

### The in-progress state is load-bearing

Excluding `in-progress` from `runnable`, and claiming the task **before** launching
it, is what stops the loop relaunching a task already running. Without it, the
predicate "not done and unblocked" is true of a task mid-flight, and the next
iteration starts a second worktree, pane and pipeline for the same ticket.

This also means Linear holds the runner's entire *state* (the graph lives in the manifest — see below). Two consequences worth
having deliberately: the board shows what is running, and a runner that dies can
be restarted without double-launching anything — but a task left in `in-progress`
by a killed runner will not be retried until someone moves it back. That is the
right trade (a stuck task is visible; a duplicated pipeline is not), and it is why
failure moves the task **out** of `in-progress` rather than leaving it there.

### Where the graph lives — CORRECTED 2026-08-27

The design as first written had the runner read the dependency graph back from
Linear. **It cannot.** `orca linear` exposes `relation add` and `relation remove`
and no read verb, and neither `list-issues` nor `issue` returns a `relations` key.
Relations are write-only through this CLI. Verified before implementation.

The split that works, and is arguably better:

| | Source | Why |
|---|---|---|
| **Graph** (edges) | `published.json` manifest | Static after publish — cannot drift |
| **State** (per task) | `orca linear list-issues --parent-id <EPIC> --json` → `.result.issues[].state.name` | Dynamic — Linear is authoritative |

Relations are still written to Linear: a human reading the board sees the blocking
structure, which is most of their value. The runner simply does not read them back.

This preserves the property that matters — a task is runnable when every task
blocking it is done — so the failure policy below still falls out of the semantics
rather than from skip logic. Only the source of the edge list changes.

**Consequence: the manifest's `relations` array is load-bearing, not bookkeeping.**
It is the only machine-readable copy of the graph.

### Failure policy — Linear enforces it

A failed task is **never moved to done**. Because runnable means "every blocking
issue is done", its dependents never become runnable, while independent branches
continue. The skip-the-subtree behaviour falls out of the DAG semantics (edges from the
manifest, states from Linear);
the runner needs no code for it, no "failed" state of its own, and no
reconciliation path when its view and Linear's disagree.

The runner exits when nothing is runnable and nothing is in flight, reporting
done / failed / still-blocked counts. **A run ending with blocked tasks is a
normal outcome, not an error.**

### Concurrency and isolation

- **One Orca worktree per task.** Builders commits to a feature branch;
  concurrent runs in one checkout collide. Removed on success, kept on failure
  for inspection.
- **`--max-parallel 3`.** Each task is a full seven-stage builders run — three
  concurrent is roughly 21 live subagents. Configurable, deliberately bounded.
- **One herdr pane per task**, named `gan-<TASK-ID>`. This is the point of the
  chosen approach: N pipelines running unattended, each watchable and
  interruptible. Killing a pane fails that task cleanly.

### Safety

- **`--dry-run`** prints the execution order and the exact `run-sdlc` invocations
  without creating a worktree, pane, or branch. Auto-run fans out into N draft
  PRs; seeing the plan first is one flag away.
- **Stopping.** Ctrl-C on the runner does not stop in-flight panes — they are
  independent processes. Killing the panes stops the work. Documented rather than
  discovered.

## Open questions

**1. Builders' human gates — RESOLVED 2026-08-27. Not blocking.**
`run-sdlc` resolves both gates from one knob, `AGENTS.md → Plan gate` →
`gate-policy`, validated at preflight (missing = `auto`):

- `always` → gate regardless; on a headless run the stop is "the designed
  outcome, not a failure" and the record reads `blocked-on-human`.
- `never` → never gate; an explicit request becomes a recorded no-op.
- `auto` (default) → gate **iff the invocation carries an explicit request**.
  "No signal means unattended: run straight through."

The same policy governs the hand-off gate. The runner therefore needs **no
configuration**: it issues no gate request, so under the default `auto` both
gates pass through. Builders was built for unattended operation — "attendance is
declared by the launcher — never inferred from a TTY, a CI variable, or a hunch
that someone is watching."

Consequence worth keeping: setting `gate-policy: always` in a target repo's
`AGENTS.md` makes every task in that repo stop for review, without touching the
runner. Blast radius is a property of the repo being changed, which is the right
place for it.

**2. Relation direction (verify, do not assume).** Note this is now a check on what
humans see on the board, not on execution order — the runner takes its edges from the
manifest.

`relation add <A> --related <B> --type blocked-by` is read as "A is blocked by B".
That is the natural reading, but reversing it inverts the entire execution order.
The first publish verifies one edge in the Linear UI before the runner trusts it.

**3. Workflow state names are per-team and must be resolved, not hardcoded.**
The runner needs the concrete names of the in-progress and done states, which
`orca linear team states` reports for team `JON`. They belong in config beside the
team key. Picking them is a one-command lookup, but guessing them would silently
break the runnable predicate — a wrong in-progress name means every launched task
still looks runnable, and the loop double-launches everything.

**4. Team is configuration, not code.** `JON` is currently the only team.

## Testing

The decompose domain's output is prose; correctness is not assertable. What is:

1. **Parser and validator** — pure functions over the canonical format. Assert:
   a dangling `Depends on:` is rejected; a cycle is rejected; a valid breakdown
   yields the expected task list and edges. No model, no network.
2. **Publish, `--dry-run`** — assert the exact `orca linear` invocations, in
   order, against a fixture breakdown, without touching Linear.
3. **Runner scheduling** — with a stubbed Linear state, assert: only unblocked
   tasks launch; `--max-parallel` is respected; a failed task's dependents never
   become runnable; **a task already in `in-progress` is never relaunched**; the
   loop terminates when nothing is runnable.
4. **One real run**, small epic, `--max-parallel 1`, on a repo where a bad PR
   costs nothing.
