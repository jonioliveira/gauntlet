# GAN Engine — adversarial pipelines for research and product definition

**Date:** 2026-08-24
**Status:** Design approved; implementation not started

## Problem

Two kinds of work recur and are currently done ad hoc, by hand, one prompt at a
time: **research** (a question, answered from evidence) and **product
definition** (a rough idea, hardened into a spec). Both are generate-then-attack
shaped. Neither has a repeatable process, so quality depends on how thorough the
prompting happened to be that day.

The wanted property is adversarial pressure: something that actively tries to
break the draft rather than agreeing with it.

## Non-goals

- Replacing interactive Claude Code. The Max subscription returns ~25x its cost
  at current usage; moving that work to per-token providers is strictly worse.
- Building on Firstmate. Herdr already supplies panes and worktrees; Firstmate
  would add a second worktree provider and a second supervisor for capabilities
  already present.
- A general workflow framework. Two pipelines share one engine. A third would
  have to justify itself.

## Why this shape

Claude Code's Workflow tool already provides the SSSF thesis — deterministic
control loop in code, agents as bounded nodes — plus per-agent model routing
(`opts.model`), effort control (`opts.effort`), budget tracking
(`budget.remaining()`), a journal trace, and resume by `runId`. Adversarial
verification, judge panels, and loop-until-dry are documented first-class
patterns. None of that needs building.

What needs building is the specific pipeline shape for these two domains, and a
door to invoke it.

### The GAN caveat

In a real GAN the discriminator learns and sharpens. An LLM critic does not — it
is static. So "loop until the critic is happy" converges on *the critic ran out
of things to say*, which is not *the artifact is good*. Two models will also
agree on something wrong.

Code review escapes this with objective gates (tests pass, diff matches claims).
Research and product definition have no ground truth, so the critic is the only
gate. Two mitigations, both in the design:

1. **Diversity of lens** over repetition — five different attacks, not five
   copies of one.
2. **K consecutive dry rounds** rather than a single clean pass.

Research gets a third: external evidence. Its critics must produce a source, so
they can be wrong in a checkable way. Product definition cannot, which is why it
ends at a human checkpoint.

## Architecture

Approach B of three considered: a skill owns invocation and domain configs; a
workflow owns the loop.

```
~/.claude/skills/gan/SKILL.md              # door: /gan research … | /gan define …
~/.claude/skills/gan/configs/research.md   # lenses + prompts, editable prose
~/.claude/skills/gan/configs/product.md
~/.claude/workflows/gan-engine.js          # the loop; domain-free
```

Outputs land in `docs/spec/` of whichever repo the user is in, never globally.

Rejected alternatives:

- **One workflow, hand-written invocation** — thinnest, but no real command and
  configs bloat a single file.
- **Two saved workflows sharing a sub-workflow** — most explicit, but duplicates
  invocation glue and the two drift.

Skill-invokes-workflow is also the sanctioned opt-in path: invoking the skill is
itself the authorization to run a workflow, so the user never types "use a
workflow".

### Runtime: hybrid

Workflow scripts are plain JavaScript with no filesystem or Node API access, so
the control loop **cannot call `herdr` directly**. Spawned agents have full
tools. Therefore:

```
Workflow script  (deterministic JS — loop, gates, budget)
  └─ agent("drive a herdr pane: start generator, prompt, wait, return draft")
        └─ Bash → herdr agent start / prompt --wait / read
  └─ parallel(critics)  ← plain background agents, no panes
```

Pane driving lives inside a wrapper agent. One indirection, but the loop stays
deterministic and the generator stays watchable.

| | Runs as | Model | Rationale |
|---|---|---|---|
| Generator | herdr pane via driver agent | opus, xhigh | Long, expensive, worth watching. Keeps its pane across rounds, so a revision costs the critiques and the delta — not a re-sent draft. |
| Critics | background subagents, `parallel()` | sonnet/haiku, low | Many, short, disposable. Diversity comes from lenses, not spend. |

That split is the model routing and token optimization: one expensive stateful
agent, N cheap stateless ones.

## Engine contract

### Config (passed by the skill as `args`)

