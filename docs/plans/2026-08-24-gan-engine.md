# GAN Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a domain-free adversarial generate-and-attack loop, invoked by a `/gan` skill, that hardens research questions and product ideas against rotating panels of critic agents.

**Architecture:** Pure loop logic lives in `src/core.js`, unit-tested under Bun. A build step inlines it into `src/engine.template.js` to produce `dist/gan-engine.js`, a self-contained Claude Code Workflow script. A `/gan` skill owns invocation and holds the two domain configs as editable prose; it assembles an args object and calls the Workflow tool.

**Tech Stack:** Plain JavaScript (ES modules for source/tests; the built workflow is a single non-module script), Bun test runner, Claude Code Workflow tool, herdr CLI for the generator pane.

**Spec:** `docs/spec/2026-08-24-gan-engine.md`

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- Workflow scripts are **plain JavaScript, NOT TypeScript**. No type annotations, interfaces, or generics.
- Workflow scripts have **no filesystem or Node.js API access**. No `import`, no `require`, no `fs`.
- `Date.now()`, `new Date()` (argless), and `Math.random()` **throw** inside a workflow script — they break resume. Rotation must be index arithmetic; `slug` is supplied by the caller.
- `export const meta = {...}` must be the **first statement** and a **pure literal** — no variables, function calls, spreads, or template interpolation.
- Dedup is against `seen`, **never** against issues the generator accepted.
- A clean rotation round **must escalate** the next round to the full lens set.
- All critics failing in a round **aborts**; it must **not** count as a dry round.
- No silent caps: every early exit calls `log()`.
- Outputs land in `docs/spec/` of the **target repo**, never globally.
- Default termination: `dryRounds: 2`, `maxRounds: 5`, `budgetFloor: 50000`, `lensesPerRound: 3`.

---

### Task 1: Repo scaffolding and lens rotation

**Files:**
- Create: `package.json`
- Create: `src/core.js`
- Test: `test/core.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `lensesFor(lenses, perRound, round, full) -> Array<Lens>`, where `Lens` is any object with a `name` string. Pure; no I/O; no randomness.

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "gan-engine",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "bun test",
    "build": "bun run build.js"
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `test/core.test.js`:

```js
import { test, expect } from "bun:test"
import { lensesFor } from "../src/core.js"

const L = ["a", "b", "c", "d", "e"].map(name => ({ name }))
const names = xs => xs.map(x => x.name)

test("rotates a window of size K across rounds", () => {
  expect(names(lensesFor(L, 3, 0, false))).toEqual(["a", "b", "c"])
  expect(names(lensesFor(L, 3, 1, false))).toEqual(["d", "e", "a"])
  expect(names(lensesFor(L, 3, 2, false))).toEqual(["b", "c", "d"])
})

test("every lens is seen at least once across two consecutive rounds", () => {
  for (let r = 0; r < 10; r++) {
    const pair = new Set([
      ...names(lensesFor(L, 3, r, false)),
      ...names(lensesFor(L, 3, r + 1, false)),
    ])
    expect(pair.size).toBe(L.length)
  }
})

test("full=true returns every lens regardless of round", () => {
  expect(names(lensesFor(L, 3, 1, true))).toEqual(names(L))
})

test("K >= lens count returns every lens", () => {
  expect(names(lensesFor(L, 5, 1, false))).toEqual(names(L))
  expect(names(lensesFor(L, 99, 3, false))).toEqual(names(L))
})

