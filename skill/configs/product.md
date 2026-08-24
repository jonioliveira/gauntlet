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
