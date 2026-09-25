import { describe, expect, test } from "bun:test"
import {
  __test as t,
  evaluate,
  formatMiss,
  formatStatus,
  missNotice,
  warmNotice,
  getCacheWarmingDelayMs,
  lifetimeSeconds,
  MissDetector,
  price,
  type Rate,
  type Tokens,
  Warmer,
} from "../index.ts"

// Opus 5.5 list prices, $/M tokens.
const OPUS: Rate[] = [{ input: 4, output: 20, cache: { read: 0.2, write: 5 } }]
const TIERED: Rate[] = [
  { input: 3, output: 15, cache: { read: 0.3, write: 3.75 } },
  { tier: { type: "context", size: 200_000 }, input: 6, output: 22.5, cache: { read: 0.6, write: 7.5 } },
]

describe("policy (pi parity)", () => {
  test("refresh at 90% of the TTL with at least 10s margin", () => {
    expect(getCacheWarmingDelayMs(300_000)).toBe(270_000)
    expect(getCacheWarmingDelayMs(3_600_000)).toBe(3_240_000)
    expect(getCacheWarmingDelayMs(60_000)).toBe(50_000)
    expect(getCacheWarmingDelayMs(12_000)).toBe(2_000)
    expect(getCacheWarmingDelayMs(10_000)).toBeUndefined()
  })

  test("streaming warms almost always; idle only for large prompts", () => {
    expect(evaluate(OPUS, 11_000, "streaming").action).toBe("warm")
    expect(evaluate(OPUS, 10_000, "streaming").action).toBe("stop")
    expect(evaluate(OPUS, 100_000, "idle").action).toBe("warm")
    expect(evaluate(OPUS, 90_000, "idle").action).toBe("stop")
    const d = evaluate(OPUS, 100_000, "idle")
    expect(d.warmCost).toBeCloseTo(0.02 + 20 / 1e6, 9)
    expect(d.missCost).toBeCloseTo(0.5 - 0.02, 9)
    expect(d.expectedSavings).toBeCloseTo(0.15 * 0.48 - 0.02002, 9)
  })

  test("unknown prices or prompt size stop warming", () => {
    const none = evaluate(undefined, 100_000, "streaming")
    expect(none.economicsAvailable).toBe(false)
    expect(none.action).toBe("stop")
    expect(evaluate(OPUS, 0, "streaming").economicsAvailable).toBe(false)
  })

  test("context tiers price the whole request, like OpenCode", () => {
    expect(price(TIERED, { cacheRead: 100_000 })).toBeCloseTo(0.03, 9)
    expect(price(TIERED, { cacheRead: 300_000 })).toBeCloseTo(0.18, 9)
  })

  test("lifetimes: direct Anthropic built in, overrides merge per tier", () => {
    const m = { providerID: "anthropic", id: "claude-opus-5-5" }
    expect(lifetimeSeconds({}, m, "short")).toBe(300)
    expect(lifetimeSeconds({}, m, "long")).toBe(3600)
    expect(lifetimeSeconds({}, { providerID: "openrouter", id: "x" }, "short")).toBeUndefined()
    expect(lifetimeSeconds({ "anthropic/claude-opus-5-5": { short: 40 } }, m, "short")).toBe(40)
    expect(lifetimeSeconds({ "anthropic/claude-opus-5-5": { short: 40 } }, m, "long")).toBe(3600)
    expect(lifetimeSeconds({ openrouter: { short: 300 } }, { providerID: "openrouter", id: "x" }, "short")).toBe(300)
  })
})

