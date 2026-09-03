export const meta = {
  name: 'gauntlet',
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
  throw new Error('gauntlet: args must include { slug, input }')
}
if (!cfg.generator || !Array.isArray(cfg.lenses) || cfg.lenses.length === 0) {
  throw new Error('gauntlet: args must include a generator and at least one lens')
}

const DEFAULT_TERMINATION = {
  dryRounds: 2,
  maxRounds: 5,
  budgetFloor: 50000,
  lensesPerRound: 3,
}

// Only finite numbers are accepted. `args` crosses a JSON boundary, so a missing
// value arrives as null, and `0 >= null` is true — an unvalidated null would
// report convergence on a draft no critic ever saw.
const termination = {}
for (const key of Object.keys(DEFAULT_TERMINATION)) {
  const value = cfg.termination ? cfg.termination[key] : undefined
  if (typeof value === 'number' && Number.isFinite(value)) {
    termination[key] = value
  } else {
    termination[key] = DEFAULT_TERMINATION[key]
    if (value !== undefined && value !== null) {
      log('termination.' + key + ' was not a finite number — using default '
          + DEFAULT_TERMINATION[key])
    }
  }
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
  const name = 'gauntlet-' + cfg.slug
  const outFile = '/tmp/gauntlet-' + cfg.slug + '-r' + round + '.md'
  return [
    'You are driving a Herdr pane that hosts a long-lived generator agent.',
    'Use Bash. Run `herdr --skill` first if you do not already know the verbs.',
    '',
    'AGENT NAME: ' + name,
    'ROUND: ' + round,
    'OUTPUT FILE: ' + outFile,
    '',
    round === 0
      ? '1. Run `herdr agent get ' + name + '`. If no such agent exists, create a pane and '
        + 'start a `claude` agent in it named exactly "' + name + '", passing the model '
        + 'through: herdr agent start ' + name + ' --kind claude -- --model '
        + (cfg.generator.model || 'opus')
      : '1. The agent "' + name + '" already exists from an earlier round. Do NOT create it '
        + 'again — its context is the point.',
    '2. Send the PROMPT below to that agent and wait for it to finish:',
    '   herdr agent prompt ' + name + ' "<prompt>" --wait --timeout 900000',
    '3. Read the document from the FILE with Bash: cat ' + outFile,
    '   Do NOT recover the document from the pane\'s scrollback. Scrollback truncates',
    '   silently and wraps lines; the file is the transport.',
    '4. Return the full contents of that file, verbatim, and nothing else.',
    '',
    'If Herdr is unavailable, the agent cannot be started or prompted, or ' + outFile,
    'does not exist or is empty, reply with exactly PANE_UNAVAILABLE and nothing else.',
    '',
    'PROMPT:',
    '---',
    body,
    '',
    '(Write your complete answer to ' + outFile + ' — create or overwrite it.',
    ' Then reply in the pane with only the word DONE.)',
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

function buildBody(critiques, current, forPane) {
  if (critiques && critiques.length) {
    const head = [
      'Revise the draft to address these critiques.',
      'Return ONLY the complete revised document, exactly as it should stand.',
      'No preamble, no commentary, no list of what you changed, and no argument',
      'about critiques you disagree with — a critique you reject is simply one',
      'you leave the draft unchanged for. Anything you write that is not part of',
      'the document itself becomes part of the document, and the next round of',
      'critics will review it as such.',
      '',
    ]
    if (forPane) {
      // The pane agent is long-lived and already holds the draft, the request,
      // and the preflight context in its own conversation. Re-sending them
      // would waste the entire point of keeping the pane alive across rounds.
      return head.concat([JSON.stringify(critiques, null, 2)]).join('\n')
    }
    // A background agent is a fresh subagent every round and remembers nothing,
    // so the draft it is asked to revise must travel with the request.
    return head.concat([
      'ORIGINAL REQUEST:',
      cfg.input,
      preflightContext ? '\nPREFLIGHT CONTEXT:\n' + preflightContext : '',
      '',
      'CURRENT DRAFT:',
      current,
      '',
      'CRITIQUES:',
      JSON.stringify(critiques, null, 2),
    ]).join('\n')
  }
  return [
    cfg.generator.task,
    '',
    'INPUT:',
    cfg.input,
    preflightContext ? '\nPREFLIGHT CONTEXT:\n' + preflightContext : '',
  ].join('\n')
}

async function generate(critiques, round, current) {
  if (usePane) {
    const out = await agent(
      paneDriverPrompt(round, cfg.generator.role + '\n\n' + buildBody(critiques, current, true)),
      {
        label: 'generate:pane:r' + round,
        phase: 'Generate',
        model: 'sonnet',
        effort: 'low',
        agentType: 'general-purpose',
      }
    )
    const trimmed = (out || '').trim()
    // Length-bounded so a real document that happens to quote the token cannot
    // false-positive, but a chatty failure message still degrades gracefully.
    if (trimmed.length < 200 && trimmed.includes('PANE_UNAVAILABLE')) {
      log('herdr pane unavailable — falling back to a background generator')
      usePane = false
    } else if (out) {
      return out
    } else {
      log('pane generator returned nothing on round ' + round + ' — falling back to a background generator')
      usePane = false
    }
  }

  return await agent(cfg.generator.role + '\n\n' + buildBody(critiques, current, false), {
    label: 'generate:r' + round,
    phase: 'Generate',
    model: cfg.generator.model,
    effort: cfg.generator.effort,
  })
}

phase('Generate')
let draft = await generate(null, 0, null)
if (!draft) throw new Error('gauntlet: the generator produced nothing on round 0')

const seen = new Set()
const raised = new Map()      // id -> full issue object, everything ever raised
const unresolved = new Map()  // id -> full issue object, re-raised after being seen
const history = []
let state = { dry: 0, round: 0, full: false }

while (shouldContinue(
  state,
  termination,
  budget && typeof budget.remaining === 'function' ? budget.remaining() : null
)) {
  const active = lensesFor(cfg.lenses, termination.lensesPerRound, state.round, state.full)

  phase('Attack')
  const raw = (await parallel(active.map(l => () =>
    agent(attackPrompt(l, draft), {
      label: 'critic:' + l.name,
      phase: 'Attack',
      model: l.model,
      effort: l.effort,
      agentType: l.agentType,
      schema: CRITIQUE,
    })))).filter(Boolean)

  // A truthy result is not necessarily a usable one. Only a well-formed
  // {issues: [...]} counts as a critic that actually reviewed the draft —
  // otherwise a malformed reply becomes a silent vote for convergence.
  const results = raw.filter(r => r && Array.isArray(r.issues))

  if (raw.length > results.length) {
    log('round ' + state.round + ': ' + (raw.length - results.length)
        + ' critic(s) returned a malformed result (no issues array)')
  }

  if (!results.length) {
    throw new Error(
      'gauntlet: all ' + active.length + ' critics failed or returned malformed'
      + ' results in round ' + state.round
      + ' — aborting rather than counting a false dry round'
    )
  }
  if (results.length < active.length) {
    log('round ' + state.round + ': ' + (active.length - results.length) + ' critic(s) failed')
  }

  // A critic raising an id that is already in `seen` means the generator was shown
  // this critique and did not satisfy it. That is the unresolved signal.
  for (const result of results) {
    for (const issue of result.issues) {
      if (!issue || typeof issue.id !== 'string' || !issue.id) continue
      if (!raised.has(issue.id)) raised.set(issue.id, issue)
      if (seen.has(issue.id)) unresolved.set(issue.id, issue)
    }
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
    const revised = await generate(fresh, state.round + 1, draft)
    if (!revised) throw new Error('gauntlet: the generator died on round ' + (state.round + 1))
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
  issuesRaised: Array.from(raised.values()),
  unresolved: Array.from(unresolved.values()),
  history: history,
  outputPath: (cfg.output && cfg.output.path) || null,
}
