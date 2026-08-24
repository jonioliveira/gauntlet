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
