import { test, expect } from "bun:test"
import { parseBreakdown, validateBreakdown } from "../src/breakdown.js"

const SAMPLE = `# EPIC: Add partner contacts

Give each partner unit a named contact and phone number.

## TASK: Add contact columns to the schema

**Estimate:** 2
**Depends on:** none
**Description:** Add \`contact_name\` and \`contact_phone\` to the units table.
**Acceptance criteria:**
- Migration applies cleanly
- Existing rows get NULL

## TASK: Show the contact on the unit page

**Estimate:** 3
**Depends on:** Add contact columns to the schema
**Description:** Render the contact under the unit header.
**Acceptance criteria:**
- Name and phone render when present
- Nothing renders when both are NULL
`

test("parses the epic title and summary", () => {
  const b = parseBreakdown(SAMPLE)
  expect(b.epic.title).toBe("Add partner contacts")
  expect(b.epic.summary).toBe("Give each partner unit a named contact and phone number.")
})

test("parses every task in file order", () => {
  const b = parseBreakdown(SAMPLE)
  expect(b.tasks.map(t => t.title)).toEqual([
    "Add contact columns to the schema",
    "Show the contact on the unit page",
  ])
})

test("parses estimate as a number", () => {
  expect(parseBreakdown(SAMPLE).tasks[0].estimate).toBe(2)
})

test("'none' becomes an empty dependency list", () => {
  expect(parseBreakdown(SAMPLE).tasks[0].dependsOn).toEqual([])
})

test("a named dependency is captured verbatim", () => {
  expect(parseBreakdown(SAMPLE).tasks[1].dependsOn)
    .toEqual(["Add contact columns to the schema"])
})

test("acceptance criteria become a list", () => {
  expect(parseBreakdown(SAMPLE).tasks[0].acceptanceCriteria)
    .toEqual(["Migration applies cleanly", "Existing rows get NULL"])
})

test("a missing epic heading throws", () => {
  expect(() => parseBreakdown("## TASK: orphan\n")).toThrow(/EPIC/)
})

test("a breakdown with no tasks parses to an empty task list", () => {
  const b = parseBreakdown("# EPIC: Empty\n\nNothing yet.\n")
  expect(b.tasks).toEqual([])
})

test("prose between the criteria heading and its bullets does not drop the list", () => {
  const md = `# EPIC: E

s

## TASK: t

**Acceptance criteria:**
The following must all hold:
- one
- two
`
  expect(parseBreakdown(md).tasks[0].acceptanceCriteria).toEqual(["one", "two"])
})

test("a wrapped description keeps its continuation lines", () => {
  const md = `# EPIC: E

s

## TASK: t

**Description:** first line
second line
**Acceptance criteria:**
- c
`
  expect(parseBreakdown(md).tasks[0].description).toBe("first line second line")
})

test("a field ends at the next field marker, not at a blank line", () => {
  const md = `# EPIC: E

s

## TASK: t

**Description:** alpha

beta
**Estimate:** 4
**Acceptance criteria:**
- c
`
  const t = parseBreakdown(md).tasks[0]
  expect(t.description).toBe("alpha beta")
  expect(t.estimate).toBe(4)
})

test("a non-numeric estimate degrades to null rather than NaN", () => {
  const md = `# EPIC: E

s

## TASK: t

**Estimate:** TBD
**Acceptance criteria:**
- c
`
  expect(parseBreakdown(md).tasks[0].estimate).toBe(null)
})

const bd = (...tasks) => ({ epic: { title: "E", summary: "s" }, tasks })
const task = (title, dependsOn = []) => ({
  title, estimate: 1, dependsOn, description: "d", acceptanceCriteria: ["a"],
})

test("a valid breakdown passes and yields a topological order", () => {
  const r = validateBreakdown(bd(task("b", ["a"]), task("a")))
  expect(r.ok).toBe(true)
  expect(r.errors).toEqual([])
  expect(r.order.indexOf("a")).toBeLessThan(r.order.indexOf("b"))
})

test("a dangling dependency is rejected and named", () => {
  const r = validateBreakdown(bd(task("a", ["ghost"])))
  expect(r.ok).toBe(false)
  expect(r.errors.join(" ")).toContain("ghost")
  expect(r.order).toEqual([])
})

test("a two-node cycle is rejected", () => {
  const r = validateBreakdown(bd(task("a", ["b"]), task("b", ["a"])))
  expect(r.ok).toBe(false)
  expect(r.errors.join(" ").toLowerCase()).toContain("cycle")
})

test("a three-node cycle is rejected", () => {
  const r = validateBreakdown(bd(task("a", ["c"]), task("b", ["a"]), task("c", ["b"])))
  expect(r.ok).toBe(false)
  expect(r.errors.join(" ").toLowerCase()).toContain("cycle")
})

test("a self-dependency is rejected", () => {
  const r = validateBreakdown(bd(task("a", ["a"])))
  expect(r.ok).toBe(false)
})

test("duplicate task titles are rejected", () => {
  const r = validateBreakdown(bd(task("a"), task("a")))
  expect(r.ok).toBe(false)
  expect(r.errors.join(" ").toLowerCase()).toContain("duplicate")
})

test("a breakdown with no tasks is rejected", () => {
  const r = validateBreakdown(bd())
  expect(r.ok).toBe(false)
})

test("a task with no acceptance criteria is rejected", () => {
  const bare = { title: "a", estimate: 1, dependsOn: [], description: "d", acceptanceCriteria: [] }
  const r = validateBreakdown(bd(bare))
  expect(r.ok).toBe(false)
  expect(r.errors.join(" ").toLowerCase()).toContain("acceptance")
})

test("a comma in a task title is rejected — it would break dependency references", () => {
  const r = validateBreakdown(bd(task("Add contact_name, contact_phone columns")))
  expect(r.ok).toBe(false)
  expect(r.errors.join(" ").toLowerCase()).toContain("comma")
})

test("an unrecognised field marker is rejected, not silently swallowed", () => {
  const md = `# EPIC: E

s

## TASK: t

**Description:** We must migrate the table.
**Note:** the old column stays.
More description that matters.
**Acceptance criteria:**
- c
`
  const b = parseBreakdown(md)
  expect(b.tasks[0].unknownFields).toEqual(["Note"])
  const r = validateBreakdown(b)
  expect(r.ok).toBe(false)
  expect(r.errors.join(" ")).toContain("**Note:**")
})

test("the four canonical field markers are not flagged", () => {
  const b = parseBreakdown(SAMPLE)
  expect(b.tasks.every(t => t.unknownFields.length === 0)).toBe(true)
  expect(validateBreakdown(b).ok).toBe(true)
})

test("a `### TASK:` heading is rejected rather than absorbed", () => {
  const md = `# EPIC: E

s

## TASK: real

**Description:** d
**Acceptance criteria:**
- c

### TASK: vanished

**Description:** d
**Acceptance criteria:**
- c
`
  const b = parseBreakdown(md)
  // The proof it would have vanished: only one task was split out.
  expect(b.tasks.map(t => t.title)).toEqual(["real"])
  expect(b.malformedTaskHeadings).toEqual(["### TASK: vanished"])
  const r = validateBreakdown(b)
  expect(r.ok).toBe(false)
  expect(r.errors.join(" ")).toContain("wrong depth")
})

test("a validator called on a hand-built breakdown tolerates the new fields", () => {
  expect(validateBreakdown(bd(task("a"))).ok).toBe(true)
})
