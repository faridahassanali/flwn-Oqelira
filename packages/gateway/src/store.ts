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
    user_id text NOT NULL,
    org_id text NOT NULL DEFAULT '',
    valid_after bigint NOT NULL,
    blocked boolean NOT NULL DEFAULT false,
    PRIMARY KEY (user_id, org_id)
  )`,
  // Legacy shape (user_id PK, revoked_at): keep each row as a global block. No-op once migrated.
  `DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'gw_revocations' AND column_name = 'revoked_at') THEN
      ALTER TABLE gw_revocations ADD COLUMN org_id text NOT NULL DEFAULT '', ADD COLUMN valid_after bigint, ADD COLUMN blocked boolean NOT NULL DEFAULT true;
      UPDATE gw_revocations SET valid_after = (extract(epoch FROM revoked_at) * 1000)::bigint;
      ALTER TABLE gw_revocations ALTER COLUMN valid_after SET NOT NULL, ALTER COLUMN blocked SET DEFAULT false, DROP COLUMN revoked_at;
      ALTER TABLE gw_revocations DROP CONSTRAINT gw_revocations_pkey, ADD PRIMARY KEY (user_id, org_id);
    END IF;
  END $$`,
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

/** Row (user, '') is user-global; (user, org) applies only to tokens whose org claim is that org. */
const MATCH = "user_id = $1 AND org_id IN ('', $2)"

/** True when a matching row blocks the user, or says tokens issued at or before `iat` (epoch ms) are void. */
export async function isRevoked(db: Db, userId: string, orgId: string, iat: number): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM gw_revocations WHERE ${MATCH} AND (blocked OR valid_after >= $3)`, [userId, orgId, iat])
  return rows.length > 0
}

/** Minting check: only an explicit block refuses; old valid_after is irrelevant to a fresh token. */
export async function isBlocked(db: Db, userId: string, orgId: string): Promise<boolean> {
  const { rows } = await db.query(`SELECT 1 FROM gw_revocations WHERE ${MATCH} AND blocked`, [userId, orgId])
  return rows.length > 0
}

/** Epoch ms before which a user's sessions may no longer mint tokens (their last self revoke), or 0. */
export async function revokedBefore(db: Db, userId: string): Promise<number> {
  const { rows } = await db.query("SELECT valid_after FROM gw_revocations WHERE user_id = $1 AND org_id = ''", [userId])
  return rows.length ? Number(rows[0]?.valid_after) : 0
}

/** Self revoke: voids every token issued so far. Keeps an existing block (it is not the user's to lift). */
export async function revokeUser(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO gw_revocations (user_id, org_id, valid_after, blocked) VALUES ($1, '', $2, false)
     ON CONFLICT (user_id, org_id) DO UPDATE SET valid_after = GREATEST(gw_revocations.valid_after, EXCLUDED.valid_after)`,
    [userId, now.getTime()],
  )
}

/** Org admin block: voids the user's tokens for that org and refuses new ones until unblocked. */
export async function blockUser(db: Db, userId: string, orgId: string, now = new Date()): Promise<void> {
  await db.query(
    `INSERT INTO gw_revocations (user_id, org_id, valid_after, blocked) VALUES ($1, $2, $3, true)
     ON CONFLICT (user_id, org_id) DO UPDATE SET valid_after = GREATEST(gw_revocations.valid_after, EXCLUDED.valid_after), blocked = true`,
    [userId, orgId, now.getTime()],
  )
}

/** Lifts the block but keeps valid_after, so tokens issued before the block stay dead. */
export async function unblockUser(db: Db, userId: string, orgId: string): Promise<void> {
  await db.query('UPDATE gw_revocations SET blocked = false WHERE user_id = $1 AND org_id = $2', [userId, orgId])
}
