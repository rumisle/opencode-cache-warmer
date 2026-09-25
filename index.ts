// opencode-cache-warmer: pi's prompt cache warming and cache-miss accounting for OpenCode.
//
// A port of pi's CacheWarmer (packages/coding-agent/src/core/cache-warmer.ts) and cache-stats.ts.
// The policy is the same: replay the last real request with a one-token output cap shortly before
// its cache entry expires, only while the expected savings are at least $0.05.

import { createHash, randomUUID } from "node:crypto"
import { Definition, type Snapshot } from "./rpc.ts"

const PLUGIN_ID = "opencode-cache-warmer"

/** Streaming warming never continues past this long after the real request that started it. */
const MAX_WARMING_AGE_MS = 60 * 60_000
/** Idle warming uses a shorter horizon because continuation estimates become less reliable with age. */
const MAX_IDLE_WARMING_AGE_MS = 30 * 60_000
/** A refresh is sent only when it is expected to save at least this many dollars. */
const CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS = 0.05
/** pi's measured chance that a real request arrives before the entry expires while idle. */
const IDLE_CONTINUATION_PROBABILITY = 0.15
/** Idle gaps longer than this are named as the likely cause of a miss. */
const CACHE_TTL_MS = 5 * 60_000
/** Per-turn misses at or below this are cache breakpoint granularity noise. */
const NOISE_FLOOR_TOKENS = 1024
/** Keep this many recent warm and miss records per session in storage. */
const MAX_RECORDS = 50

/** Direct Anthropic: ephemeral entries live 5 minutes, or 1 hour with `ttl: "1h"`. */
const DEFAULT_LIFETIMES: Record<string, Lifetimes> = { anthropic: { short: 300, long: 3600 } }

/** Anthropic billing header that Claude Code-shaped requests carry (see opencode-anth). */
const BILLING_PREFIX = "x-anthropic-billing-header:"
const CCH_SEED = 0x6e52736ac806831en
const CCH_MASK = 0xfffffn

export type Mode = "off" | "streaming" | "idle"
export type Retention = "short" | "long"
export type Lifetimes = Partial<Record<Retention, number>>
export type Action = "warm" | "stop"

export interface Options {
  /** "streaming" (default) warms only during agent runs; "idle" also between runs; "off" disables. */
  mode?: Mode
  /** Cache lifetimes in seconds, keyed by "provider" or "provider/model". Merged per tier over the defaults. */
  lifetimes?: Record<string, Lifetimes>
}

export interface Tokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface Rate {
  tier?: { type: string; size: number }
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface Decision {
  phase: "streaming" | "idle"
  warmCost: number
  missCost: number
  continuationProbability: number
  expectedSavings: number
  economicsAvailable: boolean
  action: Action
}

export interface Status {
  state: "inactive" | "scheduled" | "refreshing"
  reason?: string
  nextWarmAt?: number
  decision?: Decision
}

export interface WarmRecord {
  time: number
  model: string
  tokens: Tokens
  cost: number
}

export interface MissRecord {
  time: number
  model: string
  missedTokens: number
  missedCost: number
  idleMs: number
  modelChanged: boolean
}

export interface SessionLedger {
  warms: { count: number; cost: number; recent: WarmRecord[] }
  misses: { count: number; tokens: number; cost: number; recent: MissRecord[] }
}

// ---------------------------------------------------------------------------------------------
// Pure policy (identical to pi)

/** Refresh at 90% of the TTL while preserving at least ten seconds of margin. */
export function getCacheWarmingDelayMs(ttlMs: number): number | undefined {
  if (ttlMs <= 10_000) return undefined
  return Math.max(1, Math.floor(Math.min(ttlMs * 0.9, ttlMs - 10_000)))
}

/** The rate OpenCode bills a request of `context` prompt tokens at: the largest context tier it exceeds. */
export function rateFor(rates: readonly Rate[], context: number): Rate | undefined {
  const tier = rates
    .filter((rate) => rate.tier?.type === "context" && context > rate.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  return tier ?? rates.find((r) => r.tier === undefined)
}

const finite = (n: number) => (Number.isFinite(n) ? n : 0)

/** OpenCode's SessionUsage.calculateCost. */
export function price(rates: readonly Rate[], tokens: Partial<Tokens>): number {
  const t = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...tokens }
  const rate = rateFor(rates, t.input + t.cacheRead + t.cacheWrite)
  if (!rate) return 0
  const f = finite
  return (
    (t.input * f(rate.input) +
      t.output * f(rate.output) +
      t.cacheRead * f(rate.cache.read) +
      t.cacheWrite * f(rate.cache.write)) /
    1_000_000
  )
}

export function evaluate(
  rates: readonly Rate[] | undefined,
  promptTokens: number,
  phase: "streaming" | "idle",
): Decision {
  const r = rates ?? []
  const writeRate = (r.find((x) => x.tier === undefined) ?? r[0])?.cache.write ?? 0
  const cacheHitCost = price(r, { cacheRead: promptTokens })
  const cacheMissCost = price(r, writeRate > 0 ? { cacheWrite: promptTokens } : { input: promptTokens })
  const warmCost = price(r, { cacheRead: promptTokens, output: 1 })
  const missCost = Math.max(0, cacheMissCost - cacheHitCost)
  const continuationProbability = phase === "idle" ? IDLE_CONTINUATION_PROBABILITY : 1
  const economicsAvailable = promptTokens > 0 && (cacheHitCost > 0 || cacheMissCost > 0)
  const expectedSavings = continuationProbability * missCost - warmCost
  return {
    phase,
    warmCost,
    missCost,
    continuationProbability,
    expectedSavings,
    economicsAvailable,
    action: expectedSavings >= CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS ? "warm" : "stop",
  }
}

// ---------------------------------------------------------------------------------------------
// Anthropic Messages replay

export type Replay =
  | { ok: true; body: string; retention: Retention }
  | { ok: false; reason: string }

/** Retention tier of the shortest-lived cache breakpoint in the request, or undefined without caching. */
export function requestRetention(body: unknown): Retention | undefined {
  let found = false
  let allLong = true
  const walk = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(walk)
    if (!value || typeof value !== "object") return
    for (const [key, child] of Object.entries(value)) {
      if (key === "cache_control" && child && typeof child === "object") {
        found = true
        if ((child as { ttl?: unknown }).ttl !== "1h") allLong = false
      } else walk(child)
    }
  }
  walk(body)
  if (!found) return undefined
  return allLong ? "long" : "short"
}

