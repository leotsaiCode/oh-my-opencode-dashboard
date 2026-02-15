import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Database as BunDatabase } from "bun:sqlite"
import { Hono } from "hono"
import { describe, expect, it } from "vitest"
import { createApi } from "./api"
import { createDashboardStore } from "./dashboard"
import type { StorageBackend } from "../ingest/storage-backend"

function makeFixtureRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "omo-api-smoke-"))
}

function makeStorageRoot(root: string): string {
  const storageRoot = path.join(root, "opencode", "storage")
  fs.mkdirSync(path.join(storageRoot, "session"), { recursive: true })
  fs.mkdirSync(path.join(storageRoot, "message"), { recursive: true })
  fs.mkdirSync(path.join(storageRoot, "part"), { recursive: true })
  return storageRoot
}

function writeFileFixture(opts: {
  root: string
  projectRoot: string
  sessionId: string
  messageId: string
}): { storageRoot: string } {
  const storageRoot = makeStorageRoot(opts.root)
  const projectID = "proj_smoke"

  const sessionDir = path.join(storageRoot, "session", projectID)
  fs.mkdirSync(sessionDir, { recursive: true })
  fs.writeFileSync(
    path.join(sessionDir, `${opts.sessionId}.json`),
    JSON.stringify({
      id: opts.sessionId,
      projectID,
      directory: opts.projectRoot,
      time: { created: 1000, updated: 1000 },
    }),
    "utf8",
  )

  const messageDir = path.join(storageRoot, "message", opts.sessionId)
  fs.mkdirSync(messageDir, { recursive: true })
  fs.writeFileSync(
    path.join(messageDir, `${opts.messageId}.json`),
    JSON.stringify({
      id: opts.messageId,
      sessionID: opts.sessionId,
      role: "assistant",
      agent: "sisyphus",
      providerID: "openai",
      modelID: "gpt-4o",
      time: { created: 1000 },
    }),
    "utf8",
  )

  const partDir = path.join(storageRoot, "part", opts.messageId)
  fs.mkdirSync(partDir, { recursive: true })
  fs.writeFileSync(
    path.join(partDir, "part_1.json"),
    JSON.stringify({
      id: "part_1",
      sessionID: opts.sessionId,
      messageID: opts.messageId,
      type: "tool",
      callID: "call_1",
      tool: "bash",
      state: { status: "completed", input: { command: "pwd" } },
    }),
    "utf8",
  )

  return { storageRoot }
}

function writeSqliteFixture(opts: {
  root: string
  projectRoot: string
  sessionId: string
  messageId: string
}): { storageRoot: string; sqlitePath: string } {
  const storageRoot = makeStorageRoot(opts.root)
  const sqlitePath = path.join(opts.root, "opencode", "opencode.db")
  fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })

  const db = new BunDatabase(sqlitePath)
  db.run("CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)")
  db.run("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.run("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")

  db.run(
    "INSERT INTO session (id, project_id, parent_id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [opts.sessionId, "proj_sqlite", null, opts.projectRoot, "SQLite Session", 1000, 1000],
  )
  db.run(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
    [
      opts.messageId,
      opts.sessionId,
      1000,
      1000,
      JSON.stringify({
        role: "assistant",
        agent: "sisyphus",
        providerID: "openai",
        modelID: "gpt-4o",
        time: { created: 1000 },
      }),
    ],
  )
  db.run(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
    [
      "part_sqlite_1",
      opts.messageId,
      opts.sessionId,
      1001,
      1001,
      JSON.stringify({
        type: "tool",
        callID: "call_sqlite_1",
        tool: "glob",
        state: { status: "completed", input: { pattern: "*.ts" } },
      }),
    ],
  )
  db.close()

  return { storageRoot, sqlitePath }
}

function startServer(opts: {
  storageRoot: string
  projectRoot: string
  storageBackend?: StorageBackend
}) {
  const store = createDashboardStore({
    projectRoot: opts.projectRoot,
    storageRoot: opts.storageRoot,
    storageBackend: opts.storageBackend,
    watch: false,
    pollIntervalMs: 10,
  })
  const app = new Hono()
  app.route(
    "/api",
    createApi({
      store,
      storageRoot: opts.storageRoot,
      projectRoot: opts.projectRoot,
      storageBackend: opts.storageBackend,
    }),
  )
  const server = Bun.serve({
    fetch: app.fetch,
    hostname: "127.0.0.1",
    port: 0,
  })

  return {
    baseUrl: `http://127.0.0.1:${server.port}/api`,
    stop: () => server.stop(true),
  }
}

