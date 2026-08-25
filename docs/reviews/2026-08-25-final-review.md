# Final whole-branch review — 9689821..bbdaba6

Reviewer: gan-final (opus), read-only. 9 commits, 12 files, +688/-3.
Working tree verified clean at `bbdaba6`; `dist/gan-engine.js` verified byte-identical
to a fresh build of `src/core.js` + `src/engine.template.js` (reproduced the build
transform in memory, wrote nothing).

### Verdict

**Fix first.** Two Critical items, both on the path every real `/gan` run takes and
neither ever executed: the skill points `scriptPath` at a string that has never been
proven to resolve, and the herdr pane retrieval path — enabled by default in *both*
shipped configs — moves the entire generated document through terminal scrollback and
a low-effort relay agent, with a silent-truncation failure mode. Everything behind
those two doors is in good shape.

---

## What's Solid

- **The core/template/build split is the right call and is executed cleanly.**
  `src/core.js:1-45` is genuinely pure — four total functions, no I/O, no clock, no
  RNG — and `build.js:12-16` strips exports with a guard that *throws* on any residual
  `^export` rather than silently shipping a broken artifact. The build is a 3-line
  string substitution with no toolchain. This is the least clever solution that works,
  which is the correct amount of clever for a file that gets pasted into a sandbox.

- **The false-convergence guard is defended in depth, and it is the right thing to
  defend.** The spec (`docs/spec/…:308`) names all-critics-died as "the only genuine
  correctness bug available here," and the engine treats it that way:
  `engine.template.js:221` rejects truthy-but-malformed critic results *before*
  counting the round, `:228-234` aborts rather than crediting a dry round, and
  `:223-226` logs the discrepancy. The F3 fix (a malformed reply is not a vote for
  convergence) closed the exact side door the spec's abort was written to hold shut.

- **The escalation state machine matches the spec exactly and is tested algebraically,
  not anecdotally.** `advance()` sets `full: true` on a clean round (`core.js:35`), so
  convergence requires a clean rotation *followed by* a clean full pass. `core.test.js:13-21`
  proves the stronger invariant — every lens is seen across any two consecutive rounds —
  by iteration over 10 rounds rather than by three hand-picked examples.

