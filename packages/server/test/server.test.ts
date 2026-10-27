import { pglitePool } from './database.js'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { PGlite } from '@electric-sql/pglite'
import type { Pool } from 'pg'
import type { ModelProvider, Message } from '@oqelira/core'
import { builtinTools } from '@oqelira/core'
import type { HostEvent } from '@oqelira/protocol'
import { createAuth } from '../src/auth.js'
import { migrate } from '../src/migrate.js'
import { Store, recoverHistory } from '../src/store.js'
import { createCloudServer } from '../src/server.js'
import { serverConfig } from '../src/config.js'
import { dockerArgs } from '../src/sandbox.js'
import path from 'node:path'
import { createServer as createNetServer } from 'node:net'
import fs from 'node:fs/promises'
import os from 'node:os'

/** Real PostgreSQL engine in WASM; only the pg wire/client transport is adapted. */
test('configuration fails closed and sandbox arguments never mount the host or enable networking', () => {
  assert.throws(() => serverConfig({}), /Missing/)
  assert.throws(() => serverConfig({ OQELIRA_SERVER_URL: 'http://example.com', NODE_ENV: 'production' }), /HTTPS/)
  const production = { NODE_ENV: 'production', OQELIRA_SERVER_URL: 'https://oqelira.example.test', OQELIRA_AUTH_SECRET: '09c264f90a634f0b9fca9bcf3c06d6f2d3d069192dc848ab', OQELIRA_DATABASE_URL: 'postgres://fixture?sslmode=verify-full' }
  assert.equal(serverConfig(production).signup, false)
  assert.throws(() => serverConfig({ ...production, OQELIRA_ALLOW_SIGNUP: 'true' }), /Public signup is unavailable/)
  const args = dockerArgs(randomUUID(), randomUUID(), 'oqelira-worker:test')
  assert.ok(args.includes('none')); assert.ok(args.includes('--read-only')); assert.ok(args.includes('1000:1000'))
  assert.ok(!args.some(a => a.includes('docker.sock') || a.includes('type=bind') || a === '--privileged'))
  assert.throws(() => dockerArgs('../../host', randomUUID(), 'image'), /identity/)
})
test('recovery preserves known results and records missing outcomes instead of replaying commands', () => {
  const history: Message[] = [{ role: 'assistant', text: '', toolCalls: [{ id: 'a', name: 'run_command', input: { command: 'anything' } }, { id: 'b', name: 'write_file', input: {} }] }, { role: 'tool', results: [{ id: 'a', name: 'run_command', output: 'done' }] }]
  const recovered = recoverHistory(history)
  const result = recovered[1]!
  assert.equal(result.role, 'tool')
  assert.equal(result.results[0]!.output, 'done')
  assert.match(result.results[1]!.output, /outcome is unknown/)
  assert.equal(recoverHistory(recovered).length, recovered.length)
})
test('real auth, durable PostgreSQL sessions, tenant isolation, memory and approval ownership', { timeout: 120000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-database-'))
  const db = new PGlite(directory), pool = pglitePool(db)
  const reservation = createNetServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const reserved = reservation.address(); assert.ok(reserved && typeof reserved !== 'string')
  const port = reserved.port
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const config = serverConfig({ OQELIRA_SERVER_URL: `http://127.0.0.1:${port}`, OQELIRA_AUTH_SECRET: '09c264f90a634f0b9fca9bcf3c06d6f2d3d069192dc848ab', OQELIRA_DATABASE_URL: 'postgres://test', OQELIRA_ALLOW_SIGNUP: 'true' })
  await migrate(pool, config)
  const store = new Store(pool), auth = createAuth(pool, config)
  const provider: ModelProvider = { id: 'fixture', async *stream(req) {
    if (req.messages.at(-1)?.role === 'user') {
      yield { type: 'tool-call', call: { id: 'remember-1', name: 'remember_project', input: { content: 'Use the pastel theme' } } }
      yield { type: 'finish', reason: 'tool-calls' }
    } else { yield { type: 'text-delta', text: 'Saved' }; yield { type: 'finish', reason: 'stop' } }
  } }
  const server = createCloudServer({ auth, store, sandbox: { tools: () => builtinTools.map(tool => ({...tool, run: async () => 'fixture output'})) }, origin: config.baseURL, dist: path.resolve('packages/web/dist'), models: [{ id: 'fixture', deployment: 'fixture-deployment', api: 'chat', speed: 'fast' }], provider: () => provider })
  const address = await server.listen(port)
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const request = (route: string, cookie = '', data?: unknown, extra: Record<string, string> = {}) => fetch(origin + route, { headers: { Origin: config.baseURL, Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) })
  const signup = async (email: string) => {
    const response = await request('/api/auth/sign-up/email', '', { email, name: 'Test user', password: 'A long fixture password 9281!' })
    assert.equal(response.status, 200, await response.clone().text())
    const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ')
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/i)
    return { cookie, data: await response.json() as { user: { id: string } } }
  }
  try {
    assert.equal((await request('/api/projects')).status, 401)
    const a = await signup('a@example.test'), b = await signup('b@example.test')
    const project = await (await request('/api/projects', a.cookie, { name: 'Private project' })).json() as { id: string }
    assert.equal((await request('/api/projects', b.cookie)).status, 200)
    assert.deepEqual(await (await request('/api/projects', b.cookie)).json(), [])
    assert.equal((await request('/api/memory?projectId=' + project.id, b.cookie)).status, 404)
    assert.equal((await request('/api/memory', b.cookie, { projectId: project.id, content: 'injected' })).status, 404)
    for (const route of ['files', 'file', 'git']) assert.equal((await request(`/api/${route}?projectId=${project.id}`, b.cookie)).status, 404)
    assert.equal((await request('/api/file', b.cookie, { projectId:project.id,path:'a.txt',content:'injected' })).status, 404)
    assert.equal((await request('/api/file', a.cookie, { projectId:project.id,path:'a.txt',content:'owned text' })).status, 200)
    assert.equal((await request('/api/projects', a.cookie, { name: 'csrf' }, { Origin: 'https://untrusted.example' })).status, 403)
    const response = await request('/api/run', a.cookie, { projectId: project.id, model: 'fixture', prompt: 'Remember the theme' })
    assert.equal(response.status, 200, await (response.status !== 200 ? response.text() : Promise.resolve('')))
    const reader = response.body!.getReader(), decoder = new TextDecoder()
    let buffer = '', runId = '', conversation = '', completed = false
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break
      buffer += decoder.decode(chunk.value, { stream: true })
      let i: number
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (!line.trim()) continue
        const event = JSON.parse(line) as HostEvent
        if (event.type === 'started') { runId = event.runId; conversation = event.sessionId }
        if (event.type === 'approval') {
          assert.equal((await request('/api/approval', b.cookie, { runId, approvalId: event.approval.id, allowed: true })).status, 409)
          assert.equal((await request('/api/approval', a.cookie, { runId, approvalId: event.approval.id, allowed: true })).status, 200)
        }
        if (event.type === 'done') completed = true
      }
    }
    reader.releaseLock()
    assert.equal(completed, true)
    assert.equal((await request('/api/conversation?id=' + conversation, b.cookie)).status, 404)
    const saved = await (await request('/api/conversation?id=' + conversation, a.cookie)).json() as { messages: Message[] }
    assert.equal(saved.messages.at(-1)?.role, 'assistant')
    assert.equal((await new Store(pool).memory(a.data.user.id, project.id))[0]!.content, 'Use the pastel theme')
    const second = await store.createConversation(a.data.user.id, project.id, 'Second conversation', 'fixture')
    const firstRun = randomUUID(), otherRun = randomUUID()
    assert.equal(await store.claim(a.data.user.id, conversation, firstRun), true)
    assert.equal((await request('/api/file', a.cookie, { projectId:project.id,path:'a.txt',content:'race' })).status, 409)
    assert.equal(await store.claim(a.data.user.id, second, otherRun), false)
    await store.release(a.data.user.id, conversation, firstRun, 'ready')
    assert.equal(await store.claim(a.data.user.id, second, otherRun), true)
    await store.release(a.data.user.id, second, otherRun, 'ready')
    assert.equal(await store.takeQuota(a.data.user.id, 'fixture', 1, 3600), true)
    assert.equal(await store.takeQuota(a.data.user.id, 'fixture', 1, 3600), false)
    assert.equal(await store.takeQuota(b.data.user.id, 'fixture', 1, 3600), true)
    const signedOut = await request('/api/auth/sign-out', a.cookie, {})
    assert.equal(signedOut.status, 200)
    assert.equal((await request('/api/projects', a.cookie)).status, 401)
  } finally { await server.close(); await db.close() }
  const reopened = new PGlite(directory)
  try {
    assert.equal((await reopened.query<{count:string}>('SELECT count(*) FROM oq_projects')).rows[0]!.count, 1)
    assert.equal((await reopened.query('SELECT content FROM oq_memory')).rows.length, 1)
  } finally { await reopened.close(); await fs.rm(directory, {recursive:true,force:true}) }
})
