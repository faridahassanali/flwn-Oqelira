import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
export function pglitePool(db: PGlite): Pool {
  let tail = Promise.resolve()
  async function connect() {
    const previous = tail
    let release!: () => void
    tail = new Promise<void>(resolve => { release = resolve })
    await previous
    return {
      async query(sql: string | { text: string; values?: unknown[] }, values?: unknown[]) {
        const query = typeof sql === 'string' ? sql : sql.text
        const args = typeof sql === 'string' ? values : sql.values
        if (!args?.length && query.includes(';') && !query.trim().toUpperCase().startsWith('SELECT')) { await db.exec(query); return { rows: [], rowCount: 0, command: query.split(' ')[0] } }
        const result = await db.query(query, args)
        return { ...result, rowCount: result.affectedRows ?? result.rows.length, command: query.trim().split(' ')[0]!.toUpperCase() }
      },
      release,
    }
  }
  return { connect, async query(sql: string, values?: unknown[]) { const client = await connect(); try { return await client.query(sql, values) } finally { client.release() } }, async end() {} } as unknown as Pool
}
