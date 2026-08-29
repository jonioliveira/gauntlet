# Final whole-branch review — research → Linear → SDLC

**Merge base:** 123fdb0 **Head:** ca5571c (16 commits)
**Reviewer scope:** whole branch, read-only. No live path executed; `--dry-run`
against fixtures and `--help` on `orca`/`herdr` only.

---

## Verdict

**Fix first.** Three Critical defects. Two of them (C1, C2) mean the runner
cannot complete a single task on a first live run and will loop forever trying;
the third (C3) means the documented recovery path from a partial publish
duplicates every issue in the user's Linear. The pure layers — parser,
validator, scheduler — are in good shape and I would merge them as they stand.
The two shell scripts need another round.

---

## What's Solid

Worth saying plainly, because several of these are the parts that are hardest to
get right and easiest to skip.

- **The bash-3.2 discipline is real and consistent.** The jq-as-map trick at
  `bin/publish-epic.sh:55-60` carries its own justification in a comment, and
  there is no `declare -A`, no `mapfile`, no `${var^^}`, no `wait -n` anywhere in
  either script. I checked the one remaining 3.2 trap — `${#matches[@]}` on an
  empty array under `set -u` (`bin/run-epic.sh:40`) — against the actual
  3.2.57 on this machine: it works.
- **The `set -e`-in-argument-position class is properly fixed, in the right
  shape, in both places.** `bin/publish-epic.sh:45-50` and `:80-85` put
  `save-issue` in command-substitution *assignment* position with an explicit
  `|| { … exit 1; }`, and then separately assert the identifier is non-empty via
  `// empty`. That is the correct two-part guard: it catches the failing call
  *and* the succeeding call that returns nothing useful.
- **`runnable()`'s refusal to accept empty state arrays** (`src/schedule.js:14-21`)
  is exactly the right call, and the comment explains *why* an empty set is worse
  than a crash rather than just asserting it. The tests distinguish "missing key"
  from "present but empty" (`test/schedule.test.js:49-57`) — the second is the one
  `Array.isArray` alone would wave through.
- **The parser's field model** — "a field runs until the NEXT marker, never until
  a line fails to match" (`src/breakdown.js:5-7`) — is the correct fix for the
  truncation class, and `test/breakdown.test.js:83-115` pins both the wrapped-prose
  and the blank-line-inside-a-field cases precisely.
- **`write_manifest` is called after every task, not at the end**
  (`bin/publish-epic.sh:87`). That is the property the spec's no-rollback policy
  actually rests on, and it would have been easy to write it once at the bottom.
- **The success-but-cannot-mark-done branch** (`bin/run-epic.sh:99-109`) is the
  best-reasoned error handling in the branch: it deliberately does *not* release
  the claim, says why in the comment, prints the exact manual recovery command,
  and leaves a note on the ticket. Getting that trade the right way round is rare.
- **The manifest-as-only-graph decision is documented at all three sites that
  depend on it** (`bin/publish-epic.sh:62-63`, `bin/run-epic.sh:26-28`, `:50-52`),
  so a future reader cannot quietly undo it.
- **Test density where it counts:** 15 scheduler tests and 22 parser tests, and
  the load-bearing ones are all present — in-progress not runnable, a canceled
  blocker does not unblock, a blocker id absent from the issue set does not unblock.

---

## Findings

### Critical (Must Fix Before Merge)

#### C1 — `herdr agent start` is missing its required `--pane <ID>`; no task can launch

`bin/run-epic.sh:91-92`

```bash
if ( cd "$WT" && herdr agent start "gan-$TASK" --kind claude \
      && herdr agent prompt "gan-$TASK" "/run-sdlc $TASK" --wait --timeout 3600000 ); then
```

`herdr agent start --help`:

```
Start a supported interactive agent in an existing pane
Usage: herdr agent start <NAME> --kind <KIND> --pane <ID> [OPTIONS] [-- [AGENT_ARG]...]
      --pane <ID>   Existing pane at an interactive shell prompt
```

`--pane` sits outside the `[OPTIONS]` group: it is required, and herdr does not
create the pane. Panes come from `herdr tab create` (`--workspace`, `--cwd <PATH>`,
`--label <TEXT>`, `--env`) or `herdr pane split`.