function xxh64(input: string): bigint | undefined {
  const bun = (globalThis as any).Bun
  if (typeof bun?.hash?.xxHash64 === "function") return BigInt(bun.hash.xxHash64(input, CCH_SEED))
  return undefined
}

/** Recompute a Claude Code billing hash the way opencode-anth wrote it: over the body with cch=00000. */
export function resignBilling(serialized: string, body: any): string {
  const first = Array.isArray(body?.system) ? body.system[0] : undefined
  if (typeof first?.text !== "string" || !first.text.startsWith(BILLING_PREFIX)) return serialized
  if (!/cch=[0-9a-f]{5};/.test(first.text)) return serialized
  first.text = first.text.replace(/cch=[0-9a-f]{5};/, "cch=00000;")
  const zeroed = JSON.stringify(body)
  const hash = xxh64(zeroed)
  const cch =
    hash !== undefined
      ? (hash & CCH_MASK).toString(16).padStart(5, "0")
      : createHash("sha256").update(zeroed).digest("hex").slice(0, 5)
  return zeroed.replace("cch=00000;", `cch=${cch};`)
}

/**
 * The request body re-sent with a one-token output cap. Budget-based thinking derives its budget
 * from max_tokens, which Anthropic keys the message cache on, so such requests are not replayable
 * (pi's isReplayable); adaptive thinking is.
 */
export function anthropicReplay(text: string): Replay {
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, reason: "request body is not JSON" }
  }
  if (body?.thinking?.type === "enabled") return { ok: false, reason: "request cannot be replayed safely" }
  const retention = requestRetention(body)
  if (!retention) return { ok: false, reason: "request disabled prompt caching" }
  body.max_tokens = 1
  return { ok: true, body: resignBilling(JSON.stringify(body), body), retention }
}

function usageFrom(u: any, into: Tokens) {
  if (!u || typeof u !== "object") return
  if (typeof u.input_tokens === "number") into.input = u.input_tokens
  if (typeof u.output_tokens === "number") into.output = u.output_tokens
  if (typeof u.cache_read_input_tokens === "number") into.cacheRead = u.cache_read_input_tokens
  if (typeof u.cache_creation_input_tokens === "number") into.cacheWrite = u.cache_creation_input_tokens
}

/** Usage from an Anthropic Messages response, streamed (SSE) or not. */
export async function readAnthropicUsage(response: Response): Promise<Tokens | undefined> {
  const text = await response.text()
  const tokens: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  let seen = false
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (!line.startsWith("data:")) continue
      try {
        const event = JSON.parse(line.slice(5))
        if (event.type === "message_start") usageFrom(event.message?.usage, tokens), (seen = true)
        else if (event.type === "message_delta") usageFrom(event.usage, tokens), (seen = true)
      } catch {}
    }
  } else {
    try {
      usageFrom(JSON.parse(text).usage, tokens)
      seen = true
    } catch {}
  }
  return seen ? tokens : undefined
}

