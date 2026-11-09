import { Pool } from 'pg'
import { createFoundry, foundryConfigFromEnv } from '@oqelira/core'
import { gatewayConfig } from './config.js'
import { createGatewayServer } from './server.js'
import { migrate } from './store.js'

// Fail at startup on missing keys, prices or limits, not on a user's first request.
const config = gatewayConfig()
const foundry = foundryConfigFromEnv()
const pool = new Pool({ connectionString: config.databaseURL, max: 10, connectionTimeoutMillis: 10000 })
await migrate(pool)
const server = createGatewayServer({ db: pool, config, provider: createFoundry(foundry), knownSecrets: [foundry.apiKey] })
// Gateway listens on a private interface; put TLS and the public edge (APIM / Container Apps ingress) in front.
server.listen(config.port, process.env.OQELIRA_GATEWAY_HOST ?? '127.0.0.1', () => process.stdout.write('Oqelira model gateway ready\n'))
const shutdown = () => { server.close(() => void pool.end().finally(() => process.exit())) }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
