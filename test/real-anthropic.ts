// Manual check against the real Anthropic API: a Claude Code-shaped request (opencode-anth's
// rewriteBody) followed by this plugin's replay. The replay must succeed and read the whole
// prompt from cache. Usage: ANTHROPIC_OAUTH_TOKEN=sk-ant-oat01-... bun test/real-anthropic.ts
import { randomUUID } from "node:crypto"
import { __test as anth } from "../../opencode-anth/index.ts"
import { __test as warm } from "../index.ts"

const token = process.env.ANTHROPIC_OAUTH_TOKEN
if (!token) throw new Error("set ANTHROPIC_OAUTH_TOKEN")
const model = process.env.MODEL ?? "claude-opus-5-5"
const wait = Number(process.env.WAIT_SECONDS ?? 20)

// ~8k tokens of stable system text so the prefix is cacheable on every model.
const filler = Array.from({ length: 700 }, (_, i) => `Rule ${i}: keep answers short and precise.`).join("\n")
const request = {
  model,
  max_tokens: 32000,
  stream: true,
  thinking: { type: "adaptive" },
  system: [{ type: "text", text: `You are a test assistant.\n${filler}`, cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "Reply with the single word: pong", cache_control: { type: "ephemeral" } }] }],
}
const ids = { device: "0".repeat(64), account: process.env.ACCOUNT_UUID ?? "", session: randomUUID() }
const body = anth.rewriteBody(structuredClone(request), ids, anth.buildToolMap(undefined))

const headers = () => ({
  authorization: `Bearer ${token}`,
  "content-type": "application/json",
  accept: "application/json",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14",
  "anthropic-dangerous-direct-browser-access": "true",
  "user-agent": "claude-cli/2.1.281 (external, sdk-cli)",
  "x-app": "cli",
  "x-client-request-id": randomUUID(),
})
const url = "https://api.anthropic.com/v1/messages?beta=true"

async function send(label: string, payload: string) {
  const started = Date.now()
  const response = await fetch(url, { method: "POST", headers: headers(), body: payload })
  if (!response.ok) throw new Error(`${label}: HTTP ${response.status} ${await response.text()}`)
  const usage = await warm.readAnthropicUsage(response)
  console.log(`${label}: ${Date.now() - started}ms`, JSON.stringify(usage))
  return usage!
}

const first = await send("original", body)
const replay = warm.anthropicReplay(body)
if (!replay.ok) throw new Error(replay.reason)
console.log(`waiting ${wait}s ...`)
await Bun.sleep(wait * 1000)
const warmed = await send("replay  ", replay.body)
const prompt = first.input + first.cacheRead + first.cacheWrite
const ok = warmed.output <= 1 && warmed.cacheRead >= prompt - 64 && warmed.cacheWrite <= 64
console.log(ok ? "PASS: replay read the whole prompt from cache" : "FAIL")
process.exit(ok ? 0 : 1)