describe("anthropic replay", () => {
  const base = {
    model: "claude-opus-5-5",
    max_tokens: 32000,
    stream: true,
    thinking: { type: "adaptive" },
    system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "hi", cache_control: { type: "ephemeral" } }] }],
  }

  test("only max_tokens changes", () => {
    const r = t.anthropicReplay(JSON.stringify(base))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(JSON.parse(r.body)).toEqual({ ...base, max_tokens: 1 })
    expect(r.retention).toBe("short")
  })

  test("retention is the shortest breakpoint", () => {
    const long = { type: "ephemeral", ttl: "1h" }
    expect(t.requestRetention({ a: { cache_control: long }, b: [{ cache_control: long }] })).toBe("long")
    expect(t.requestRetention({ a: { cache_control: long }, b: [{ cache_control: { type: "ephemeral" } }] })).toBe("short")
    expect(t.requestRetention({ a: 1 })).toBeUndefined()
  })

  test("budget thinking and uncached requests are not replayed", () => {
    const budget = t.anthropicReplay(JSON.stringify({ ...base, thinking: { type: "enabled", budget_tokens: 4000 } }))
    expect(budget).toEqual({ ok: false, reason: "request cannot be replayed safely" })
    const uncached = t.anthropicReplay(JSON.stringify({ model: "x", max_tokens: 5, messages: [{ role: "user", content: "hi" }] }))
    expect(uncached).toEqual({ ok: false, reason: "request disabled prompt caching" })
  })

  test("billing hash matches what opencode-anth would send for the replay", async () => {
    let anth: any
    try {
      anth = (await import("../../opencode-anth/index.ts")).__test
    } catch {
      console.warn("opencode-anth checkout not found; skipping")
      return
    }
    const ids = { device: "d".repeat(64), account: "acct", session: "sess" }
    const request = structuredClone(base)
    const sent = anth.rewriteBody(structuredClone(request), ids, anth.buildToolMap(request.tools))
    const expected = anth.rewriteBody({ ...structuredClone(request), max_tokens: 1 }, ids, anth.buildToolMap(request.tools))
    const r = t.anthropicReplay(sent)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.body).toBe(expected)
    expect(sent).toMatch(/cch=[0-9a-f]{5};/)
    expect(sent).not.toBe(expected)
  })
})

describe("usage parsing", () => {
  const sse = (events: any[]) =>
    new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    })
  const start = { type: "message_start", message: { usage: { input_tokens: 3, cache_read_input_tokens: 90_000, cache_creation_input_tokens: 12, output_tokens: 1 } } }

  test("streamed and JSON responses", async () => {
    expect(await t.readAnthropicUsage(sse([start, { type: "message_delta", usage: { output_tokens: 1 } }]))).toEqual({
      input: 3,
      output: 1,
      cacheRead: 90_000,
      cacheWrite: 12,
    })
    const json = Response.json({ usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 7 } })
    expect(await t.readAnthropicUsage(json)).toEqual({ input: 5, output: 1, cacheRead: 7, cacheWrite: 0 })
  })

  test("prompt tokens from message_start, split across chunks", async () => {
    const text = `event: message_start\ndata: ${JSON.stringify(start)}\n\n`
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        const bytes = new TextEncoder().encode(text)
        c.enqueue(bytes.slice(0, 17))
        c.enqueue(bytes.slice(17))
        c.close()
      },
    })
    expect(await t.readPromptTokens(stream)).toBe(90_015)
  })
})

describe("miss detection (pi cache-stats parity)", () => {
  const u = (input: number, cacheRead: number, cacheWrite = 0): Tokens => ({ input, output: 10, cacheRead, cacheWrite })
  const M = "anthropic/claude-opus-5-5"

  test("counts re-billed prefix above the noise floor", () => {
    const d = new MissDetector()
    expect(d.onRequest(u(10, 0, 50_000), M, 0, OPUS)).toBeUndefined()
    expect(d.onRequest(u(10, 50_000, 800), M, 1_000, OPUS)).toBeUndefined()
    const miss = d.onRequest(u(10, 0, 51_000), M, 400_000, OPUS)!
    expect(miss.missedTokens).toBe(50_810)
    expect(miss.idleMs).toBe(399_000)
    expect(miss.modelChanged).toBe(false)
    expect(miss.missedCost).toBeCloseTo(50_810 * ((10 * 4 + 51_000 * 5) / 51_010 - 0.2) / 1e6, 9)
    expect(formatMiss(miss)).toBe("Cache miss after 7m idle: 51k tokens re-billed (~$0.24)")
    expect(missNotice(miss)).toBe("Cache miss after 7m idle · 51k tokens re-billed · ~$0.24")
    expect(missNotice({ ...miss, missedTokens: 5_000, missedCost: 0.02 })).toBeUndefined()
    expect(warmNotice({ count: 1, cost: 0.004 })).toBe("Cache kept warm · 1 refresh · <$0.01")
    expect(warmNotice({ count: 3, cost: 0.0456 })).toBe("Cache kept warm · 3 refreshes · $0.05")
  })

  test("warms re-anchor the baseline; compaction resets it; model switches are flagged", () => {
    const d = new MissDetector()
    d.onRequest(u(10, 0, 50_000), M, 0, OPUS)
    d.onWarm({ input: 1, output: 1, cacheRead: 50_010, cacheWrite: 0 }, M, 270_000)
    expect(d.onRequest(u(10, 50_010, 500), M, 400_000, OPUS)).toBeUndefined()
    d.reset()
    expect(d.onRequest(u(10, 0, 60_000), M, 500_000, OPUS)).toBeUndefined()
    const switched = d.onRequest(u(10, 0, 60_100), "anthropic/claude-sonnet-5", 510_000, OPUS)!
    expect(switched.modelChanged).toBe(true)
    expect(formatMiss(switched)).toStartWith("Cache miss after model switch")
  })
})

