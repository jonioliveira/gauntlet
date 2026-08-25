# Final fix wave — re-review (bbdaba6..53bc41f)

Reviewer: re-review only. Read the diff file and `dist/gan-engine.js` (built artifact, gitignored). Did not run git, install.sh, the Workflow tool, or the test suite.

### Finding Verdicts

**C1 — `skill/SKILL.md` hardcoded, unexpandable `scriptPath`** — ADDRESSED.
`skill/SKILL.md:34-39` (new step 5): resolves via `echo $HOME` at invocation, builds `<that value>/.claude/workflows/gan-engine.js`, states `scriptPath` is a JSON string so `~` never expands, and instructs the skill to tell the user to run `./install.sh` and stop if the file is absent — no repo-path fallback. Steps 6-8 renumbered consistently; no stale step-number references found elsewhere in the file.

**C2 — pane path moved the document through terminal scrollback** — ADDRESSED.
`src/engine.template.js:131-167` (`paneDriverPrompt`): step 3 is now `cat ' + outFile` with an explicit "Do NOT recover the document from the pane's scrollback" instruction (`:151-153`); step 4 returns the file's contents verbatim. The embedded prompt tells the generator to write its answer to `outFile` and reply only `DONE` (`:163-164`). `PANE_UNAVAILABLE` now also covers the file missing or empty (`:156-157`). Confirmed no remaining code path reads the pane via `herdr agent read`/scrollback — the only other reference to that idiom is inside the intentionally-preserved historical code block in `docs/plans/2026-08-24-gan-engine.md:525`, which I5 explicitly requires to be left as-is (see I5). The non-pane fallback (`:256-261`) is a plain `agent()` call, unrelated to herdr/scrollback.

**I2 — generator model routing unimplemented on the pane path** — ADDRESSED.
`src/engine.template.js:143-146`: round-0 branch now emits `herdr agent start <name> --kind claude -- --model <cfg.generator.model || 'opus'>`. `cfg.generator` is guaranteed to exist by the top-of-file validation, so this is safe; falls back to `'opus'` only if `model` itself is unset, matching both shipped configs' declared value.

**I3 — `PANE_UNAVAILABLE` matched with `===`** — ADDRESSED.
`src/engine.template.js:242-245`: `const trimmed = (out || '').trim(); if (trimmed.length < 200 && trimmed.includes('PANE_UNAVAILABLE'))`. Verified against edge cases: chatty failure ("PANE_UNAVAILABLE — herdr is not running") now degrades to the background generator; empty/undefined `out` still falls through to the "returned nothing" branch unchanged; a real document under 200 chars would still theoretically false-positive if it happened to quote the token, but that's exactly the bound the finding specified — implemented verbatim.

**I1 — unvalidated `termination` could fabricate convergence** — ADDRESSED.
`src/engine.template.js:75-87`: per-key loop over `DEFAULT_TERMINATION`, accepting a value only when `typeof value === 'number' && Number.isFinite(value)`. `null` fails `typeof value === 'number'` (typeof null === 'object') and falls to the default, silently (no log, since `value !== undefined && value !== null` is false for null) — the exact fabricated-convergence path is closed. A legitimate `0` (e.g. `budgetFloor: 0`) passes `typeof === 'number' && Number.isFinite(0)` and is preserved. `cfg.termination` entirely absent still defaults everything, matching prior behavior. No regression versus the old spread for the "absent" case.

**I4 — non-convergence returned no unresolved issues** — ADDRESSED.
`src/engine.template.js:268-270, 313-321, 355-356`: `raised` and `unresolved` Maps added beside `seen`. The capture loop (`:315-321`) runs on `results` before `freshIssues` is called and before `seen` is mutated for this round, so `seen.has(issue.id)` at that point reflects only *prior* rounds — meaning `unresolved` is populated exclusively from re-raised issues, not from every issue seen this round. `raised` accumulates every well-formed issue ever seen (first occurrence kept, full object with `claim`/`evidence`). Return value: `issuesRaised: Array.from(raised.values())`, `unresolved: Array.from(unresolved.values())` (`:355-356`). `seen` (`:334`, `:341` via `advance`) and `freshIssues` (`src/core.js:17-39`, untouched — not in this diff) are byte-identical to before; convergence logic is unaffected.

**I6 — `bun test` passed against a stale `dist/`** — NOT ADDRESSED (fix applied exactly as specified, but the named defect persists).
`package.json:6`: `"pretest": "bun run build"` added, `test`/`build` unchanged — this is precisely the required fix as instructed. However `pretest` is an npm-lifecycle convention; Bun's built-in `bun test` subcommand does not consult `package.json` script hooks (only `bun run <script>` does). So `bun run test` now rebuilds honestly, but bare `bun test` — the exact command named in the finding's one-liner — still runs against whatever `dist/gan-engine.js` happens to be on disk. The implementer's own report (`final-fix-report.md`, "Concerns" §1) discloses this with empirical evidence (`rm -f dist/gan-engine.js && bun test` → 16 pass/6 fail with `ENOENT`, i.e. the cold-checkout failure the finding describes reappears; only `bun run test` triggers the hook). The specific defect — silent green on a stale artifact under `bun test` — has not been eliminated, only narrowed to a subset of invocations. Closing it fully needs one of the two follow-ups the implementer names (rename the documented command everywhere to `bun run test`, or have `test/build.test.js` build the artifact itself in `beforeAll`).

**I5 — committed plan retained pre-fix buggy code uncommented** — ADDRESSED.
`docs/plans/2026-08-24-gan-engine.md:429-435`, immediately above the Task 4 Step 1 code fence: `> **Superseded — do not copy this block.**` naming F1-F4 explicitly and pointing at `src/engine.template.js` as authoritative. The code fence itself (including the old `herdr agent read ... --lines 2000` line, now at `:525`) is left unchanged, matching the instruction to preserve it as historical record rather than rewrite it.

### New Breakage in the Fix Diff

None found. Checked specifically: the I1 validation doesn't regress the "termination entirely absent" default path; the I4 Map additions don't touch `seen`/`freshIssues`/`advance` semantics; the I3 length bound doesn't change the "empty output" or "real short document" branches beyond the finding's own accepted trade-off; the I2 model interpolation guards on `cfg.generator` already being validated non-null upstream; SKILL.md renumbering has no dangling references. `dist/gan-engine.js` matches the `src/` diff line-for-line for every fix (spot-checked C2/I2/I1/I3/I4 regions).

### Out-of-Scope Observations

Non-blocking.

- `skill/SKILL.md:49-51` (step 7, "report `converged`, `rounds`, and the count of `issuesRaised`") was not updated to mention the new `unresolved` field I4 added to the engine's return value. Not one of the eight findings, but a natural follow-up now that the field exists — a `/gan` run's user-facing report still can't surface which issues went unresolved.
- The non-convergence log (`src/engine.template.js:346-347`) still reports `seen.size`, not `raised.size`/`unresolved.size` — flagged by the implementer as a known non-blocking gap (final-fix-report.md, Concerns §3), left as-is since I4's required fix specified only the return-value change.

### Verdict

**Fix wave:** Findings remain open — **I6** is not fully addressed. `pretest` was added exactly as the required fix specified, but Bun's `bun test` subcommand doesn't invoke `package.json` lifecycle scripts, so the named defect (stale `dist/` passing green) still reproduces under the bare `bun test` invocation; only `bun run test` is honest. All other seven findings (C1, C2, I1, I2, I3, I4, I5) are fully addressed with no new Critical/Important breakage introduced by the fix diff.
