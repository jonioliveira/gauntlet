# Research → Linear → SDLC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn a `/gan research` findings document into a Linear epic with dependency-linked tasks, then run each task through builders' seven-stage pipeline to a draft PR.

**Architecture:** Pure logic (breakdown parsing, validation, scheduling) lives in `src/*.js` as ES modules, unit-tested under Bun and CLI-invokable via `import.meta.main`. All I/O — `orca linear`, `orca worktree`, `herdr` — lives in `bin/*.sh`, which call those modules for decisions. The GAN engine is not modified; `decompose` is a third domain config.

**Tech Stack:** Plain JavaScript (ES modules), Bun test runner, Bash, `orca` CLI (Linear + worktrees), `herdr` CLI (panes), builders `run-sdlc`.

**Spec:** `docs/spec/2026-08-27-research-to-sdlc.md`

## Global Constraints

Copied from the spec. Every task's requirements implicitly include these.

- **Do not modify `src/core.js`, `src/engine.template.js`, `build.js`, or `dist/`.** The GAN engine is unchanged by this work.
- **Do not modify anything under `~/workspace/builders`.** It is consumed, not edited.
- `src/breakdown.js` and `src/schedule.js` are **plain ES modules**, NOT inlined into the workflow script. They may use `import`. This is the opposite of `src/core.js`'s constraint — do not confuse them.
- Plain JavaScript, NOT TypeScript. No type annotations, interfaces, or generics.
- **Pass 0 of publish writes nothing.** Validation failures must occur before the first `orca linear save-issue`.
- **On publish failure: stop, do not roll back.** Report what was created.
- **A failed task is never moved to a done state.** Its dependents stay blocked by Linear's own semantics — never add skip logic.
- **Claim a task into the in-progress state BEFORE launching it.** Otherwise the loop relaunches a running task.
- Workflow state names are per-team config, resolved via `orca linear team states` — never hardcoded.
- Team is `JON`, held in config, not literals.
- Both `bin/*.sh` scripts must support `--dry-run`, printing the exact commands without executing any of them.
- Run `bun run test` (not bare `bun test` — it skips the build hook).

---

### Task 1: Breakdown parser

**Files:**
- Create: `src/breakdown.js`
- Test: `test/breakdown.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseBreakdown(markdown) -> {epic: {title, summary}, tasks: Task[]}` where `Task` is `{title: string, estimate: number|null, dependsOn: string[], description: string, acceptanceCriteria: string[]}`. Pure; throws `Error` on a missing epic heading.

- [ ] **Step 1: Write the failing test**

Create `test/breakdown.test.js`:

```js
import { test, expect } from "bun:test"
import { parseBreakdown } from "../src/breakdown.js"

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/workspace/gan-engine && bun test test/breakdown.test.js`
Expected: FAIL — `Cannot find module '../src/breakdown.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/breakdown.js`:

