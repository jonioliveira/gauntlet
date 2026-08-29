// Parses and validates the canonical breakdown format emitted by
// `/gan decompose`. Pure: no I/O, no network. Unlike src/core.js this is a
// normal ES module — it is never inlined into a Workflow script.

// The only field markers the format defines. Anything else matching `**Word:**`
// at the start of a line looks like a marker to the parser and therefore ENDS the
// field above it. Recording those here so the validator can reject them is what
// keeps that truncation from happening silently.
const KNOWN_FIELDS = ["Estimate", "Depends on", "Description", "Acceptance criteria"]
const KNOWN_FIELD_KEYS = KNOWN_FIELDS.map(n => n.toLowerCase())

// A field runs until the NEXT **Field:** marker — never until "some line did not
// match". LLM output wraps prose and puts sentences between a heading and its
// bullets; both used to truncate silently.
function parseTask(block) {
  const lines = block.split("\n")
  const task = {
    title: lines[0].trim(),
    estimate: null,
    dependsOn: [],
    description: "",
    acceptanceCriteria: [],
    unknownFields: [],
  }

  let field = null
  const descriptionLines = []

  for (const line of lines.slice(1)) {
    const header = line.match(/^\*\*([A-Za-z ]+):\*\*\s*(.*)$/)
    if (header) {
      const name = header[1].trim().toLowerCase()
      const rest = header[2].trim()
      field = null
      if (name === "estimate") {
        const n = Number(rest)
        task.estimate = Number.isFinite(n) ? n : null
      } else if (name === "depends on") {
        task.dependsOn = rest.toLowerCase() === "none"
          ? []
          : rest.split(",").map(s => s.trim()).filter(Boolean)
      } else if (name === "description") {
        if (rest) descriptionLines.push(rest)
        field = "description"
      } else if (name === "acceptance criteria") {
        field = "criteria"
      } else if (!KNOWN_FIELD_KEYS.includes(name)) {
        task.unknownFields.push(header[1].trim())
      }
      continue
    }

    if (field === "criteria") {
      // Non-bullet prose here is skipped, not fatal: it must not end the field.
      const item = line.match(/^\s*-\s+(.+)$/)
      if (item) task.acceptanceCriteria.push(item[1].trim())
      continue
    }

    if (field === "description" && line.trim() !== "") {
      descriptionLines.push(line.trim())
    }
  }

  task.description = descriptionLines.join(" ")
  return task
}

export function parseBreakdown(markdown) {
  const epicMatch = markdown.match(/^#\s+EPIC:\s*(.+)$/m)
  if (!epicMatch) {
    throw new Error("breakdown: no `# EPIC: <title>` heading found")
  }

  const afterEpic = markdown.slice(epicMatch.index + epicMatch[0].length)
  const taskSplit = afterEpic.split(/^##\s+TASK:\s*/m)

  // A `### TASK:` heading is not a task — the split above only sees `##`. Its
  // content is neither a field marker nor a bullet, so it is absorbed into the
  // PREVIOUS task's description and a whole unit of scope disappears. Collect
  // them for the validator rather than letting that happen quietly.
  const malformedTaskHeadings =
    (afterEpic.match(/^#{3,}\s+TASK:.*$/gm) || []).map(h => h.trim())

  return {
    epic: { title: epicMatch[1].trim(), summary: taskSplit[0].trim() },
    tasks: taskSplit.slice(1).map(parseTask),
    malformedTaskHeadings,
  }
}

// Kahn's algorithm: repeatedly remove tasks whose dependencies are all
// satisfied. Anything left over is in a cycle. Also yields the topological
// order publish uses to create issues parents-first.
export function validateBreakdown(breakdown) {
  const errors = []
  const tasks = breakdown.tasks || []

  if (tasks.length === 0) errors.push("breakdown has no tasks")

  for (const heading of breakdown.malformedTaskHeadings || []) {
    errors.push(
      `task heading at the wrong depth: "${heading}" — a task must be "## TASK: <title>". ` +
      "A deeper heading is not split out as a task and is absorbed into the previous one."
    )
  }

  const titles = new Set()
  for (const t of tasks) {
    if (titles.has(t.title)) errors.push(`duplicate task title: "${t.title}"`)
    titles.add(t.title)
    if (t.title.includes(",")) {
      errors.push(
        `task title contains a comma, which would break dependency references: "${t.title}"`
      )
    }
    if (!t.acceptanceCriteria || t.acceptanceCriteria.length === 0) {
      errors.push(`task "${t.title}" has no acceptance criteria`)
    }
    for (const f of t.unknownFields || []) {
      errors.push(
        `task "${t.title}" has an unrecognised field marker "**${f}:**" — only ` +
        KNOWN_FIELDS.map(n => `**${n}:**`).join(", ") +
        " are allowed, and any other marker silently ends the field above it."
      )
    }
  }

  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!titles.has(dep)) {
        errors.push(`task "${t.title}" depends on "${dep}", which is not in this breakdown`)
      }
    }
  }

  if (errors.length) return { ok: false, errors, order: [] }

  const remaining = new Map(tasks.map(t => [t.title, new Set(t.dependsOn)]))
  const order = []
  let progress = true
  while (remaining.size && progress) {
    progress = false
    for (const [title, deps] of [...remaining]) {
      if (deps.size === 0) {
        order.push(title)
        remaining.delete(title)
        for (const [, otherDeps] of remaining) otherDeps.delete(title)
        progress = true
      }
    }
  }

  if (remaining.size) {
    errors.push(`dependency cycle among: ${[...remaining.keys()].join(", ")}`)
    return { ok: false, errors, order: [] }
  }

  return { ok: true, errors: [], order }
}

// CLI entry so shell scripts can get a validated, ordered plan as JSON.
// `bun src/breakdown.js plan <file>` → {epic, tasks:[{title,body,estimate}],
// order:[title], edges:[{child,parent}]}. Exits 1 with errors on stderr.
if (import.meta.main) {
  const [cmd, path] = process.argv.slice(2)
  if (cmd !== "plan" || !path) {
    console.error("usage: bun src/breakdown.js plan <breakdown.md>")
    process.exit(2)
  }
  const md = await Bun.file(path).text()
  const breakdown = parseBreakdown(md)
  const check = validateBreakdown(breakdown)
  if (!check.ok) {
    for (const e of check.errors) console.error(e)
    process.exit(1)
  }
  const body = t => [
    t.description,
    "",
    "## Acceptance criteria",
    ...t.acceptanceCriteria.map(c => `- ${c}`),
  ].join("\n")
  console.log(JSON.stringify({
    epic: breakdown.epic,
    tasks: breakdown.tasks.map(t => ({ title: t.title, body: body(t), estimate: t.estimate })),
    order: check.order,
    edges: breakdown.tasks.flatMap(t => t.dependsOn.map(p => ({ child: t.title, parent: p }))),
  }))
}
