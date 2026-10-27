import fs from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import { loadEnvFiles } from '../packages/core/src/config/env.js'

loadEnvFiles({ cwd: process.cwd() })
const secret = () => randomBytes(32).toString('base64url')
const password = secret()
const env: Record<string, string> = {
  OQELIRA_SERVER_URL: 'http://127.0.0.1:4320',
  OQELIRA_AUTH_SECRET: secret(),
  OQELIRA_DATABASE_URL: `postgresql://oqelira:${password}@127.0.0.1:54329/oqelira`,
  OQELIRA_DB_PASSWORD: password,
  OQELIRA_ALLOW_SIGNUP: 'true',
  OQELIRA_RUNNER_URL: 'http://127.0.0.1:4321',
  OQELIRA_RUNNER_TOKEN: secret(),
  OQELIRA_WORKER_IMAGE: 'oqelira-worker:local',
  PORT: '4320',
}
for (const key of ['FOUNDRY_KEY', 'FOUNDRY_ENDPOINT', 'FOUNDRY_BASE_URL', 'OQELIRA_MODELS_JSON']) if (process.env[key]) env[key] = process.env[key]!
for (const value of Object.values(env)) if (/[\r\n]/.test(value)) throw new Error('Multiline configuration values are unsupported')
try {
  const file = await fs.open('.env.server', 'wx', 0o600)
  try { await file.writeFile('# Generated local development configuration. Never commit or share.\n' + Object.entries(env).map(([key,value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n') } finally { await file.close() }
  console.log('Created ignored .env.server with random local secrets. Existing Foundry configuration was copied without displaying it.')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code === 'EEXIST') console.log('.env.server already exists; nothing was overwritten.')
  else throw error
}