- **F1's fix is correct in a way that is easy to get wrong.** `buildBody(critiques,
  current, forPane)` (`engine.template.js:120-159`) builds the revision body *per
  destination*, and the pane branch deliberately omits the draft with a comment
  explaining why (`:133-135`). The naive fix — compute the body once, reuse it on
  fallback — was explicitly identified and avoided. Both call sites (`:194`, `:253`)
  throw on a null generator rather than carrying `undefined` forward.

- **The prompts are unusually well-written.** `engine.template.js:66-67` ("If you find
  nothing you can justify, return an empty issues array. Do NOT invent issues to appear
  useful — a clean report is a valid result.") directly counter-pressures the failure
  mode that would otherwise make the loop never terminate. The PF-6 revision instruction
  (`:122-129`) explains *why* commentary is forbidden ("Anything you write that is not
  part of the document itself becomes part of the document") rather than just forbidding
  it, and smoke3 confirmed it works.

- **The lens sets are genuinely different attacks.** `research.md:31-35` and
  `product.md:27-31` are five distinct failure modes each, not five rephrasings of "find
  problems" — which is the whole mitigation the spec's GAN caveat rests on.

- **The ledger.** `progress.md` records every ruling with its authority and its
  cost-if-wrong, and includes a controller self-correction (Task 4, "CONTROLLER ERROR
  (corrected)"). The stale-plan defect was self-reported before I looked for it.

---

## Findings

### Critical (Must Fix Before Merge)

**C1 — `skill/SKILL.md:35`: the door points at a path that has never been shown to resolve, and ignores the one the installer creates.**

```
scriptPath: "~/workspace/gan-engine/dist/gan-engine.js"
```

Three problems in one line:

1. `scriptPath` is a JSON string parameter, not a shell word. Nothing expands `~`.
   The only value ever proven to work is the fully-expanded one — grepping the session
   journals for every real workflow launch returns exactly one distinct value:
   `"/Users/jonioliveira/workspace/gan-engine/dist/gan-engine.js"`. All three smoke runs
   used that. The tilde form has zero runtime evidence.
2. It hardcodes the author's repo location, so the skill only works on one machine and
   only if the repo lives at that path.
3. It bypasses `~/.claude/workflows/gan-engine.js` entirely — the location `install.sh:15`
   creates, `README.md:14` advertises, and the spec's architecture block
   (`docs/spec/…:67`) names as *the* home of the engine. As shipped, the installer's
   workflow symlink is dead weight.

Why it matters: this is the only line connecting the skill to the engine, it is on the
path of every `/gan` invocation, and PF-7 deferred both real invocations — so nothing in
this branch has ever exercised it. If the tilde does not expand, `/gan` fails 100% of the
time on first use.

Fix: have the skill resolve the path at invocation instead of hardcoding it. The skill
agent has Bash; one step of "run `echo $HOME`, then use
`$HOME/.claude/workflows/gan-engine.js`" makes it machine-independent *and* routes through
the installed artifact, which is what the spec says the architecture is. Verify against a
real launch before merging — this is a one-command check, not a full acceptance run.

**C2 — `src/engine.template.js:87`: the pane path moves the whole document through terminal scrollback, and it is the default in both shipped configs.**

```js
'3. Read the full reply: herdr agent read ' + name + ' --lines 2000',
'4. Return ONLY the generator\'s document, verbatim. No commentary of your own.',
```

Herdr's own skill doc warns about exactly this (`~/.agents/skills/herdr/SKILL.md:183`):
"`--lines` asks Herdr for more rows from the pane's available screen and host scrollback.
If increasing it does not reveal more of a completed response, the pane is probably
running the agent on the terminal's alternate screen. Rows that leave the alternate
screen do not enter Herdr's host scrollback, so a larger line count cannot recover them."

Independent of the alternate-screen question, three problems are certain:

- The call omits `--source recent-unwrapped`, the idiom herdr's own examples use
  (`SKILL.md:151`, `:169`). Without it, the read returns terminal-wrapped rows — hard
  line breaks inserted mid-sentence into markdown.
- The scrollback contains the agent's TUI chrome (box borders, tool-call output, status
  markers) interleaved with the document. A `sonnet`/`low` relay agent
  (`engine.template.js:168-169`) has to strip that and re-emit a multi-thousand-word
  document verbatim, from context, token by token.
- The failure is **silent**. A truncated or paraphrased draft comes back as a normal
  non-empty string — not `PANE_UNAVAILABLE` — so `generate()` returns it, the critics
  attack the fragment, the loop converges, and the truncated artifact is what gets
  written to `docs/spec/`. This is the false-success class the spec calls the only
  genuinely dangerous bug.

Both `research.md:8` and `product.md:8` set `pane: true`, so this is the production path
for every real run, and the never-exercised one.

Fix, in order of preference:
1. Stop moving the document through the terminal. Have the pane generator **write the
   draft to a file** (`/tmp/gan-<slug>-r<round>.md`) and return only that path; the
   driver `cat`s it and returns the contents. Scrollback then only has to survive a
   40-character path, and the relay agent copies a file instead of retyping a document.
2. Failing that, at minimum add `--source recent-unwrapped` and have the driver return
   `PANE_UNAVAILABLE` if the extracted text is implausibly short.
3. Cheapest de-risk if you want to merge now: flip both configs to `pane: false`. Two
   characters, drops to the path smoke1-3 actually exercised, and costs only
   watchability plus re-sent context per round.

---

### Important (Should Fix Before Merge)

**I1 — `src/engine.template.js:21-27` + `src/core.js:40-44`: unvalidated `termination` values can return `converged: true` with zero critics run.** *(promotion of deferred Task 4 #6)*

The spread copies whatever the caller sends. `args` crosses a JSON boundary, so
`undefined` cannot survive — but `null` can, and it is exactly what an LLM assembling
JSON from a prose config emits for a value it cannot find. Verified:

```
0 >= null        → true     // shouldContinue stops before round 0
converged = state.dry >= termination.dryRounds = 0 >= null → true
```

So `{"dryRounds": null}` returns `converged: true, rounds: 0, history: []` — a draft no
critic has ever seen, reported as converged. `{"budgetFloor": null}` disables the budget
stop (`100 <= null` → false). `{"maxRounds": undefined}`, the originally-flagged form,
removes the round cap.

This is the same false-success class as C2, reachable through a config typo, and the
skill's args assembly (`SKILL.md:34-41`) is prose-driven with no schema. Fix: coerce and
validate in the engine, e.g. take each of the four only when
`typeof v === 'number' && Number.isFinite(v)`, else fall back to the default. ~4 lines.

**My explicit answer on Task 4 #6: yes, promote.** Not for the `undefined` case the
reviewer found — that one can't cross JSON — but for the `null` case it points at, which
can, and which is strictly worse: it does not merely remove a cap, it fabricates a
convergence.

**I2 — `src/engine.template.js:81-84` vs `:168-170`: the spec's generator model routing is not implemented on the pane path.**

The spec's routing table (`docs/spec/…:98`) says the generator runs **opus / xhigh** —
that is the "one expensive stateful agent, N cheap stateless ones" split the whole design
is justified by. Both configs duly declare `model: opus, effort: xhigh`
(`research.md:8`, `product.md:8`).

But in pane mode those values are never used. The driver prompt says only "start a
`claude` agent in it named exactly …" with no model flag, and the *driver itself* is
hardcoded to `sonnet`/`low`. `cfg.generator.model` and `cfg.generator.effort` are read at
exactly one place — `:187-188`, the background fallback. So the flagship path silently
runs the generator on whatever `claude` defaults to.

Fix: herdr supports passthrough args — `herdr agent start <name> --kind claude --pane <id>
-- --model opus` (`~/.agents/skills/herdr/SKILL.md:117`). Interpolate `cfg.generator.model`
into the round-0 branch of `paneDriverPrompt`.

**I3 — `src/engine.template.js:173`: `PANE_UNAVAILABLE` is matched exactly, so a chatty failure message becomes the draft.**

```js
if (out && out.trim() === 'PANE_UNAVAILABLE') {
```

The driver is *instructed* to reply "with exactly PANE_UNAVAILABLE and nothing else"
(`:91`), but it is a sonnet/low agent and models add explanation under failure conditions
more than under success ones. "PANE_UNAVAILABLE — herdr is not running on this host"
fails the `===`, falls to `:176`, and is returned as the draft. The critics then attack an
error message, and the run converges on it.

This is the spec's designated graceful-degradation path (`docs/spec/…:305`, "Degraded,
not dead"), and it degrades into the silent-corruption case instead. Fix:
`const t = (out || '').trim(); if (t.length < 200 && t.includes('PANE_UNAVAILABLE'))` —
length-bounded so a real document that happens to quote the token can't false-positive.

**I4 — `src/engine.template.js:260-273`: non-convergence returns no unresolved issues, which the spec mandates, and `issuesRaised` is too lossy to substitute.**

The spec's failure table (`docs/spec/…:307`) is explicit: "Non-convergence at `maxRounds`
→ Return the draft flagged `converged: false`, **with unresolved issues listed**." The
engine returns `issuesRaised: Array.from(seen)` — a flat list of kebab-case id strings
covering *everything ever raised*, resolved or not, with `claim` and `evidence` discarded.
A user handed `converged: false` plus `["unstated-multitenancy-assumption"]` has a slug
and nothing else.

The loop already holds the information needed. Fix, ~6 lines:
- keep `const raised = new Map()` alongside `seen`, storing the full issue object;
- in `freshIssues`' rejection path the engine can't see re-raises, but the engine can:
  count, per round, ids present in `results` that were filtered because `seen.has(id)`.
  **A re-raised issue is direct evidence the generator did not satisfy that critique** —
  it is the only unresolved-signal available without ground truth;
- return `unresolved: [...]` (re-raised issues, full objects) and make `issuesRaised`
  carry objects rather than bare ids.

This is also the constructive answer to the `converged` question below, and the
follow-through PF-6 promised when it removed the generator's rejection rationale.

**I5 — `docs/plans/2026-08-24-gan-engine.md:549-616`: the committed plan still contains the pre-fix `generate()`, including the Critical F1 defect.**

Confirmed by reading: `async function generate(critiques, round)` at line ~549 takes no
`current`, builds one body for both destinations, and carries neither draft nor input —
F1 exactly. Line 600 has the F4 budget bug (`budget.total ? budget.remaining() : null`),
line ~551 has the PF-6 "state plainly why you reject it" instruction, and `:576` has the
F2 falsy-pane fall-through. All four survive in a copy-pasteable code block, in a document
that outlives this workspace.

Fix: not a rewrite. Insert a note directly above the Step 1 code fence — "**Superseded.**
This block is the as-planned version; it contains defects F1–F4 found in review. The
authoritative implementation is `src/engine.template.js` at `bbdaba6`." That preserves the
plan as the historical argument (which is its value) while making it non-executable by
accident. Judgment: **annotate, before merge.** See the dedicated section below.

**I6 — `package.json:5-8`: `bun test` is not self-sufficient, and a stale `dist/` passes the suite silently.** *(promotion of deferred Task 3 #3 / PF-2)*

`test/build.test.js` reads `dist/gan-engine.js`, which is gitignored. On a fresh checkout
the suite fails 6 tests. Worse in daily use: after editing `src/` without rebuilding, all
6 build tests pass **against the previous artifact** — the suite reports green on a file
that no longer corresponds to the source it is meant to guard. `SKILL.md:55-57` names a
stale `dist/` as "the most likely cause of an edit appearing to have no effect," so this
footgun is already known to the authors.

PF-2 was right at the time — a `pretest` hook would have broken Tasks 1–2, where
`build.js` did not exist. That reason expired at Task 3. Fix now:
`"pretest": "bun run build"`. One line, and it makes every future `bun test` honest.

---

### Minor (Follow-up)

- **`src/engine.template.js:42`** — `required: ['id','severity','claim']` omits `evidence`.
  The spec leans hard on grounding (`docs/spec/…:271`: "forcing a critic to ground its
  objection in something checkable is the cheapest defense against confident fabrication,
  since an ungroundable objection cannot be filed"), and `product.md:30` tells the
  `feasibility` lens "An objection you cannot ground, do not raise" — but the schema does
  not enforce it, so the prompt is the only gate. Adding `evidence` to `required` makes
  the spec's argument true. Held at Minor because it changes runtime critic behaviour and
  nothing has exercised it.
- **`src/engine.template.js:262-263`** — the non-convergence log does not say *why*
  (maxRounds vs budget floor). Spec: "A truncated run must say it was truncated." It does
  say that; it doesn't say which truncation. Bundle with I4. *(deferred Task 4 #5)*
- **`src/engine.template.js:203`** — the budget expression rests on an untested claim
  (F4's rationale: "`remaining()` already returns Infinity when no target is set"). If it
  returns `0` instead, every run stops at round 0. Fail-loud (`converged: false, rounds: 0`)
  so not a merge blocker, but worth one defensive line treating a non-finite value as
  `null`, and worth checking on the first real run.
- **`src/core.js:9`** — `return lenses` aliases the caller's array; the windowed branch
  returns a fresh one. *(deferred Task 1 — explicit opinion below)*
- **`src/engine.template.js:235-236`** — a malformed-but-truthy critic is logged twice,
  once as malformed and once as failed, since `active.length - results.length` spans both
  categories. Cosmetic. *(deferred Task 4)*
- **`src/engine.template.js:14-19`** — validation checks `slug`, `input`, `generator`,
  `lenses`, but not `generator.role` / `generator.task`. A missing one interpolates the
  literal string `"undefined"` into the generator prompt.
- **`src/engine.template.js:49-98`** — `attackPrompt` and `paneDriverPrompt` are pure
  functions living past `// @@CORE@@`, invisible to the suite. Moving them into
  `src/core.js` would make I3 and I2 testable. *(deferred Task 4 #11)*
- **`install.sh:14`** — `ln -sfn` onto an existing *real* directory at
  `~/.claude/skills/gan` creates the link *inside* it rather than replacing it, so the
  install silently no-ops. Guard with `[ -L "$target" ] || [ ! -e "$target" ]`.
  *(deferred Task 6)*
- **`skill/SKILL.md:34-41`** — the config→JSON translation convention is never stated;
  an agent could pass the literal `"—"` as `agentType`. Cheap to fix in the same edit as
  C1. *(deferred Task 5, and its cosmetic twin about table asymmetry between
  `research.md` and `product.md`)*
- **`src/engine.template.js:240-245`** — `history` records counts but not issue ids, so
  the per-round trace cannot be joined to `issuesRaised`. Bundle with I4.
- **spec `docs/spec/…:122`** lists `checkpoint: "before-final" | "none"` in the engine
  config block, but the engine never reads it and `SKILL.md:38` does not send it. The
  behaviour is correct (the skill owns the checkpoint, `SKILL.md:47-51`) — the spec's
  contract block is what is stale. One-line spec correction.
- Remaining deferred items (build.js `try/catch`, no test for build.js's guard throw,
  mid-file `import` in `core.test.js`, O(n²) in-batch dedup, preflight failures reported
  by count, `additionalProperties`, escalation no-op when `K >= lenses.length`,
  `install.sh` symlink self-resolution) — all correctly triaged as follow-ups. See below.

---

## Deferred-Minor Triage

**Promote to pre-merge (3 of 20):**

| # | Item | Why now |
|---|---|---|
| T4 #6 | `{maxRounds: undefined}` removes the cap | → **I1**. The `null` variant is worse than reported: it fabricates `converged: true` with 0 rounds. |
| T3 #3 | `bun test` fails cold / passes on stale `dist` | → **I6**. PF-2's blocking reason expired at Task 3; one line. |
| T4 #13 | no named test for `buildBody`/pane/malformed/budget | Not a test-writing mandate, but it is *why* C2, I2 and I3 are unverifiable. Moving the two pure prompt builders into `core.js` (T4 #11) makes I2/I3 testable and should ride along with those fixes. |

**Cheap, do while the file is already open (4):** T4 #5 (log which limit stopped it) and
T4 #12 (double-counted failure log) alongside I4; T5 #1 (state the "omit, don't pass —"
convention) and T5 #2 / T6 #2 (table asymmetry) alongside C1's `SKILL.md` edit.

**Genuine follow-ups (11):** T2 #1 mid-file import, T2 #2 O(n²), T3 #1 guard-path test,
T3 #2 `readFileSync` try/catch, T4 #7 preflight failure names, T4 #8
`additionalProperties`, T4 #9 escalation no-op, T4 #11 prompts→core (unless bundled per
above), T6 #1 `install.sh` self-symlink resolution.

