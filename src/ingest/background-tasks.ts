import * as fs from "node:fs"
import * as path from "node:path"
import type { OpenCodeStorageRoots, SessionMetadata, StoredMessageMeta, StoredToolPart } from "./session"
import { getMessageDir } from "./session"

export type BackgroundTaskRow = {
  id: string
  description: string
  agent: string
  status: "queued" | "running" | "completed" | "error" | "unknown"
  toolCalls: number | null
  lastTool: string | null
  timeline: string
  sessionId: string | null
}

const DESCRIPTION_MAX = 120
const AGENT_MAX = 30

function clampString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null
  const s = value.trim()
  if (!s) return null
  return s.length <= maxLen ? s : s.slice(0, maxLen)
}

function readJsonFile<T>(filePath: string): T | null {
  try {
    const content = fs.readFileSync(filePath, "utf8")
    return JSON.parse(content) as T
  } catch {
    return null
  }
}

function listJsonFiles(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json"))
  } catch {
    return []
  }
}

function readToolPartsForMessage(storage: OpenCodeStorageRoots, messageID: string): StoredToolPart[] {
  const partDir = path.join(storage.part, messageID)
  if (!fs.existsSync(partDir)) return []

  const files = listJsonFiles(partDir).sort()
  const parts: StoredToolPart[] = []
  for (const f of files) {
    const p = readJsonFile<StoredToolPart>(path.join(partDir, f))
    if (p && p.type === "tool" && typeof p.tool === "string" && p.state && typeof p.state === "object") {
      parts.push(p)
    }
  }
  return parts
}

function readRecentMessageMetas(messageDir: string, maxMessages: number): StoredMessageMeta[] {
  if (!messageDir || !fs.existsSync(messageDir)) return []
  const files = listJsonFiles(messageDir)
    .map((f) => ({
      f,
      mtime: (() => {
        try {
          return fs.statSync(path.join(messageDir, f)).mtimeMs
        } catch {
          return 0
        }
      })(),
    }))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, maxMessages)

  const metas: StoredMessageMeta[] = []
  for (const item of files) {
    const meta = readJsonFile<StoredMessageMeta>(path.join(messageDir, item.f))
    if (meta && typeof meta.id === "string") metas.push(meta)
  }
  return metas
}

export function readAllSessionMetas(sessionStorage: string): SessionMetadata[] {
  if (!fs.existsSync(sessionStorage)) return []
  const metas: SessionMetadata[] = []
  try {
    const projectDirs = fs.readdirSync(sessionStorage, { withFileTypes: true })
    for (const d of projectDirs) {
      if (!d.isDirectory()) continue
      const projectPath = path.join(sessionStorage, d.name)
      for (const file of listJsonFiles(projectPath)) {
        const meta = readJsonFile<SessionMetadata>(path.join(projectPath, file))
        if (meta && typeof meta.id === "string") metas.push(meta)
      }
    }
  } catch {
    return []
  }
  return metas
}

function findBackgroundSessionId(opts: {
  allSessionMetas: SessionMetadata[]
  parentSessionId: string
  description: string
  startedAt: number
}): string | null {
  const title = `Background: ${opts.description}`
  const windowStart = opts.startedAt
  const windowEnd = opts.startedAt + 60_000

  const candidates = opts.allSessionMetas.filter(
    (m) =>
      m.parentID === opts.parentSessionId &&
      m.title === title &&
      m.time?.created >= windowStart &&
      m.time?.created <= windowEnd
  )
  candidates.sort((a, b) => b.time.created - a.time.created)
  return candidates[0]?.id ?? null
}

function deriveBackgroundSessionStats(storage: OpenCodeStorageRoots, sessionId: string): { toolCalls: number; lastTool: string | null; lastUpdateAt: number | null } {
  const messageDir = getMessageDir(storage.message, sessionId)
  const metas = readRecentMessageMetas(messageDir, 200)
  let toolCalls = 0
  let lastTool: string | null = null
  let lastUpdateAt: number | null = null

  // Deterministic ordering by time.created then id.
  const ordered = [...metas].sort((a, b) => {
    const at = a.time?.created ?? 0
    const bt = b.time?.created ?? 0
    if (at !== bt) return at - bt
    return String(a.id).localeCompare(String(b.id))
  })

  for (const meta of ordered) {
    const created = meta.time?.created
    if (typeof created === "number") lastUpdateAt = created
    const parts = readToolPartsForMessage(storage, meta.id)
    for (const p of parts) {
      toolCalls += 1
      lastTool = p.tool
    }
  }

  return { toolCalls, lastTool, lastUpdateAt }
}

function formatTimeline(startAt: number | null, lastUpdateAt: number | null): string {
  if (!startAt && !lastUpdateAt) return ""
  const start = typeof startAt === "number" ? new Date(startAt).toISOString() : "?"
  const last = typeof lastUpdateAt === "number" ? new Date(lastUpdateAt).toISOString() : "?"
  return `${start} - ${last}`
}

export function deriveBackgroundTasks(opts: {
  storage: OpenCodeStorageRoots
  mainSessionId: string
}): BackgroundTaskRow[] {
  const messageDir = getMessageDir(opts.storage.message, opts.mainSessionId)
  const metas = readRecentMessageMetas(messageDir, 200)
  const allSessionMetas = readAllSessionMetas(opts.storage.session)

  const rows: BackgroundTaskRow[] = []

  // Iterate newest-first to cap list and keep latest tasks.
  const ordered = [...metas].sort((a, b) => (b.time?.created ?? 0) - (a.time?.created ?? 0))
  for (const meta of ordered) {
    const startedAt = meta.time?.created ?? null
    if (typeof startedAt !== "number") continue

    const parts = readToolPartsForMessage(opts.storage, meta.id)
    for (const part of parts) {
      if (part.tool !== "delegate_task") continue
      if (!part.state || typeof part.state !== "object") continue

      const input = part.state.input ?? {}
      if (typeof input !== "object" || input === null) continue

      const runInBackground = (input as Record<string, unknown>).run_in_background
      if (runInBackground !== true) continue

      const description = clampString((input as Record<string, unknown>).description, DESCRIPTION_MAX)
      if (!description) continue

      const subagentType = clampString((input as Record<string, unknown>).subagent_type, AGENT_MAX)
      const category = clampString((input as Record<string, unknown>).category, AGENT_MAX)
      const agent = subagentType ?? (category ? `sisyphus-junior (${category})` : "unknown")

      const backgroundSessionId = findBackgroundSessionId({
        allSessionMetas,
        parentSessionId: opts.mainSessionId,
        description,
        startedAt,
      })

      const stats = backgroundSessionId
        ? deriveBackgroundSessionStats(opts.storage, backgroundSessionId)
        : { toolCalls: 0, lastTool: null, lastUpdateAt: startedAt }

      // Best-effort status: if background session exists and has any tool calls, treat as running unless idle.
      let status: BackgroundTaskRow["status"] = "unknown"
      if (!backgroundSessionId) {
        status = "queued"
      } else if (stats.lastUpdateAt && Date.now() - stats.lastUpdateAt <= 15_000) {
        status = "running"
      } else if (stats.toolCalls > 0) {
        status = "completed"
      }

      rows.push({
        id: part.callID,
        description,
        agent,
        status,
        toolCalls: backgroundSessionId ? stats.toolCalls : null,
        lastTool: stats.lastTool,
        timeline: formatTimeline(startedAt, stats.lastUpdateAt),
        sessionId: backgroundSessionId,
      })
    }

    if (rows.length >= 50) break
  }

  return rows
}
