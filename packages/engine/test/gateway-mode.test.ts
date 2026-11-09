import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { test } from 'node:test'
import { createEngine } from '../src/engine.js'
import type { HostEvent } from '@oqelira/protocol'

const KEYS = ['FOUNDRY_KEY', 'FOUNDRY_BASE_URL', 'FOUNDRY_ENDPOINT', 'OQELIRA_GATEWAY_URL', 'OQELIRA_GATEWAY_TOKEN', 'OQELIRA_NO_ENV_FILES', 'OQELIRA_HOME', 'OQELIRA_EMBEDDING_DEPLOYMENT']

async function withEnv(env: Record<string, string>, fn: () => Promise<void>) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  for (const k of KEYS) delete process.env[k]
  Object.assign(process.env, { OQELIRA_NO_ENV_FILES: '1' }, env)
  try { await fn() } finally { for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
}

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oq-gw-'))

async function runOnce(handler: http.RequestListener, extra: Record<string, string> = {}) {
  const server = http.createServer(handler)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const events: HostEvent[] = []
  try {
    await withEnv({ OQELIRA_GATEWAY_URL: url, OQELIRA_GATEWAY_TOKEN: 'tok', OQELIRA_HOME: tmp(), ...extra }, async () => {
      const engine = await createEngine({ cwd: tmp() })
      await engine.run('hi', { approve: async () => ({ allowed: false }) as never, onEvent: (e) => events.push(e) })
    })
  } finally { server.close() }
  return events
}

test('gateway mode needs no Foundry key and sends only the token', async () => {
  let auth = ''
  const events = await runOnce((req, res) => {
    auth = String(req.headers.authorization)
    req.resume()
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Oqelira-Quota-Warning': '5h:80%' })
    res.end('{"type":"text-delta","text":"ok"}\n{"type":"finish","reason":"stop","usage":{"inputTokens":1,"outputTokens":1}}\n')
  })
  assert.equal(auth, 'Bearer tok')
  assert.ok(events.some((e) => e.type === 'text'))
  assert.ok(events.some((e) => e.type === 'notice' && /80%/.test(e.message)))
  assert.ok(events.some((e) => e.type === 'done'))
})

test('gateway mode ignores a Foundry key and endpoint in the environment', async () => {
  let hit = false
  const events = await runOnce((req, res) => { req.resume(); hit = true; res.writeHead(200).end('{"type":"finish","reason":"stop"}\n') }, { FOUNDRY_KEY: 'k', FOUNDRY_BASE_URL: 'https://attacker.test' })
  assert.ok(hit)
  assert.ok(events.some((e) => e.type === 'done'))
})

test('gateway refusals reach the user as readable errors', async () => {
  const refuse = (status: number, body: object) => runOnce((req, res) => { req.resume(); res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body)) })
  const msg = (events: HostEvent[]) => (events.find((e) => e.type === 'error') as { message: string }).message
  assert.match(msg(await refuse(401, { error: 'Token revoked' })), /Sign in again/)
  assert.match(msg(await refuse(429, { error: 'Usage limit reached', retryAt: '2030-01-01T05:00:00.000Z' })), /frees up at/)
  assert.match(msg(await refuse(422, { error: 'Blocked by gateway', reasons: ['x'] })), /Blocked by the gateway: x/)
})

test('without a gateway the default is direct Foundry and its key is required', async () => {
  await withEnv({}, async () => {
    await assert.rejects(createEngine({ cwd: tmp() }), /FOUNDRY_KEY/)
  })
  await withEnv({ OQELIRA_GATEWAY_URL: 'https://gw.example.com' }, async () => {
    await assert.rejects(createEngine({ cwd: tmp() }), /OQELIRA_GATEWAY_TOKEN/)
  })
})