**No action (2):** T1 #2 (report-text inconsistency; the code was always fine) and T4 #10
(`outputPath` is inert *by design* — `SKILL.md:47` correctly owns the write). Both are
resolved observations, not debt.

### The two you asked about explicitly

**Task 4 #6 — `{maxRounds: undefined}`: PROMOTE. Yes, it is a promotion.**
The reviewer under-sold it. `undefined` cannot cross the JSON boundary the skill passes
`args` over, so the literal reported case is unreachable — but the mechanism it identifies
(the spread copies whatever it is handed, and there is no validation behind it) is
reachable via `null`, which JSON carries fine and which is the natural output of an LLM
filling a prose-driven template for a field it cannot resolve. And the `null` case is
strictly worse than removing a safety cap: `0 >= null` is `true`, so
`{"dryRounds": null}` skips the loop entirely and then computes
`converged = 0 >= null = true`. The engine reports a fully-converged run on a draft no
critic ever read. That is the branch's headline failure class arriving through a config
typo. Fix is ~4 lines of `Number.isFinite` filtering. → I1.

**Task 1 — `lensesFor` returning the caller's array by reference: DO NOT PROMOTE, but fix it.**
There is no live bug. The single caller (`engine.template.js:205`) only does
`active.map(...)` and reads `active.length`; nothing in `core.js` or the template mutates
a lens array; `cfg.lenses` is never sorted, spliced, or reassigned. So it is a latent
trap, not a defect — and a reviewer promoting it on "consistency" alone would be grading
style as correctness.