describe("warmer lifecycle", () => {
  const model = { providerID: "anthropic", id: "claude-opus-5-5" }
  const make = (mode: "streaming" | "idle", tokens = 150_000) => {
    const calls: { url: string; body: string; headers: Headers }[] = []
    const warmed: Tokens[] = []
    const logs: string[] = []
    const warmer = new Warmer({
      mode: () => mode,
      lifetimes: { anthropic: { short: 12 } },
      rates: () => OPUS,
      promptTokens: () => tokens,
      fetch: async (url, init) => {
        calls.push({ url, body: init.body as string, headers: new Headers(init.headers) })
        return Response.json({ usage: { input_tokens: 2, output_tokens: 1, cache_read_input_tokens: tokens } })
      },
      onWarmed: (_s, _m, t) => warmed.push(t),
      log: (...a) => logs.push(a.join(" ")),
    })
    return { warmer, calls, warmed, logs }
  }
  const req = (sentAt = Date.now()) => ({
    sessionID: "s1",
    agent: "build",
    model,
    url: "https://api.anthropic.com/v1/messages?beta=true",
    headers: [["authorization", "Bearer x"], ["content-length", "999"], ["x-client-request-id", "fixed"]] as [string, string][],
    body: '{"max_tokens":1}',
    retention: "short" as const,
    sentAt,
  })

  test("replays at 90% of the lifetime and keeps going while streaming", async () => {
    const { warmer, calls, warmed } = make("streaming")
    warmer.start(req())
    expect(warmer.status("s1").state).toBe("scheduled")
    expect(formatStatus(warmer.status("s1"))).toStartWith("Decision in 2s (100% continuation probability while agent is running")
    await Bun.sleep(2_300)
    expect(calls.length).toBe(1)
    expect(calls[0]!.body).toBe('{"max_tokens":1}')
    expect(calls[0]!.headers.get("content-length")).toBeNull()
    expect(calls[0]!.headers.get("x-client-request-id")).not.toBe("fixed")
    expect(warmed[0]!.cacheRead).toBe(150_000)
    expect(warmer.status("s1").state).toBe("scheduled")
    await Bun.sleep(2_100)
    expect(calls.length).toBe(2)
    warmer.cancelAll()
  }, 10_000)

  test("streaming mode stops when the run settles; stale settle events are ignored", () => {
    const { warmer } = make("streaming")
    const sent = Date.now()
    warmer.start(req(sent))
    warmer.onAgentSettled("s1", sent - 5)
    expect(warmer.status("s1").state).toBe("scheduled")
    warmer.onAgentSettled("s1", sent + 5)
    expect(warmer.status("s1")).toEqual({ state: "inactive", reason: "agent run settled" })
  })

  test("idle mode continues at 15% and stops on a cheap prompt", async () => {
    const small = make("idle", 50_000)
    small.warmer.start(req())
    small.warmer.onAgentSettled("s1", Date.now())
    expect(small.warmer.status("s1").decision?.continuationProbability).toBe(0.15)
    await Bun.sleep(2_300)
    expect(small.calls.length).toBe(0)
    expect(small.warmer.status("s1").reason).toBe("expected savings below threshold")

    const big = make("idle", 150_000)
    big.warmer.start(req())
    big.warmer.onAgentSettled("s1", Date.now())
    await Bun.sleep(2_300)
    expect(big.calls.length).toBe(1)
    big.warmer.cancelAll()
  }, 10_000)

  test("context changes stop; late timers and old runs are refused", async () => {
    const a = make("streaming")
    a.warmer.start(req())
    a.warmer.onContextChanged("s1", Date.now())
    expect(a.warmer.status("s1").reason).toBe("conversation context changed")

    const late = make("streaming")
    late.warmer.start(req(Date.now() - 8_000))
    await Bun.sleep(50)
    expect(late.calls.length).toBe(0)
    expect(late.warmer.status("s1").reason).toBe("cache refresh deadline missed")

    const old = make("streaming")
    old.warmer.start(req(Date.now() - 61 * 60_000))
    expect(old.warmer.status("s1").reason).toBe("one-hour safety limit reached")
  })
})