```js
{
  slug: "auth-rework",           // skill-generated; names the herdr pane, survives rounds
  input: "<the question or idea>",

  preflight: [                   // optional; parallel; absent = skip
    { name, prompt, model, effort, agentType }
  ],

  generator: {
    role:  "<system framing>",
    task:  "<what to produce>",
    model: "opus", effort: "xhigh",
    pane:  true
  },

  lenses: [
    { name: "assumptions", prompt: "<attack instructions>",
      model: "sonnet", effort: "low", agentType: "general-purpose" }
  ],

  termination: {
    dryRounds: 2, maxRounds: 5, budgetFloor: 50000,
    lensesPerRound: 3            // rotate; omit or set >= lenses.length to run all
  },
  checkpoint:  "before-final" | "none",
  output:      { path: "docs/spec/research/auth-rework.md" }   // repo-relative
}
```

`slug` is supplied rather than generated because workflow scripts cannot call
`Math.random()` or `Date.now()` — they would break resume. The skill computes it
once, which also lets a crashed run resume onto the same pane.

`preflight` is generic, not domain machinery: research uses it for a multi-modal
evidence sweep, product definition for a repo scan.

### Lens rotation

Running all five lenses every round is the dominant cost. Most rounds do not
need all five, so the engine rotates a subset — but a clean *rotation* round is
weaker evidence than a clean *full* round, because two lenses never saw the
draft. Escalation resolves this: a clean rotation round promotes the next round
to the full set.

Rotation is index arithmetic, never random — workflow scripts cannot call
`Math.random()`:

```js
const K = cfg.termination.lensesPerRound ?? cfg.lenses.length
const lensesFor = (round, full) =>
  (full || K >= cfg.lenses.length)
    ? cfg.lenses
    : Array.from({length: K},
        (_, i) => cfg.lenses[(round * K + i) % cfg.lenses.length])
```

With 5 lenses and `K = 3`: round 0 → `[0,1,2]`, round 1 → `[3,4,0]`,
round 2 → `[1,2,3]`. Every lens is seen at least once every two rounds.

### Loop

```js
let draft = await generate(cfg, null)        // round 0, fed preflight results
const seen = new Set()
let dry = 0, round = 0, full = false

while (dry < cfg.termination.dryRounds
       && round < cfg.termination.maxRounds
       && (!budget.total || budget.remaining() > cfg.termination.budgetFloor)) {

  const active = lensesFor(round, full)

  const results = (await parallel(active.map(l => () =>
      agent(attackPrompt(l, draft), {
        label: `critic:${l.name}`, phase: 'Attack',
        model: l.model, effort: l.effort,
        agentType: l.agentType, schema: CRITIQUE
      }))))
    .filter(Boolean)

  if (!results.length) throw new Error('all critics failed — aborting')

  const fresh = results.flatMap(r => r.issues).filter(i => !seen.has(i.id))

  if (!fresh.length) {          // clean round
    dry++
    full = true                 // escalate: next round runs every lens
    round++
    continue
  }

  dry = 0
  full = false
  fresh.forEach(i => seen.add(i.id))
  draft = await generate(cfg, fresh)
  round++
}
```

Convergence therefore requires a clean rotation round **followed by** a clean
full pass. A full pass that finds something resets `dry` to 0 and resumes
rotating.

Dedup is against `seen`, never against issues the generator accepted. The
generator may legitimately reject a critique; without marking it seen, that
critic raises it every round and the loop never converges.

### Critic output schema

```js
CRITIQUE = { issues: [{
  id:       "unstated-multitenancy-assumption",   // critic-assigned stable slug
  severity: "blocking" | "major" | "minor",
  claim:    "what is wrong",
  evidence: "why — source URL, file:line, or reasoning"
}]}
```

The critic assigns `id`, which is what makes dedup work without randomness.

## Domain configs

### Research — input is a question

| Lens | Attack instruction | Model |
|---|---|---|
| `contradiction` | Actively search for a source that contradicts this claim. Raise an issue if you find tension. | sonnet / low, `general-purpose` |
| `coverage` | Name a specific search angle, source type, or stakeholder view never consulted. | sonnet / low, `general-purpose` |
| `source-quality` | Is each citation primary, authoritative, dated? Flag secondary sources presented as primary. | sonnet / low |
| `overreach` | Does any claim exceed its evidence? Flag generalization from a single data point. | sonnet / low |
| `recency` | Flag any claim whose truth depends on a fast-moving fact with no date. | haiku / low |

- **preflight:** 3–4 gatherers, each a different modality — by-source-type,
  by-entity, by-time, by-contrarian-framing.
- **generator:** opus / xhigh, in a pane.
- **output:** `docs/spec/research/<slug>.md`
- **checkpoint:** `none` — external evidence is the gate, so it runs unattended.

### Product definition — input is a rough idea