That said, the asymmetry is exactly the kind that survives until someone adds
`active.sort((a,b) => ...)` for deterministic ordering and silently reorders
`cfg.lenses` for every subsequent round — which would corrupt rotation, the one thing the
spec insists must be deterministic. `return lenses.slice()` costs one method call on a
five-element array, changes no test (`core.test.js:23-33` compares by name), and removes
the trap permanently. Do it in the same pass as I1, since both touch the loop's inputs.
Not a merge blocker on its own.

---

## Ruling Assessment

- **PF-1 (replace the false-failing export regex with an export-count check) — right.**
  The plan's assertion contradicted the spec's own mandate that `export const meta` be the
  first statement; the spec wins, and the count check preserves the real intent (core's
  exports were stripped). `build.test.js:17-20` independently guards the half the count
  check gives up.
- **PF-4 (fix the test, revert the source comment) — right, and for the right reason.**
  The constraint forbids *calls*, and a test that cannot distinguish a call from a mention
  is testing the wrong thing. Rejecting the alternative (strip comments in `build.js`) was
  also correct: `dist/` is what a human reads when debugging a workflow run. The stated
  cost-if-wrong (a block comment would still false-positive) is fail-safe.
- **PF-6 (drop the rejection rationale entirely) — right, and verified.** The rationale
  was decorative to the loop — a rejected issue sits in `seen` and cannot resurface — and
  it was actively corrupting the artifact. smoke3 proves the fix. But its stated
  cost-if-wrong ("a human loses visibility into *why* the generator refused a critique")
  is now a live cost, not a hypothetical: nothing in the return value records a refusal.
  **I4 is the follow-through this ruling deferred**, and it is cheaper than the "structured
  disposition field" the ruling imagined, because a re-raised issue already *is* the signal.