/** Prompt tokens from the first `message_start` of a streamed response; stops reading there. */
export async function readPromptTokens(stream: ReadableStream<Uint8Array>): Promise<number | undefined> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return undefined
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line.startsWith("data:")) continue
        try {
          const event = JSON.parse(line.slice(5))
          if (event.type !== "message_start") continue
          const t: Tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          usageFrom(event.message?.usage, t)
          return t.input + t.cacheRead + t.cacheWrite
        } catch {}
      }
    }
  } finally {
    reader.cancel().catch(() => {})
  }
}

// ---------------------------------------------------------------------------------------------
// Cache-miss detection (pi's cache-stats.ts)

interface PreviousRequest {
  promptTokens: number
  modelKey: string
  timestamp: number
  reportedCache: boolean
}

export class MissDetector {
  private prev?: PreviousRequest

  reset() {
    this.prev = undefined
  }

  /** A warm refresh re-anchors the cache: the next request should read everything it read. */
  onWarm(tokens: Tokens, modelKey: string, timestamp: number) {
    const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
    if (promptTokens > 0) this.prev = { promptTokens, modelKey, timestamp, reportedCache: true }
  }

  /** Returns the counted miss for a completed request, if any, and advances the baseline. */
  onRequest(tokens: Tokens, modelKey: string, timestamp: number, rates: readonly Rate[] | undefined) {
    const prev = this.prev
    const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite
    let miss: Omit<MissRecord, "time" | "model"> | undefined
    if (prev && promptTokens > 0 && (tokens.cacheRead + tokens.cacheWrite > 0 || prev.reportedCache)) {
      const missedTokens = Math.min(prev.promptTokens, promptTokens) - tokens.cacheRead
      if (missedTokens > NOISE_FLOOR_TOKENS) {
        // Missed tokens were billed as input or cache writes instead of cache reads.
        const rate = rateFor(rates ?? [], promptTokens)
        const paidTokens = tokens.input + tokens.cacheWrite
        const paidPerToken =
          rate && paidTokens > 0
            ? (tokens.input * finite(rate.input) + tokens.cacheWrite * finite(rate.cache.write)) / paidTokens / 1_000_000
            : 0
        const readPerToken = rate ? finite(rate.cache.read) / 1_000_000 : 0
        miss = {
          missedTokens,
          missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
          idleMs: Math.max(0, timestamp - prev.timestamp),
          modelChanged: modelKey !== prev.modelKey,
        }
      }
    }
    if (promptTokens > 0) {
      this.prev = {
        promptTokens,
        modelKey,
        timestamp,
        reportedCache: (prev?.reportedCache ?? false) || tokens.cacheRead + tokens.cacheWrite > 0,
      }
    }
    return miss
  }
}

/** pi's transcript notice text, or undefined below its display threshold. */
export function formatMiss(miss: Pick<MissRecord, "missedTokens" | "missedCost" | "idleMs" | "modelChanged">) {
  if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return undefined
  const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : ""
  const tokens = miss.missedTokens >= 1000 ? `${Math.round(miss.missedTokens / 1000)}k` : String(miss.missedTokens)
  let label = "Cache miss"
  if (miss.modelChanged) label = "Cache miss after model switch"
  else if (miss.idleMs >= CACHE_TTL_MS) label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`
  return `${label}: ${tokens} tokens re-billed${cost}`
}

const usd = (value: number) => (value >= 0.01 ? `$${value.toFixed(2)}` : "<$0.01")
const kTokens = (value: number) => (value >= 1000 ? `${Math.round(value / 1000)}k` : String(value))

/** Transcript notice for a significant miss ("headline · details"), or undefined below pi's threshold. */
export function missNotice(miss: Pick<MissRecord, "missedTokens" | "missedCost" | "idleMs" | "modelChanged">) {
  if (!formatMiss(miss)) return undefined
  let label = "Cache miss"
  if (miss.modelChanged) label = "Cache miss after model switch"
  else if (miss.idleMs >= CACHE_TTL_MS) label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`
  return [label, `${kTokens(miss.missedTokens)} tokens re-billed`, ...(miss.missedCost >= 0.01 ? [`~${usd(miss.missedCost)}`] : [])].join(" · ")
}

/** Transcript notice for a run of refreshes with nothing sent in between. */
export function warmNotice(stretch: { count: number; cost: number }) {
  return `Cache kept warm · ${stretch.count} refresh${stretch.count === 1 ? "" : "es"} · ${usd(stretch.cost)}`
}

