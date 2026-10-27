import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Pool } from 'pg'
import { createFoundry, foundryConfigFromEnv, modelsFromEnv } from '@oqelira/core'
import { createAuth } from './auth.js'
import { serverConfig } from './config.js'
import { Store } from './store.js'
import { DockerSandbox } from './sandbox.js'
import { RemoteSandbox } from './remote-sandbox.js'
import { createCloudServer } from './server.js'
import {smtpDelivery,startAccountMail,enqueueAccountMail} from './mail.js'

const config = serverConfig()
const pool = new Pool({ connectionString: config.databaseURL, max: 10, connectionTimeoutMillis: 10000, idleTimeoutMillis: 30000 })
const mailSender=smtpDelivery(config.smtpURL,config.smtpFrom,config.baseURL)
// Auth transactions must not wait for a second connection from their own saturated pool.
const mailPool=mailSender?new Pool({connectionString:config.databaseURL,max:2,connectionTimeoutMillis:5000,idleTimeoutMillis:30000}):undefined
// Fail startup on missing provider credentials, not on the first user's task.
const foundry = createFoundry(foundryConfigFromEnv())
const root = fileURLToPath(new URL('../../../', import.meta.url))
const runnerURL = process.env.OQELIRA_RUNNER_URL
if (config.production && (!runnerURL || new URL(runnerURL).protocol !== 'https:')) throw new Error('Production requires a private HTTPS sandbox runner; local execution is forbidden')
const sandbox = runnerURL ? new RemoteSandbox(runnerURL, process.env.OQELIRA_RUNNER_TOKEN ?? '') : new DockerSandbox(process.env.OQELIRA_WORKER_IMAGE)
const socialProviders:('google'|'github')[]=[]
if(config.google)socialProviders.push('google')
if(config.github)socialProviders.push('github')
const server = createCloudServer({ auth: createAuth(pool, config,mailPool?email=>enqueueAccountMail(mailPool,email):undefined), store: new Store(pool), sandbox, origin: config.baseURL, dist: path.join(root, 'packages/web/dist'), models: modelsFromEnv(), provider: foundry,authCapabilities:{signup:config.signup,emailRecovery:!!mailSender,verification:config.requireEmailVerification,socialProviders} })
await pool.query('SELECT 1')
const stopMail=startAccountMail(mailPool??pool,mailSender)
await server.listen(config.port, process.env.OQELIRA_LISTEN_HOST ?? '127.0.0.1')
process.stdout.write('Oqelira multi-user server ready\n')
const shutdown = () => { stopMail();void server.close().then(() => Promise.all([pool.end(),mailPool?.end()])).finally(() => process.exit()) }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown)
