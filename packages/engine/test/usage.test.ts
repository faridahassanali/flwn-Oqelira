import assert from 'node:assert/strict'
import { test } from 'node:test'
import { UsageLimitError, UsageTracker, usageLimitsFromEnv } from '../src/usage.js'
import type { UsageEvent, UsageStore } from '../src/usage.js'

class MemoryUsageStore implements UsageStore {
  events: UsageEvent[] = []
  recordUsage(event: UsageEvent) { this.events.push(event) }
  usageSince(since: Date) {
    const events = this.events.filter(event => event.at >= since)
    return { tokens: events.reduce((sum, event) => sum + event.inputTokens + event.outputTokens, 0), oldestAt: events[0]?.at }
  }
}

test('usage tracker counts input and output tokens in rolling windows and reports when capacity returns', () => {
  const now = new Date('2026-11-09T12:00:00.000Z')
  const store = new MemoryUsageStore()
  const tracker = new UsageTracker(store, { fiveHours: 100 }, () => now)
  tracker.record('fixture', { inputTokens: 60, outputTokens: 20 })
  assert.deepEqual(tracker.warnings(), ['5-hour token usage is 80/100 (80%).'])
  tracker.record('fixture', { inputTokens: 10, outputTokens: 10 })
  assert.throws(() => tracker.check(), (error: unknown) => error instanceof UsageLimitError && error.window === '5-hour' && error.freesAt.toISOString() === '2026-11-09T17:00:00.000Z')
})

test('usage tracker expires old events from rolling windows', () => {
  const now = new Date('2026-11-09T12:00:00.000Z')
  const store = new MemoryUsageStore()
  store.recordUsage({ at: new Date('2026-11-09T06:59:59.999Z'), model: 'fixture', inputTokens: 100, outputTokens: 0 })
  const tracker = new UsageTracker(store, { fiveHours: 100 }, () => now)
  assert.doesNotThrow(() => tracker.check())
})

test('usage limits come only from explicit positive configuration', () => {
  assert.deepEqual(usageLimitsFromEnv({}), { fiveHours: undefined, weekly: undefined })
  assert.deepEqual(usageLimitsFromEnv({ OQELIRA_USAGE_5H_TOKENS: '50', OQELIRA_USAGE_WEEKLY_TOKENS: '500' }), { fiveHours: 50, weekly: 500 })
  assert.throws(() => usageLimitsFromEnv({ OQELIRA_USAGE_5H_TOKENS: '0' }), /positive integer/)
})
