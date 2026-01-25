import { Hono } from "hono"
import type { DashboardStore } from "./dashboard"

export function createApi(store: DashboardStore): Hono {
  const api = new Hono()

  api.get("/health", (c) => {
    return c.json({ ok: true })
  })

  api.get("/dashboard", (c) => {
    return c.json(store.getSnapshot())
  })

  return api
}
