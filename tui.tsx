/** @jsxImportSource @opentui/solid */
// Sidebar block for opencode-cache-warmer: pi's `/session` cache warming line, warming spend,
// and cache misses, pushed live from the server plugin over RPC. Significant misses also toast,
// like pi's transcript notices.
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, on, onCleanup, Show } from "solid-js"
import { Definition, type Snapshot } from "./rpc.ts"

const usd = (value: number) => (value < 0.01 && value > 0 ? `$${value.toFixed(3)}` : `$${value.toFixed(2)}`)
const tokens = (value: number) =>
  value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1000 ? `${Math.round(value / 1000)}k` : String(value)

function countdown(ms: number) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const m = Math.floor(total / 60)
  return m > 0 ? `${m}m ${String(total % 60).padStart(2, "0")}s` : `${total}s`
}

export default Plugin.define({
  id: "opencode-cache-warmer.sidebar",
  setup(context) {
    const rpc = context.client.rpc(Definition as any) as any
    // Latest snapshot per session, stamped with local receipt time to correct for clock skew.
    const [snapshots, setSnapshots] = createSignal<Record<string, Snapshot & { receivedAt: number }>>({})
    const store = (snap: Snapshot) => setSnapshots((all) => ({ ...all, [snap.sessionID]: { ...snap, receivedAt: Date.now() } }))

    const off = rpc.events.on("update", (event: { data: Snapshot }) => {
      const snap = event.data
      store(snap)
      if (snap.notice) context.ui.toast.show({ variant: "warning", message: snap.notice, sessionID: snap.sessionID })
    })

    const [now, setNow] = createSignal(Date.now())
    const tick = setInterval(() => setNow(Date.now()), 1000)

    function Block(props: { sessionID: string }) {
      const theme = context.theme
      const snap = createMemo(() => snapshots()[props.sessionID])

      // Fetch once per session shown; later changes arrive as events.
      createEffect(
        on(
          () => props.sessionID,
          (sessionID) => {
            const location = context.data.session.get(sessionID)?.location
            rpc
              .status({ sessionID }, location ? { location } : undefined)
              .then((result: Snapshot) => result && store(result))
              .catch(() => {})
          },
        ),
      )

      // Two short lines: the sidebar is narrow.
      const line = createMemo(() => {
        const s = snap()
        if (!s) return undefined
        if (s.mode === "off") return "Warming off"
        if (s.state === "refreshing") return "Refreshing…"
        if (s.state === "scheduled" && s.nextWarmAt) {
          const localAt = s.nextWarmAt - s.serverNow + s.receivedAt
          return `Refresh in ${countdown(localAt - now())} (${s.phase === "idle" ? "idle" : "running"})`
        }
        return `Stopped: ${s.reason ?? "inactive"}`
      })
      const detail = createMemo(() => {
        const s = snap()
        if (!s || s.state === "inactive" || s.expectedSavings === undefined) return undefined
        return `expected saving ~${usd(Math.max(0, s.expectedSavings))}`
      })

      return (
        <Show when={snap()}>
          {(s) => (
            <box>
              <text fg={theme.text.base}>
                <b>Cache</b>
              </text>
              <text fg={theme.text.muted}>{line()}</text>
              <Show when={detail()}>
                <text fg={theme.text.muted}>{detail()}</text>
              </Show>
              <Show when={s().warms.count > 0}>
                <text fg={theme.text.muted}>
                  {s().warms.count} {s().warms.count === 1 ? "refresh" : "refreshes"} · {usd(s().warms.cost)}
                </text>
              </Show>
              <Show when={s().misses.count > 0}>
                <text fg={theme.text.feedback.warning.base}>
                  {s().misses.count} {s().misses.count === 1 ? "miss" : "misses"} · {tokens(s().misses.tokens)} tokens · ~
                  {usd(s().misses.cost)}
                </text>
              </Show>
            </box>
          )}
        </Show>
      )
    }

    const release = context.ui.slot({
      append: "sidebar.content",
      render: (props) => <Block sessionID={props.sessionID} />,
    })

    return () => {
      release()
      off()
      clearInterval(tick)
    }
  },
})
