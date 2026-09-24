// Differential tests against pi's own implementation. Needs a pi-mono checkout with node_modules
// (PI_MONO, default ~/work/pi-mono); skipped otherwise.
import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { evaluate, getCacheWarmingDelayMs, MissDetector } from "../index.ts"

const core = path.join(process.env.PI_MONO ?? path.join(homedir(), "work/pi-mono"), "packages/coding-agent/src/core")
const available = existsSync(path.join(core, "cache-warmer.ts"))
const { CacheWarmer, getCacheWarmingDelayMs: piDelay } = available ? await import(path.join(core, "cache-warmer.ts")) : ({} as any)
const { detectCacheMiss } = available ? await import(path.join(core, "cache-stats.ts")) : ({} as any)

const piModel = (cost: any) => ({ id: "m", provider: "anthropic", api: "anthropic-messages", cost, promptCache: { short: 300, long: 3600 }, compat: { forceAdaptiveThinking: true } }) as any
const asst = (usage: any, ts = 0, model = "m") => ({ type: "message", message: { role: "assistant", provider: "anthropic", model, timestamp: ts, usage: { ...usage, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } })

test.skipIf(!available)("decisions match pi on random prices, sizes, phases", () => {
  let rnd = 42; const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  for (let i = 0; i < 2000; i++) {
    const cost = { input: r() * 15, output: r() * 75, cacheRead: r() * 1.5, cacheWrite: r() < 0.2 ? 0 : r() * 20 }
    const prompt = Math.floor(r() * 400_000)
    const idle = r() < 0.5
    const branch = [asst({ input: Math.floor(prompt / 3), cacheRead: prompt - Math.floor(prompt / 3), cacheWrite: 0, output: 5 })]
    const w = new CacheWarmer({ streamSimple: () => { throw 0 } } as any, { appendUsage: () => ({}) as any, getBranch: () => branch as any }, () => (idle ? "idle" : "streaming"))
    w.start({ model: piModel(cost), context: { messages: [] } as any, options: {} as any }, () => true)
    if (idle) w.onAgentSettled()
    const pi = w.status.decision
    w.cancel()
    const mine = evaluate([{ input: cost.input, output: cost.output, cache: { read: cost.cacheRead, write: cost.cacheWrite } }], prompt, idle ? "idle" : "streaming")
    if (!pi) { expect(mine.economicsAvailable).toBe(false); continue }
    expect(mine.action).toBe(pi.action)
    expect(mine.warmCost).toBeCloseTo(pi.warmCost, 12)
    expect(mine.missCost).toBeCloseTo(pi.missCost, 12)
    expect(mine.expectedSavings).toBeCloseTo(pi.expectedSavings, 12)
  }
  for (const ttl of [10_000, 10_001, 60_000, 300_000, 3_600_000]) expect(getCacheWarmingDelayMs(ttl)).toBe(piDelay(ttl))
})

test.skipIf(!available)("miss detection matches pi on random sequences", () => {
  let rnd = 7; const r = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
  const rates = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
  const models = { getModel: () => ({ cost: { cacheRead: rates.cacheRead } }) }
  for (let run = 0; run < 200; run++) {
    const entries: any[] = []; const mine = new MissDetector(); let ts = 0; let size = 5_000
    for (let step = 0; step < 12; step++) {
      ts += Math.floor(r() * 600_000)
      size += Math.floor(r() * 20_000)
      const read = r() < 0.3 ? Math.floor(r() * size) : size - Math.floor(r() * 3000)
      const write = size - Math.max(0, read)
      const input = Math.floor(r() * 50)
      const model = r() < 0.1 ? "other" : "m"
      const usage = { input, output: 10, cacheRead: Math.max(0, read), cacheWrite: write }
      // pi derives paid/read rates from the message's own cost breakdown
      const msg = asst(usage, ts, model)
      msg.message.usage.cost = { input: input * rates.input / 1e6, output: 0, cacheRead: usage.cacheRead * rates.cacheRead / 1e6, cacheWrite: write * rates.cacheWrite / 1e6, total: 0 }
      const piMiss = detectCacheMiss(entries, msg.message as any, models as any)
      const myMiss = mine.onRequest(usage, `anthropic/${model}`, ts, [{ input: rates.input, output: rates.output, cache: { read: rates.cacheRead, write: rates.cacheWrite } }])
      expect(!!myMiss).toBe(!!piMiss)
      if (piMiss && myMiss) {
        expect(myMiss.missedTokens).toBe(piMiss.missedTokens)
        expect(myMiss.missedCost).toBeCloseTo(piMiss.missedCost, 9)
        expect(myMiss.modelChanged).toBe(piMiss.modelChanged)
        expect(myMiss.idleMs).toBe(piMiss.idleMs)
      }
      entries.push(msg)
    }
  }
})
