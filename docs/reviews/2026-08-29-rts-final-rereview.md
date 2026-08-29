# Final re-review — fix wave verification

**Fix base:** ca5571c **Head:** a162672
**Scope:** re-verify C1, C2, C3, I1, I2, I3, I4, I6, I7, I9, I11, and the three
promoted minors against the fix diff. Read-only; no live `orca`/`herdr`/`gh`
calls made — only `bash -n` and a static `grep` for forbidden bash-4 constructs.

---

### Finding Verdicts

- **C1** — ADDRESSED. `bin/run-epic.sh:106-127`. `run_task` now creates the pane
  via `herdr tab create --cwd "$WT" --label "gan-$TASK" --no-focus` (no `--json`
  flag, matching the corrected contract), extracts
  `.result.root_pane.pane_id` and `.result.tab.tab_id`, and calls
  `herdr agent start "gan-$TASK" --kind claude --pane "$PANE"`. An empty `$PANE`
  (`bin/run-epic.sh:122-127`) fails the task, releases the claim, and returns
  before `agent start` is ever called with an empty `--pane`. The inert
  `cd "$WT" && herdr agent start …` subshell is gone; `--cwd "$WT"` on `tab
  create` is what now actually places the pipeline in the task's worktree.

- **C2** — ADDRESSED. `bin/run-epic.sh:233-282`. Traced by hand: `ATTEMPTED` is
  a newline-delimited string, checked via `was_attempted()` before a task is
  counted toward `nready` or launched (`:249-256`); a task is added to
  `ATTEMPTED` the moment it is picked up for launch — before the claim write —
  so both the claim-failure branch (`:262-266`) and every `run_task` failure
  branch are covered by the same guard. The outer `while :; do … done` breaks
  when `nready` is 0, i.e. when every still-runnable task has already been
  attempted this invocation (`:273`); a released claim makes the task
  Todo/runnable again on the next iteration's `fetch_state`, but `was_attempted`
  skips it, so `nready` does not count it and the loop terminates. **Linear
  state transitions are unchanged** — `release_claim` still writes back to
  `TODO_STATES` (`:85-88`); the attempted-set only gates the *current process's*
  relaunch, exactly per the ruling.

- **C3** — ADDRESSED. `bin/publish-epic.sh:63-160`. Manifest-seeded resume
  (`EPIC_ID`/`TASK_MAP`/`RELS_DONE` from `published.json` when present,
  `:67-73`) skips the epic, each already-published task, and each
  already-written relation, each with a printed skip line. `write_id_for`
  (`:40-46`) hashes `"$SLUG|$1"` with `openssl md5` — no clock, no randomness;
  verified the format is deterministic and collision-free per title (test
  `publish.test.js:118` confirms stability and 3 distinct values). Verified by
  hand that `write_manifest` is called immediately after `EPIC_ID` is captured
  (`:115`, before the task loop) — without this the "Created so far: $MANIFEST"
  message on a task-1 failure would point at a nonexistent file and a re-run
  would create a second epic, which is precisely the bug C3 exists to close.
  `relationsCreated` is tracked separately from the planned `relations` graph
  (`:55-61`, `:102-110`), so the runner still gets the full edge list even if
  pass 2 never completes, while a resume only skips what pass 2 actually wrote.

- **I1** — ADDRESSED. `bin/run-epic.sh:169-170`. `--worktree "name:$TASK"`
  matches the `--name "$TASK"` used at creation; the bare `|| true` is replaced
  with a stderr warning naming the selector and the path left behind.

- **I2** — ADDRESSED. `bin/run-epic.sh:201-226`. Dry mode now fetches state
  once, then loops: compute `runnable`, print a wave, mark those ids done in a
  **local copy** of `$STATE_FILE` via `sim_mark_done` (`:192-199`), repeat until
  nothing is runnable. Confirmed by reading the loop that `$MAXP` only groups
  output into `-- batch N --` labels (`:214-217`) and never truncates — every
  task in `$READY` is printed regardless of `$left`. Matches the controller
  ruling exactly (local-copy simulation, `--max-parallel` as a label only).

- **I3** — ADDRESSED. `bin/run-epic.sh:129-147`. `--until idle --until done
  --until blocked` is spelled out, and the outcome is read back via
  `herdr agent get "gan-$TASK"` → `.result.agent.agent_status`, matching the
  field the implementer reports verifying live. A `blocked` status takes a
  dedicated branch that returns 1 without touching Done, worktree removal, tab
  close, or the claim (matches the report's claim that nothing built should not
  be marked Done and should not be relaunched into the same gate).

- **I4** — ADDRESSED. `bin/run-epic.sh:70`:
  `state: (.state.name // error("issue \($id) came back with no .state.name"))`.
  Under `pipefail`, a null/missing state now aborts `fetch_state` loudly instead
  of falling through as runnable.

- **I6** — ADDRESSED. `bin/run-epic.sh:107`: `.result.path // .path // empty`.
  An absent path now fails the `[ -z "$WT" ]` guard instead of proceeding with
  the literal string `"null"`.

- **I7** — ADDRESSED. `src/breakdown.js:5-10,47-49,101-106,120-126`.
  `KNOWN_FIELD_KEYS` names the four canonical markers; any other
  `^\*\*(\w[\w ]*):\*\*` header is recorded in `task.unknownFields` and turned
  into a validator error naming the marker and the four allowed ones. Chosen
  over "treat as content" as the review's own stated preference for a loud
  failure.

