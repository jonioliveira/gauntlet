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
