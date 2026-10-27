import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createFoundry, foundryConfigFromEnv, DEFAULT_MODELS, loadEnvFiles } from '@oqelira/core'
import type { ModelConfig } from '@oqelira/core'
import { createHost } from './server.js'

const root = fileURLToPath(new URL('../../../', import.meta.url))
loadEnvFiles({ cwd: root })
const cwd = path.resolve(process.env.OQELIRA_WORKSPACE ?? root)
let config: ReturnType<typeof foundryConfigFromEnv> | undefined
try { config = foundryConfigFromEnv() } catch { /* UI shows setup guidance */ }
let models: readonly ModelConfig[] = DEFAULT_MODELS
if (process.env.OQELIRA_MODELS_JSON) {
  const value: unknown = JSON.parse(process.env.OQELIRA_MODELS_JSON)
  if (!Array.isArray(value) || !value.length || value.some(m => !m || typeof m.id !== 'string' || !m.id || typeof m.deployment !== 'string' || !m.deployment || !['chat', 'responses'].includes(m.api) || !['fast', 'slow'].includes(m.speed) || (m.reasoningEffort !== undefined && typeof m.reasoningEffort !== 'string')) || new Set(value.map(m => m.id)).size !== value.length) throw new Error('Invalid OQELIRA_MODELS_JSON')
  models = value as ModelConfig[]
}
const host = createHost({ cwd, dist: path.join(root, 'packages/web/dist'), models, configured: Boolean(config), provider: model => {
  if (!config) throw new Error('Foundry is not configured')
  return createFoundry(config)(model)
} })
const port = Number(process.env.OQELIRA_PORT ?? 4317)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid OQELIRA_PORT')
const origin = await host.listen(port)
process.stdout.write(`Oqelira workspace: ${origin}\n`)
process.send?.({ type: 'ready', origin })
const shutdown = () => { void host.close().finally(() => process.exit()) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
if (process.send) process.on('disconnect', shutdown)
