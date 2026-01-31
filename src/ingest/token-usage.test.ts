import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { deriveTokenUsage } from "./token-usage"
import { getStorageRoots } from "./session"

function mkStorageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-storage-"))
  fs.mkdirSync(path.join(root, "session"), { recursive: true })
  fs.mkdirSync(path.join(root, "message"), { recursive: true })
  fs.mkdirSync(path.join(root, "part"), { recursive: true })
  return root
}

function writeMessageMeta(opts: {
  messageDir: string
  messageId: string
  meta: Record<string, unknown>
}): void {
  fs.mkdirSync(opts.messageDir, { recursive: true })
  fs.writeFileSync(
    path.join(opts.messageDir, `${opts.messageId}.json`),
    JSON.stringify({ id: opts.messageId, sessionID: "", role: "assistant", ...opts.meta }),
    "utf8"
  )
}

describe("deriveTokenUsage token usage", () => {
  it("aggregates token usage across main + background sessions", () => {
    // #given
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"
    const backgroundSessionId = "ses_bg"

    writeMessageMeta({
      messageDir: path.join(storage.message, mainSessionId),
      messageId: "msg_main",
      meta: {
        sessionID: mainSessionId,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: { input: 2, output: 1, reasoning: 1, cache: { read: 0, write: 0 } },
      },
    })

    writeMessageMeta({
      messageDir: path.join(storage.message, backgroundSessionId),
      messageId: "msg_bg",
      meta: {
        sessionID: backgroundSessionId,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: { input: 3, output: 0, reasoning: 0, cache: { read: 1, write: 0 } },
      },
    })

    // #when
    const result = deriveTokenUsage({
      storage,
      mainSessionId,
      backgroundSessionIds: [backgroundSessionId],
    })

    // #then
    expect(result.rows.length).toBe(1)
    expect(result.rows[0]).toEqual({
      model: "openai/gpt-5.2",
      input: 5,
      output: 1,
      reasoning: 1,
      cacheRead: 1,
      cacheWrite: 0,
      total: 8,
    })
    expect(result.totals).toEqual({
      input: 5,
      output: 1,
      reasoning: 1,
      cacheRead: 1,
      cacheWrite: 0,
      total: 8,
    })
  })

  it("returns empty payload when message directories are missing", () => {
    // #given
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)

    // #when
    const result = deriveTokenUsage({
      storage,
      mainSessionId: "ses_missing",
      backgroundSessionIds: ["ses_other"],
    })

    // #then
    expect(result.rows).toEqual([])
    expect(result.totals).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    })
  })

  it("dedupes message ids across sessions and ignores empty ids", () => {
    // #given
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"
    const backgroundSessionId = "ses_bg"

    writeMessageMeta({
      messageDir: path.join(storage.message, mainSessionId),
      messageId: "msg_dupe",
      meta: {
        sessionID: mainSessionId,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: { input: 4, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })

    writeMessageMeta({
      messageDir: path.join(storage.message, backgroundSessionId),
      messageId: "msg_dupe",
      meta: {
        sessionID: backgroundSessionId,
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: { input: 9, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    })

    // #when
    const result = deriveTokenUsage({
      storage,
      mainSessionId,
      backgroundSessionIds: [backgroundSessionId, "", "  ", null],
    })

    // #then
    expect(result.totals.input).toBe(4)
  })
})
