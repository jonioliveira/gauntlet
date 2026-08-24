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
