// Shared RPC contract between the server plugin (index.ts) and the TUI sidebar (tui.tsx).

export const RPC_ID = "opencode-cache-warmer"

export interface Snapshot {
  sessionID: string
  mode: "off" | "streaming" | "idle"
  /** Server clock when the snapshot was taken; the TUI uses it to convert `nextWarmAt` to its own clock. */
  serverNow: number
  state: "inactive" | "scheduled" | "refreshing"
  reason?: string
  nextWarmAt?: number
  phase?: "streaming" | "idle"
  expectedSavings?: number
  action?: "warm" | "stop"
  economicsAvailable?: boolean
  /** pi's one-line `/session` status. */
  line: string
  warms: { count: number; cost: number }
  misses: { count: number; tokens: number; cost: number }
  /** Set on the update that carries a newly counted miss worth showing (pi's notice threshold). */
  notice?: string
}

const snapshotSchema = { type: "object", additionalProperties: true } as const

export const Definition = {
  id: RPC_ID,
  methods: {
    status: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: snapshotSchema,
    },
  },
  events: {
    update: { schema: snapshotSchema },
  },
} as const