export function formatStatus(status: Status, now = Date.now()): string {
  const d = status.decision
  if (!d || (status.state === "inactive" && !d.economicsAvailable)) return `Inactive (${status.reason ?? "unknown reason"})`
  const dollars = (v: number) => (v < 0 ? `-$${Math.abs(v).toFixed(3)}` : `$${v.toFixed(3)}`)
  const p = Math.round(d.continuationProbability * 100)
  const economics = d.economicsAvailable
    ? `${p}% continuation probability${d.phase === "streaming" ? " while agent is running" : ""}, expected savings ${dollars(d.expectedSavings)} ${d.action === "warm" ? ">=" : "<"} $${CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS.toFixed(3)}`
    : "cache economics unavailable"
  const details = `${economics} -> ${d.action}`
  if (status.state === "inactive") return `Stopped (${details})`
  if (status.state === "refreshing") return `Warming cache (${details})`
  const left = Math.max(0, Math.ceil(((status.nextWarmAt ?? now) - now) / 1000))
  const m = Math.floor(left / 60)
  return `Decision in ${m > 0 ? `${m}m ` : ""}${left % 60}s (${details})`
}

// ---------------------------------------------------------------------------------------------
// Warmer

export interface CapturedRequest {
  sessionID: string
  agent: string
  model: { providerID: string; id: string }
  url: string
  headers: [string, string][]
  body: string
  retention: Retention
  sentAt: number
}

interface Run extends CapturedRequest {
  ttlMs: number
  delayMs: number
  refreshDeadlineAt: number
  startedAt: number
  controller: AbortController
  phase: "streaming" | "idle"
  nextWarmAt: number
  timer?: ReturnType<typeof setTimeout>
}

export interface WarmerDeps {
  mode: () => Mode
  lifetimes: Record<string, Lifetimes>
  rates: (model: { providerID: string; id: string }) => readonly Rate[] | undefined
  /** Make prices for `model` available before a decision (e.g. reload the catalog after login). */
  prepare?: (model: { providerID: string; id: string }) => Promise<void>
  promptTokens: (sessionID: string) => number
  fetch: (url: string, init: RequestInit) => Promise<Response>
  onWarmed: (sessionID: string, model: { providerID: string; id: string }, tokens: Tokens, cost: number) => void
  log: (...args: unknown[]) => void
  /** Called whenever a session's warming status changes. */
  onChange?: (sessionID: string) => void
}

export function lifetimeSeconds(
  table: Record<string, Lifetimes>,
  model: { providerID: string; id: string },
  retention: Retention,
): number | undefined {
  const merged = {
    ...DEFAULT_LIFETIMES[model.providerID],
    ...DEFAULT_LIFETIMES[`${model.providerID}/${model.id}`],
    ...table[model.providerID],
    ...table[`${model.providerID}/${model.id}`],
  }
  const seconds = merged[retention]
  return typeof seconds === "number" && seconds > 0 ? seconds : undefined
}

/** One prompt cache entry per session kept alive by re-sending its request before it expires. */
export class Warmer {
  private runs = new Map<string, Run>()
  private inactive = new Map<string, Status>()

  constructor(private deps: WarmerDeps) {}

  phase(sessionID: string) {
    return this.runs.get(sessionID)?.phase
  }

  status(sessionID: string): Status {
    if (this.deps.mode() === "off") return { state: "inactive", reason: "cache warming disabled" }
    const run = this.runs.get(sessionID)
    if (!run) return this.inactive.get(sessionID) ?? { state: "inactive", reason: "waiting for first request" }
    const decision = this.evaluate(run)
    const refreshing = run.timer === undefined
    if (!decision.economicsAvailable && !refreshing) return { state: "inactive", reason: "cache economics unavailable" }
    return { state: refreshing ? "refreshing" : "scheduled", nextWarmAt: run.nextWarmAt, decision }
  }

  startedAt(sessionID: string) {
    return this.runs.get(sessionID)?.startedAt
  }

  runModel(sessionID: string) {
    const run = this.runs.get(sessionID)
    return run && { ...run.model, agent: run.agent }
  }

