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