| Lens | Attack instruction | Model |
|---|---|---|
| `assumptions` | List unstated assumptions this depends on. For each: what breaks if it is false? | sonnet / low |
| `scope` | What here is YAGNI? Flag anything not required by the stated goal. | sonnet / low |
| `edges` | Enumerate failure modes, edge cases, and error paths the spec does not address. | sonnet / low |
| `feasibility` | What is expensive or hard to build? Ground it in the actual codebase, cite `file:line`. | sonnet / low, `general-purpose` |
| `problem-fit` | Is this solving the stated problem? Flag solution-first thinking and absent user evidence. | opus / medium |

- **preflight:** 2 scanners — existing patterns in the target repo, prior specs
  and decisions.
- **generator:** opus / xhigh, in a pane.
- **output:** `docs/spec/<date>-<slug>.md`
- **checkpoint:** `before-final`.

`problem-fit` gets opus deliberately: it is the one lens where a cheap model
reliably rubber-stamps. `feasibility` must cite `file:line` — forcing a critic to
ground its objection in something checkable is the cheapest defense against
confident fabrication, since an ungroundable objection cannot be filed.

### Checkpoint semantics

Workflows run in the background and cannot ask the user anything mid-run. So
`checkpoint: "before-final"` does not mean pause-and-wait. It means:

> the workflow returns the converged draft plus full critique history → it is
> presented to the user → on approval, finalization writes the file.

Research skips this. Product definition keeps it, because "is this the right
product" is a judgment no critic can make.

## Failure handling

| Failure | Behaviour |
|---|---|
| A critic dies or returns null | `.filter(Boolean)`; the round proceeds with surviving lenses. Never blocks convergence. |
| **All** critics die in a round | Abort with an error. Does **not** count as a dry round. |
| Generator dies | Abort. Return last good draft plus critique history. |
| herdr pane will not start | Driver agent falls back to a background subagent and logs it. Degraded, not dead. |
| Non-convergence at `maxRounds` | Return the draft flagged `converged: false`, with unresolved issues listed. |

The all-critics-died case is the only genuine correctness bug available here.
Every other failure degrades visibly; that one looks like success, because an
empty round is indistinguishable from "nothing left to attack" unless you check
whether anyone actually spoke.

## Budget

```js
while (dry < 2 && round < 5
       && (!budget.total || budget.remaining() > 50_000)) { … }
```

Every early exit calls `log()`. A truncated run must say it was truncated, or
"converged" is a lie.

### Expected scale

With `lensesPerRound: 3` over 5 lenses:

| Stage | `agent()` calls |
|---|---|
| preflight | 3–4 |
| productive round (3 critics + 1 generate) | 4 |
| clean rotation round (3 critics, nothing to revise) | 3 |
| escalated full pass (5 critics) | 5 |

**Typical** — 2 productive rounds, then converge:
`4 + 4 + 4 + 3 + 5` = **~20 agents**

**Worst case** — `maxRounds: 5`, all productive, no convergence:
`4 + 5×4` = **~24 agents**

Down from ~34 without rotation. Still above the session's default "medium"
guideline of 15, which is explicitly a guideline rather than a hard limit — but
the gap is now small enough to accept rather than engineer around. Concurrency
is capped at ~10 simultaneous agents regardless, so the residual cost is
wall-clock and orchestration risk, not money: critics are cheap and the
generator is a single persistent pane agent no matter how many rounds run.

## Testing

The output is prose, so correctness is not assertable. What is verifiable:

1. **Engine determinism** — run with a stub config whose critics return fixed
   issue lists. Assert: terminates on 2 dry rounds; dedups by `id`; honours
   `maxRounds`; aborts when all critics fail; `lensesFor()` cycles every lens
   within two rounds; a clean rotation round escalates the next round to the
   full lens set. Pure control flow, no model.
2. **Resume** — kill mid-run, relaunch with `resumeFromRunId`; the cached prefix
   should replay instantly. *Deferred:* this is a property of the Workflow
   runtime rather than of this code, and exercising it means deliberately
   killing a paid run. Check it opportunistically the first time a real run
   fails, not as a scheduled task.
3. **One real run each** — research on a question whose answer is already known,
   so quality is judgeable; product definition on a small real idea.

## Open questions

None blocking. Deferred until after first use:

- Whether `maxRounds: 5`, `dryRounds: 2`, and `lensesPerRound: 3` are the right
  constants.
- Whether the research generator should also run unattended overnight.
- Whether a third domain justifies extracting anything further.