describe("API smoke", () => {
  it("serves health/dashboard/tool-calls with file backend", async () => {
    const root = makeFixtureRoot()
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-project-file-smoke-"))
    const sessionId = "ses_file_smoke"
    const messageId = "msg_file_smoke"

    try {
      const { storageRoot } = writeFileFixture({ root, projectRoot, sessionId, messageId })
      const server = startServer({ storageRoot, projectRoot })
      try {
        const health = await fetch(`${server.baseUrl}/health`)
        expect(health.status).toBe(200)
        expect(await health.json()).toEqual({ ok: true })

        const dashboard = await fetch(`${server.baseUrl}/dashboard`)
        expect(dashboard.status).toBe(200)
        const dashboardBody = await dashboard.json() as Record<string, unknown>
        expect(dashboardBody).toHaveProperty("mainSession")
        expect(dashboardBody).toHaveProperty("planProgress")
        expect(dashboardBody).toHaveProperty("timeSeries")

        const calls = await fetch(`${server.baseUrl}/tool-calls/${sessionId}`)
        expect(calls.status).toBe(200)
        const callsBody = await calls.json() as { ok: boolean; toolCalls: Array<{ tool: string }> }
        expect(callsBody.ok).toBe(true)
        expect(callsBody.toolCalls.length).toBeGreaterThan(0)
      } finally {
        server.stop()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("serves health/dashboard/tool-calls with sqlite backend", async () => {
    const root = makeFixtureRoot()
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-project-sqlite-smoke-"))
    const sessionId = "ses_sqlite_smoke"
    const messageId = "msg_sqlite_smoke"

    try {
      const { storageRoot, sqlitePath } = writeSqliteFixture({ root, projectRoot, sessionId, messageId })
      const storageBackend: StorageBackend = {
        kind: "sqlite",
        dataDir: root,
        sqlitePath,
      }

      const server = startServer({ storageRoot, projectRoot, storageBackend })
      try {
        const health = await fetch(`${server.baseUrl}/health`)
        expect(health.status).toBe(200)
        expect(await health.json()).toEqual({ ok: true })

        const dashboard = await fetch(`${server.baseUrl}/dashboard`)
        expect(dashboard.status).toBe(200)
        const dashboardBody = await dashboard.json() as Record<string, unknown>
        expect(dashboardBody).toHaveProperty("mainSession")
        expect(dashboardBody).toHaveProperty("planProgress")
        expect(dashboardBody).toHaveProperty("timeSeries")

        const calls = await fetch(`${server.baseUrl}/tool-calls/${sessionId}`)
        expect(calls.status).toBe(200)
        const callsBody = await calls.json() as { ok: boolean; toolCalls: Array<{ tool: string }> }
        expect(callsBody.ok).toBe(true)
        expect(callsBody.toolCalls.length).toBeGreaterThan(0)
      } finally {
        server.stop()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })

  it("falls back to files when sqlite reads fail", async () => {
    const root = makeFixtureRoot()
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "omo-project-fallback-smoke-"))
    const sessionId = "ses_fallback_smoke"
    const messageId = "msg_fallback_smoke"

    try {
      const { storageRoot } = writeFileFixture({ root, projectRoot, sessionId, messageId })
      const sqlitePath = path.join(root, "opencode", "opencode.db")
      fs.mkdirSync(path.dirname(sqlitePath), { recursive: true })
      fs.writeFileSync(sqlitePath, "not sqlite", "utf8")
      const storageBackend: StorageBackend = {
        kind: "sqlite",
        dataDir: root,
        sqlitePath,
      }

      const server = startServer({ storageRoot, projectRoot, storageBackend })
      try {
        const dashboard = await fetch(`${server.baseUrl}/dashboard`)
        expect(dashboard.status).toBe(200)
        const dashboardBody = await dashboard.json() as { mainSession?: { sessionId?: string | null } }
        expect(dashboardBody.mainSession?.sessionId).toBe(sessionId)

        const calls = await fetch(`${server.baseUrl}/tool-calls/${sessionId}`)
        expect(calls.status).toBe(200)
        const callsBody = await calls.json() as { ok: boolean; toolCalls: Array<{ tool: string }> }
        expect(callsBody.ok).toBe(true)
        expect(callsBody.toolCalls.length).toBeGreaterThan(0)
      } finally {
        server.stop()
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
      fs.rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
