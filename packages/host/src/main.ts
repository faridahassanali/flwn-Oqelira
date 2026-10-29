import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { foundryConfigFromEnv, modelsFromEnv, loadEnvFiles } from '@oqelira/core'
import { spawnEngine } from './engine-client.js'
import { createHost } from './server.js'

// Only the desktop app starts this process, and it passes a fresh secret. Take it from the real
// environment and drop it so the engine child never inherits it.
const launchToken = process.env.OQELIRA_LAUNCH_TOKEN ?? ''
delete process.env.OQELIRA_LAUNCH_TOKEN
if (launchToken.length < 32) {
  process.stderr.write('The Oqelira host is started by the desktop app: run `npm run desktop`.\n')
  process.exit(2)
}
const root = fileURLToPath(new URL('../../../', import.meta.url))
loadEnvFiles({ cwd: root })
const cwd = path.resolve(process.env.OQELIRA_WORKSPACE ?? root)
let config: ReturnType<typeof foundryConfigFromEnv> | undefined
try { config = foundryConfigFromEnv() } catch { /* UI shows setup guidance */ }
const models = modelsFromEnv()
const host = createHost({ cwd, dist: path.join(root, 'packages/web/dist'), models, configured: Boolean(config), launchToken, startEngine: () => spawnEngine({ cwd }) })
const port = Number(process.env.OQELIRA_PORT ?? 4317)
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid OQELIRA_PORT')
const origin = await host.listen(port)
process.stdout.write(`Oqelira workspace: ${origin}\n`)
process.send?.({ type: 'ready', origin })
const shutdown = () => { void host.close().finally(() => process.exit()) }
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
if (process.send) process.on('disconnect', shutdown)
