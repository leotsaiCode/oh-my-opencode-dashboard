import { describe, expect, it } from "vitest"
import { aggregateTokenUsage } from "./token-usage-core"

describe("token usage aggregateTokenUsage", () => {
  it("aggregates assistant-only token usage", () => {
    // #given
    const metas = [
      {
        id: "msg_1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: {
          input: 10,
          output: 5,
          reasoning: 2,
          cache: { read: 1, write: 3 },
        },
      },
      {
        id: "msg_2",
        role: "user",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: {
          input: 99,
          output: 99,
          reasoning: 99,
          cache: { read: 99, write: 99 },
        },
      },
    ]

    // #when
    const result = aggregateTokenUsage(metas)

    // #then
    expect(result.rows.length).toBe(1)
    expect(result.rows[0]?.model).toBe("openai/gpt-5.2")
    expect(result.totals).toEqual({
      input: 10,
      output: 5,
      reasoning: 2,
      cacheRead: 1,
      cacheWrite: 3,
      total: 21,
    })
  })

  it("defaults missing tokens to zeros", () => {
    // #given
    const metas = [
      {
        id: "msg_1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
      },
    ]

    // #when
    const result = aggregateTokenUsage(metas)

    // #then
    expect(result.rows).toEqual([
      {
        model: "openai/gpt-5.2",
        input: 0,
        output: 0,
        reasoning: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
      },
    ])
    expect(result.totals.total).toBe(0)
  })

  it("uses unknown/unknown when model is missing", () => {
    // #given
    const metas = [
      {
        id: "msg_1",
        role: "assistant",
        tokens: {
          input: 1,
          output: 2,
          reasoning: 3,
          cache: { read: 4, write: 5 },
        },
      },
    ]

    // #when
    const result = aggregateTokenUsage(metas)

    // #then
    expect(result.rows[0]?.model).toBe("unknown/unknown")
  })

  it("totals equal the sum of per-model rows", () => {
    // #given
    const metas = [
      {
        id: "msg_1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: {
          input: 1,
          output: 2,
          reasoning: 3,
          cache: { read: 4, write: 5 },
        },
      },
      {
        id: "msg_2",
        role: "assistant",
        providerID: "anthropic",
        modelID: "claude",
        tokens: {
          input: 10,
          output: 20,
          reasoning: 30,
          cache: { read: 40, write: 50 },
        },
      },
    ]

    // #when
    const result = aggregateTokenUsage(metas)

    // #then
    const summed = result.rows.reduce(
      (acc, row) => ({
        input: acc.input + row.input,
        output: acc.output + row.output,
        reasoning: acc.reasoning + row.reasoning,
        cacheRead: acc.cacheRead + row.cacheRead,
        cacheWrite: acc.cacheWrite + row.cacheWrite,
        total: acc.total + row.total,
      }),
      { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    )
    expect(result.totals).toEqual(summed)
  })

  it("dedupes by message id", () => {
    // #given
    const metas = [
      {
        id: "msg_1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: { input: 3, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
      {
        id: "msg_1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: { input: 9, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      },
    ]

    // #when
    const result = aggregateTokenUsage(metas)

    // #then
    expect(result.totals.input).toBe(3)
  })

  it("clamps invalid token values to zero", () => {
    // #given
    const metas = [
      {
        id: "msg_1",
        role: "assistant",
        providerID: "openai",
        modelID: "gpt-5.2",
        tokens: {
          input: -5,
          output: "7",
          reasoning: Number.NaN,
          cache: { read: -1, write: 3 },
        },
      },
    ]

    // #when
    const result = aggregateTokenUsage(metas)

    // #then
    expect(result.rows[0]).toEqual({
      model: "openai/gpt-5.2",
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 3,
      total: 3,
    })
  })
})