  start(request: CapturedRequest) {
    const { sessionID } = request
    this.clearRun(sessionID)
    if (this.deps.mode() === "off") return this.stop(sessionID, "cache warming disabled")
    const seconds = lifetimeSeconds(this.deps.lifetimes, request.model, request.retention)
    if (seconds === undefined) return this.stop(sessionID, "cache lifetime unavailable")
    const ttlMs = seconds * 1000
    const delayMs = getCacheWarmingDelayMs(ttlMs)
    if (delayMs === undefined) return this.stop(sessionID, "cache lifetime unavailable")
    const run: Run = {
      ...request,
      ttlMs,
      delayMs,
      refreshDeadlineAt: 0,
      startedAt: request.sentAt,
      controller: new AbortController(),
      phase: "streaming",
      nextWarmAt: 0,
    }
    this.runs.set(sessionID, run)
    this.deps.log(sessionID, `start: ${request.retention} lifetime ${seconds}s, refresh every ${delayMs / 1000}s`)
    this.schedule(run, request.sentAt)
    this.deps.onChange?.(sessionID)
  }

  /** A new request replaced the cache entry but cannot be warmed. */
  reject(sessionID: string, reason: string) {
    this.stop(sessionID, reason)
  }

  /** The agent run that sent the request settled at `at`. */
  onAgentSettled(sessionID: string, at: number) {
    const run = this.runs.get(sessionID)
    if (!run || at < run.startedAt) return
    if (this.deps.mode() === "streaming") return this.stop(sessionID, "agent run settled")
    run.phase = "idle"
    this.deps.log(sessionID, "run settled: idle warming")
    const deadline = run.startedAt + MAX_IDLE_WARMING_AGE_MS
    if (run.nextWarmAt > deadline || Date.now() >= deadline) return this.stop(sessionID, "30-minute idle safety limit reached")
    this.deps.onChange?.(sessionID)
  }

  /** The conversation context changed at `at` (model/agent switch, revert, compaction, deletion). */
  onContextChanged(sessionID: string, at: number, reason = "conversation context changed") {
    const run = this.runs.get(sessionID)
    if (run && at >= run.startedAt) this.stop(sessionID, reason)
  }

  cancelAll() {
    for (const sessionID of [...this.runs.keys()]) this.clearRun(sessionID)
  }

  private clearRun(sessionID: string) {
    const run = this.runs.get(sessionID)
    if (!run) return
    this.runs.delete(sessionID)
    if (run.timer) clearTimeout(run.timer)
    run.controller.abort()
  }

  private stop(sessionID: string, reason: string, decision?: Decision) {
    this.clearRun(sessionID)
    this.inactive.set(sessionID, { state: "inactive", reason, ...(decision ? { decision } : {}) })
    this.deps.log(sessionID, "stop:", reason)
    this.deps.onChange?.(sessionID)
  }

  private schedule(run: Run, from = Date.now()) {
    run.nextWarmAt = from + run.delayMs
    // A timer can run late after sleep or event-loop blockage. Keep half of the planned
    // pre-expiry margin for that delay; a late refresh is a full-price cache write, not a warm.
    run.refreshDeadlineAt = run.nextWarmAt + Math.floor((run.ttlMs - run.delayMs) / 2)
    const deadline = run.startedAt + (run.phase === "idle" ? MAX_IDLE_WARMING_AGE_MS : MAX_WARMING_AGE_MS)
    if (run.nextWarmAt > deadline || Date.now() >= deadline) {
      return this.stop(
        run.sessionID,
        run.phase === "idle" ? "30-minute idle safety limit reached" : "one-hour safety limit reached",
      )
    }
    run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.nextWarmAt - Date.now()))
    ;(run.timer as any).unref?.()
  }

  private current(run: Run) {
    if (this.runs.get(run.sessionID) !== run) return false
    const mode = this.deps.mode()
    if (mode === "off") return this.stop(run.sessionID, "cache warming disabled"), false
    if (mode === "streaming" && run.phase === "idle") return this.stop(run.sessionID, "agent run settled"), false
    return true
  }

  private deadlineMissed(run: Run) {
    if (Date.now() <= run.refreshDeadlineAt) return false
    this.stop(run.sessionID, "cache refresh deadline missed")
    return true
  }

  private evaluate(run: Run) {
    return evaluate(this.deps.rates(run.model), this.deps.promptTokens(run.sessionID), run.phase)
  }

  private async refresh(run: Run) {
    run.timer = undefined
    if (!this.current(run) || this.deadlineMissed(run)) return
    if (!this.deps.rates(run.model)) await this.deps.prepare?.(run.model).catch(() => {})
    if (!this.current(run) || this.deadlineMissed(run)) return
    const decision = this.evaluate(run)
    if (decision.action === "stop") {
      const reason = decision.economicsAvailable ? "expected savings below threshold" : "cache economics unavailable"
      return this.stop(run.sessionID, reason, decision)
    }
    this.deps.onChange?.(run.sessionID)
    try {
      const headers = new Headers(run.headers)
      headers.delete("content-length")
      if (headers.has("x-client-request-id")) headers.set("x-client-request-id", randomUUID())
      const response = await this.deps.fetch(run.url, {
        method: "POST",
        headers,
        body: run.body,
        signal: run.controller.signal,
        redirect: "error",
      })
      if (!response.ok) {
        this.deps.log(run.sessionID, "refresh failed:", response.status, (await response.text()).slice(0, 300))
      } else {
        const tokens = await readAnthropicUsage(response)
        if (tokens && this.runs.get(run.sessionID) === run) {
          const cost = price(this.deps.rates(run.model) ?? [], tokens)
          this.deps.log(run.sessionID, "warmed:", JSON.stringify(tokens), `$${cost.toFixed(4)}`)
          this.deps.onWarmed(run.sessionID, run.model, tokens, cost)
        }
      }
    } catch (error) {
      // Cache warming is best-effort and must not affect the session.
      if (!run.controller.signal.aborted) this.deps.log(run.sessionID, "refresh error:", String(error))
    }
    if (this.runs.get(run.sessionID) !== run) return
    this.schedule(run)
    if (this.runs.get(run.sessionID) === run) this.deps.onChange?.(run.sessionID)
  }
}

