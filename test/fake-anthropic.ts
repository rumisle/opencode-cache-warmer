// Fake Anthropic API for end-to-end tests with a real `opencode serve` + opencode-anth.
// Every /v1/messages request is logged to $OUT/requests.jsonl with its time, max_tokens,
// and whether its Claude Code billing hash (cch) is valid for the body it came with.
import { appendFileSync, mkdirSync } from "node:fs"

const OUT = process.env.OUT ?? "/tmp/warm-e2e"
const PROMPT = Number(process.env.PROMPT_TOKENS ?? 150_000)
const SLEEP = process.env.SLEEP ?? "25"
mkdirSync(OUT, { recursive: true })

const sse = (events: any[]) =>
  new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  })
const message = (content: any[], stop: string, usage: any) => [
  { type: "message_start", message: { id: `msg_${Date.now()}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage } },
  ...content.flatMap((block, index) =>
    block.type === "text"
      ? [
          { type: "content_block_start", index, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index, delta: { type: "text_delta", text: block.text } },
          { type: "content_block_stop", index },
        ]
      : [
          { type: "content_block_start", index, content_block: { type: "tool_use", id: block.id, name: block.name, input: {} } },
          { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) } },
          { type: "content_block_stop", index },
        ],
  ),
  { type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: content.length ? 5 : 1 } },
  { type: "message_stop" },
]

function cchValid(body: string): boolean | null {
  const m = body.match(/cch=([0-9a-f]{5});/)
  if (!m) return null
  const zeroed = body.replace(`cch=${m[1]};`, "cch=00000;")
  const hash = BigInt(Bun.hash.xxHash64(zeroed, 0x6e52736ac806831en)) & 0xfffffn
  return hash.toString(16).padStart(5, "0") === m[1]
}

let tokenN = 0
const seenPrefix = new Set<string>()
const server = Bun.serve({
  port: Number(process.env.PORT ?? 4801),
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    const body = await req.text()
    if (url.pathname === "/v1/oauth/token") {
      tokenN++
      return Response.json({ access_token: `sk-ant-oat01-fake${tokenN}`, refresh_token: `sk-ant-ort01-fake${tokenN}`, expires_in: 28800, token_type: "Bearer" })
    }
    if (url.pathname === "/api/oauth/profile") return Response.json({ account: { uuid: "acc-11111111-2222-3333-4444-555555555555" } })
    if (!url.pathname.endsWith("/v1/messages")) return new Response("not found", { status: 404 })

    const parsed = JSON.parse(body)
    const tools: string[] = (parsed.tools ?? []).map((t: any) => t.name)
    const text = JSON.stringify(parsed.messages)
    const warm = parsed.max_tokens === 1
    const withoutMax = JSON.stringify({ ...parsed, max_tokens: 0, system: parsed.system?.slice?.(1) })
    appendFileSync(
      `${OUT}/requests.jsonl`,
      JSON.stringify({
        t: Date.now(),
        warm,
        max_tokens: parsed.max_tokens,
        cch: cchValid(body),
        auth: (req.headers.get("authorization") ?? "").slice(0, 26),
        requestId: req.headers.get("x-client-request-id"),
        messages: parsed.messages?.length,
        sameAsPrevious: seenPrefix.has(withoutMax),
      }) + "\n",
    )
    seenPrefix.add(withoutMax)

    const usage = { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: PROMPT, cache_creation_input_tokens: 50 }
    if (warm) return sse(message([], "max_tokens", usage))
    if (tools.includes("Bash") && !text.includes('"tool_result"') && text.includes("SLEEP"))
      return sse(message([{ type: "tool_use", id: `toolu_${Date.now()}`, name: "Bash", input: { command: `sleep ${SLEEP}` } }], "tool_use", usage))
    return sse(message([{ type: "text", text: "E2E-OK" }], "end_turn", usage))
  },
})
console.log(`fake anthropic on ${server.url}`)
