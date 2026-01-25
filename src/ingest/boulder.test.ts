import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { readBoulderState, readPlanProgress } from "./boulder"

function mkProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-project-"))
  fs.mkdirSync(path.join(root, ".sisyphus"), { recursive: true })
  return root
}

describe("readBoulderState", () => {
  it("returns null if boulder.json is missing", () => {
    const projectRoot = mkProjectRoot()
    expect(readBoulderState(projectRoot)).toBe(null)
  })

  it("returns null if boulder.json is invalid JSON", () => {
    const projectRoot = mkProjectRoot()
    fs.writeFileSync(path.join(projectRoot, ".sisyphus", "boulder.json"), "{nope", "utf8")
    expect(readBoulderState(projectRoot)).toBe(null)
  })
})

describe("readPlanProgress", () => {
  it("computes checkbox progress for an existing plan", () => {
    const projectRoot = mkProjectRoot()
    const planPath = path.join(projectRoot, ".sisyphus", "plans", "plan.md")
    fs.mkdirSync(path.dirname(planPath), { recursive: true })
    fs.writeFileSync(
      planPath,
      ["- [ ] Task 1", "- [x] Task 2", "- [X] Task 3"].join("\n"),
      "utf8"
    )

    const progress = readPlanProgress(projectRoot, planPath)
    expect(progress.missing).toBe(false)
    expect(progress.total).toBe(3)
    expect(progress.completed).toBe(2)
    expect(progress.isComplete).toBe(false)
  })

  it("treats missing plan file as not started", () => {
    const projectRoot = mkProjectRoot()
    const planPath = path.join(projectRoot, ".sisyphus", "plans", "missing.md")
    const progress = readPlanProgress(projectRoot, planPath)
    expect(progress.missing).toBe(true)
    expect(progress.total).toBe(0)
    expect(progress.completed).toBe(0)
    expect(progress.isComplete).toBe(false)
  })

  it("treats a plan with zero checkboxes as complete", () => {
    const projectRoot = mkProjectRoot()
    const planPath = path.join(projectRoot, ".sisyphus", "plans", "empty.md")
    fs.mkdirSync(path.dirname(planPath), { recursive: true })
    fs.writeFileSync(planPath, "# No tasks\nJust text", "utf8")

    const progress = readPlanProgress(projectRoot, planPath)
    expect(progress.missing).toBe(false)
    expect(progress.total).toBe(0)
    expect(progress.completed).toBe(0)
    expect(progress.isComplete).toBe(true)
  })

  it("rejects active_plan paths outside projectRoot", () => {
    const projectRoot = mkProjectRoot()
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "omo-outside-"))
    const outsidePlan = path.join(outside, "plan.md")
    fs.writeFileSync(outsidePlan, "- [x] outside", "utf8")

    const progress = readPlanProgress(projectRoot, outsidePlan)
    expect(progress.missing).toBe(true)
    expect(progress.isComplete).toBe(false)
  })
})
