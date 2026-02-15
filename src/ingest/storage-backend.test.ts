import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { describe, expect, it } from "vitest"
import {
  readMainSessionMetasSqlite,
  readRecentMessageMetasSqlite,
  readToolPartsForMessagesSqlite,
  selectStorageBackend,
} from "./storage-backend"

function makeDataDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omo-dashboard-storage-backend-"))
}

function makeLegacyStorage(dataDir: string): void {
  fs.mkdirSync(path.join(dataDir, "opencode", "storage"), { recursive: true })
}

function makeSqliteDb(dataDir: string, opts?: { includePartTable?: boolean }): string {
  const sqlitePath = path.join(dataDir, "opencode", "opencode.db")
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })

  const db = new BunDatabase(sqlitePath)
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY)")
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY)")
  if (opts?.includePartTable !== false) {
    db.run("CREATE TABLE part (id TEXT PRIMARY KEY)")
  }
  db.close()

  return sqlitePath
}

function makeIngestSqliteDb(dataDir: string): string {
  const sqlitePath = path.join(dataDir, "opencode", "opencode.db")
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })

  const db = new BunDatabase(sqlitePath)
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.close()

  return sqlitePath
}

describe("selectStorageBackend", () => {
  it("selects files when only legacy storage exists", () => {
    const dataDir = makeDataDir()
    makeLegacyStorage(dataDir)

    const selected = selectStorageBackend({ dataDir })

    expect(selected.kind).toBe("files")
    if (selected.kind === "files") {
      expect(selected.storageRoot).toBe(path.join(dataDir, "opencode", "storage"))
    }
  })

  it("selects sqlite when sqlite exists and has required tables", () => {
    const dataDir = makeDataDir()
    const sqlitePath = makeSqliteDb(dataDir)

    const selected = selectStorageBackend({ dataDir })

    expect(selected.kind).toBe("sqlite")
    if (selected.kind === "sqlite") {
      expect(selected.sqlitePath).toBe(sqlitePath)
    }
  })

  it("selects files when sqlite is missing a required table and legacy exists", () => {
    const dataDir = makeDataDir()
    makeLegacyStorage(dataDir)
    makeSqliteDb(dataDir, { includePartTable: false })

    const selected = selectStorageBackend({ dataDir })

    expect(selected.kind).toBe("files")
  })

  it("selects files when sqlite is corrupt or unopenable and legacy exists", () => {
    const dataDir = makeDataDir()
    makeLegacyStorage(dataDir)
    const sqlitePath = path.join(dataDir, "opencode", "opencode.db")
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
    fs.writeFileSync(sqlitePath, "not a sqlite database", "utf8")

    const selected = selectStorageBackend({ dataDir })

    expect(selected.kind).toBe("files")
  })
})

describe("sqlite ingest readers", () => {
  it("reads session metas sorted by updated desc and directory filter", () => {
    const dataDir = makeDataDir()
    const sqlitePath = makeIngestSqliteDb(dataDir)
    const db = new BunDatabase(sqlitePath)

    db.run(
      "INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["s1", "p1", null, "/repo/a", "Session A", 100, 300],
    )
    db.run(
      "INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["s2", "p2", null, "/repo/b", "Session B", 200, 500],
    )
    db.run(
      "INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ["s3-child", "p2", "s2", "/repo/b", "Child", 250, 550],
    )
    db.close()

    const all = readMainSessionMetasSqlite({ sqlitePath })
    expect(all.ok).toBe(true)
    if (!all.ok) return
    expect(all.rows.map((row) => row.id)).toEqual(["s2", "s1"])

    const filtered = readMainSessionMetasSqlite({ sqlitePath, directoryFilter: "/repo/a" })
    expect(filtered.ok).toBe(true)
    if (!filtered.ok) return
    expect(filtered.rows.map((row) => row.id)).toEqual(["s1"])
  })

  it("reads message metas with json rehydration and skips bad json rows", () => {
    const dataDir = makeDataDir()
    const sqlitePath = makeIngestSqliteDb(dataDir)
    const db = new BunDatabase(sqlitePath)

    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      [
        "m-old",
        "s1",
        10,
        11,
        JSON.stringify({
          id: "ignored-message-id",
          sessionID: "ignored-session-id",
          role: "assistant",
          time: { created: 10, completed: 12 },
          agent: "oracle",
          providerID: "openai",
          modelID: "gpt-5.3",
          tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 3, write: 1 } },
        }),
      ],
    )
    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ["m-fallback", "s1", 20, 21, JSON.stringify({ role: "assistant", time: {}, agent: "build" })],
    )
    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ["m-new", "s1", 30, 31, JSON.stringify({ role: "user", time: { created: 30 } })],
    )
    db.run(
      "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
      ["m-bad", "s1", 40, 41, "{bad json"],
    )
    db.close()

    const result = readRecentMessageMetasSqlite({ sqlitePath, sessionId: "s1", limit: 10 })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.rows.map((row) => row.id)).toEqual(["m-new", "m-fallback", "m-old"])
    expect(result.rows[2]).toMatchObject({
      id: "m-old",
      sessionID: "s1",
      role: "assistant",
      agent: "oracle",
      time: { created: 10, completed: 12 },
      providerID: "openai",
      modelID: "gpt-5.3",
      tokens: { input: 4, output: 2, reasoning: 1, cache: { read: 3, write: 1 } },
    })
  })

  it("reads tool parts with json rehydration and skips bad rows", () => {
    const dataDir = makeDataDir()
    const sqlitePath = makeIngestSqliteDb(dataDir)
    const db = new BunDatabase(sqlitePath)

    db.run(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "p1",
        "m1",
        "s1",
        1,
        2,
        JSON.stringify({
          id: "ignored-part-id",
          sessionID: "ignored-session-id",
          messageID: "ignored-message-id",
          type: "tool",
          callID: "c1",
          tool: "bash",
          state: {
            status: "completed",
            input: { command: "pwd" },
            output: "ok",
            time: { start: 1, end: 2 },
          },
        }),
      ],
    )
    db.run(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      ["p2", "m1", "s1", 3, 4, "{bad json"],
    )
    db.run(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      ["p3", "m2", "s1", 5, 6, JSON.stringify({ type: "text", text: "hi" })],
    )
    db.run(
      "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
      [
        "p4",
        "m2",
        "s1",
        7,
        8,
        JSON.stringify({ type: "tool", callID: "c2", tool: "glob", state: { status: "running", input: { pattern: "*.ts" }, time: { start: 7 } } }),
      ],
    )
    db.close()

    const result = readToolPartsForMessagesSqlite({ sqlitePath, messageIds: ["m1", "m2"] })
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.rows.map((row) => row.id)).toEqual(["p1", "p4"])
    expect(result.rows[0]).toMatchObject({
      id: "p1",
      sessionID: "s1",
      messageID: "m1",
      type: "tool",
      callID: "c1",
      tool: "bash",
    })
  })

  it("surfaces corrupt sqlite db as unusable", () => {
    const dataDir = makeDataDir()
    const sqlitePath = path.join(dataDir, "opencode", "opencode.db")
    fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
    fs.writeFileSync(sqlitePath, "not sqlite", "utf8")

    const result = readMainSessionMetasSqlite({ sqlitePath })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("db_corrupt")
  })
})
