# opencode-cache-warmer

[pi](https://github.com/earendil-works/pi)'s prompt cache warming and cache-miss accounting, as an OpenCode v2 plugin.

Anthropic drops a prompt cache entry 5 minutes (or 1 hour) after its last use. The next request then pays the cache-write price for the whole prompt again. This plugin re-sends the last request with a one-token output cap shortly before the entry expires, but only when that is expected to save money.

It is a direct port of pi's `cache-warmer.ts` and `cache-stats.ts`. The tests compare it against pi's own code on random inputs.

## How it works (same as pi)

- **Exact replay.** It sends the request the session actually sent (after other plugins such as opencode-anth have rewritten it) with `max_tokens: 1`. The prefix is identical, so the refresh is a cache read and adds nothing to the cache. A Claude Code billing header (`cch=`) is recomputed for the new body.
- **Timing from the cache lifetime.** Refreshes happen at 90% of the lifetime, leaving at least 10 s of margin: 4m30s for the 5-minute cache, 54 min for the 1-hour cache. The tier is read from the request's own `cache_control` breakpoints (`ttl: "1h"` everywhere means 1 hour).
- **Late-timer guard.** If a timer fires too late (sleep, blocked event loop), the refresh is skipped: it would be a full-price write, not a warm.
- **Only when it pays.** It refreshes when `p × (miss cost − hit cost) − refresh cost ≥ $0.05`, recalculated before every refresh from OpenCode's model prices and the prompt size.
  - `p` = 100% while the agent is running (e.g. a long tool call).
  - `p` = 15% while idle, pi's figure measured from real usage.
- **Modes.** `streaming` (default) warms only while the agent is running. `idle` also warms between turns. `off` disables warming.
- **Limits.** Warming during a run stops after 60 minutes, idle warming after 30 minutes.
- **Stops as soon as the context changes:** model or agent switch, revert, compaction, or session deletion.
- **Not replayable, so skipped:** budget-based thinking (`thinking.type: "enabled"`). Its budget comes from `max_tokens`, so the replay would miss the cache. Adaptive thinking is fine.
- **Cache-miss detection** (all providers). Each step's prompt tokens that were in the previous request but weren't cache reads count as a miss, with the dollar cost. Misses of 1k tokens or less are ignored. A warm refresh re-anchors the baseline; compaction resets it.

Like pi, only **direct Anthropic** has a built-in cache lifetime. Other providers that use the Anthropic Messages API (proxies, gateways) can opt in with `lifetimes`.

## Install

```jsonc
// ~/.config/opencode/opencode.json
{
  "plugins": [
    { "package": "github:rumisle/opencode-cache-warmer", "options": { "mode": "idle" } }
  ]
}
```

Options:

| Option | Default | |
|---|---|---|
| `mode` | `"streaming"` | `"off"`, `"streaming"`, or `"idle"` |
| `lifetimes` | `{ "anthropic": { "short": 300, "long": 3600 } }` | Cache lifetime in seconds per `"provider"` or `"provider/model"`, merged per tier over the default |

`OPENCODE_CACHE_WARMER_DEBUG=1` logs each start, refresh, stop reason, and cache miss to stderr (`opencode serve --print-logs`).

## Transcript notices (ocelot)

On [ocelot](https://github.com/rumisle/ocelot) (patch `core/session-notices`), the plugin also posts notices into the session transcript, which the web app and the TUI show. The model never sees them.

- `Cache kept warm · 3 refreshes · $0.09`: one notice per run of refreshes with nothing sent in between, updated in place. Each refresh's usage counts toward the session's cost and tokens, like pi's `cache_warm` usage entries.
- `Cache miss after 7m idle · 150k tokens re-billed · ~$0.72` (a warning): significant misses, pi's threshold (20k+ tokens or $0.10+).

Stock OpenCode has no notices, so there the plugin skips them.

## TUI sidebar

The package also has a TUI half (`./tui`), which the OpenCode TUI loads automatically for an installed server plugin. It adds a **Cache** block to the session sidebar:

```
Cache
Refresh in 3m 12s (idle)
expected saving ~$0.08
5 refreshes · $0.15
1 miss · 150k tokens · ~$0.72
```

- The first line is the next warm-or-stop decision, or why warming stopped (`Stopped: agent run settled`, `Stopped: expected savings below threshold`, …).
- Refresh and miss totals are per session and survive restarts.
- A significant miss (20k+ tokens or $0.10+, pi's threshold) also shows a toast: `Cache miss after 7m idle: 150k tokens re-billed (~$0.72)`.

The server pushes updates over the plugin's RPC (`./rpc`: `status` method, `update` event), so the countdown stays correct when the TUI runs on another machine.

The web UI has no plugin slots, so it shows none of this.

## Where the numbers go

Each refresh and each counted miss is recorded in the plugin's storage under `session/<sessionID>`: counts, dollar totals, and the last 50 records.

OpenCode's own session cost does not include refreshes: its usage records (`session.usage.recorded`) only accept title and compaction usage, and plugins can't publish them. Fixing that needs an upstream change.

## Tests

```bash
bun test                                     # unit tests + differential tests against pi (needs ~/work/pi-mono or PI_MONO)
ANTHROPIC_OAUTH_TOKEN=... bun test/real-anthropic.ts   # real API: replay must read the whole prompt from cache
```

`test/fake-anthropic.ts` is a fake Anthropic API for end-to-end runs with `opencode serve` and opencode-anth. It logs every request with its `max_tokens` and whether its billing hash is valid.

## Development

`tui.js` is generated from `tui.tsx`: run `bun install && bun scripts/build-tui.ts` after editing it. Installed plugins live under `node_modules`, where OpenTUI's runtime Solid transform does not run, so the published TUI entry has to be precompiled. A local checkout loads `tui.tsx` directly.
