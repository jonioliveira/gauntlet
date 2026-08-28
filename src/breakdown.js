// Parses and validates the canonical breakdown format emitted by
// `/gan decompose`. Pure: no I/O, no network. Unlike src/core.js this is a
// normal ES module — it is never inlined into a Workflow script.

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

  return {
    epic: { title: epicMatch[1].trim(), summary: taskSplit[0].trim() },
    tasks: taskSplit.slice(1).map(parseTask),
  }
}
