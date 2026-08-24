import { test, expect } from "bun:test"
import { lensesFor } from "../src/core.js"

const L = ["a", "b", "c", "d", "e"].map(name => ({ name }))
const names = xs => xs.map(x => x.name)

test("rotates a window of size K across rounds", () => {
  expect(names(lensesFor(L, 3, 0, false))).toEqual(["a", "b", "c"])
  expect(names(lensesFor(L, 3, 1, false))).toEqual(["d", "e", "a"])
  expect(names(lensesFor(L, 3, 2, false))).toEqual(["b", "c", "d"])
})

test("every lens is seen at least once across two consecutive rounds", () => {
  for (let r = 0; r < 10; r++) {
    const pair = new Set([
      ...names(lensesFor(L, 3, r, false)),
      ...names(lensesFor(L, 3, r + 1, false)),
    ])
    expect(pair.size).toBe(L.length)
  }
})

test("full=true returns every lens regardless of round", () => {
  expect(names(lensesFor(L, 3, 1, true))).toEqual(names(L))
})

test("K >= lens count returns every lens", () => {
  expect(names(lensesFor(L, 5, 1, false))).toEqual(names(L))
  expect(names(lensesFor(L, 99, 3, false))).toEqual(names(L))
})

test("null perRound means no rotation", () => {
  expect(names(lensesFor(L, null, 2, false))).toEqual(names(L))
})

import { freshIssues, advance, shouldContinue } from "../src/core.js"

const issue = (id, severity = "major") => ({ id, severity, claim: `claim ${id}` })

test("freshIssues drops issues already seen", () => {
  const seen = new Set(["x"])
  const got = freshIssues([{ issues: [issue("x"), issue("y")] }], seen)
  expect(got.map(i => i.id)).toEqual(["y"])
})

test("freshIssues dedups within the same round", () => {
  const got = freshIssues(
    [{ issues: [issue("dup")] }, { issues: [issue("dup")] }],
    new Set()
  )
  expect(got.map(i => i.id)).toEqual(["dup"])
})

test("freshIssues skips issues with no id and tolerates empty results", () => {
  const got = freshIssues(
    [{ issues: [{ severity: "minor", claim: "no id" }] }, { issues: [] }, {}],
    new Set()
  )
  expect(got).toEqual([])
})

test("advance on a clean round increments dry and escalates to full", () => {
  expect(advance({ dry: 0, round: 3, full: false }, 0))
    .toEqual({ dry: 1, round: 4, full: true })
})

test("advance on a productive round resets dry and resumes rotating", () => {
  expect(advance({ dry: 1, round: 4, full: true }, 2))
    .toEqual({ dry: 0, round: 5, full: false })
})

test("advance never mutates the state it is given", () => {
  const before = { dry: 0, round: 0, full: false }
  advance(before, 0)
  expect(before).toEqual({ dry: 0, round: 0, full: false })
})

const T = { dryRounds: 2, maxRounds: 5, budgetFloor: 50000 }

test("shouldContinue is true mid-run", () => {
  expect(shouldContinue({ dry: 1, round: 2, full: false }, T, null)).toBe(true)
})

test("shouldContinue stops once dryRounds is reached", () => {
  expect(shouldContinue({ dry: 2, round: 2, full: true }, T, null)).toBe(false)
})

test("shouldContinue stops at maxRounds", () => {
  expect(shouldContinue({ dry: 0, round: 5, full: false }, T, null)).toBe(false)
})

test("shouldContinue stops when budget falls to the floor", () => {
  expect(shouldContinue({ dry: 0, round: 1, full: false }, T, 50000)).toBe(false)
  expect(shouldContinue({ dry: 0, round: 1, full: false }, T, 50001)).toBe(true)
})

test("shouldContinue ignores budget when there is no target", () => {
  expect(shouldContinue({ dry: 0, round: 1, full: false }, T, null)).toBe(true)
})
