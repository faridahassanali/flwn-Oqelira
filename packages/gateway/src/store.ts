import type { Bucket } from './limits.js'

/** Anything with a pg-style query(). Both pg's Pool and the PGlite test adapter fit. */
export interface Db {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>
}

/** One statement per entry so drivers without multi-statement support can run it. */
export const schema: string[] = [
  `CREATE TABLE IF NOT EXISTS gw_requests (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    ts timestamptz NOT NULL,
    user_id text NOT NULL,
    org_id text NOT NULL,
    device_id text NOT NULL,
    model text NOT NULL,
    decision text NOT NULL CHECK (decision IN ('allowed', 'blocked', 'limited', 'failed')),
    reasons text[] NOT NULL DEFAULT '{}',
    input_tokens bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    cost_micro bigint NOT NULL DEFAULT 0,
    usage_source text NOT NULL CHECK (usage_source IN ('foundry', 'estimate', 'none'))
  )`,
  'CREATE INDEX IF NOT EXISTS gw_requests_user ON gw_requests (user_id, ts)',
  'CREATE INDEX IF NOT EXISTS gw_requests_org ON gw_requests (org_id, ts)',
  `CREATE TABLE IF NOT EXISTS gw_revocations (
    user_id text PRIMARY KEY,
    revoked_at timestamptz NOT NULL
  )`,
]

export async function migrate(db: Db): Promise<void> {
  for (const statement of schema) await db.query(statement)
}

export interface RequestRecord {
  ts: Date
  userId: string
  orgId: string
  deviceId: string
  model: string
  decision: 'allowed' | 'blocked' | 'limited' | 'failed'
  reasons: string[]
  inputTokens: number
  outputTokens: number
  costMicro: number
  usageSource: 'foundry' | 'estimate' | 'none'
}

/** Decision log and usage meter in one table. It holds reason codes and token counts, never prompt or completion text. */
export async function recordRequest(db: Db, r: RequestRecord): Promise<void> {
  await db.query(
    `INSERT INTO gw_requests (ts, user_id, org_id, device_id, model, decision, reasons, input_tokens, output_tokens, cost_micro, usage_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [r.ts, r.userId, r.orgId, r.deviceId, r.model, r.decision, r.reasons, r.inputTokens, r.outputTokens, r.costMicro, r.usageSource],
  )
}

/** Recent requests for one user (or one org) since `since`, as buckets for the limit checks. */
export async function usageSince(db: Db, by: 'user_id' | 'org_id', key: string, since: Date): Promise<Bucket[]> {
  const { rows } = await db.query(
    `SELECT ts, input_tokens + output_tokens AS tokens, cost_micro FROM gw_requests WHERE ${by} = $1 AND ts >= $2 ORDER BY ts`,
    [key, since],
  )
  return rows.map((row) => ({ ts: new Date(row.ts as string | Date).getTime(), tokens: Number(row.tokens), costMicro: Number(row.cost_micro) }))
}

export async function isRevoked(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query('SELECT 1 FROM gw_revocations WHERE user_id = $1', [userId])
  return rows.length > 0
}

/** Kills every token for the user on their next request. The Foundry key is not involved. */
export async function revokeUser(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.query('INSERT INTO gw_revocations (user_id, revoked_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING', [userId, now])
}

/** Restores token minting. Callers must not let a user undo their own revocation. */
export async function unrevokeUser(db: Db, userId: string): Promise<void> {
  await db.query('DELETE FROM gw_revocations WHERE user_id = $1', [userId])
}