// ---------------------------------------------------------------------------------------------
// Plugin

const emptyLedger = (): SessionLedger => ({
  warms: { count: 0, cost: 0, recent: [] },
  misses: { count: 0, tokens: 0, cost: 0, recent: [] },
})

const modelKey = (m: { providerID: string; id: string }) => `${m.providerID}/${m.id}`

function isAnthropicMessages(url: string) {
  try {
    return new URL(url).pathname.endsWith("/v1/messages")
  } catch {
    return false
  }
}

export default {
  id: PLUGIN_ID,
  setup: async (ctx: any) => {
    const options: Options = ctx.options ?? {}
    const mode: Mode = options.mode === "off" || options.mode === "idle" ? options.mode : "streaming"
    const debug = !!process.env.OPENCODE_CACHE_WARMER_DEBUG
    const log = (...args: unknown[]) => {
      if (debug) console.error(`[${PLUGIN_ID}]`, ...args)
    }

    // Model prices, refreshed lazily when an unknown model shows up.
    let rateTable = new Map<string, Rate[]>()
    let loading: Promise<void> | undefined
    const loadRates = () =>
      (loading ??= (async () => {
        try {
          const result = await ctx.model.list()
          const next = new Map<string, Rate[]>()
          const models: any[] = result?.data ?? []
          const ratesOf = (info: any): Rate[] => (Array.isArray(info.cost) ? info.cost : [])
          // Exact ids win: variants such as `claude-opus-5-5-fast` share `modelID` with the base model
          // but have their own (higher) prices.
          for (const info of models) next.set(`${info.providerID}/${info.id}`, ratesOf(info))
          for (const info of models) {
            const key = `${info.providerID}/${info.modelID}`
            if (info.modelID && !next.has(key)) next.set(key, ratesOf(info))
          }
          rateTable = next
        } catch (error) {
          log("model list failed:", String(error))
        } finally {
          loading = undefined
        }
      })())
    await loadRates()
    const rates = (model: { providerID: string; id: string }) => {
      const found = rateTable.get(modelKey(model))
      if (!found) void loadRates()
      return found
    }

    const promptTokens = new Map<string, number>()
    const detectors = new Map<string, MissDetector>()
    const lastModel = new Map<string, { providerID: string; id: string }>()
    const sendTimes = new Map<string, number>()
    const detector = (sessionID: string) => {
      let d = detectors.get(sessionID)
      if (!d) detectors.set(sessionID, (d = new MissDetector()))
      return d
    }

    // Transcript notices (ocelot's session.notice; stock OpenCode has none, so they are skipped).
    // Refreshes with nothing sent in between share one notice that is updated in place, and their
    // cost counts toward the session's cost like pi's cache_warm usage entries.
    const canNotice = typeof ctx.session?.notice === "function"
    const stretches = new Map<string, { id?: Promise<string | undefined>; count: number; cost: number }>()
    const postNotice = async (input: { sessionID: string; id?: string; level: "info" | "warning"; text: string; usage?: unknown }) => {
      if (!canNotice) return undefined
      try {
        const result = await ctx.session.notice({ ...input, source: PLUGIN_ID })
        return (result?.id ?? result?.data?.id) as string | undefined
      } catch (error) {
        log(input.sessionID, "notice failed:", String(error))
      }
    }
    const noticeWarm = (sessionID: string, tokens: Tokens, cost: number) => {
      const stretch = stretches.get(sessionID) ?? { count: 0, cost: 0 }
      stretches.set(sessionID, stretch)
      stretch.count++
      stretch.cost += cost
      const usage = {
        cost,
        tokens: { input: tokens.input, output: tokens.output, reasoning: 0, cache: { read: tokens.cacheRead, write: tokens.cacheWrite } },
      }
      const text = warmNotice(stretch)
      // Updates wait for the first post so they carry its id.
      const previous = stretch.id
      stretch.id = (async () => {
        const id = await previous
        return (await postNotice({ sessionID, id, level: "info", text, usage })) ?? id
      })()
    }

    // Per-session ledgers: loaded from storage once, then kept in memory; writes are serialized.
    const ledgers = new Map<string, Promise<SessionLedger>>()
    const ledger = (sessionID: string) => {
      let loaded = ledgers.get(sessionID)
      if (!loaded) {
        loaded = (async () => {
          try {
            const stored = (await ctx.storage.get(`session/${sessionID}`)) as SessionLedger | undefined
            if (stored && stored.warms && stored.misses) return stored
          } catch (error) {
            log("ledger read failed:", String(error))
          }
          return emptyLedger()
        })()
        ledgers.set(sessionID, loaded)
      }
      return loaded
    }
    const ledgerWrites = new Map<string, Promise<void>>()
    const updateLedger = (sessionID: string, update: (ledger: SessionLedger) => void, notice?: string) => {
      const next = (ledgerWrites.get(sessionID) ?? Promise.resolve()).then(async () => {
        try {
          const current = await ledger(sessionID)
          update(current)
          current.warms.recent = current.warms.recent.slice(-MAX_RECORDS)
          current.misses.recent = current.misses.recent.slice(-MAX_RECORDS)
          await ctx.storage.set(`session/${sessionID}`, current as any)
        } catch (error) {
          log("ledger write failed:", String(error))
        }
        await notify(sessionID, notice)
      })
      ledgerWrites.set(sessionID, next)
      return next
    }

    const snapshot = async (sessionID: string, notice?: string): Promise<Snapshot> => {
      const status = warmer.status(sessionID)
      const l = await ledger(sessionID)
      const d = status.decision
      return {
        sessionID,
        mode,
        serverNow: Date.now(),
        state: status.state,
        ...(status.reason ? { reason: status.reason } : {}),
        ...(status.nextWarmAt ? { nextWarmAt: status.nextWarmAt } : {}),
        ...(d
          ? { phase: d.phase, expectedSavings: d.expectedSavings, action: d.action, economicsAvailable: d.economicsAvailable }
          : {}),
        line: formatStatus(status),
        warms: { count: l.warms.count, cost: l.warms.cost },
        misses: { count: l.misses.count, tokens: l.misses.tokens, cost: l.misses.cost },
        ...(notice ? { notice } : {}),
      }
    }
    let rpc: { events: { emit: (name: "update", data: any) => Promise<void> } } | undefined
    const notify = async (sessionID: string, notice?: string) => {
      if (!rpc) return
      try {
        await rpc.events.emit("update", await snapshot(sessionID, notice))
      } catch (error) {
        log("rpc emit failed:", String(error))
      }
    }

    const warmer = new Warmer({
      mode: () => mode,
      lifetimes: options.lifetimes ?? {},
      rates,
      prepare: () => loadRates(),
      promptTokens: (sessionID) => promptTokens.get(sessionID) ?? 0,
      fetch: (url, init) => fetch(url, init),
      log,
      onChange: (sessionID) => void notify(sessionID),
      onWarmed: (sessionID, model, tokens, cost) => {
        const time = Date.now()
        detector(sessionID).onWarm(tokens, modelKey(model), time)
        noticeWarm(sessionID, tokens, cost)
        void updateLedger(sessionID, (ledger) => {
          ledger.warms.count++
          ledger.warms.cost += cost
          ledger.warms.recent.push({ time, model: modelKey(model), tokens, cost })
        })
      },
    })

    // Hooks are scoped to providers with a known cache lifetime; nothing else is touched.
    const providers = new Set([
      ...Object.keys(DEFAULT_LIFETIMES),
      ...Object.keys(options.lifetimes ?? {}).map((key) => key.split("/")[0]!),
    ])
    const onRequest = (event: any) => {
      if (event.kind !== "primary") return
      sendTimes.set(event.sessionID, Date.now())
      // A real request ends the current run of refreshes: the next one starts a new notice.
      stretches.delete(event.sessionID)
    }
    const onResponse = async (event: any) => {
      if (event.kind !== "primary") return
      const request: Request = event.request
      const response: Response = event.response
      if (!response.ok || request.method !== "POST" || !isAnthropicMessages(request.url)) return
      const model = { providerID: event.model.providerID, id: event.model.id }
      lastModel.set(event.sessionID, model)

      // Read the prompt size from message_start on a tee; the session keeps the other branch.
      if (response.body && (response.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const [mine, theirs] = response.body.tee()
        event.response = new Response(theirs, { status: response.status, statusText: response.statusText, headers: response.headers })
        void readPromptTokens(mine).then((tokens) => {
          if (tokens !== undefined) promptTokens.set(event.sessionID, tokens)
        })
      }

      const replay = anthropicReplay(await request.clone().text())
      if (!replay.ok) return warmer.reject(event.sessionID, replay.reason)
      warmer.start({
        sessionID: event.sessionID,
        agent: event.agent,
        model,
        url: request.url,
        headers: [...request.headers.entries()],
        body: replay.body,
        retention: replay.retention,
        sentAt: sendTimes.get(event.sessionID) ?? Date.now(),
      })
    }
    if (mode !== "off") {
      for (const providerID of providers) {
        await ctx.session.hook("http.request", onRequest, { providerID })
        await ctx.session.hook("http.response", onResponse, { providerID })
      }
    }

    try {
      rpc = await ctx.rpc.register(Definition as any, {
        status: async (input: { sessionID: string }) => snapshot(input.sessionID),
      })
    } catch (error) {
      log("rpc register failed:", String(error))
    }

    // Session events: run settlement, context changes, and per-step usage for miss detection.
    const abort = new AbortController()
    const handle = (event: any) => {
      const data = event?.data ?? {}
      const sessionID: string | undefined = data.sessionID
      if (!sessionID) return
      const at: number = typeof event.created === "number" ? event.created : Date.now()
      switch (event.type) {
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
        case "session.idle":
          return warmer.onAgentSettled(sessionID, at)
        case "session.model.selected": {
          const run = warmer.runModel(sessionID)
          if (run && (data.model?.providerID !== run.providerID || data.model?.id !== run.id))
            warmer.onContextChanged(sessionID, at)
          return
        }
        case "session.agent.selected": {
          const run = warmer.runModel(sessionID)
          if (run && data.agent !== run.agent) warmer.onContextChanged(sessionID, at)
          return
        }
        case "session.revert.staged":
        case "session.revert.committed":
        case "session.compaction.started":
          return warmer.onContextChanged(sessionID, at)
        case "session.compaction.ended":
          return detector(sessionID).reset()
        case "session.step.started":
          // Every provider, not only warmable ones: miss detection is provider-agnostic.
          if (data.model?.providerID && data.model?.id) lastModel.set(sessionID, { providerID: data.model.providerID, id: data.model.id })
          return
        case "session.deleted":
          warmer.onContextChanged(sessionID, at, "session deleted")
          promptTokens.delete(sessionID)
          detectors.delete(sessionID)
          stretches.delete(sessionID)
          ledgers.delete(sessionID)
          lastModel.delete(sessionID)
          sendTimes.delete(sessionID)
          return
        case "session.step.ended": {
          const t = data.tokens
          const model = lastModel.get(sessionID)
          if (!t || !model) return
          const tokens: Tokens = { input: t.input ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), cacheRead: t.cache?.read ?? 0, cacheWrite: t.cache?.write ?? 0 }
          const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite
          if (prompt > 0) promptTokens.set(sessionID, prompt)
          const miss = detector(sessionID).onRequest(tokens, modelKey(model), at, rates(model))
          if (!miss) return
          const record: MissRecord = { time: at, model: modelKey(model), ...miss }
          const notice = formatMiss(record)
          if (notice) log(sessionID, notice)
          const text = missNotice(record)
          if (text) void postNotice({ sessionID, level: "warning", text })
          void updateLedger(
            sessionID,
            (ledger) => {
              ledger.misses.count++
              ledger.misses.tokens += miss.missedTokens
              ledger.misses.cost += miss.missedCost
              ledger.misses.recent.push(record)
            },
            notice,
          )
          return
        }
      }
    }
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          for await (const event of ctx.event.subscribe({ signal: abort.signal })) handle(event)
        } catch (error) {
          if (!abort.signal.aborted) log("event stream error:", String(error))
        }
        if (!abort.signal.aborted) await new Promise((r) => setTimeout(r, 1000))
      }
    })()

    return async () => {
      abort.abort()
      warmer.cancelAll()
      await (rpc as any)?.dispose?.()
    }
  },
}

export const __test = { anthropicReplay, requestRetention, resignBilling, readAnthropicUsage, readPromptTokens, rateFor }