test("null perRound means no rotation", () => {
  expect(names(lensesFor(L, null, 2, false))).toEqual(names(L))
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/workspace/gan-engine && bun test test/core.test.js`
Expected: FAIL — `Cannot find module '../src/core.js'`

- [ ] **Step 4: Write minimal implementation**

Create `src/core.js`:

```js
// Pure loop logic for the GAN engine.
//
// Every function here must be safe to inline verbatim into a Claude Code
// Workflow script: no imports, no I/O, no Date.now(), no Math.random().
// `build.js` strips the `export` keywords and pastes this file in whole.

export function lensesFor(lenses, perRound, round, full) {
  const K = perRound == null ? lenses.length : perRound
  if (full || K >= lenses.length) return lenses
  const out = []
  for (let i = 0; i < K; i++) {
    out.push(lenses[(round * K + i) % lenses.length])
  }
  return out
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd ~/workspace/gan-engine && bun test test/core.test.js`
Expected: PASS — 5 tests

- [ ] **Step 6: Commit**

```bash
cd ~/workspace/gan-engine
git add package.json src/core.js test/core.test.js
git commit -m "feat(core): deterministic lens rotation"
```

---

### Task 2: Dedup and the termination state machine

**Files:**
- Modify: `src/core.js`
- Test: `test/core.test.js`

**Interfaces:**
- Consumes: `lensesFor` from Task 1 (same file).
- Produces:
  - `freshIssues(results, seen) -> Array<Issue>` where `results` is an array of `{issues: Issue[]}` and `Issue` is `{id: string, severity: string, claim: string, evidence?: string}`; `seen` is a `Set<string>`. Returns issues whose `id` is not in `seen`, deduped within the batch, skipping any issue lacking an `id`.
  - `advance(state, freshCount) -> State` where `State` is `{dry: number, round: number, full: boolean}`. Never mutates its input.
  - `shouldContinue(state, termination, budgetRemaining) -> boolean`. `budgetRemaining` is a number, or `null` when no budget target is set.

- [ ] **Step 1: Write the failing tests**

Append to `test/core.test.js`:

```js
import { freshIssues, advance, shouldContinue } from "../src/core.js"

const issue = (id, severity = "major") => ({ id, severity, claim: `claim ${id}` })

test("freshIssues drops issues already seen", () => {
  const seen = new Set(["x"])
  const got = freshIssues([{ issues: [issue("x"), issue("y")] }], seen)
  expect(got.map(i => i.id)).toEqual(["y"])
})

test("freshIssues dedups within the same round", () => {
  const got = freshIssues(
    [{ issues: [issue("dup")] }, { issues: [issue("dup")] }],
    new Set()
  )
  expect(got.map(i => i.id)).toEqual(["dup"])
})

test("freshIssues skips issues with no id and tolerates empty results", () => {
  const got = freshIssues(
    [{ issues: [{ severity: "minor", claim: "no id" }] }, { issues: [] }, {}],
    new Set()
  )
  expect(got).toEqual([])
})

test("advance on a clean round increments dry and escalates to full", () => {
  expect(advance({ dry: 0, round: 3, full: false }, 0))
    .toEqual({ dry: 1, round: 4, full: true })
})

test("advance on a productive round resets dry and resumes rotating", () => {
  expect(advance({ dry: 1, round: 4, full: true }, 2))
    .toEqual({ dry: 0, round: 5, full: false })
})

test("advance never mutates the state it is given", () => {
  const before = { dry: 0, round: 0, full: false }
  advance(before, 0)
  expect(before).toEqual({ dry: 0, round: 0, full: false })
})

const T = { dryRounds: 2, maxRounds: 5, budgetFloor: 50000 }

test("shouldContinue is true mid-run", () => {
  expect(shouldContinue({ dry: 1, round: 2, full: false }, T, null)).toBe(true)
})

test("shouldContinue stops once dryRounds is reached", () => {
  expect(shouldContinue({ dry: 2, round: 2, full: true }, T, null)).toBe(false)
})

test("shouldContinue stops at maxRounds", () => {
  expect(shouldContinue({ dry: 0, round: 5, full: false }, T, null)).toBe(false)
})

test("shouldContinue stops when budget falls to the floor", () => {
  expect(shouldContinue({ dry: 0, round: 1, full: false }, T, 50000)).toBe(false)
  expect(shouldContinue({ dry: 0, round: 1, full: false }, T, 50001)).toBe(true)
})

test("shouldContinue ignores budget when there is no target", () => {
  expect(shouldContinue({ dry: 0, round: 1, full: false }, T, null)).toBe(true)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/gan-engine && bun test test/core.test.js`
Expected: FAIL — `freshIssues is not a function` (or an import error)

- [ ] **Step 3: Write minimal implementation**

Append to `src/core.js`:

```js
export function freshIssues(results, seen) {
  const out = []
  for (const result of results) {
    const issues = (result && result.issues) || []
    for (const issue of issues) {
      if (!issue || typeof issue.id !== "string" || issue.id.length === 0) continue
      if (seen.has(issue.id)) continue
      if (out.some(o => o.id === issue.id)) continue
      out.push(issue)
    }
  }
  return out
}

export function advance(state, freshCount) {
  if (freshCount === 0) {
    // A clean round is weak evidence when only a subset of lenses ran, so the
    // next round escalates to the full set before convergence is allowed.
    return { dry: state.dry + 1, round: state.round + 1, full: true }
  }
  return { dry: 0, round: state.round + 1, full: false }
}

export function shouldContinue(state, termination, budgetRemaining) {
  if (state.dry >= termination.dryRounds) return false
  if (state.round >= termination.maxRounds) return false
  if (budgetRemaining !== null && budgetRemaining <= termination.budgetFloor) return false
  return true
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/gan-engine && bun test`
Expected: PASS — 16 tests

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/gan-engine
git add src/core.js test/core.test.js
git commit -m "feat(core): issue dedup and termination state machine"
```

---

### Task 3: Build step that inlines core into the workflow script

**Files:**
- Create: `build.js`
- Create: `src/engine.template.js` (marker only at this stage)
- Create: `.gitignore` entry for `dist/`
- Test: `test/build.test.js`

**Interfaces:**
- Consumes: `src/core.js` from Tasks 1–2.
- Produces: `dist/gan-engine.js` — a single self-contained script with no `import`/`export`/`require`, containing the core functions verbatim.

- [ ] **Step 1: Create the template stub**

Create `src/engine.template.js` with exactly this content for now:

```js
export const meta = {
  name: 'gan-engine',
  description: 'Adversarial generate-and-attack loop for research and product definition',
  phases: [
    { title: 'Preflight', detail: 'parallel context gathering' },
    { title: 'Generate', detail: 'draft or revise against critiques' },
    { title: 'Attack', detail: 'rotating panel of adversarial critics' },
  ],
}

// @@CORE@@
```

- [ ] **Step 2: Write the failing test**

Create `test/build.test.js`:

```js
import { test, expect } from "bun:test"
import { readFileSync, existsSync } from "node:fs"

const OUT = "dist/gan-engine.js"

test("build output exists", () => {
  expect(existsSync(OUT)).toBe(true)
})

test("build output is self-contained — no module syntax", () => {
  const src = readFileSync(OUT, "utf8")
  expect(src).not.toMatch(/^\s*import\s/m)
  expect(src).not.toMatch(/^\s*export\s+(function|const|let|class)/m)
  expect(src).not.toMatch(/\brequire\s*\(/)
})

test("build output keeps meta as the first statement", () => {
  const src = readFileSync(OUT, "utf8")
  expect(src.trimStart().startsWith("export const meta")).toBe(true)
})

test("build output inlines every core function", () => {
  const src = readFileSync(OUT, "utf8")
  for (const fn of ["lensesFor", "freshIssues", "advance", "shouldContinue"]) {
    expect(src).toContain(`function ${fn}(`)
  }
})

test("build output contains no forbidden non-determinism", () => {
  const src = readFileSync(OUT, "utf8")
  expect(src).not.toMatch(/Math\.random\s*\(/)
  expect(src).not.toMatch(/Date\.now\s*\(/)
})

test("build output parses as JavaScript", () => {
  const src = readFileSync(OUT, "utf8")
  // `export const meta` is legal only in a module, so parse as one.
  expect(() => new Function(`return async () => { ${src.replace(/^export /, "")} }`))
    .not.toThrow()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd ~/workspace/gan-engine && bun test test/build.test.js`
Expected: FAIL — `expect(existsSync(OUT)).toBe(true)` receives `false`

- [ ] **Step 4: Write the build script**

Create `build.js`:

```js
// Inlines src/core.js into src/engine.template.js at the // @@CORE@@ marker.
//
// Workflow scripts cannot import, so the pure logic is developed and tested as
// a normal ES module and pasted in whole at build time. This keeps one copy of
// the source of truth while leaving the shipped script self-contained.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs"

const MARKER = "// @@CORE@@"

const core = readFileSync("src/core.js", "utf8")
  .replace(/^export\s+function\s/gm, "function ")

if (/^\s*export\s/m.test(core)) {
  throw new Error("build: src/core.js has an export form the stripper does not handle")
}

const template = readFileSync("src/engine.template.js", "utf8")
if (!template.includes(MARKER)) {
  throw new Error(`build: src/engine.template.js is missing the ${MARKER} marker`)
}

mkdirSync("dist", { recursive: true })
writeFileSync("dist/gan-engine.js", template.replace(MARKER, core.trim()))
console.log("built dist/gan-engine.js")
```

- [ ] **Step 5: Ignore build output**

Append to `.gitignore`:

```
dist/
```

- [ ] **Step 6: Run the build, then the tests**

Run: `cd ~/workspace/gan-engine && bun run build && bun test`
Expected: `built dist/gan-engine.js`, then PASS — 22 tests

- [ ] **Step 7: Commit**

```bash
cd ~/workspace/gan-engine
git add build.js src/engine.template.js test/build.test.js .gitignore package.json
git commit -m "build: inline core into a self-contained workflow script"
```

---

### Task 4: The workflow engine body

**Files:**
- Modify: `src/engine.template.js`
- Test: manual smoke run (documented below)

**Interfaces:**
- Consumes: `lensesFor`, `freshIssues`, `advance`, `shouldContinue` — inlined by `build.js`.
- Produces: a workflow returning
  `{slug, converged, rounds, draft, issuesRaised: string[], history, outputPath}`.
  Expects `args` shaped exactly as the spec's config block.

- [ ] **Step 1: Replace `src/engine.template.js` with the full engine**

The `meta` block and `// @@CORE@@` marker stay exactly as they are; everything below the marker is new.

> **Superseded — do not copy this block.** This is the as-planned version. Review found
> four defects in it: F1 (Critical — the revision body carried no draft, so background
> revisions rewrote a document they had never seen), F2 (a falsy pane reply fell through
> silently), F3 (a malformed critic result was credited as a dry round), and F4 (a zero
> budget disabled the budget stop). A later review added more. The authoritative
> implementation is `src/engine.template.js`; read that, not this.

```js
export const meta = {
  name: 'gan-engine',
  description: 'Adversarial generate-and-attack loop for research and product definition',
  phases: [
    { title: 'Preflight', detail: 'parallel context gathering' },
    { title: 'Generate', detail: 'draft or revise against critiques' },
    { title: 'Attack', detail: 'rotating panel of adversarial critics' },
  ],
}

// @@CORE@@

const cfg = args
if (!cfg || !cfg.slug || !cfg.input) {
  throw new Error('gan-engine: args must include { slug, input }')
}
if (!cfg.generator || !Array.isArray(cfg.lenses) || cfg.lenses.length === 0) {
  throw new Error('gan-engine: args must include a generator and at least one lens')
}

const termination = {
  dryRounds: 2,
  maxRounds: 5,
  budgetFloor: 50000,
  lensesPerRound: 3,
  ...(cfg.termination || {}),
}

const CRITIQUE = {
  type: 'object',
  properties: {
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: ['blocking', 'major', 'minor'] },
          claim: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['id', 'severity', 'claim'],
      },
    },
  },
  required: ['issues'],
}

function attackPrompt(lens, draft) {
  return [
    'You are an adversarial critic. Find what is WRONG with the draft below.',
    'Do not praise it. Do not summarise it. Report only defects you can justify.',
    '',
    'YOUR LENS: ' + lens.name,
    lens.prompt,
    '',
    'ORIGINAL REQUEST:',
    cfg.input,
    '',
    'DRAFT UNDER REVIEW:',
    draft,
    '',
    'Assign each issue a stable descriptive kebab-case id derived from its',
    'substance (e.g. "unstated-multitenancy-assumption"), so the same defect',
    'receives the same id if it is raised again in a later round.',
    'If you find nothing you can justify, return an empty issues array.',
    'Do NOT invent issues to appear useful — a clean report is a valid result.',
  ].join('\n')
}

function paneDriverPrompt(round, body) {
  const name = 'gan-' + cfg.slug
  return [
    'You are driving a Herdr pane that hosts a long-lived generator agent.',
    'Use Bash. Run `herdr --skill` first if you do not already know the verbs.',
    '',
    'AGENT NAME: ' + name,
    'ROUND: ' + round,
    '',
    round === 0
      ? '1. Run `herdr agent get ' + name + '`. If no such agent exists, create a '
        + 'pane and start a `claude` agent in it named exactly "' + name + '".'
      : '1. The agent "' + name + '" already exists from an earlier round. '
        + 'Do NOT create it again — its context is the point.',
    '2. Send the PROMPT below to that agent and wait for it to finish:',
    '   herdr agent prompt ' + name + ' "<prompt>" --wait --timeout 900000',
    '3. Read the full reply: herdr agent read ' + name + ' --lines 2000',
    '4. Return ONLY the generator\'s document, verbatim. No commentary of your own.',
    '',
    'If Herdr is unavailable, or the agent cannot be started or prompted,',
    'reply with exactly PANE_UNAVAILABLE and nothing else.',
    '',
    'PROMPT:',
    '---',
    body,
    '---',
  ].join('\n')
}

let preflightContext = ''
if (Array.isArray(cfg.preflight) && cfg.preflight.length) {
  phase('Preflight')
  const gathered = (await parallel(cfg.preflight.map(p => () =>
    agent(p.prompt + '\n\nTOPIC:\n' + cfg.input, {
      label: 'preflight:' + p.name,
      phase: 'Preflight',
      model: p.model,
      effort: p.effort,
      agentType: p.agentType,
    })))).filter(Boolean)
  preflightContext = gathered.join('\n\n---\n\n')
  log('preflight: ' + gathered.length + '/' + cfg.preflight.length + ' returned')
  if (gathered.length < cfg.preflight.length) {
    log('WARNING: ' + (cfg.preflight.length - gathered.length) + ' preflight agent(s) failed')
  }
}

let usePane = cfg.generator.pane === true

async function generate(critiques, round) {
  const body = (critiques && critiques.length)
    ? [
        'Revise your draft to address these critiques.',
        'For each one, either fix it or state plainly why you reject it.',
        'Return the complete revised document, not a diff.',
        '',
        JSON.stringify(critiques, null, 2),
      ].join('\n')
    : [
        cfg.generator.task,
        '',
        'INPUT:',
        cfg.input,
        preflightContext ? '\nPREFLIGHT CONTEXT:\n' + preflightContext : '',
      ].join('\n')

  if (usePane) {
    const out = await agent(paneDriverPrompt(round, cfg.generator.role + '\n\n' + body), {
      label: 'generate:pane:r' + round,
      phase: 'Generate',
      model: 'sonnet',
      effort: 'low',
      agentType: 'general-purpose',
    })
    if (out && out.trim() === 'PANE_UNAVAILABLE') {
      log('herdr pane unavailable — falling back to a background generator')
      usePane = false
    } else if (out) {
      return out
    }
  }

  return await agent(cfg.generator.role + '\n\n' + body, {
    label: 'generate:r' + round,
    phase: 'Generate',
    model: cfg.generator.model,
    effort: cfg.generator.effort,
  })
}

phase('Generate')
let draft = await generate(null, 0)
if (!draft) throw new Error('gan-engine: the generator produced nothing on round 0')

const seen = new Set()
const history = []
let state = { dry: 0, round: 0, full: false }

while (shouldContinue(state, termination, budget.total ? budget.remaining() : null)) {
  const active = lensesFor(cfg.lenses, termination.lensesPerRound, state.round, state.full)

  phase('Attack')
  const results = (await parallel(active.map(l => () =>
    agent(attackPrompt(l, draft), {
      label: 'critic:' + l.name,
      phase: 'Attack',
      model: l.model,
      effort: l.effort,
      agentType: l.agentType,
      schema: CRITIQUE,
    })))).filter(Boolean)

  if (!results.length) {
    throw new Error(
      'gan-engine: all ' + active.length + ' critics failed in round ' + state.round
      + ' — aborting rather than counting a false dry round'
    )
  }
  if (results.length < active.length) {
    log('round ' + state.round + ': ' + (active.length - results.length) + ' critic(s) failed')
  }

  const fresh = freshIssues(results, seen)
  history.push({
    round: state.round,
    full: state.full,
    lenses: active.map(l => l.name),
    found: fresh.length,
  })
  log('round ' + state.round + (state.full ? ' [full]' : ' [rotating]')
      + ': ' + active.length + ' lenses -> ' + fresh.length + ' new issues')

  if (fresh.length) {
    for (const i of fresh) seen.add(i.id)
    phase('Generate')
    const revised = await generate(fresh, state.round + 1)
    if (!revised) throw new Error('gan-engine: the generator died on round ' + (state.round + 1))
    draft = revised
  }

  state = advance(state, fresh.length)
}

const converged = state.dry >= termination.dryRounds
if (!converged) {
  log('STOPPED WITHOUT CONVERGENCE after ' + state.round + ' round(s) — '
      + 'raised ' + seen.size + ' issue(s); treat the draft as unfinished')
}

return {
  slug: cfg.slug,
  converged: converged,
  rounds: state.round,
  draft: draft,
  issuesRaised: Array.from(seen),
  history: history,
  outputPath: (cfg.output && cfg.output.path) || null,
}
```

- [ ] **Step 2: Rebuild and confirm the build tests still pass**

Run: `cd ~/workspace/gan-engine && bun run build && bun test`
Expected: `built dist/gan-engine.js`, then PASS — 22 tests

- [ ] **Step 3: Smoke-run the engine with a trivial config**

This is the first real workflow run. It uses one cheap lens, one round, and no pane, so it costs very little and proves the wiring end to end.

Invoke the Workflow tool with `scriptPath: "~/workspace/gan-engine/dist/gan-engine.js"` and these args:

```json
{
  "slug": "smoke",
  "input": "Write two sentences explaining what a semaphore is.",
  "generator": {
    "role": "You are a precise technical writer.",
    "task": "Write the requested explanation.",
    "model": "haiku",
    "effort": "low",
    "pane": false
  },
  "lenses": [
    { "name": "accuracy",
      "prompt": "Flag any statement that is technically incorrect.",
      "model": "haiku", "effort": "low" }
  ],
  "termination": { "dryRounds": 1, "maxRounds": 1, "budgetFloor": 0, "lensesPerRound": 1 }
}
```

Expected: the workflow completes and returns an object with `slug: "smoke"`, a non-empty `draft`, a `history` array of length 1, and `rounds: 1`.

- [ ] **Step 4: Verify the trace**

Run: `cat <transcriptDir>/journal.jsonl | tail -5`
Expected: one `generate:r0` entry and one `critic:accuracy` entry with a structured `issues` return value.

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/gan-engine
git add src/engine.template.js
git commit -m "feat(engine): adversarial loop with pane generator and rotating critics"
```

---

### Task 5: The `/gan` skill and the research config

**Files:**
- Create: `skill/SKILL.md`
- Create: `skill/configs/research.md`

**Interfaces:**
- Consumes: `dist/gan-engine.js` from Task 4.
- Produces: a `/gan research <question>` command that assembles the args object of Task 4 and calls the Workflow tool.

- [ ] **Step 1: Write the skill**

Create `skill/SKILL.md`:

```markdown
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

## What to do

1. **Parse the subcommand.** `research` or `define`. If neither is given, ask
   which one — do not guess.

2. **Compute a slug.** Kebab-case, 2–4 words, derived from the input
   (e.g. "should we adopt tRPC" -> `adopt-trpc`). It names the herdr pane and
   must stay stable across resumes, so write it down and reuse it.

3. **Read the matching config** — `configs/research.md` or `configs/product.md`
   from this skill's directory. It holds the generator framing, the lenses, and
   the preflight agents as prose.

4. **Confirm the output path with the user** before running. Research goes to
   `docs/spec/research/<slug>.md`, product definition to
   `docs/spec/<YYYY-MM-DD>-<slug>.md`, both relative to the repo they are in.
   If the current directory is not a git repo, ask where output should land.

5. **Call the Workflow tool** with
   `scriptPath: "~/workspace/gan-engine/dist/gan-engine.js"` and an `args`
   object built from the config, in exactly this shape:

   `{slug, input, preflight: [...], generator: {...}, lenses: [...],
     termination: {...}, output: {path}}`

   Pass `args` as a real JSON object, never a JSON-encoded string.

6. **When it returns**, report `converged`, `rounds`, and the count of
   `issuesRaised`. If `converged` is false, say so plainly — the draft is
   unfinished, not merely long.

7. **Write the draft** to the agreed output path.
   - `research`: write it, then summarise the findings.
   - `define`: do **not** write it yet. Show the user the draft and the issues
     that were raised, and ask for approval first. This checkpoint exists
     because no critic can judge whether it is the right product to build.

## Notes

- The engine is rebuilt with `bun run build` in `~/workspace/gan-engine` after
  any change to `src/`. A stale `dist/` is the most likely cause of an edit
  appearing to have no effect.
- Tune lenses by editing the config markdown. Never add domain branching to the
  engine — if `gan-engine.js` ever needs to know which domain it is running,
  the shared engine was the wrong call.
```

- [ ] **Step 2: Write the research config**

Create `skill/configs/research.md`:

```markdown
# Research config

`input` is a question. Output is evidence-backed findings.
`checkpoint: none` — external evidence is the gate, so this runs unattended.

## generator

- model: `opus`, effort: `xhigh`, pane: `true`
- role: "You are a rigorous researcher. Every claim you make must carry a
  source. You would rather report uncertainty than assert something you cannot
  support. You never pad."
- task: "Answer the question below from evidence. Structure the answer as
  claims, each with its supporting source and date. State plainly what you
  could not determine."

## preflight (parallel, each a different modality)

| name | model / effort | prompt |
|---|---|---|
| `by-source-type` | sonnet / low | "Find primary sources on this topic — specs, papers, official docs, source code. Prefer primary over commentary. Return URLs with one-line summaries." |
| `by-entity` | sonnet / low | "Identify the people, companies, and projects central to this topic, and what each publicly claims. Return names with sources." |
| `by-time` | sonnet / low | "Establish the timeline: when did this emerge, what changed recently, what is deprecated? Date every item." |
| `by-contrarian` | sonnet / low | "Find the strongest published criticism, dissent, or failure report on this topic. Actively seek the minority view." |

All preflight agents use `agentType: general-purpose` so they have web access.

## lenses

| name | model / effort | agentType | prompt |
|---|---|---|---|
| `contradiction` | sonnet / low | general-purpose | "Actively search for a source that contradicts a claim in this draft. Raise an issue wherever you find real tension, citing the contradicting source." |
| `coverage` | sonnet / low | general-purpose | "Name a specific search angle, source type, or stakeholder perspective that was never consulted. Be concrete about what is missing and why it would change the answer." |
| `source-quality` | sonnet / low | — | "Check every citation. Is it primary, authoritative, and dated? Flag secondary sources presented as primary, undated claims, and any assertion with no source at all." |
| `overreach` | sonnet / low | — | "Does any claim exceed the evidence given for it? Flag generalisation from a single data point, and confident phrasing over thin support." |
| `recency` | haiku / low | — | "Flag any claim whose truth depends on a fast-moving fact but carries no date, and anything that may have changed since its source was published." |

## termination

`dryRounds: 2`, `maxRounds: 5`, `budgetFloor: 50000`, `lensesPerRound: 3`

## output

`docs/spec/research/<slug>.md`
```

- [ ] **Step 3: Verify the skill file parses**

Run:
```bash
cd ~/workspace/gan-engine
head -5 skill/SKILL.md
grep -c "^| \`" skill/configs/research.md
```
Expected: valid YAML frontmatter with `name: gan`; `9` config table rows (4 preflight + 5 lenses).

- [ ] **Step 4: Commit**

```bash
cd ~/workspace/gan-engine
git add skill/SKILL.md skill/configs/research.md
git commit -m "feat(skill): /gan door and the research domain config"
```

---

### Task 6: Product config, install, and the first real runs

**Files:**
- Create: `skill/configs/product.md`
- Create: `install.sh`
- Modify: `README.md`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces: symlinks making the skill and workflow live in `~/.claude/`.

- [ ] **Step 1: Write the product config**

Create `skill/configs/product.md`:

```markdown
# Product definition config

`input` is a rough idea. Output is a spec that has survived criticism.
`checkpoint: before-final` — the user approves before anything is written.

## generator

- model: `opus`, effort: `xhigh`, pane: `true`
- role: "You are a product engineer who writes specs other people can build
  from. You state assumptions explicitly, cut scope aggressively, and never
  describe a feature you cannot justify from the stated goal."
- task: "Turn the idea below into a spec: problem, non-goals, approach, the
  decisions taken and why, and what is deliberately excluded. Be concrete
  enough to build from."

## preflight (parallel)

| name | model / effort | agentType | prompt |
|---|---|---|---|
| `existing-patterns` | sonnet / low | general-purpose | "Survey this repository for patterns relevant to the idea below: how similar features are structured, which conventions hold, what already exists that could be reused. Cite `file:line`." |
| `prior-decisions` | sonnet / low | general-purpose | "Find prior specs, plans, ADRs, and README notes in this repo that constrain or contradict the idea below. Quote them with paths." |

## lenses

| name | model / effort | agentType | prompt |
|---|---|---|---|
| `assumptions` | sonnet / low | — | "List the unstated assumptions this spec depends on. For each, say concretely what breaks if it turns out to be false." |
| `scope` | sonnet / low | — | "What here is YAGNI? Flag anything not required by the stated goal, every speculative extension point, and any abstraction with one caller." |
| `edges` | sonnet / low | — | "Enumerate the failure modes, edge cases, and error paths this spec does not address. Concurrency, empty states, partial failure, and rollback especially." |
| `feasibility` | sonnet / low | general-purpose | "What here is expensive or hard to build in THIS codebase? Ground every objection in real code and cite `file:line`. An objection you cannot ground, do not raise." |
| `problem-fit` | opus / medium | — | "Is this solving the problem that was actually stated? Flag solution-first thinking, missing user evidence, and any place where a simpler thing would do. You are the last defence against building the wrong product — say so if you believe it." |

## termination

`dryRounds: 2`, `maxRounds: 5`, `budgetFloor: 50000`, `lensesPerRound: 3`

## output

`docs/spec/<YYYY-MM-DD>-<slug>.md`
```

- [ ] **Step 2: Write the installer**

Create `install.sh`:

```bash
#!/usr/bin/env bash
# Links the skill and the built workflow into ~/.claude so edits in this repo
# take effect immediately, with no copy step to forget.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v bun >/dev/null || { echo "bun is required" >&2; exit 1; }

cd "$REPO"
bun run build

mkdir -p "$HOME/.claude/skills" "$HOME/.claude/workflows"
ln -sfn "$REPO/skill"                 "$HOME/.claude/skills/gan"
ln -sfn "$REPO/dist/gan-engine.js"    "$HOME/.claude/workflows/gan-engine.js"

echo "linked:"
echo "  ~/.claude/skills/gan            -> $REPO/skill"
echo "  ~/.claude/workflows/gan-engine.js -> $REPO/dist/gan-engine.js"
```

- [ ] **Step 3: Run the installer and verify the links**

Run:
```bash
cd ~/workspace/gan-engine && chmod +x install.sh && ./install.sh
ls -l ~/.claude/skills/gan ~/.claude/workflows/gan-engine.js
```
Expected: both paths are symlinks pointing into `~/workspace/gan-engine`.

- [ ] **Step 4: Update the README**

Replace `README.md` with:

```markdown
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
```

- [ ] **Step 5: First real research run**

In a new Claude Code session (so the skill is loaded), run `/gan research` on a
question whose answer is already known, so quality is judgeable. Confirm:
`converged` is true, `rounds` is between 2 and 5, `issuesRaised` is non-empty,
and a herdr pane named `gan-<slug>` appeared and persisted across rounds.

- [ ] **Step 6: First real product-definition run**

Run `/gan define` on a small real idea. Confirm the run stops and asks for
approval instead of writing the file.

- [ ] **Step 7: Commit**

```bash
cd ~/workspace/gan-engine
git add skill/configs/product.md install.sh README.md
git commit -m "feat: product config, installer, and docs"
```

---

## Self-Review

**Spec coverage.** Engine contract → Tasks 1–4. Lens rotation with escalation →
Tasks 1–2, verified in tests. Critic schema → Task 4. Domain configs → Tasks 5–6.
Checkpoint semantics → Task 5, step 7 of the skill. Failure handling: critic
death → Task 4 `.filter(Boolean)`; all-critics-died → Task 4 explicit throw;
generator death → Task 4 throw; pane unavailable → Task 4 `PANE_UNAVAILABLE`
fallback; non-convergence → Task 4 `converged: false` plus `log()`. Budget guard
→ Task 2 `shouldContinue`, wired in Task 4. Testing plan → Tasks 1–3 unit tests,
Task 4 step 3 smoke run, Task 6 steps 5–6 real runs.

**Gap found and closed.** The spec's testing section names resume
(`resumeFromRunId`) as a verification step. It is not a task here: resume is a
property of the Workflow runtime rather than of this code, and testing it
requires deliberately killing a paid run. It is recorded as a deferred check in
the spec's open questions instead of being silently dropped.

**Placeholder scan.** No TBDs. Every code step carries real code. Task 4's smoke
config is concrete JSON rather than "a trivial config".

**Type consistency.** `lensesFor(lenses, perRound, round, full)`,
`freshIssues(results, seen)`, `advance(state, freshCount)`,
`shouldContinue(state, termination, budgetRemaining)` — signatures match between
Tasks 1–2 and their call sites in Task 4. `State` is `{dry, round, full}`
throughout. `Issue` carries `{id, severity, claim, evidence?}` in the schema, the
tests, and `freshIssues`. `termination` keys `dryRounds`, `maxRounds`,
`budgetFloor`, `lensesPerRound` are identical in Task 2, Task 4's defaults, and
both configs.
