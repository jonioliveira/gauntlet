# Decompose config

`input` is the path to a `/gan research` findings document. Output is one epic and
its tasks, ready to publish to Linear.
`checkpoint: before-final` — publishing creates real Linear issues and then fans out
into N pipeline runs. The user approves the breakdown before anything is written.

## generator

- model: `opus`, effort: `xhigh`, pane: `true`
- role: "You turn research into buildable work. Every task you write must trace to
  something the research established. You would rather write four honest tasks than
  eight speculative ones."
- task: "Break the research below into one epic and its tasks, in the canonical
  format given. Each task must be independently buildable, carry acceptance criteria
  a reviewer could check, and declare its dependencies by task title."

## Canonical output format — the generator MUST emit exactly this

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

`Depends on:` names other tasks by their exact `## TASK:` title, comma-separated, or the
literal `none`. It is the only ordering signal — section order means nothing.

**Those four `**Field:**` markers are the only ones allowed.** Any other line starting
`**Word:**` — `**Note:**`, `**Why:**`, `**Context:**`, `**Risk:**` — ends the field above
it, so the rest of that description would be dropped. Put the extra prose inside
`**Description:**` instead. A breakdown containing any other marker is rejected before
anything is published.

**Tasks are `## TASK:`, at exactly two hashes.** A `### TASK:` heading is not split out
as a task at all — it is absorbed into the previous task and the whole unit of scope
disappears. That, too, is rejected before publishing.

**Task titles must not contain commas.** `Depends on:` is comma-separated, so a comma in
a title makes every reference to it ambiguous. Write "Add contact_name and contact_phone
columns", never "Add contact_name, contact_phone columns". A breakdown that breaks this
rule is rejected before anything is published.

## preflight (parallel)

| name | model / effort | agentType | prompt |
|---|---|---|---|
| `existing-patterns` | sonnet / low | general-purpose | "Survey this repository for patterns relevant to the research below: how similar features are structured, which conventions hold, what already exists that could be reused. Cite `file:line`." |
| `prior-work` | sonnet / low | general-purpose | "Find existing tickets, specs, plans, or ADRs in this repo that overlap the research below. Quote them with paths — work already planned should not be re-planned." |

## lenses

| name | model / effort | agentType | prompt |
|---|---|---|---|
| `missing-work` | sonnet / low | — | "What work does this breakdown not account for? Name the specific gap and which epic goal it leaves unmet. Migrations, config, rollback, and docs are the usual omissions. Also flag any task title containing a comma — it would break dependency references." |
| `granularity` | sonnet / low | — | "Which tasks are too large to estimate confidently, and which are too small to justify a full pipeline run? Name each and say what it should become." |
| `dependencies` | sonnet / low | — | "What ordering is unstated? For each pair, say concretely what breaks if they run in the declared order. Flag any task that could not actually start with only its declared dependencies done." |
| `unsupported` | opus / medium | — | "What scope here is NOT justified by the research document? For each task, quote the research claim it rests on — or flag it as invented. You are the last defence against a backlog that has drifted from its evidence." |
| `feasibility` | sonnet / low | general-purpose | "What is expensive or hard to build in THIS codebase? Ground every objection in real code and cite `file:line`. An objection you cannot ground, do not raise." |

## termination

`dryRounds: 2`, `maxRounds: 5`, `budgetFloor: 50000`, `lensesPerRound: 3`

## output

`docs/spec/epics/<slug>/breakdown.md`
