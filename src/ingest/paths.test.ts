import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { assertAllowedPath, getOpenCodeStorageDir } from "./paths"

describe("getOpenCodeStorageDir", () => {
  it("uses XDG_DATA_HOME when set", () => {
    const got = getOpenCodeStorageDir({ XDG_DATA_HOME: "/tmp/xdg" }, "/home/test")
    expect(got).toBe("/tmp/xdg/opencode/storage")
  })

  it("falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
    const got = getOpenCodeStorageDir({}, "/home/test")
    expect(got).toBe("/home/test/.local/share/opencode/storage")
  })
})

describe("assertAllowedPath", () => {
  it("allows paths inside allowed roots", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-dashboard-"))
    const allowed = path.join(base, "allowed")
    fs.mkdirSync(allowed, { recursive: true })

    const resolved = assertAllowedPath({
      candidatePath: path.join(allowed, "file.txt"),
      allowedRoots: [allowed],
    })

    expect(resolved).toContain("/allowed/")
  })

  it("rejects traversal outside allowed root", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-dashboard-"))
    const allowed = path.join(base, "allowed")
    fs.mkdirSync(allowed, { recursive: true })
    const outside = path.join(base, "outside.txt")

    expect(() =>
      assertAllowedPath({
        candidatePath: outside,
        allowedRoots: [allowed],
      })
    ).toThrow("Access denied")
  })

  it("rejects symlink escapes", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-dashboard-"))
    const allowed = path.join(base, "allowed")
    const outsideDir = path.join(base, "outside")
    fs.mkdirSync(allowed, { recursive: true })
    fs.mkdirSync(outsideDir, { recursive: true })

    const outsideFile = path.join(outsideDir, "secret.txt")
    fs.writeFileSync(outsideFile, "nope", "utf8")

    const linkPath = path.join(allowed, "link.txt")
    fs.symlinkSync(outsideFile, linkPath)

    expect(() =>
      assertAllowedPath({
        candidatePath: linkPath,
        allowedRoots: [allowed],
      })
    ).toThrow("Access denied")
  })

  it("allows a non-existent file path if its nearest existing parent is inside", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omo-dashboard-"))
    const allowed = path.join(base, "allowed")
    fs.mkdirSync(allowed, { recursive: true })

    const candidate = path.join(allowed, "missing", "file.txt")
    const resolved = assertAllowedPath({
      candidatePath: candidate,
      allowedRoots: [allowed],
    })

    expect(resolved).toContain("/allowed/")
    expect(resolved.endsWith(path.join("missing", "file.txt"))).toBe(true)
  })
})
