export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

export type Reading = { limits: Limit[]; at: number }

export type Tokens = { total: number; output: number }

declare module 'claude-code' {
  interface PluginState {
    'quota-meter': {
      limits: Limit[]
      isStale: boolean
      usd: number | null
      tokens: Tokens
      now: number
      isHidden: boolean
    }
  }
}