- **PF-7 (the last two plan steps are user-facing acceptance tests) — right in principle,
  and it is why C1 exists.** An implementer subagent genuinely cannot run `/gan` in a fresh
  session with the skill installed. But the consequence is that the entire door — skill
  parse → config read → args assembly → `scriptPath` → engine — has never run, and C1 is a
  defect sitting squarely in that untested span. The ruling's mitigation ("smoke1/2/3
  already exercised the engine end to end") is true of the *engine* and not of the *door*.
  Recommendation: fix C1, then treat the user's first `/gan research` run as the
  acceptance test rather than as ordinary first use.
- **PF-8 (create `install.sh`, do not execute it) — right, unambiguously.** It mutates
  `~/.claude/` for every future session, which is outside this repo's blast radius, and
  the narrowing cost the user one command. Independently verified: `~/.claude/workflows`
  does not exist and `~/.claude/skills` contains only `find-skills` and `herdr`, so the
  script demonstrably never ran.

---

## The `converged` Semantic

**Keep the name. Fix the return value. Ship the fix with this branch.**

`converged` is not a misleading name for what the loop does — it accurately describes a
fixed point of the iteration, and every generate-and-attack loop uses the word that way.
Renaming it to `settled` trades one ambiguous word for a vaguer one, breaks
`SKILL.md:43-46`, and would not have prevented the smoke3 outcome: a reader who saw
`settled: true, issuesRaised: ["missing-code-example"]` would draw the same wrong
conclusion.