```js
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd ~/workspace/gan-engine && bun test test/breakdown.test.js`
Expected: PASS — 8 tests

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/gan-engine
git add src/breakdown.js test/breakdown.test.js
git commit -m "feat(breakdown): parse the canonical decompose format"
```

---

### Task 2: Breakdown validator

**Files:**
- Modify: `src/breakdown.js`
- Test: `test/breakdown.test.js`

**Interfaces:**
- Consumes: `parseBreakdown` from Task 1 (same file).
- Produces: `validateBreakdown(breakdown) -> {ok: boolean, errors: string[], order: string[]}`. `order` is a topological ordering of task titles when `ok` is true, and `[]` when it is false. Pure.

- [ ] **Step 1: Write the failing tests**

Append to `test/breakdown.test.js`:

```js
import { validateBreakdown } from "../src/breakdown.js"

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/gan-engine && bun test test/breakdown.test.js`
Expected: FAIL — `validateBreakdown is not a function`

- [ ] **Step 3: Write minimal implementation**

Append to `src/breakdown.js`:

```js
// Kahn's algorithm: repeatedly remove tasks whose dependencies are all
// satisfied. Anything left over is in a cycle. Also yields the topological
// order publish uses to create issues parents-first.
export function validateBreakdown(breakdown) {
  const errors = []
  const tasks = breakdown.tasks || []

  if (tasks.length === 0) errors.push("breakdown has no tasks")

  const titles = new Set()
  for (const t of tasks) {
    if (titles.has(t.title)) errors.push(`duplicate task title: "${t.title}"`)
    titles.add(t.title)
    if (!t.acceptanceCriteria || t.acceptanceCriteria.length === 0) {
      errors.push(`task "${t.title}" has no acceptance criteria`)
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/gan-engine && bun run test`
Expected: PASS — 39 tests (23 existing + 8 from Task 1 + 8 here)

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/gan-engine
git add src/breakdown.js test/breakdown.test.js
git commit -m "feat(breakdown): validate dangling deps and cycles before any write"
```

---

### Task 3: The decompose domain config

**Files:**
- Create: `skill/configs/decompose.md`
- Modify: `skill/SKILL.md`

**Interfaces:**
- Consumes: the GAN engine's existing args shape — `{slug, input, preflight?, generator, lenses, termination, output}`.
- Produces: a `/gan decompose <research-doc>` subcommand whose draft is the canonical breakdown format Task 1 parses.

- [ ] **Step 1: Create the config**

Create `skill/configs/decompose.md`:

````markdown
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

`Depends on:` names other tasks by their exact `## TASK:` title, comma-separated,
or the literal `none`. It is the only ordering signal — section order means nothing.

## preflight (parallel)

| name | model / effort | agentType | prompt |
|---|---|---|---|
| `existing-patterns` | sonnet / low | general-purpose | "Survey this repository for patterns relevant to the research below: how similar features are structured, which conventions hold, what already exists that could be reused. Cite `file:line`." |
| `prior-work` | sonnet / low | general-purpose | "Find existing tickets, specs, plans, or ADRs in this repo that overlap the research below. Quote them with paths — work already planned should not be re-planned." |

## lenses

| name | model / effort | agentType | prompt |
|---|---|---|---|
| `missing-work` | sonnet / low | — | "What work does this breakdown not account for? Name the specific gap and which epic goal it leaves unmet. Migrations, config, rollback, and docs are the usual omissions." |
| `granularity` | sonnet / low | — | "Which tasks are too large to estimate confidently, and which are too small to justify a full pipeline run? Name each and say what it should become." |
| `dependencies` | sonnet / low | — | "What ordering is unstated? For each pair, say concretely what breaks if they run in the declared order. Flag any task that could not actually start with only its declared dependencies done." |
| `unsupported` | opus / medium | — | "What scope here is NOT justified by the research document? For each task, quote the research claim it rests on — or flag it as invented. You are the last defence against a backlog that has drifted from its evidence." |
| `feasibility` | sonnet / low | general-purpose | "What is expensive or hard to build in THIS codebase? Ground every objection in real code and cite `file:line`. An objection you cannot ground, do not raise." |

## termination

`dryRounds: 2`, `maxRounds: 5`, `budgetFloor: 50000`, `lensesPerRound: 3`

## output

`docs/spec/epics/<slug>/breakdown.md`
````

- [ ] **Step 2: Wire the subcommand into the skill**

In `skill/SKILL.md`, under `## Usage`, add a third line after the `define` line:

```markdown
- `/gan decompose <research-doc>` — a Linear epic and its tasks, stops for your approval
```

In step 1 ("Parse the subcommand"), change `research` or `define`. If neither is given, ask which one — do not guess.` to:

```markdown
   `research`, `define`, or `decompose`. If none is given, ask which one — do not
   guess.
```

In step 3 ("Read the matching config"), change the config list to name all three:

```markdown
3. **Read the matching config** — `configs/research.md`, `configs/product.md`, or
   `configs/decompose.md` from this skill's directory. It holds the generator
   framing, the lenses, and the preflight agents as prose.
```

In step 8, add a third bullet after the `define` bullet:

```markdown
   - `decompose`: do **not** publish yet. Show the user the breakdown and the issues
     that were raised, and ask for approval. On approval, run
     `bin/publish-epic.sh <breakdown-path>` — never call `orca linear` by hand.
```

- [ ] **Step 3: Verify the config parses with the Task 1 parser**

Run:
```bash
cd ~/workspace/gan-engine
bun -e '
import { parseBreakdown, validateBreakdown } from "./src/breakdown.js"
const md = await Bun.file("skill/configs/decompose.md").text()
const fence = md.match(/```markdown\n([\s\S]*?)```/)[1]
const sample = fence.replace(/<title>/g, "T").replace(/<summary[^>]*>/g, "s")
  .replace(/<points>/g, "1").replace(/<task title> \| none/g, "none")
  .replace(/<what and why>/g, "d").replace(/<criterion>/g, "c")
const b = parseBreakdown(sample)
console.log("epic:", b.epic.title, "| tasks:", b.tasks.length)
'
```
Expected: `epic: T | tasks: 1` — the documented format is the format the parser accepts.

- [ ] **Step 4: Confirm the skill lists three subcommands**

Run: `grep -c "^- \`/gan " skill/SKILL.md`
Expected: `3`

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/gan-engine
git add skill/configs/decompose.md skill/SKILL.md
git commit -m "feat(skill): decompose domain — research into an epic and tasks"
```

---

### Task 4: Publish to Linear

**Files:**
- Create: `bin/publish-epic.sh`
- Test: `test/publish.test.js`

**Interfaces:**
- Consumes: `parseBreakdown`, `validateBreakdown` from Tasks 1–2.
- Produces: `bin/publish-epic.sh <breakdown.md> [--dry-run] [--team KEY]`. Writes `docs/spec/epics/<slug>/published.json` with `{epic, tasks: [{title, id}], relations: [{child, parent}]}` — ids, not titles. **The `relations` array is load-bearing**: `orca linear` has no relation-read verb, so this manifest is the only machine-readable copy of the dependency graph, and Task 6's runner reads its edges from here. Exit 0 on success, non-zero with a named reason on failure.

- [ ] **Step 1: Write the failing test**

Create `test/publish.test.js`:

```js
import { test, expect } from "bun:test"
import { $ } from "bun"

const FIXTURE = "test/fixtures/breakdown-ok.md"

test("dry-run emits the exact orca calls in dependency order", async () => {
  const out = await $`bash bin/publish-epic.sh ${FIXTURE} --dry-run --team JON`.text()
  const lines = out.split("\n").filter(l => l.startsWith("orca "))

  expect(lines[0]).toContain("save-issue")
  expect(lines[0]).toContain("--team JON")
  expect(lines[0]).toContain("EPIC")

  const schemaAt = lines.findIndex(l => l.includes("schema"))
  const pageAt = lines.findIndex(l => l.includes("unit page"))
  expect(schemaAt).toBeGreaterThan(0)
  expect(pageAt).toBeGreaterThan(schemaAt)

  expect(lines.some(l => l.includes("relation add") && l.includes("blocked-by"))).toBe(true)
})

test("dry-run writes nothing", async () => {
  await $`bash bin/publish-epic.sh ${FIXTURE} --dry-run --team JON`.quiet()
  const manifest = Bun.file("docs/spec/epics/breakdown-ok/published.json")
  expect(await manifest.exists()).toBe(false)
})

test("a cycle is rejected before any orca call", async () => {
  const r = await $`bash bin/publish-epic.sh test/fixtures/breakdown-cycle.md --dry-run --team JON`
    .nothrow().quiet()
  expect(r.exitCode).not.toBe(0)
  expect(r.stderr.toString().toLowerCase()).toContain("cycle")
  expect(r.stdout.toString()).not.toContain("orca linear save-issue")
})

test("a dangling dependency is rejected before any orca call", async () => {
  const r = await $`bash bin/publish-epic.sh test/fixtures/breakdown-dangling.md --dry-run --team JON`
    .nothrow().quiet()
  expect(r.exitCode).not.toBe(0)
  expect(r.stdout.toString()).not.toContain("orca linear save-issue")
})
```

Create `test/fixtures/breakdown-ok.md`:

```markdown
# EPIC: Add partner contacts

Give each partner unit a named contact and phone number.

## TASK: Add contact columns to the schema

**Estimate:** 2
**Depends on:** none
**Description:** Add contact_name and contact_phone to the units table.
**Acceptance criteria:**
- Migration applies cleanly

## TASK: Show the contact on the unit page

**Estimate:** 3
**Depends on:** Add contact columns to the schema
**Description:** Render the contact under the unit header.
**Acceptance criteria:**
- Name and phone render when present
```

Create `test/fixtures/breakdown-cycle.md`:

```markdown
# EPIC: Cyclic

A breakdown that cannot be ordered.

## TASK: alpha

**Estimate:** 1
**Depends on:** beta
**Description:** d
**Acceptance criteria:**
- c

## TASK: beta

**Estimate:** 1
**Depends on:** alpha
**Description:** d
**Acceptance criteria:**
- c
```

Create `test/fixtures/breakdown-dangling.md`:

```markdown
# EPIC: Dangling

A breakdown referencing a task that does not exist.

## TASK: alpha

**Estimate:** 1
**Depends on:** ghost
**Description:** d
**Acceptance criteria:**
- c
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/workspace/gan-engine && bun test test/publish.test.js`
Expected: FAIL — `bin/publish-epic.sh: No such file or directory`

- [ ] **Step 3: Write the script**

Create `bin/publish-epic.sh`:

```bash
#!/usr/bin/env bash
# Publish a decompose breakdown to Linear as an epic with dependency-linked child
# tasks. Two passes, because relations need ids that pass 1 creates.
#
# Pass 0 validates and writes NOTHING: a dangling reference or a cycle is caught
# before a single issue exists.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BREAKDOWN=""; DRY=0; TEAM="${GAN_LINEAR_TEAM:-JON}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1; shift ;;
    --team)    TEAM="$2"; shift 2 ;;
    *)         BREAKDOWN="$1"; shift ;;
  esac
done

[ -n "$BREAKDOWN" ] || { echo "usage: publish-epic.sh <breakdown.md> [--dry-run] [--team KEY]" >&2; exit 2; }
[ -f "$BREAKDOWN" ] || { echo "no such breakdown: $BREAKDOWN" >&2; exit 2; }

SLUG="$(basename "$BREAKDOWN" .md)"
OUTDIR="$(dirname "$BREAKDOWN")"
MANIFEST="$OUTDIR/published.json"

# ---- Pass 0: validate. No writes. ----
PLAN="$(bun "$REPO/src/breakdown.js" plan "$BREAKDOWN")" || {
  echo "breakdown validation failed" >&2; exit 1;
}

run() {
  echo "$*"
  [ "$DRY" -eq 1 ] && return 0
  "$@"
}

# ---- Pass 1: create the epic, then each task in topological order ----
EPIC_TITLE="$(echo "$PLAN" | jq -r '.epic.title')"
EPIC_BODY="$OUTDIR/.epic-body.md"
echo "$PLAN" | jq -r '.epic.summary' > "$EPIC_BODY"

echo "orca linear save-issue --team $TEAM --title \"EPIC: $EPIC_TITLE\" --body-file $EPIC_BODY --json"
if [ "$DRY" -eq 0 ]; then
  EPIC_ID="$(orca linear save-issue --team "$TEAM" --title "EPIC: $EPIC_TITLE" \
              --body-file "$EPIC_BODY" --json | jq -r '.identifier')"
else
  EPIC_ID="DRY-EPIC"
fi

declare -A TASK_ID

# The manifest is the ONLY machine-readable copy of the dependency graph:
# `orca linear` has no relation-read verb. bin/run-epic.sh reads its edges here.
write_manifest() {
  # relations are emitted by id, mapped from PLAN's title-based edges
  local rel="[]"
  if [ "${#TASK_ID[@]}" -gt 0 ]; then
    local map="{}"
    for k in "${!TASK_ID[@]}"; do
      map="$(jq -c --arg t "$k" --arg i "${TASK_ID[$k]}" '. + {($t): $i}' <<<"$map")"
    done
    rel="$(echo "$PLAN" | jq -c --argjson m "$map" \
      '[.edges[] | select($m[.child] and $m[.parent])
                 | {child: $m[.child], parent: $m[.parent]}]')"
  fi

  local tasks="[]"
  for k in "${!TASK_ID[@]}"; do
    tasks="$(jq -c --arg t "$k" --arg i "${TASK_ID[$k]}" \
      '. + [{title: $t, id: $i}]' <<<"$tasks")"
  done

  jq -n --arg e "$EPIC_ID" --argjson t "$tasks" --argjson r "$rel" \
    '{epic: $e, tasks: $t, relations: $r}' > "$MANIFEST"
}'
  } > "$MANIFEST"
}
while IFS= read -r title; do
  BODY="$OUTDIR/.task-$(echo "$title" | tr -cd '[:alnum:]' | cut -c1-40).md"
  echo "$PLAN" | jq -r --arg t "$title" '.tasks[] | select(.title==$t) | .body' > "$BODY"
  EST="$(echo "$PLAN" | jq -r --arg t "$title" '.tasks[] | select(.title==$t) | .estimate // empty')"

  echo "orca linear save-issue --team $TEAM --parent-id $EPIC_ID --title \"$title\" --body-file $BODY ${EST:+--estimate $EST} --json"
  if [ "$DRY" -eq 0 ]; then
    TASK_ID[$title]="$(orca linear save-issue --team "$TEAM" --parent-id "$EPIC_ID" \
                        --title "$title" --body-file "$BODY" ${EST:+--estimate "$EST"} \
                        --json | jq -r '.identifier')"
    write_manifest
  else
    TASK_ID[$title]="DRY-$(echo "$title" | tr -cd '[:alnum:]' | cut -c1-8)"
  fi
done < <(echo "$PLAN" | jq -r '.order[]')

# ---- Pass 2: wire dependencies ----
while IFS=$'\t' read -r child parent; do
  echo "orca linear relation add ${TASK_ID[$child]} --related ${TASK_ID[$parent]} --type blocked-by"
  [ "$DRY" -eq 0 ] && orca linear relation add "${TASK_ID[$child]}" \
      --related "${TASK_ID[$parent]}" --type blocked-by --json > /dev/null
done < <(echo "$PLAN" | jq -r '.edges[] | "\(.child)\t\(.parent)"')

rm -f "$OUTDIR"/.epic-body.md "$OUTDIR"/.task-*.md
[ "$DRY" -eq 1 ] && echo "(dry run — nothing was created)" || echo "published: $MANIFEST"
```

Make it executable: `chmod +x bin/publish-epic.sh`

- [ ] **Step 4: Add the `plan` CLI entry to `src/breakdown.js`**

Append to `src/breakdown.js`:

```js
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/workspace/gan-engine && bun run test`
Expected: PASS — 43 tests (39 + 4 publish tests)

- [ ] **Step 6: Commit**

```bash
cd ~/workspace/gan-engine
git add bin/publish-epic.sh src/breakdown.js test/publish.test.js test/fixtures/
git commit -m "feat(publish): two-pass Linear publish, validated before any write"
```

---

### Task 5: The scheduler

**Files:**
- Create: `src/schedule.js`
- Test: `test/schedule.test.js`

**Interfaces:**
- Consumes: nothing.
- Produces: `runnable(issues, stateNames) -> Issue[]` where `Issue` is `{id: string, state: string, blockedBy: string[]}` and `stateNames` is `{done: string[], canceled: string[], inProgress: string[]}`. Returns issues eligible to launch. Pure.

- [ ] **Step 1: Write the failing tests**

Create `test/schedule.test.js`:

```js
import { test, expect } from "bun:test"
import { runnable } from "../src/schedule.js"

const S = { done: ["Done"], canceled: ["Canceled"], inProgress: ["In Progress"] }
const i = (id, state, blockedBy = []) => ({ id, state, blockedBy })
const ids = xs => xs.map(x => x.id)

test("an unblocked backlog task is runnable", () => {
  expect(ids(runnable([i("A", "Todo")], S))).toEqual(["A"])
})

test("a task blocked by an unfinished task is not runnable", () => {
  expect(ids(runnable([i("A", "Todo"), i("B", "Todo", ["A"])], S))).toEqual(["A"])
})

test("a task becomes runnable once its blocker is done", () => {
  expect(ids(runnable([i("A", "Done"), i("B", "Todo", ["A"])], S))).toEqual(["B"])
})

test("an in-progress task is NOT runnable — this is what stops a relaunch", () => {
  expect(ids(runnable([i("A", "In Progress")], S))).toEqual([])
})

test("a done task is not runnable", () => {
  expect(ids(runnable([i("A", "Done")], S))).toEqual([])
})

test("a canceled task is not runnable", () => {
  expect(ids(runnable([i("A", "Canceled")], S))).toEqual([])
})

test("a canceled blocker does NOT unblock its dependent", () => {
  expect(ids(runnable([i("A", "Canceled"), i("B", "Todo", ["A"])], S))).toEqual([])
})

test("a failed task's dependents stay blocked — no skip logic needed", () => {
  // A failed run leaves A in Todo. B must not run.
  expect(ids(runnable([i("A", "Todo"), i("B", "Todo", ["A"])], S)).includes("B")).toBe(false)
})

test("a task blocked by an id not in the set is not runnable", () => {
  expect(ids(runnable([i("B", "Todo", ["missing"])], S))).toEqual([])
})

test("independent branches both run", () => {
  expect(ids(runnable([i("A", "Todo"), i("B", "Todo")], S)).sort()).toEqual(["A", "B"])
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd ~/workspace/gan-engine && bun test test/schedule.test.js`
Expected: FAIL — `Cannot find module '../src/schedule.js'`

- [ ] **Step 3: Write minimal implementation**

Create `src/schedule.js`:

```js
// Decides which tasks may launch. Pure: the runner does the I/O, this decides.
//
// Two invariants live here and nowhere else:
//   1. An in-progress task is never runnable — otherwise the loop relaunches a
//      task already running, creating a second worktree, pane and pipeline.
//   2. Only a DONE blocker unblocks a dependent. A failed task is left in its
//      original state, so its dependents stay blocked with no skip logic.

export function runnable(issues, stateNames) {
  const done = new Set(stateNames.done)
  const canceled = new Set(stateNames.canceled)
  const inProgress = new Set(stateNames.inProgress)
  const stateOf = new Map(issues.map(i => [i.id, i.state]))

  return issues.filter(issue => {
    if (done.has(issue.state)) return false
    if (canceled.has(issue.state)) return false
    if (inProgress.has(issue.state)) return false
    return (issue.blockedBy || []).every(id => {
      const s = stateOf.get(id)
      return s !== undefined && done.has(s)
    })
  })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd ~/workspace/gan-engine && bun run test`
Expected: PASS — 53 tests (43 + 10 here)

- [ ] **Step 5: Commit**

```bash
cd ~/workspace/gan-engine
git add src/schedule.js test/schedule.test.js
git commit -m "feat(schedule): runnable predicate — in-progress and failure semantics"
```

---

### Task 6: The runner

**Files:**
- Create: `bin/run-epic.sh`
- Modify: `src/schedule.js` (add a CLI entry)
- Modify: `README.md`
- Test: `test/run-epic.test.js`

**Interfaces:**
- Consumes: `runnable` from Task 5, `orca`, `herdr`, builders' `run-sdlc`.
- Produces: `bin/run-epic.sh <EPIC-ID> [--max-parallel N] [--dry-run]`.

- [ ] **Step 1: Write the failing test**

Create `test/run-epic.test.js`:

```js
import { test, expect } from "bun:test"
import { $ } from "bun"

// GAN_FAKE_LINEAR points the runner at a JSON fixture instead of the real CLI,
// so scheduling is testable without touching Linear.
const FIX = "test/fixtures/epic-state.json"

test("dry-run launches only unblocked tasks", async () => {
  const out = await $`bash bin/run-epic.sh JON-1 --dry-run --max-parallel 3`
    .env({ ...process.env, GAN_FAKE_LINEAR: FIX }).text()
  expect(out).toContain("JON-2")
  expect(out).not.toContain("JON-3")
})

test("dry-run respects --max-parallel", async () => {
  const out = await $`bash bin/run-epic.sh JON-1 --dry-run --max-parallel 1`
    .env({ ...process.env, GAN_FAKE_LINEAR: FIX }).text()
  const launches = out.split("\n").filter(l => l.includes("herdr agent start"))
  expect(launches.length).toBe(1)
})

test("dry-run creates no worktree, pane, or Linear write", async () => {
  const out = await $`bash bin/run-epic.sh JON-1 --dry-run --max-parallel 3`
    .env({ ...process.env, GAN_FAKE_LINEAR: FIX }).text()
  expect(out).toContain("(dry run")
  const wt = await $`orca worktree list`.nothrow().quiet()
  expect(wt.stdout.toString()).not.toContain("JON-2")
})
```

Create `test/fixtures/epic-state.json`:

```json
[
  {"id": "JON-2", "state": "Todo", "blockedBy": []},
  {"id": "JON-3", "state": "Todo", "blockedBy": ["JON-2"]},
  {"id": "JON-4", "state": "Done", "blockedBy": []}
]
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd ~/workspace/gan-engine && bun test test/run-epic.test.js`
Expected: FAIL — `bin/run-epic.sh: No such file or directory`

- [ ] **Step 3: Add the `runnable` CLI entry to `src/schedule.js`**

Append to `src/schedule.js`:

```js
// CLI entry so the runner can ask "what may launch now?" from bash.
// `bun src/schedule.js runnable <state.json> <done> <canceled> <inProgress>`
// prints one id per line. State names are comma-separated.
if (import.meta.main) {
  const [cmd, path, done, canceled, inProgress] = process.argv.slice(2)
  if (cmd !== "runnable" || !path) {
    console.error("usage: bun src/schedule.js runnable <state.json> <done> <canceled> <inProgress>")
    process.exit(2)
  }
  const issues = JSON.parse(await Bun.file(path).text())
  const split = s => (s || "").split(",").map(x => x.trim()).filter(Boolean)
  const ready = runnable(issues, {
    done: split(done), canceled: split(canceled), inProgress: split(inProgress),
  })
  for (const issue of ready) console.log(issue.id)
}
```

- [ ] **Step 4: Write the runner**

Create `bin/run-epic.sh`:

```bash
#!/usr/bin/env bash
# Run every task of a Linear epic through builders' pipeline, respecting the
# dependency graph. Linear holds all the state: the runner asks what is runnable
# rather than tracking its own graph.
#
# A failed task is never moved to done, so its dependents never unblock. That is
# the whole failure policy — there is deliberately no skip logic here.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EPIC=""; DRY=0; MAXP=3
DONE_STATES="${GAN_DONE_STATES:-Done}"
CANCELED_STATES="${GAN_CANCELED_STATES:-Canceled}"
INPROGRESS_STATES="${GAN_INPROGRESS_STATES:-In Progress}"

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)      DRY=1; shift ;;
    --max-parallel) MAXP="$2"; shift 2 ;;
    *)              EPIC="$1"; shift ;;
  esac
done
[ -n "$EPIC" ] || { echo "usage: run-epic.sh <EPIC-ID> [--max-parallel N] [--dry-run]" >&2; exit 2; }

STATE_FILE="$(mktemp)"
trap 'rm -f "$STATE_FILE"' EXIT

# Edges come from the manifest, states from Linear. `orca linear` has NO
# relation-read verb, so the graph cannot be recovered from the API — the
# manifest published alongside the epic is the only machine-readable copy.
fetch_state() {
  if [ -n "${GAN_FAKE_LINEAR:-}" ]; then
    cp "$GAN_FAKE_LINEAR" "$STATE_FILE"
    return
  fi
  [ -f "$MANIFEST" ] || { echo "no manifest at $MANIFEST — publish first" >&2; exit 1; }
  orca linear list-issues --parent-id "$EPIC" --json \
    | jq --slurpfile m "$MANIFEST" '
        ($m[0].relations // []) as $rel
        | [ .result.issues[]
            | .identifier as $id
            | {id: $id,
               state: .state.name,
               blockedBy: [ $rel[] | select(.child == $id) | .parent ]} ]' \
    > "$STATE_FILE"
}

launched=0
while :; do
  fetch_state
  READY="$(bun "$REPO/src/schedule.js" runnable "$STATE_FILE" \
            "$DONE_STATES" "$CANCELED_STATES" "$INPROGRESS_STATES")"
  [ -n "$READY" ] || break

  n=0
  while IFS= read -r TASK; do
    [ -n "$TASK" ] || continue
    [ "$n" -ge "$MAXP" ] && break
    n=$((n+1)); launched=$((launched+1))

    # Claim the task BEFORE launching: an in-progress task is not runnable, so
    # this is what stops the next iteration starting it a second time.
    echo "orca linear save-issue $TASK --state \"${INPROGRESS_STATES%%,*}\""
    echo "orca worktree create --name $TASK --linear-issue $TASK --base-branch main --json"
    echo "herdr agent start gan-$TASK --kind claude"
    echo "herdr agent prompt gan-$TASK \"/run-sdlc $TASK\" --wait"

    if [ "$DRY" -eq 0 ]; then
      orca linear save-issue "$TASK" --state "${INPROGRESS_STATES%%,*}" --json >/dev/null
      # --linear-issue binds the worktree to the ticket, which is what makes
      # `orca linear attach --current` and `save-issue --current` work inside it.
      WT="$(orca worktree create --name "$TASK" --linear-issue "$TASK" \
              --base-branch main --json | jq -r '.result.path // .path')"
      ( cd "$WT" && herdr agent start "gan-$TASK" --kind claude \
          && herdr agent prompt "gan-$TASK" "/run-sdlc $TASK" --wait --timeout 3600000 ) &
    fi
  done <<< "$READY"

  if [ "$DRY" -eq 1 ]; then echo "(dry run — nothing was created)"; break; fi
  wait
done

echo "launched: $launched"
```

Make it executable: `chmod +x bin/run-epic.sh`

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd ~/workspace/gan-engine && bun run test`
Expected: PASS — 56 tests (53 + 3 here)

- [ ] **Step 6: Document it**

In `README.md`, after the `## Use` block, add:

```markdown
## Research → tracked work → PRs

    /gan research "<question>"          # evidence-backed findings
    /gan decompose docs/spec/research/<slug>.md   # → epic + tasks, you approve
    bin/publish-epic.sh docs/spec/epics/<slug>/breakdown.md   # → Linear
    bin/run-epic.sh JON-<id> --dry-run  # see the plan
    bin/run-epic.sh JON-<id>            # run it

Both scripts take `--dry-run`. `run-epic.sh` opens one herdr pane per task,
named `gan-<TASK-ID>` — kill a pane to stop that task. Ctrl-C on the runner does
not stop in-flight panes.

State names are per-team; resolve yours with `orca linear team states` and set
`GAN_DONE_STATES`, `GAN_CANCELED_STATES`, `GAN_INPROGRESS_STATES` if they differ
from the defaults (`Done`, `Canceled`, `In Progress`).
```

- [ ] **Step 7: Commit**

```bash
cd ~/workspace/gan-engine
git add bin/run-epic.sh src/schedule.js test/run-epic.test.js test/fixtures/epic-state.json README.md
git commit -m "feat(runner): DAG execution over Linear state with panes and worktrees"
```

---

## First real run — verify before trusting

These are not tasks; they are the acceptance checks the spec's open question 2 requires.

1. **Relation direction.** After the first real `publish-epic.sh`, open the epic in
   Linear and confirm the task that should run *second* shows as *blocked by* the
   first. If reversed, flip `--type blocked-by` to `blocks` in `bin/publish-epic.sh`
   Pass 2 and re-publish. Getting this backwards inverts the entire execution order.
2. **State names.** Run `orca linear team states` and confirm `Done`, `Canceled`
   and `In Progress` are the real names for team `JON`. A wrong in-progress name
   means every launched task still looks runnable and the loop double-launches.
3. **First epic**, `--max-parallel 1`, on a repo where a bad PR costs nothing.

## Self-Review

**Spec coverage.** Decompose domain → Task 3. Canonical format → Tasks 1, 3.
Markdown-over-JSON → Task 1 (parser, not a JSON schema). Pass 0 validation →
Task 2 + Task 4 Step 3. Two-pass publish → Task 4. Manifest/idempotency → Task 4.
Failure policy → Task 5 (`runnable` only unblocks on done). In-progress invariant
→ Task 5 tests + Task 6 claim-before-launch. Concurrency → Task 6 `--max-parallel`.
Panes and worktrees → Task 6. `--dry-run` on both scripts → Tasks 4, 6. Stopping →
Task 6 Step 6 (README). Testing plan → Tasks 1, 2, 4, 5, 6.

**Gap found and closed (reversed on verification).** An earlier draft of this
self-review argued the manifest need not carry `relations`, because they were
re-derivable and only *creates* need idempotency. That reasoning was wrong, and
checking the CLI proved it: `orca linear` exposes `relation add` and `relation
remove` and **no read verb**, and neither `list-issues` nor `issue` returns a
`relations` key. Relations are write-only. The manifest is therefore the only
machine-readable copy of the graph, and Task 6 reads its edges from there. Task 4
writes them.

**Gap accepted.** Builders' gate policy needs no configuration (spec open question
1, resolved): the runner issues no gate request, so the default `auto` passes
through. No task is needed.

**CLI contracts verified against the real tools, not assumed.** Four defects found
and fixed before handing this over:
- `list-issues --parent` does not exist; it is `--parent-id`.
- `list-issues --json` returns `{id, ok, result: {issues: [...]}}`, not a bare array.
- `worktree create` takes `--name`, not `--branch` — and offers `--linear-issue`,
  which binds the worktree to the ticket so `orca linear attach --current` and
  `save-issue --current` work inside it. Now used.
- **Relations are write-only.** `orca linear` has `relation add`/`remove` and no
  read verb; neither `list-issues` nor `issue` returns a `relations` key. This
  broke the spec's premise that the runner queries Linear for the graph. Corrected
  in both documents: edges come from the manifest, states from Linear.

Both `jq` expressions (manifest relation mapping, and the state/edge join) were run
against fixture input and produce the documented output.

**Placeholder scan.** No TBDs. Every code step carries real code. Fixtures are
concrete files, not descriptions.

**Type consistency.** `parseBreakdown` → `{epic:{title,summary}, tasks:[{title,
estimate, dependsOn, description, acceptanceCriteria}]}` is produced in Task 1 and
consumed unchanged in Tasks 2 and 4. `validateBreakdown` → `{ok, errors, order}` is
produced in Task 2 and consumed in Task 4's CLI entry. `runnable(issues,
stateNames)` with `Issue = {id, state, blockedBy}` is produced in Task 5 and
consumed by Task 6's CLI entry and `bin/run-epic.sh`'s `jq` projection, which emits
exactly those three fields.