- **I9** — ADDRESSED. `install.sh:15-18` links `$REPO/bin` to
  `$HOME/.claude/gan-bin`; `skill/SKILL.md` step 8 now names
  `<$HOME>/.claude/gan-bin/publish-epic.sh`, tells the reader to resolve `$HOME`
  the way step 5 does, and states the missing-link failure mode. `bash -n
  install.sh` passes.

- **I11** — ADDRESSED. `README.md` documents all four `GAN_*_STATES` variables
  in a table with defaults, states comparison is exact, and names the failure
  mode of each wrong value. `bin/run-epic.sh:85-88` (`release_claim`) and
  `:263` (claim-failure branch) both now warn on stderr naming the specific env
  var to check, replacing the two silent `|| true` sites.

- **Promoted minor — `### TASK:` rejected** — ADDRESSED.
  `src/breakdown.js:82-83,101-106`: `malformedTaskHeadings` collects
  `^#{3,}\s+TASK:` lines; `validateBreakdown` rejects each, naming the heading
  and explaining it is absorbed into the previous task rather than split out.

- **Promoted minor — unused `run()` deleted** — ADDRESSED. Confirmed absent
  from `bin/publish-epic.sh` in the current file; no `run()` function remains.

- **Promoted minor — unused `SLUG` deleted** — ADDRESSED, via a disclosed
  deviation: `SLUG` was **not** deleted but made load-bearing — it namespaces
  `write_id_for`'s hash input, which C3's ruling explicitly requires ("derived
  from the epic slug plus the task title"). The dead-code/misdirection
  objection is resolved by a comment (`bin/publish-epic.sh:23-24`) explaining
  what it is now for. This is a materially better resolution than deletion
  followed by recomputing the same string two lines later, and the report
  discloses the deviation plainly. Verdict stands as addressed.

---

### New Defects Introduced (check 6)

None found. Specifically checked and clean:

- **Pane/tab/path extraction guards.** `TABJSON=`, `PANE=`, `TAB=`, `STATUS=`,
  and `WT=` are each assigned via `"$(...)" || VAR=""` or inside an `if !`
  condition — the same "assignment position + explicit guard" idiom the
  original review praised, applied consistently to every new command
  substitution. None is a bare, unguarded assignment that could abort the
  script silently under `set -e`.
- **`release_claim`'s `cmd || echo …` pattern** always returns 0 (the `echo`
  succeeds even when the underlying `orca` write failed), so it can never
  itself trip `set -e`; callers don't check its return value, which is correct
  since it is fire-and-forget by design.
- **`[ "$nready" -eq 0 ] && break`** and the other bare `test && action`
  statements in the new code are the standard bash idiom exempted from
  `set -e` (the left-hand test is not "the last command in the list" when it's
  false) — same pattern as pre-existing code in this file, not a new risk.
- **No bash-4-only construct** anywhere in the new diff. Independently reran
  `grep -nE 'declare -A|mapfile|\$\{[A-Za-z_]+\^\^|wait -n|\[-1\]' bin/*.sh
  install.sh` — only the two comments explaining their avoidance match.
  `bash -n` passes on all three scripts.
- **`sim_mark_done`'s temp-file swap** (`$STATE_FILE.sim` → `$STATE_FILE`) is
  cleaned up by the widened `trap … EXIT` (`bin/run-epic.sh:48`); no leaked
  temp file on early exit.
- **The dry-run path's single real read call** (`orca linear list-issues` via
  `fetch_state`, when `GAN_FAKE_LINEAR` is unset) is unchanged from before this
  wave — the new simulation loop reuses that one fetch and iterates on a local
  copy of the state, it does not add further live calls.
- Traced the `write_id_for` uuid formatting by hand: it drops one hash
  character (`h[12]`) between the second and third groups, which is harmless
  (still fully deterministic, no clock/randomness, and the remaining 31 hex
  chars leave uniqueness practically intact for this use) — not a functional
  defect, noting it only for completeness.

### Existing Tests Amended (check 7)

Three tests amended, all disclosed in `final-fix-report.md`'s table, and the
diff confirms the disclosure is accurate:

1. `"dry-run launches only unblocked tasks"` (asserted `JON-3` absent) →
   replaced by `"dry-run simulates every wave, not just the first"` +
   `"a dependent task lands in a later wave than its blocker"` (assert `JON-3`
   present, in a later wave). Necessary consequence of I2's fix — disclosed.
2. `"dry-run respects --max-parallel"` (asserted 1 launch at
   `--max-parallel 1`) and `"dry-run launches every runnable task when
   max-parallel allows"` (asserted 2) → both folded into `"--max-parallel
   groups the plan into batches without truncating it"` (asserts 3 launches at
   both 1 and 3, plus batch labels). Necessary consequence of I2's fix —
   disclosed.

No other pre-existing test's assertions changed; every other diff hunk in the
three test files is pure addition (`+` lines only, confirmed by reading the
diff).

---

### Verdict

**Fix wave:** All findings addressed, no new Critical/Important breakage.

C1, C2, and C3 are each independently traced and hold up under inspection, not
just under the cited tests. All eight Important findings are fixed at the
cited locations, matching the controller's rulings on C2, C3, and I2 exactly.
The two promoted dead-code minors are resolved (one by deletion, one — `SLUG`
— by a disclosed, well-justified repurposing). No new defect class from the
checklist (unguarded commands, argument-position substitutions, silent
backgrounded-subshell aborts, bash-4-only constructs) was found in the ~57KB
diff. Three pre-existing tests were amended, both instances disclosed and
necessitated by the I2 fix as expected.

No open findings from this wave's scope. (I5, I8-except-the-four-lines, I10,
`--max-parallel` validation, and `--base-branch main` remain open per the
review package's own "known residuals" list, which this review was told not
to re-litigate.)