The actual defect is not the label, it is that **the return value gives the reader no way
to distinguish an issue that was fixed from one that was refused.** `issuesRaised` flattens
both into the same list of bare slugs. The information exists inside the loop and is thrown
away.

The dedup-against-`seen` design is right and should not change — the spec's justification
(`docs/spec/…:225-227`) holds, and dedup against "accepted" would make convergence
impossible. But `seen` is also, unused, the best unresolved-signal available in a domain
with no ground truth: **when a critic re-raises an id already in `seen`, that is direct
evidence the generator did not satisfy that critique.** smoke3 produced exactly that signal
and discarded it.

So:

- **Pre-merge** (this is spec compliance, not enhancement): the spec's failure table
  mandates that non-convergence return "unresolved issues listed," and it currently returns
  nothing of the kind. → I4.
- **Same change, ~6 lines**: track re-raises, return `unresolved: [...]` with full issue
  objects, and make `issuesRaised` carry objects rather than ids. Then `converged: true,
  unresolved: [{id: "missing-code-example", claim: …}]` reads honestly — the loop reached a
  fixed point *and* here is what it reached it in spite of.
- **Not now**: renaming, a structured generator-disposition field, or any change to dedup
  semantics. Those are redesigns, and the data fix makes them unnecessary.

---

## The Stale Plan Document

