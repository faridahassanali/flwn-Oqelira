export interface UsageStore {
  recordUsage(event: UsageEvent): void
  usageSince(since: Date): { tokens: number; oldestAt?: Date }
}

export interface UsageEvent {
  at: Date
  model: string
  inputTokens: number
  outputTokens: number
}

export interface UsageLimits {
  fiveHours?: number
  weekly?: number
}

export class UsageLimitError extends Error {
  constructor(readonly window: '5-hour' | 'weekly', readonly freesAt: Date) {
    super(`${window} token limit reached. Usage becomes available again at ${freesAt.toLocaleString()}.`)
  }
}

const WINDOWS = [
  { name: '5-hour' as const, durationMs: 5 * 60 * 60 * 1000, limit: (limits: UsageLimits) => limits.fiveHours },
  { name: 'weekly' as const, durationMs: 7 * 24 * 60 * 60 * 1000, limit: (limits: UsageLimits) => limits.weekly },
]

/** Enforces configured rolling token windows at model-request boundaries. */
export class UsageTracker {
  constructor(private store: UsageStore, private limits: UsageLimits, private now: () => Date = () => new Date()) {}

  check(): void {
    const now = this.now()
    for (const window of WINDOWS) {
      const limit = window.limit(this.limits)
      if (!limit) continue
      const usage = this.store.usageSince(new Date(now.getTime() - window.durationMs))
      if (usage.tokens >= limit) {
        const freesAt = usage.oldestAt ? new Date(usage.oldestAt.getTime() + window.durationMs) : now
        throw new UsageLimitError(window.name, freesAt)
      }
    }
  }

  record(model: string, usage: { inputTokens?: number; outputTokens?: number }): void {
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) return
    if (inputTokens + outputTokens === 0) return
    this.store.recordUsage({ at: this.now(), model, inputTokens, outputTokens })
  }

  warnings(): string[] {
    const now = this.now()
    const notices: string[] = []
    for (const window of WINDOWS) {
      const limit = window.limit(this.limits)
      if (!limit) continue
      const usage = this.store.usageSince(new Date(now.getTime() - window.durationMs))
      if (usage.tokens >= Math.ceil(limit * 0.8) && usage.tokens < limit) notices.push(`${window.name} token usage is ${usage.tokens}/${limit} (${Math.floor((usage.tokens / limit) * 100)}%).`)
    }
    return notices
  }
}

export function usageLimitsFromEnv(env: NodeJS.ProcessEnv = process.env): UsageLimits {
  const parse = (name: string) => {
    const raw = env[name]?.trim()
    if (!raw) return undefined
    const value = Number(raw)
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`)
    return value
  }
  return { fiveHours: parse('OQELIRA_USAGE_5H_TOKENS'), weekly: parse('OQELIRA_USAGE_WEEKLY_TOKENS') }
}
