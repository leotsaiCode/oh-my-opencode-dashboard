import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { deriveBackgroundTasks } from "./background-tasks"
import { getStorageRoots } from "./session"

function mkStorageRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omo-storage-"))
  fs.mkdirSync(path.join(root, "session"), { recursive: true })
  fs.mkdirSync(path.join(root, "message"), { recursive: true })
  fs.mkdirSync(path.join(root, "part"), { recursive: true })
  return root
}

describe("deriveBackgroundTasks", () => {
  it("extracts delegate_task background calls and correlates child sessions", () => {
    const storageRoot = mkStorageRoot()
    const storage = getStorageRoots(storageRoot)
    const mainSessionId = "ses_main"

    // Main session message + tool part
    const msgDir = path.join(storage.message, mainSessionId)
    fs.mkdirSync(msgDir, { recursive: true })
    const messageID = "msg_1"
    fs.writeFileSync(
      path.join(msgDir, `${messageID}.json`),
      JSON.stringify({
        id: messageID,
        sessionID: mainSessionId,
        role: "assistant",
        time: { created: 1000 },
      }),
      "utf8"
    )
    const partDir = path.join(storage.part, messageID)
    fs.mkdirSync(partDir, { recursive: true })
    fs.writeFileSync(
      path.join(partDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: mainSessionId,
        messageID,
        type: "tool",
        callID: "call_1",
        tool: "delegate_task",
        state: {
          status: "completed",
          input: {
            run_in_background: true,
            description: "Scan repo",
            subagent_type: "explore",
            prompt: "SECRET",
          },
        },
      }),
      "utf8"
    )

    // Child session metadata that should be correlated
    const projectID = "proj"
    const sessDir = path.join(storage.session, projectID)
    fs.mkdirSync(sessDir, { recursive: true })
    fs.writeFileSync(
      path.join(sessDir, "ses_child.json"),
      JSON.stringify({
        id: "ses_child",
        projectID,
        directory: "/tmp/project",
        title: "Background: Scan repo",
        parentID: mainSessionId,
        time: { created: 1500, updated: 1500 },
      }),
      "utf8"
    )

    // Background session message with a tool call
    const childMsgDir = path.join(storage.message, "ses_child")
    fs.mkdirSync(childMsgDir, { recursive: true })
    const childMsgId = "msg_child"
    fs.writeFileSync(
      path.join(childMsgDir, `${childMsgId}.json`),
      JSON.stringify({
        id: childMsgId,
        sessionID: "ses_child",
        role: "assistant",
        time: { created: 2000 },
      }),
      "utf8"
    )
    const childPartDir = path.join(storage.part, childMsgId)
    fs.mkdirSync(childPartDir, { recursive: true })
    fs.writeFileSync(
      path.join(childPartDir, "part_1.json"),
      JSON.stringify({
        id: "part_1",
        sessionID: "ses_child",
        messageID: childMsgId,
        type: "tool",
        callID: "call_x",
        tool: "grep",
        state: { status: "completed", input: {} },
      }),
      "utf8"
    )

    const rows = deriveBackgroundTasks({ storage, mainSessionId })
    expect(rows.length).toBe(1)
    expect(rows[0].description).toBe("Scan repo")
    expect(rows[0].agent).toBe("explore")
    expect(rows[0].sessionId).toBe("ses_child")
    expect(rows[0].toolCalls).toBe(1)
    expect(rows[0].lastTool).toBe("grep")

    // Ensure no sensitive keys leak
    expect((rows[0] as unknown as Record<string, unknown>).prompt).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).input).toBeUndefined()
    expect((rows[0] as unknown as Record<string, unknown>).state).toBeUndefined()
  })
})