The `cd "$WT" &&` is also inert for herdr's purposes: a pane's working directory
comes from `herdr tab create --cwd`, not from the cwd of the process that calls
`herdr agent start`. So even with `--pane` supplied, the pipeline would run in
whatever directory that pane happened to be in — not the task's worktree. The
spec's "herdr agent start gan-<TASK-ID> (in that worktree)" is not achieved.

**Why it matters:** every task fails at the first live invocation, which drops
straight into C2's retry loop.

**Fix:** create the pane, capture its id, then start the agent in it:

```bash
PANE="$(herdr tab create --cwd "$WT" --label "gan-$TASK" --no-focus --json | jq -r '.paneId // empty')"
[ -n "$PANE" ] || { … fail … }
herdr agent start "gan-$TASK" --kind claude --pane "$PANE"
herdr agent prompt "gan-$TASK" "/run-sdlc $TASK" --wait --until idle --until done --timeout 3600000
```

(Confirm `tab create`'s JSON field name with one manual invocation — I did not run it.)
Close the tab on success alongside the worktree removal.

---

#### C2 — any task failure puts the runner into an unbounded relaunch loop

`bin/run-epic.sh:118` (and `:87`) release the claim back to `${TODO_STATES%%,*}`
after a failure. `:124` is `while :;`, `:125` re-fetches state, and `runnable()`
(`src/schedule.js:28-36`) returns that same task again — it is Todo, and its
blockers have not changed. Nothing anywhere in the script records that a task was
already attempted during this run.

Concretely, with C1 in place, the first live run is:

```
claim JON-42 → worktree create → herdr agent start fails → comment on JON-42
→ release to Todo → refetch → JON-42 runnable → claim → worktree create → …
```

forever, with no backoff, one Linear comment (`:74`) and one `orca worktree create`
per iteration. `launched` (`:135`) and `failed` (`:157`) both grow without bound.

The claim-failure branch at `:145-148` is the same loop with nothing in it at all:
`continue` leaves the task in Todo, `PIDS` stays empty, `wait` returns instantly,
and the loop spins as fast as `orca linear list-issues` can answer.

The only path that currently terminates after a failure is the one where the
claim-release *itself* fails and the task is stranded In Progress — i.e. the loop
terminates only when a second thing goes wrong.

**On authorship:** the spec is internally inconsistent here. §C requires "on
failure: … move back out of in-progress" and also "The runner exits when nothing is
runnable and nothing is in flight." With `runnable` defined as
`state ∉ {done, canceled, in-progress} ∧ blockers done`, those two cannot both
hold. Per the calibration note, that is a finding against the spec, not an excuse.

**Fix:** keep an in-run set of attempted task ids (a newline-delimited string is
enough on bash 3.2), filter `READY` through it before launching, and report those
ids in the final summary as failed. The Linear state change stays as-is — it is
what lets a *fresh* runner retry the task, which is the property the spec actually
wants.

---

#### C3 — publish is not idempotent; the documented recovery path duplicates every issue

Spec §B, "Partial failure and idempotency":

> - **On failure: stop, do not roll back.** Report exactly what was created.
> - **On re-run:** anything in the manifest is skipped. Publishing twice is safe.
> - `--write-id <uuid>` covers a write whose response was lost, where a naive retry
>   would duplicate the issue.

Neither the second nor the third bullet is implemented. `bin/publish-epic.sh` never
reads `$MANIFEST` — its only uses are `> "$MANIFEST"` at `:71` and the two error
messages at `:82` and `:85`. `--write-id` is never passed, and
`orca linear save-issue --help` confirms it exists and is exactly the intended tool:

```
--write-id <uuid>     Retry id from linear_write_unconfirmed
```

So the sequence the spec prescribes — publish fails on task 3 of 5, you are told
what exists, you fix the cause, you re-run — creates a **second epic** and
**duplicate copies of tasks 1 and 2**. Worse, `write_manifest` (`:64-72`) then
overwrites `published.json` with the new ids, destroying the only record of the
first batch. The user is left with orphaned issues they were explicitly promised
would be tracked, and the runner's graph now points at the second set.

The plan under-specifies this: `docs/plans/2026-08-27-research-to-sdlc.md:502`
describes the manifest's shape and its load-bearing `relations` array but says
nothing about skipping on re-run, which is why six task-scoped reviews passed it.

**Why it matters:** the least-reversible operation in the system, on its own
documented failure path, in the user's real Linear.

**Fix:** before pass 1, if `$MANIFEST` exists, seed `EPIC_ID` from `.epic` and
`TASK_MAP` from `.tasks`, and skip any title already present (still printing the
skip). Derive a stable `--write-id` per title (e.g. a uuid5-style hash of
`epic-slug + title`) so a lost response resolves rather than duplicates. Pass 2 is
already effectively idempotent if `relation add` is, but it should skip edges whose
endpoints were skipped, or record created relations separately from planned ones.

---

### Important (Should Fix Before Merge)

#### I1 — `orca worktree rm` gets a bare id where a selector is required; worktrees leak silently

`bin/run-epic.sh:110`

```bash
orca worktree rm --worktree "$TASK" --json >/dev/null 2>&1 || true
```

`orca worktree rm --help`:

```
--worktree <selector>  Worktree selector such as id:<repo-id>::<path>,
                       name:<displayName>, branch:<branch>, issue:<number>,
                       path:<path>, or active/current
```

`$TASK` is `JON-42` — not a selector. The `>/dev/null 2>&1 || true` means the
failure is completely invisible. Spec: "Removed on success, kept on failure for
inspection." As written, every worktree is kept, forever, and a later retry of the
same task collides on `--name`.

**Fix:** `--worktree "name:$TASK"` (matching the `--name "$TASK"` used at `:83`),
and replace `|| true` with a warning on stderr so a leak is at least visible.

#### I2 — `--dry-run` on the runner shows one layer, not the execution order

`bin/run-epic.sh:134` caps the inner loop at `$MAXP`; `:155` breaks out of the
outer loop after the first batch. Verified against the fixture:

```
$ GAN_FAKE_LINEAR=test/fixtures/epic-state.json bash bin/run-epic.sh JON-1 --dry-run --max-parallel 3
orca linear save-issue JON-2 --state "In Progress"
…
orca linear save-issue JON-5 --state "In Progress"
…
(dry run — nothing was created)
```

JON-3 — the only task in the fixture with a dependency, and therefore the only one
whose *ordering* the user might want to check — never appears.

Spec §C Safety: "`--dry-run` prints the execution order and the exact `run-sdlc`
invocations". The plan reduced this to "printing the exact commands without
executing any of them" (`docs/plans/…:27`), and that is what was built. This is
the flag whose entire purpose is to let the user see the fan-out before N draft PRs
exist; showing 3 of 12 defeats it.

**Fix:** in dry mode, simulate — after printing a wave, mark those ids done in a
local copy of the state file and iterate until nothing is runnable, printing
`--- wave N ---` between them. Keep the `MAXP` grouping as a label; do not use it
to truncate.

#### I3 — `herdr agent prompt --wait` treats a *blocked* agent as success

`bin/run-epic.sh:92`. From `herdr agent prompt --help`:

> It then matches idle, done, or blocked by default, or any exact `--until` state.

The spec's Open question 1 explicitly sanctions `gate-policy: always` in a target
repo's `AGENTS.md` as a supported configuration ("setting `gate-policy: always` in
a target repo's `AGENTS.md` makes every task in that repo stop for review"). In
exactly that repo, builders parks at the gate, `--wait` returns 0, `:99` moves the
issue to **Done**, and `:110` tries to remove the worktree — for a task where
nothing was built.

**Fix:** `--until idle --until done`, and handle a `blocked` return as a
stop-for-human outcome: leave the claim, leave the worktree, comment saying the
pipeline is waiting at a gate.

#### I4 — a null state from Linear makes every task runnable

`bin/run-epic.sh:60-66` reads `.state.name` with no guard. I ran the expression
standalone against a response whose issue lacks `.state`:

```json
[{"id":"JON-2","state":null,"blockedBy":[]}]
```

`runnable()` (`src/schedule.js:29-31`) rejects only states it recognises, so `null`
falls through as runnable. If `orca linear list-issues --json` ever returns a
different state shape, **the entire epic launches at once, graph ignored** — the
exact fan-out `--dry-run` exists to prevent.

The contrast is instructive: `bin/publish-epic.sh:48` and `:83` are carefully
defensive about precisely this (`.result.identifier // .identifier // empty`),
because it already bit this branch twice. `fetch_state` did not get the same
treatment.

**Fix:** `state: (.state.name // error("issue \(.identifier) has no state name"))`,
so a shape change is loud rather than catastrophic.

#### I5 — the runner launches issues that are not in the manifest

`bin/run-epic.sh:59-66` takes every issue `list-issues --parent-id` returns. A
sub-issue a human adds to the epic on the board gets `blockedBy: []` and is
immediately runnable → a worktree, a pane, and a full builders pipeline for a
ticket the runner was never given. The manifest's `tasks` array is written by
publish (`bin/publish-epic.sh:69`) and never read by anything.

**Fix:** intersect against the manifest inside the same jq expression:
`($m[0].tasks | map(.id)) as $known | … | select(.identifier | IN($known[]))`.

#### I6 — `orca worktree create`'s path extraction can yield the literal `"null"`

`bin/run-epic.sh:83-84`

```bash
if ! WT="$(orca worktree create … --json | jq -r '.result.path // .path')" || [ -z "$WT" ]; then
```

If neither key is present, `jq -r` prints `null`, so `WT="null"`, `[ -z "$WT" ]` is
false, and the run proceeds. `cd null` then fails, the task is reported as
"worktree kept at null", and with C2 it retries forever. This is the third
appearance of the `.result`-wrapped/`"null"` class in this branch; the other two
were fixed with `// empty` and this one was not.

**Fix:** `jq -r '.result.path // .path // empty'`.

#### I7 — parser: any unrecognised `**Word:**` line silently ends the current field

`src/breakdown.js:22-26` sets `field = null` for *every* line matching
`^\*\*[A-Za-z ]+:\*\*`, recognised or not. Verified:

```
**Description:** We must migrate the table.
**Note:** the old column stays.
More description that matters.
```

parses to `description: "We must migrate the table."` — the rest is dropped, with
no error and nothing in the validator to catch it. `**Note:**`, `**Why:**`,
`**Context:**`, `**Risk:**` are all plausible output from an opus generator that
was handed a format template rather than a grammar, and
`skill/configs/decompose.md:20-40` does not forbid them.

This is the same silent-truncation failure the branch already fixed once for blank
lines — the fix moved the boundary from "a line that doesn't match" to "the next
`**X:**`", but did not make unknown `**X:**` markers safe.

**Fix:** treat an unrecognised marker as content when a field is open (so it lands
in the description), *or* — better, since it fails loudly — have the validator
reject any `**X:**` marker outside the four known names, and say so in the config.

#### I8 — the epic is created before anything is written to the manifest

`bin/publish-epic.sh:45-53` creates the epic. `write_manifest` is first called at
`:87`, after the *first task* succeeds. If task 1's `save-issue` fails, the message
at `:82` reads "stopping. Created so far: $MANIFEST" and points at a file that does
not exist — while a real epic issue sits orphaned in Linear with no record anywhere.

**Fix:** call `write_manifest` immediately after `EPIC_ID` is captured, before the
task loop.

#### I9 — `bin/publish-epic.sh` is not reachable from where the skill tells you to run it

`skill/SKILL.md` step 8 (new in this branch):

> On approval, run `bin/publish-epic.sh <breakdown-path>` — never call `orca linear` by hand.

`install.sh:13-15` links only `skill/` and `dist/gan-engine.js` into `~/.claude`.
`bin/` is not installed anywhere. The skill executes in the user's *target* repo,
where `bin/publish-epic.sh` does not exist. Step 5 of the same file goes to real
trouble explaining that the engine path must be fully expanded and absolute
("`scriptPath` is a JSON string, not a shell word — nothing expands `~`"); the same
care was not applied two steps later.

**Fix:** either add `ln -sfn "$REPO/bin" "$HOME/.claude/gan-bin"` to `install.sh`
and reference that, or have step 8 resolve the gan-engine checkout the way step 5
resolves the engine and use an absolute path.

#### I10 — the runner's repo binding is implicit in the caller's cwd

`bin/run-epic.sh:35` globs `docs/spec/epics/*/published.json` **relative to cwd**;
`$REPO` (`:10`) is computed but used only at `:126` for `bun`. Verified:

```
$ cd /tmp && bash …/bin/run-epic.sh JON-1 --dry-run
no published.json names epic JON-1 — publish first
```

And `bin/run-epic.sh:83` calls `orca worktree create` with no `--repo` selector —
`orca worktree create --help` shows `[--repo <selector>|--project <id>…]` — so the
worktree is created in whatever repo the cwd belongs to.

In the normal flow this happens to be right (the manifest and the code are both in
the target repo, so the glob only resolves when cwd is correct). But
`bin/run-epic.sh:30-32` also accepts a **manifest path** as the argument, which
removes the accidental guard entirely: pass a path and the cwd is unconstrained,
and every worktree, branch and draft PR lands in whatever repo you happen to be
standing in. The README documents neither the cwd requirement nor the
manifest-path form.

**Fix:** derive the repo root from the manifest's location and pass
`--repo "path:$ROOT"` to `orca worktree create`; document that the runner is
repo-scoped.

#### I11 — `GAN_TODO_STATES` is undocumented, and getting it wrong strands tasks silently

`bin/run-epic.sh:15` defaults to `Todo`. The README (this branch) documents
`GAN_DONE_STATES`, `GAN_CANCELED_STATES`, `GAN_INPROGRESS_STATES` — not this one.
On a team whose backlog state is "Backlog" or "Unstarted", the claim-release at
`:87` and `:118` fails, `|| true` swallows it, and the task sits In Progress
forever with nothing said. (Notice that this wrong default is currently the *only*
thing that would stop C2's infinite loop on such a team — an accident, not a design.)

**Fix:** document it in the README alongside the other three, and emit a warning to
stderr when the release write fails rather than swallowing it.

---

### Minor (Follow-up)

- `bin/run-epic.sh:83` hardcodes `--base-branch main`. The spec does not sanction a
  base branch at all; repos on `master`/`develop` break. Make it a flag or env var.
- `bin/publish-epic.sh:32-36` — `run()` is defined and never called. `:23` — `SLUG`
  is computed and never used; it is the residue of the spec's
  `docs/spec/epics/<slug>/published.json`, which is now merely implied by `dirname`.
- `bin/publish-epic.sh:95` prints the `relation add` call without `--json` while
  `:97` sends it with. Spec testing item 2 asks for "the exact `orca linear`
  invocations".
- `.epic-body.md` / `.task-*.md` are written even under `--dry-run`, and are cleaned
  up only at `:100` — not on any of the four error exits (`:47`, `:50`, `:82`, `:85`).
- `src/breakdown.js:28-29`: an empty `**Estimate:**` parses to `0`, because
  `Number("") === 0`. jq's `// empty` treats `0` as truthy, so `--estimate 0` is sent.
  Guard on `rest === ""`.
- Duplicate dependencies (`**Depends on:** A, A`) pass validation and produce two
  identical `relation add` calls in pass 2. Dedupe in `parseTask`.
- `bin/run-epic.sh:134`: `--max-parallel 0` gives a tight infinite loop with zero
  launches; a non-numeric value silently *disables* the cap, because
  `[ "$n" -ge "abc" ]` exits 2 and the `&&` list never breaks. Validate it as an
  integer ≥ 1 at parse time.
- Extra positional arguments are silently swallowed, last-one-wins, in both scripts
  (`bin/publish-epic.sh:16`, `bin/run-epic.sh:21`).
- `bin/run-epic.sh:161` reports `launched: N, failed: M`. Spec §C asks for "done /
  failed / still-blocked counts" — still-blocked is the one a user actually needs,
  since "a run ending with blocked tasks is a normal outcome".
- `bin/run-epic.sh:156-158` waits on the whole batch rather than maintaining a
  sliding window of `MAXP`. Defensible on bash 3.2 (no `wait -n`), but the comment
  should say that is why, not leave it looking like an oversight.
- `src/breakdown.js:45` flattens nested sub-bullets into top-level acceptance
  criteria.
- `docs/spec/epics/` does not exist in this repo, so `bin/run-epic.sh`'s
  manifest-discovery *success* path has never executed anywhere — only the
  zero-match failure is covered (`test/run-epic.test.js:37-41`).

---

## Cross-Task Contract Check

**1. Manifest producer ↔ consumer — verified, with two gaps.**
`bin/publish-epic.sh:64-72` writes `{epic, tasks:[{title,id}], relations:[{child,parent}]}`.
`bin/run-epic.sh:32,:37` read `.epic`; `:61-66` read `.relations[]` and join
`.child`/`.parent` against Linear's `.identifier`. Both sides use identifiers, not
UUIDs — consistent. I ran the join expression standalone against a hand-built
manifest and a `.result`-wrapped `list-issues` response and it produced the correct
`blockedBy` arrays. Gaps: `.tasks` is written but never read (I5), and the join is
**never exercised by any test** — every runner test sets `GAN_FAKE_LINEAR`, which
short-circuits `fetch_state` at `:54-56` before the jq runs.

**2. Config ↔ parser — verified, with one gap.**
`skill/configs/decompose.md:20-40` documents `# EPIC:`, `## TASK:`, the four
`**Field:**` markers, comma-separated `Depends on:` with the literal `none`, and
the no-commas-in-titles rule. `src/breakdown.js` accepts exactly that, and the
comma rule is enforced at `:87-91` and tested at `test/breakdown.test.js:185`. Gap:
the config does not tell the generator that any *other* `**Word:**` marker will
silently terminate a field (I7).

**3. `runnable()` throwing contract ↔ CLI entry — verified end to end.**
`src/schedule.js:42-53` reads argv as `<state.json> <done> <canceled> <inProgress>`;
`bin/run-epic.sh:126-127` passes `"$STATE_FILE" "$DONE_STATES" "$CANCELED_STATES"
"$INPROGRESS_STATES"` in that exact order. The throw propagates correctly: an empty
`GAN_DONE_STATES` makes `split()` return `[]`, `runnable` throws, bun exits
non-zero, and `READY="$(…)"` under `set -e` aborts the runner. The throw itself is
unit-tested (`test/schedule.test.js:49-64`); the shell-level propagation is not, but
it is correct by inspection.

---

## Untested-Surface Risk

Every runner test sets `GAN_FAKE_LINEAR` and `--dry-run`, so `fetch_state`'s jq,
`run_task` in its entirety, and every `orca`/`herdr`/`gh` invocation are unexercised
by construction. Ranked by what a first live run would actually hit:

**Certain to fail:**
- `herdr agent start` without `--pane` (C1) — verified against the CLI's own usage.
- `orca worktree rm --worktree "$TASK"` (I1) — verified against the CLI's selector grammar. Fails silently.

**High risk, would fire on the first anomaly:**
- The failure branch of `run_task` (C2) — reached the moment anything goes wrong, and it loops.
- `fetch_state`'s `.state.name` with no guard (I4) — a schema change turns into a full uncontrolled fan-out.
- `orca worktree create`'s `.result.path // .path` (I6) — silently yields `"null"`.

**Fine on inspection, no change needed:**
- `orca linear save-issue [<id>] --state <state> --json` (`:87`, `:99`, `:118`, `:145`) — signature confirmed against `--help`; positional id is supported.
- `orca linear attach [<id>] --url <url> --title <title> --json` (`:97`) — confirmed; the help's own example is `orca linear attach ENG-123 --url … --title "PR/MR link"`.
- `orca linear comment add [<id>] --body <text> --json` (`:74`) — confirmed.
- `orca linear relation add [<id>] --related <issue> --type blocked-by --json` (`bin/publish-epic.sh:96-97`) — confirmed, including the `blocked-by` value and argument order. Spec Open question 2's direction check still wants one human look at the board on first publish, but the CLI surface is right.
- `orca linear list-issues --parent-id <issue> --json` with `--limit` omitted (`:59`) — the help states that omitting `--limit` returns every match and only sets `result.truncated` when a cap held results back. No pagination bug; I had suspected one and it is not there.
- `gh pr view --json url -q .url` (`:95`) — wrapped in `|| true` and only used if non-empty; safe.

**Not verifiable without running it, worth one manual check each before the first
real epic:** `herdr tab create`'s JSON field name for the pane id; whether
`orca linear save-issue --parent-id` accepts a `JON-nn` identifier (it is fed
`.result.identifier` at `bin/publish-epic.sh:48`); the actual key `orca worktree
create --json` returns for the worktree path.

---

## Deferred-Minor Triage

**Fix before merge (1 of 14):**

- **#2 — `### TASK:` at the wrong heading depth is silently absorbed.** `parseBreakdown`
  splits on `/^##\s+TASK:/m`, so a `###`-level task heading is not a task; its
  content is neither a `**Field:**` nor a bullet, so it is appended to the *previous*
  task's description and the task disappears. A whole unit of scope vanishing
  silently, on the input to the least-reversible operation in the system, is worth
  four lines in the validator: reject any line matching `^#{3,}\s+TASK:`.

**Trivial, take now while the files are open (2):**

- **#7** `run()` dead code, **#8** unused `SLUG` — both are one-line deletions in
  `bin/publish-epic.sh`, and `SLUG` in particular is a live misdirection about where
  the manifest goes.

**Follow-up (11):**

- **#1** characterization tests for odd input — the comma-in-title half is now
  covered (`test/breakdown.test.js:185`); the repeated-field half is subsumed by I7's fix.
- **#3** diamond topological-sort test, **#4** self-dependency error message,
  **#10** asymmetric rejection tests — all test-quality, none masking a defect.
- **#5** stale H1 ("research and product definition"), **#6** `**Estimate:**` doesn't
  say "bare number" — docs; bundle #6 with the empty-estimate-becomes-0 minor above.
- **#9** Pass 1/2 halt shows raw stderr with no banner — largely obsoleted by C3's
  fix, which has to print a recovery instruction anyway.
- **#11** exact-match state comparison — real, but the right response is one line in
  the README saying state names are case- and whitespace-sensitive (pairs with I11),
  not normalization code.
- **#12** the `s !== undefined` guard is indeed redundant (`done.has(undefined)` is
  already false) but it documents the "blocker not in the issue set" case. Leave it.
- **#13** batch-`wait` vs sliding window, **#14** bare count output — #14 overlaps a
  real spec gap (done / failed / still-blocked), so fold it into that rather than
  tracking it separately.

---

## First-Live-Run Readiness

**Not ready.** With C1 and C2 as they stand, pointing this at a real epic produces
an infinite loop that creates a worktree and posts a Linear comment per iteration
and never builds anything.

**Must fix before it is pointed at anything real:**

1. **C1** — pane creation, or nothing runs.
2. **C2** — the attempted-set, or a single failure loops forever.
3. **I1** — the `orca worktree rm` selector, or worktrees accumulate and retries collide on the name.
4. **I3** — `--until idle --until done`, or a gated pipeline is marked Done having built nothing.
5. **I4 + I6** — the two `// empty` / `// error` guards, so a shape change is loud instead of either a full fan-out or a `cd null`.
6. **I2** — a real `--dry-run`. This is the one that makes everything else survivable: if the user can see all N tasks and all N `run-sdlc` invocations before committing, a wrong graph or a wrong state name is caught on a printout instead of in seven worktrees.

**Must fix before the second run (the first one that can hit a partial failure):**

7. **C3** — publish idempotency. On a genuinely first-ever run, publish either
   succeeds or leaves orphans you can delete by hand. It is the *recovery* that
   duplicates, so this blocks merge but not, strictly, the very first attempt.

**Do before the first run, cheaply, without code:**

- Run `orca linear team states --json` for team `JON` and set the four
  `GAN_*_STATES` variables explicitly rather than trusting the defaults — including
  `GAN_TODO_STATES` (I11). A wrong in-progress name is the one config error the
  spec itself calls out as silently catastrophic.
- Publish a two-task epic and check one `blocked-by` edge on the board in the
  direction the spec's Open question 2 asks about, before running anything.
- Do the first run with `--max-parallel 1` on a repo where a bad PR costs nothing,
  per spec Testing item 4.

**Can wait:** every Minor above, plus the eleven follow-up deferred minors. None of
them changes what happens on a live run.
