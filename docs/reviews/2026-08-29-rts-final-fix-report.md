# Final fix wave — report

**Branch:** `feat/research-to-sdlc` **Base head:** `ca5571c`
**Scope:** C1, C2, C3; I1, I2, I3, I4, I6, I7, I9, I11; deferred minor #2 and the
two dead-code deletions in `bin/publish-epic.sh`. Nothing else in the review was
touched.

---

## The `herdr tab create` field name (C1's open question)

**Command run** (the single sanctioned live invocation, in a scratch directory):

```
herdr tab create --cwd /private/tmp/claude-501/.../scratchpad/tabtest \
                 --label "gan-probe" --no-focus
```

**Response:**

```json
{"id":"cli:tab:create","result":{
  "root_pane":{"pane_id":"w5:p13","tab_id":"w5:tC","cwd":"…/tabtest", …},
  "tab":{"tab_id":"w5:tC","label":"gan-probe","number":12, …},
  "type":"tab_created"}}
```

**Confirmed:**
- pane id → `.result.root_pane.pane_id`
- tab id → `.result.tab.tab_id`

**Correction to the review's suggested fix:** there is **no `--json` flag** on
`herdr tab create`. The `herdr tab`/`agent`/`pane` helpers speak JSON over the
socket API unconditionally, and passing `--json` would be an unknown-argument
error. The review's `--json | jq -r '.paneId'` was wrong on both counts — the flag
and the field. Both are corrected in the implementation.

**Cleanup:** `herdr tab close w5:tC` → `{"result":{"type":"ok"}}`. `herdr tab list`
afterwards shows the same five tabs that existed before the probe. Nothing left
behind.

`herdr agent get <target>` (read-only, run against an already-running agent) was
also inspected for I3: status is at `.result.agent.agent_status`, one of
`idle|working|blocked|unknown`.

---

## Critical

### C1 — `herdr agent start` had no pane; nothing could launch

`bin/run-epic.sh:115-128`.

`run_task` now creates the pane itself and passes it in:

```bash
TABJSON="$(herdr tab create --cwd "$WT" --label "gan-$TASK" --no-focus 2>/dev/null)" || TABJSON=""
PANE="$(printf '%s' "$TABJSON" | jq -r '.result.root_pane.pane_id // empty' …)"
TAB="$(printf  '%s' "$TABJSON" | jq -r '.result.tab.tab_id  // empty' …)"
[ -z "$PANE" ] → fail the task (worktree kept, claim released)
herdr agent start "gan-$TASK" --kind claude --pane "$PANE"
```

The inert `( cd "$WT" && … )` subshell around `agent start` is gone: a pane's
working directory comes from `tab create --cwd`, never from the cwd of the caller.
`--cwd "$WT"` is what actually puts the pipeline in the task's worktree, which is
the spec's "in that worktree". The `cd "$WT"` that remains is only around
`gh pr view`, where it is genuinely needed.

On success the tab is closed alongside the worktree removal
(`bin/run-epic.sh:169-176`).

