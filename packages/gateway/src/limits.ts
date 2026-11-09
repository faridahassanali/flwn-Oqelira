import type { GatewayLimits } from './config.js'

/** One recorded request, as the limit checks see it. No content. */
export interface Bucket { ts: number; tokens: number; costMicro: number }
export interface Totals { tokens: number; costMicro: number; count: number }

const MINUTE = 60_000, HOUR = 60 * 60_000, WEEK = 7 * 24 * HOUR
export const FIVE_HOURS = 5 * HOUR
export const WEEK_MS = WEEK
export const MINUTE_MS = MINUTE

/**
 * When the window stops being over its limit: drop the oldest requests until it is under, and report
 * when the last dropped one leaves the window. Null if the window is not over.
 */
export function freeAt(buckets: readonly Bucket[], now: number, windowMs: number, over: (t: Totals) => boolean): number | null {
  const live = buckets.filter((b) => b.ts > now - windowMs).sort((a, b) => a.ts - b.ts)
  const t: Totals = { tokens: 0, costMicro: 0, count: live.length }
  for (const b of live) { t.tokens += b.tokens; t.costMicro += b.costMicro }
  if (!over(t)) return null
  for (const b of live) {
    t.tokens -= b.tokens; t.costMicro -= b.costMicro; t.count -= 1
    if (!over(t)) return b.ts + windowMs
  }
  return now + windowMs
}

export interface Breach { reason: string; retryAt: number }

/**
 * Evaluates every ceiling before a request is forwarded. `userRows` covers at least the weekly window,
 * `orgRows` the org's weekly window. Ceilings already reached stop the request; the caller gets the
 * latest time at which all breached windows are free.
 */
export function evaluateLimits(l: GatewayLimits, now: number, userRows: readonly Bucket[], orgRows: readonly Bucket[]): { breaches: Breach[]; warnings: string[] } {
  const usd = (x: number) => x * 1_000_000
  const rules: { reason: string; windowMs: number; rows: readonly Bucket[]; over: (t: Totals) => boolean; near?: (t: Totals) => boolean }[] = [
    { reason: 'quota:5h-tokens', windowMs: FIVE_HOURS, rows: userRows, over: (t) => l.fiveHourTokens !== undefined && t.tokens >= l.fiveHourTokens, near: (t) => l.fiveHourTokens !== undefined && t.tokens >= 0.8 * l.fiveHourTokens },
    { reason: 'quota:weekly-tokens', windowMs: WEEK, rows: userRows, over: (t) => l.weeklyTokens !== undefined && t.tokens >= l.weeklyTokens, near: (t) => l.weeklyTokens !== undefined && t.tokens >= 0.8 * l.weeklyTokens },
    { reason: 'quota:user-weekly-spend', windowMs: WEEK, rows: userRows, over: (t) => t.costMicro >= usd(l.userWeeklyUsd) },
    { reason: 'quota:org-weekly-spend', windowMs: WEEK, rows: orgRows, over: (t) => t.costMicro >= usd(l.orgWeeklyUsd) },
    { reason: 'rate:requests-per-minute', windowMs: MINUTE, rows: userRows, over: (t) => t.count >= l.requestsPerMinute },
  ]
  const breaches: Breach[] = []
  const warnings: string[] = []
  for (const r of rules) {
    const at = freeAt(r.rows, now, r.windowMs, r.over)
    if (at !== null) breaches.push({ reason: r.reason, retryAt: at })
    else if (r.near && freeAt(r.rows, now, r.windowMs, r.near) !== null) warnings.push(r.reason)
  }
  return { breaches, warnings }
}
