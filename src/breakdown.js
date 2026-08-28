// Parses and validates the canonical breakdown format emitted by
// `/gan decompose`. Pure: no I/O, no network. Unlike src/core.js this is a
// normal ES module — it is never inlined into a Workflow script.

const FIELD = {
  estimate: /^\*\*Estimate:\*\*\s*(.+)$/,
  dependsOn: /^\*\*Depends on:\*\*\s*(.+)$/,
  description: /^\*\*Description:\*\*\s*(.+)$/,
}

function parseTask(block) {
  const lines = block.split("\n")
  const task = {
    title: lines[0].trim(),
    estimate: null,
    dependsOn: [],
    description: "",
    acceptanceCriteria: [],
  }

  let inCriteria = false
  for (const line of lines.slice(1)) {
    if (/^\*\*Acceptance criteria:\*\*/.test(line)) { inCriteria = true; continue }
    if (inCriteria) {
      const item = line.match(/^-\s+(.+)$/)
      if (item) { task.acceptanceCriteria.push(item[1].trim()); continue }
      if (line.trim() !== "") inCriteria = false
    }
    const est = line.match(FIELD.estimate)
    if (est) {
      const n = Number(est[1].trim())
      task.estimate = Number.isFinite(n) ? n : null
      continue
    }
    const dep = line.match(FIELD.dependsOn)
    if (dep) {
      const raw = dep[1].trim()
      task.dependsOn = raw.toLowerCase() === "none"
        ? []
        : raw.split(",").map(s => s.trim()).filter(Boolean)
      continue
    }
    const desc = line.match(FIELD.description)
    if (desc) { task.description = desc[1].trim(); continue }
  }
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