**Verified:** `test/run-epic.test.js:191` ("a pane is created in the task's
worktree and handed to herdr agent start") asserts, against a PATH-stubbed
`herdr`, that the call log contains
`herdr tab create --cwd <the worktree> --label gan-ZZZ-9001 --no-focus` and
`herdr agent start gan-ZZZ-9001 --kind claude --pane w9:p1` — i.e. the id really
flows from the tab response into `--pane`.
`test/run-epic.test.js:209` asserts that a tab response carrying no pane id fails
the task rather than calling `agent start` with an empty `--pane`.

### C2 — a single failure was an unbounded relaunch loop

`bin/run-epic.sh:230-282`.

An in-run attempted set, as a newline-delimited string (bash 3.2 has no sets):

```bash
ATTEMPTED=""
was_attempted() { printf '%s\n' "$ATTEMPTED" | grep -Fxq -- "$1"; }
```

`READY` is filtered through it before launching; a task is added to `ATTEMPTED`
the moment it is picked up, so both the claim-failure branch and `run_task`'s
failure branches are covered. When every runnable task has already been tried
this run, the outer loop breaks (`bin/run-epic.sh:271`).

**Linear state transitions are unchanged**, per the ruling: releasing the claim is
what lets a *fresh* runner retry, and that is the property the spec wants. The
attempted set only stops the *current* process relaunching.

Attempted-but-failed ids are reported: `launched: 1, failed: 1 (ZZZ-9001)`
(`bin/run-epic.sh:284`), fed by `mark_failed` from both the claim-failure branch
and the `wait` loop (which now tracks `pid:task` pairs rather than bare pids).

**Verified:** three tests, all against PATH-stubbed `orca`/`herdr` with a fixture
whose state never changes — exactly the condition that used to loop forever:
- `test/run-epic.test.js:96` — worktree create always fails; asserts exactly **one**
  `orca worktree create` in the call log, exit non-zero, and the failed id in the
  summary. It terminates in ~1s; before the fix this fixture is a non-terminating loop.
- `test/run-epic.test.js:129` — the claim itself fails; asserts exactly one
  `save-issue` for the task.
- `test/run-epic.test.js:117` — the dependent task never launches.

Also re-run by hand under `/bin/bash` 3.2.57 directly: terminates, one claim, one
worktree attempt, one comment, one release.

### C3 — publish was not idempotent; the documented recovery duplicated everything

`bin/publish-epic.sh:34-70, 97-161`.

Three parts:

1. **Manifest-seeded skipping** (`:63-73`). If `published.json` exists, `EPIC_ID`
   is seeded from `.epic`, `TASK_MAP` from `.tasks`, `RELS_DONE` from
   `.relationsCreated`. Each skip prints:
   `skip (already published): epic ZZZ-1`,
   `skip (already published): "<title>" -> ZZZ-2`,
   `skip (already related): "<child>" blocked-by "<parent>"`.
   Seeding runs in `--dry-run` too, so the dry run is an accurate preview of the
   resume rather than of a fresh publish.

2. **Stable `--write-id`** (`:34-48`). `write_id_for` hashes `"<slug>|<title>"`
   with `openssl md5` and formats it as a v5-shaped uuid. No clock, no randomness
   — a retry produces the byte-identical uuid the lost write used. The breakdown
   basename namespaces it so the same title in two epics cannot collide. If
   `openssl` is missing the function returns non-zero and callers omit the flag,
   which is exactly the pre-fix behaviour.

3. **Created relations recorded separately from planned ones** (`:55-61`, `:102-110`,
   `:146-161`). `relations` in the manifest stays the *planned* graph in ids — the
   runner needs the whole edge list even if pass 2 never ran. A new
   `relationsCreated` array records what pass 2 actually wrote, and only a re-run
   reads it. The reviewer's alternative ("skip edges whose endpoints were skipped")
   would have broken the case where publish halts *during* pass 2: every task is in
   the manifest, so every edge would be skipped and the graph never wired.
   `relation add` also now stops on failure with the same resume instruction, rather
   than aborting silently through `set -e`.

**One scope note, stated explicitly:** `write_manifest` is now called immediately
after `EPIC_ID` is captured (`bin/publish-epic.sh:112-115`). That is finding **I8**,
which was not in my list. I included it because C3 is not actually correct without
it: if task 1 fails, the "Created so far: $MANIFEST" message points at a file that
does not exist and the resume path has no epic id to seed, so the re-run creates a
*second* epic — the precise duplication C3 exists to prevent. It is four lines and
it is load-bearing for C3.

**A second deviation from the letter of the instructions:** the deferred minor
"`SLUG` is computed and never used" was resolved by **using** it rather than
deleting it. C3's ruling requires the write-id to be derived from "the epic slug
plus the task title", and `SLUG` is exactly that value. Deleting it and then
recomputing the same string two lines later would be worse. The misdirection the
finding objected to (it looked like it named the manifest path) is addressed with a
comment at `:23-24` saying what it is now for. The `run()` dead-code helper **was**
deleted as instructed.

**Verified:** `test/publish.test.js:71` runs publish twice against a stubbed `orca`
and asserts the second run makes **zero** additional `save-issue` calls, prints all
three skip forms, and leaves the manifest naming the original epic with both tasks.
`test/publish.test.js:91` simulates a partial failure (epic succeeds, first task
fails) and asserts the manifest exists and names the epic. `test/publish.test.js:118`
asserts the write-ids are identical across two runs, distinct per title, and
uuid-shaped.

---

## Important

### I1 — `orca worktree rm` selector

`bin/run-epic.sh:169-171`. `--worktree "name:$TASK"` (matching the `--name "$TASK"`
used at creation), and `|| true` replaced with a warning naming the selector and
the path left behind. Verified in the call log by
`test/run-epic.test.js:191`: `orca worktree rm --worktree name:ZZZ-9001 --json`.

### I2 — `--dry-run` now shows the whole execution order

`bin/run-epic.sh:186-226`. Dry mode fetches state once, then simulates: print a
wave, mark those ids done in a local copy of the state file (`sim_mark_done`,
`:192-200`), repeat until nothing is runnable. `--- wave N ---` separates waves;
`--max-parallel` is a grouping label only (`-- batch N (max-parallel M) --`) and
never truncates.

Against the fixture, `--max-parallel 3`:

```
--- wave 1 ---
-- batch 1 (max-parallel 3) --
  … JON-2 … JON-5 …
--- wave 2 ---
-- batch 1 (max-parallel 3) --
  … JON-3 …
planned: 3 task(s) over 2 wave(s)
(dry run — nothing was created)
```

With `--max-parallel 1` the same three tasks appear, split into `-- batch 1 --` and
`-- batch 2 --` inside wave 1.

**Three existing tests were amended** — flagged here rather than quietly:

| Old test | Why it had to change |
|---|---|
| `dry-run launches only unblocked tasks` (asserted `not.toContain("JON-3")`) | JON-3 is now shown, in wave 2. That is the fix. Replaced by *"dry-run simulates every wave, not just the first"* and *"a dependent task lands in a later wave than its blocker"*, which assert JON-3 appears **and** that it appears after JON-2. |
| `dry-run respects --max-parallel` (asserted 1 launch at `--max-parallel 1`) | `--max-parallel` must no longer truncate dry output. Replaced by *"--max-parallel groups the plan into batches without truncating it"*, which asserts 3 launches at both 1 and 3, plus the batch labels. |
| `dry-run launches every runnable task when max-parallel allows` (asserted 2) | Now 3 across two waves. Folded into the same replacement test. |

The behaviour these tests protected — a blocked task is not launched *in the same
wave as its blocker* — is still asserted, now per-wave rather than by absence from
the whole output.

### I3 — a blocked agent is no longer marked Done

`bin/run-epic.sh:129-155`. `--until idle --until done --until blocked` is now
spelled out (it is herdr's default set, but the three are not interchangeable
here), and the outcome is read back rather than inferred from the exit code, which
cannot distinguish them: `herdr agent get "gan-$TASK"` →
`.result.agent.agent_status`. A `blocked` status takes a stop-for-human branch that
leaves the claim, the pane and the worktree in place and comments on the ticket
saying where to answer the gate.

Deviation from the reviewer's literal `--until idle --until done`: excluding
`blocked` would make a gated pipeline hang for the full hour timeout before
failing. Matching it and then inspecting the status gets the same decision
immediately.

**Verified:** `test/run-epic.test.js:233` asserts that with a stubbed
`agent_status: "blocked"` the call log contains **no** `--state Done`, **no**
`worktree rm`, **no** `tab close`, and **no** `--state Todo` (the claim is not
released), and that stderr says `BLOCKED at a human gate`.

### I4 — a null state is now loud

`bin/run-epic.sh:70`:
`state: (.state.name // error("issue \($id) came back with no .state.name"))`.
With `pipefail`, jq's error fails `fetch_state` and aborts the runner.

**Verified:** `test/run-epic.test.js:266` stubs `orca linear list-issues` returning
`{"identifier":"ZZZ-9001","state":null}`; the runner exits non-zero, stderr contains
`no .state.name`, and stdout contains no `herdr agent start`. The companion test at
`:274` feeds well-formed states through the same previously-untested jq join and
asserts the manifest's edge produces the right two-wave order — closing the
"the join is never exercised by any test" gap the review noted.

### I6 — `"null"` worktree path

`bin/run-epic.sh:107`: `jq -r '.result.path // .path // empty'`. Verified by
`test/run-epic.test.js:221`, which stubs `orca worktree create` returning `{}` and
asserts the task fails with `worktree create failed` and never reaches
`herdr tab create` — instead of proceeding with `WT="null"`.

### I7 — an unrecognised `**Word:**` marker is now rejected

`src/breakdown.js:5-10, 46-49, 119-126`. `parseTask` records any header matching
`^\*\*([A-Za-z ]+):\*\*` whose name is not one of the four canonical fields into
`task.unknownFields`; `validateBreakdown` turns each into an error naming the
marker and the four that are allowed. Chosen over "treat it as content" because it
fails loudly, per the review's own preference.

`skill/configs/decompose.md:37-41` now tells the generator that those four markers
are the only ones allowed and that any other ends the field above it.

**Verified:** `test/breakdown.test.js:191` uses the review's exact reproduction
(`**Note:**` between a description and its continuation) and asserts `ok: false`
with `**Note:**` named. `test/breakdown.test.js:211` asserts the canonical sample
is still clean.

### I9 — `bin/` is now reachable from the skill

`install.sh:15-18` adds `ln -sfn "$REPO/bin" "$HOME/.claude/gan-bin"` (and reports
it). `skill/SKILL.md:70-79` step 8 now names
`<$HOME>/.claude/gan-bin/publish-epic.sh` and tells the reader to resolve `$HOME`
with `echo $HOME` the same way step 5 does, why a relative `bin/…` names nothing
from the user's own repo, and what to do if the path is missing. It also states
that publishing is idempotent and that re-running is the recovery path.
`README.md:29-30` documents the link.

**Verified:** `bash -n install.sh` passes; the link is a one-line `ln -sfn` matching
the two beside it. Not executed — running `install.sh` writes into `~/.claude`,
which is outside this task's remit.

### I11 — `GAN_TODO_STATES` documented; release failures no longer swallowed

`README.md:44-58` documents all four `GAN_*_STATES` variables in a table with their
defaults, says comparison is exact (case and whitespace), and spells out what a
wrong `GAN_TODO_STATES` and a wrong `GAN_INPROGRESS_STATES` each cause.

`bin/run-epic.sh:82-89`: a new `release_claim` helper replaces both `|| true` sites
and warns on stderr naming the state it tried and the variable to check. The
claim-failure branch (`:263`) also now names `GAN_INPROGRESS_STATES`.

---

## Deferred minors promoted by the reviewer

- **#2 — `### TASK:` silently absorbed.** `src/breakdown.js:78-88` collects every
  `^#{3,}\s+TASK:` line into `breakdown.malformedTaskHeadings`;
  `src/breakdown.js:101-106` rejects each with a message saying it is absorbed into
  the previous task. `skill/configs/decompose.md:43-46` says so too.
  **Verified:** `test/breakdown.test.js:217` first demonstrates the defect (only one
  task is split out of a two-heading document) and then asserts the validator
  rejects it with "wrong depth".
- **`run()` dead code** — deleted from `bin/publish-epic.sh`.
- **`SLUG` unused** — kept and made load-bearing instead of deleted; see the C3
  section above for why, and for the comment that removes the misdirection.

---

## Verification

**`bash -n`:**

```
$ bash -n bin/publish-epic.sh && echo OK   → OK
$ bash -n bin/run-epic.sh     && echo OK   → OK
$ bash -n install.sh          && echo OK   → OK
```

Also re-run under `/bin/bash` 3.2.57 explicitly. `bash` on `PATH` on this machine
*is* `/bin/bash` 3.2.57, so the whole suite already executes against 3.2.

**Forbidden constructs:** `grep -nE 'declare -A|mapfile|\$\{[A-Za-z_]+\^\^|wait -n|\[-1\]'`
over `bin/*.sh install.sh` matches only the two comments that explain why those
constructs are avoided.

**Tests:**

```
$ bun test
 86 pass
 0 fail
 187 expect() calls
Ran 86 tests across 6 files. [12.97s]
```

Up from 67. New coverage: 6 dry-run/wave tests, 4 attempted-set tests, 6 run_task
live-path tests (previously unexercised by construction), 2 `fetch_state` jq tests,
3 publish-idempotency tests, 4 parser/validator tests.

The live-path tests shadow `orca`, `herdr` and `gh` with stub scripts on `PATH` and
use issue ids in a `ZZZ-` team that does not exist, so a stub that somehow failed
to shadow could not mutate anything. One test asserts the stubs really did shadow.

**No real service was touched.** No `orca` command of any kind was invoked except
`orca linear save-issue --help` and `orca worktree rm --help` (help text only, no
network write). No `gh`, no `run-sdlc`, no `herdr agent start`, no
`herdr agent prompt`, no `orca worktree create/rm`, no
`orca linear save-issue/attach/comment/relation add`. Neither `bin/publish-epic.sh`
nor `bin/run-epic.sh` was run without `--dry-run` against anything but PATH-stubbed
binaries. The only live mutating call in the entire task was the sanctioned
`herdr tab create` probe and its `herdr tab close` cleanup, both documented above.
`herdr agent list` / `herdr agent get` / `herdr tab list` were used read-only.

---

## Not fixed

Everything else in the review, as instructed — I5, I8 (except the four lines C3
requires, disclosed above), I10, and all fourteen Minor / eleven deferred-minor
follow-ups. Specifically worth carrying forward, since this wave touched their
neighbourhoods:

- **I5** — the runner still launches sub-issues that are not in the manifest.
  `.tasks` is now written *and* read (by publish, for resume), but the runner still
  does not intersect against it.
- **I10** — the runner's repo binding is still implicit in cwd, and
  `orca worktree create` still takes no `--repo` selector.
- **Minor: `--max-parallel` validation.** A non-integer or `0` is still not
  validated. The new dry-mode batching degrades gracefully (one odd batch label)
  rather than dividing by zero, but a live run with `--max-parallel 0` still spins.
- **Minor: `--base-branch main` is still hardcoded** at `bin/run-epic.sh:107`, and
  is now also printed in the dry-run plan, so at least it is visible before a run.

Nothing in scope was left unfinished.
