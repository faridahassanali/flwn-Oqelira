import { Pool } from 'pg'
import fs from 'node:fs/promises'
import { getMigrations } from 'better-auth/db/migration'
import { createAuth } from './auth.js'
import { serverConfig } from './config.js'

export async function migrate(pool: Pool, config: ReturnType<typeof serverConfig>) {
  const auth = createAuth(pool, config)
  const { runMigrations } = await getMigrations(auth.options)
  await runMigrations()
  await pool.query(await fs.readFile(new URL('./schema.sql', import.meta.url), 'utf8'))
}
if (process.argv[1]?.replaceAll('\\', '/').endsWith('/migrate.ts')) {
  const config = serverConfig(), pool = new Pool({ connectionString: config.databaseURL, max: 2 })
  try { await migrate(pool, config); process.stdout.write('Database migrations complete\n') }
  finally { await pool.end() }
}