**Annotate before merge. Do not rewrite, do not leave.**

Confirmed present: `docs/plans/2026-08-24-gan-engine.md:549` declares
`async function generate(critiques, round)` with no `current` parameter and a single
shared body — F1 verbatim. `:600` carries F4's `budget.total ? budget.remaining() : null`.
`:551` carries the PF-6 instruction that corrupted the smoke2 artifact. `:576` carries the
F2 falsy-pane fall-through. Four defects, one Critical, in a fenced code block presented
as the thing to type.

Arguments for leaving it: the plan is a historical record of what was planned, the ledger
documents every deviation, and rewriting it would make the plan lie about its own history —
losing the record that F1 was a *planning* failure caught in review, which is the more
useful lesson.

Arguments for fixing it: `progress.md` already flags it as a FOLLOW-UP owed at branch
finish; the workspace that holds the correcting context is scratch and will disappear; the
plan is committed and will not; and a code block in an executable-looking plan is the one
artifact a future agent will copy without reading the ledger first.

Both are right, which is why annotation resolves it and neither extreme does. Insert
directly above the Step 1 fence:

> **Superseded — do not copy.** This block is the plan as written. Review found four
> defects in it (F1 Critical: the revision body carried no draft, so background-mode
> revisions revised a document they had never seen; F2–F4 per the ledger). The
> authoritative implementation is `src/engine.template.js` at `bbdaba6`; the rulings are
> in `.superpowers/sdd/2026-08-24-gan-engine/progress.md` (PF-5, PF-6).

That is ~5 lines, preserves the plan's argument and its mistakes, and makes the block
non-executable by accident. **Important, not Critical** — it cannot break the running
system, but it must not merge silently.

---

## Untested-Surface Risk

Ranked by expected damage, not by novelty.

**High — fix or de-risk before merge**

1. **The herdr pane path (never run at all).** → **C2.** Enabled by default in both
   shipped configs, so it is the production path for every real run; the retrieval
   mechanism is scrollback, which herdr's own documentation warns can be unrecoverable;
   and the failure mode is a plausible-looking truncated string, not an error. Everything
   about this path fails silently into a written artifact.
2. **The `/gan` door (never run at all).** → **C1.** PF-7 deferred both invocations, and
   the untested span contains a defect. One real launch clears it.

**Medium — inspect, then verify on first real run**

3. **A dead or falsy pane.** The *code* is fine on inspection: `:176-181` logs, flips
   `usePane`, and falls through to a fully-contexted background body. The risk is entirely
   in whether the driver model emits the sentinel exactly (→ **I3**), which no amount of
   static reading settles. Fixing I3 converts this from medium to low.
4. **An exhausted budget.** `shouldContinue`'s arithmetic is unit-tested at the boundary
   (`core.test.js:92-95`, both sides of the floor). What is untested is the runtime shape
   of `budget.remaining()` when no target is set — F4's fix rests on it returning
   `Infinity`. If it returns `0`, every run halts at round 0. Loud when wrong
   (`converged: false, rounds: 0`, with a log), so not a blocker, but check it on the
   first real run.

**Low — fine on inspection, no action needed**

5. **A malformed critic result.** One line (`:221`), `Array.isArray(r.issues)`, obviously
   correct by reading, and the `schema: CRITIQUE` constraint makes it rare in the first
   place. The abort behind it (`:228-234`) is the tested-by-construction path.
6. **A multi-lens panel and lens rotation with escalation.** This is the most
   *mathematically* load-bearing logic on the branch and it is the best-tested:
   `core.test.js:7-34` covers rotation, the two-round coverage invariant, `full`, and both
   `K >= len` degenerate forms; `:62-76` covers escalation and non-mutation. The loop
   wiring on top (`engine.template.js:205`, `:257`) is two call sites with matching arity.
   Runtime evidence would add nothing here.
7. **Preflight agents.** Structurally identical to the critic `parallel(map)` that ran
   successfully in all three smoke runs, with the same `.filter(Boolean)` and a
   failure-count log (`:112-115`). The only untested behaviour is total preflight failure,
   which proceeds with empty context — degraded and logged, which is the right call.
