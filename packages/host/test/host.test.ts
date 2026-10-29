import assert from 'node:assert/strict'
import { test } from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { HostEvent } from '@oqelira/protocol'
import { startMock } from '../../core/test/mock-server.js'
import type { Reply } from '../../core/test/mock-server.js'
import { spawnEngine } from '../src/engine-client.js'
import { createHost } from '../src/server.js'

/** The model is a mock HTTP server; the agent is the real engine process the host bridges to. */
function script(body: any): Reply {
  const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user')?.content
  const last = body.messages.at(-1)
  if (last?.role === 'tool') return { text: `RESULT: ${last.content}` }
  if (lastUser === 'fail') return { fail: 'upstream credential: NEVER_ECHO_THIS' }
  if (lastUser === 'write') return { toolCall: { name: 'write_file', args: { path: 'result.txt', content: 'APPROVED' } } }
  if (lastUser === 'read') return { toolCall: { name: 'read_file', args: { path: 'hello.txt' } } }
  return { text: 'Hello world' }
}

async function fixture(fn: (f: { cwd: string; origin: string; requests: any[]; post: (route: string, body: unknown, extra?: Record<string, string>) => Promise<Response> }) => Promise<void>, timeout = 1000) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oqelira-host-'))
  await fs.writeFile(path.join(cwd, 'hello.txt'), 'HELLO')
  await fs.writeFile(path.join(cwd, 'index.html'), '<h1>Workspace</h1>')
  const mock = await startMock({ script })
  const env = { ...process.env, OQELIRA_NO_ENV_FILES: '1', FOUNDRY_BASE_URL: mock.baseURL, FOUNDRY_KEY: 'test-key' }
  const models = [{ id: 'mai-thinking', deployment: 'MAI-Thinking-1', api: 'chat' as const, speed: 'slow' as const }]
  const host = createHost({ cwd, dist: cwd, models, configured: true, startEngine: () => spawnEngine({ cwd, env, args: ['--approval-timeout-ms', String(timeout)] }) })
  const origin = await host.listen()
  const post = (route: string, body: unknown, extra: Record<string, string> = {}) => fetch(origin + route, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Oqelira-Client': 'workspace', ...extra }, body: JSON.stringify(body),
  })
  try { await fn({ cwd, origin, requests: mock.requests, post }) }
  finally { await host.close(); await mock.close(); await fs.rm(cwd, { recursive: true, force: true }) }
}
async function collect(response: Response, onEvent?: (event: HostEvent) => Promise<void>): Promise<HostEvent[]> {
  assert.equal(response.status, 200)
  const events: HostEvent[] = []
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return events
      buffer += decoder.decode(chunk.value, { stream: true })
      let i: number
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i); buffer = buffer.slice(i + 1)
        if (!line.trim()) continue
        const event = JSON.parse(line) as HostEvent
        events.push(event)
        await onEvent?.(event)
      }
    }
  } finally { reader.releaseLock() }
}

test('host serves the renderer with CSP and exposes deployment metadata without credentials', async () => {
  await fixture(async ({ origin }) => {
    const response = await fetch(origin)
    assert.match(response.headers.get('content-security-policy')!, /connect-src 'self'/)
    assert.match(await response.text(), /Workspace/)
    const config = await (await fetch(origin + '/api/config')).json()
    assert.deepEqual(Object.keys(config).sort(), ['configured', 'models', 'workspace'])
    assert.equal(config.models[0].deployment, 'MAI-Thinking-1')
  })
})
test('host rejects cross-origin, unmarked, malformed and invalid-model run requests', async () => {
  await fixture(async ({ post }) => {
    assert.equal((await post('/api/run', { prompt: 'hi', model: 'mai-thinking' }, { Origin: 'https://untrusted.example' })).status, 403)
    assert.equal((await post('/api/run', { prompt: 'hi', model: 'mai-thinking' }, { 'X-Oqelira-Client': '' })).status, 403)
    assert.equal((await post('/api/run', { prompt: 5, model: 'mai-thinking' })).status, 400)
    assert.equal((await post('/api/run', { prompt: 'hi', model: 'absent' })).status, 400)
    assert.equal((await post('/api/run', null)).status, 400)
    assert.equal((await post('/api/run', { prompt: 'hi', model: 'mai-thinking', sessionId: 'unknown' })).status, 404)
  })
})
test('host streams text and preserves server-owned history across turns', async () => {
  await fixture(async ({ post, requests }) => {
    const events = await collect(await post('/api/run', { prompt: 'hello', model: 'mai-thinking' }))
    assert.equal(events.filter(e => e.type === 'text').map(e => e.text).join(''), 'Hello world')
    const started = events.find(e => e.type === 'started')!
    assert.equal(started.type, 'started')
    await collect(await post('/api/run', { prompt: 'continue', model: 'mai-thinking', sessionId: started.sessionId }))
    assert.deepEqual(requests[1]!.body.messages.map((m: any) => m.role), ['system', 'user', 'assistant', 'user'])
    assert.equal(events.at(-1)?.type, 'done')
  })
})
test('read tool executes without a write approval and returns actual file content', async () => {
  await fixture(async ({ post }) => {
    const events = await collect(await post('/api/run', { prompt: 'read', model: 'mai-thinking' }))
    assert.ok(!events.some(e => e.type === 'approval'))
    assert.ok(events.some(e => e.type === 'tool-result' && e.output === 'HELLO'))
  })
})
for (const allowed of [false, true]) {
  test(`write tool waits for a matching approval; allowed=${allowed}`, async () => {
    await fixture(async ({ post, cwd }) => {
      let runId = ''
      const events = await collect(await post('/api/run', { prompt: 'write', model: 'mai-thinking' }), async event => {
        if (event.type === 'started') runId = event.runId
        if (event.type !== 'approval') return
        await assert.rejects(fs.access(path.join(cwd, 'result.txt')))
        assert.equal((await post('/api/approval', { runId, approvalId: 'wrong', allowed: true })).status, 409)
        assert.equal((await post('/api/approval', { runId, approvalId: event.approval.id, allowed: 'yes' })).status, 400)
        assert.equal((await post('/api/approval', { runId, approvalId: event.approval.id, allowed })).status, 200)
        assert.equal((await post('/api/approval', { runId, approvalId: event.approval.id, allowed })).status, 409)
      })
      assert.ok(events.some(e => e.type === 'tool-result' && Boolean(e.isError) === !allowed))
      if (allowed) assert.equal(await fs.readFile(path.join(cwd, 'result.txt'), 'utf8'), 'APPROVED')
      else await assert.rejects(fs.access(path.join(cwd, 'result.txt')))
    })
  })
}
test('expired approvals fail closed without writing a file', async () => {
  await fixture(async ({ post, cwd }) => {
    const events = await collect(await post('/api/run', { prompt: 'write', model: 'mai-thinking' }))
    assert.ok(events.some(e => e.type === 'tool-result' && e.isError))
    await assert.rejects(fs.access(path.join(cwd, 'result.txt')))
  }, 30)
})
test('one run per session; disconnect cancels a pending approval', async () => {
  await fixture(async ({ post, cwd }) => {
    const response = await post('/api/run', { prompt: 'write', model: 'mai-thinking' })
    const reader = response.body!.getReader()
    let text = ''
    let runId = '', sessionId = '', approvalId = ''
    while (!approvalId) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false)
      text += new TextDecoder().decode(chunk.value)
      for (const line of text.split('\n').filter(Boolean)) {
        let event: HostEvent
        try { event = JSON.parse(line) as HostEvent } catch { continue }
        if (event.type === 'started') { runId = event.runId; sessionId = event.sessionId }
        if (event.type === 'approval') approvalId = event.approval.id
      }
    }
    assert.equal((await post('/api/run', { prompt: 'hello', model: 'mai-thinking', sessionId })).status, 409)
    await reader.cancel()
    // Acceptance of a new run proves the previous run released the session.
    let next: Response | undefined
    for (let i = 0; i < 20; i++) {
      next = await post('/api/run', { prompt: 'hello', model: 'mai-thinking', sessionId })
      if (next.status === 200) break
      await next.text()
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    await collect(next!)
    assert.equal((await post('/api/approval', { runId, approvalId, allowed: true })).status, 409)
    await assert.rejects(fs.access(path.join(cwd, 'result.txt')))
  })
})
test('upstream errors never reveal provider diagnostics or credentials', async () => {
  await fixture(async ({ post }) => {
    const events = await collect(await post('/api/run', { prompt: 'fail', model: 'mai-thinking' }))
    assert.equal(events.at(-1)?.type, 'error')
    assert.ok(!JSON.stringify(events).includes('NEVER_ECHO_THIS'))
  })
})

test('the engine never reads the workspace .env, so a project cannot redirect the model key', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oqelira-host-env-'))
  const mock = await startMock({ script })
  // Evil project .env points the key at a dead address; the host's own environment points at the mock.
  await fs.writeFile(path.join(cwd, '.env'), 'FOUNDRY_BASE_URL=http://127.0.0.1:1/v1\n')
  const env: NodeJS.ProcessEnv = { ...process.env, FOUNDRY_ENDPOINT: mock.baseURL.replace(/\/v1$/, ''), FOUNDRY_KEY: 'test-key' }
  for (const k of ['OQELIRA_NO_ENV_FILES', 'FOUNDRY_BASE_URL']) delete env[k]
  const models = [{ id: 'mai-thinking', deployment: 'MAI-Thinking-1', api: 'chat' as const, speed: 'slow' as const }]
  const host = createHost({ cwd, dist: cwd, models, configured: true, startEngine: () => spawnEngine({ cwd, env }) })
  const origin = await host.listen()
  try {
    const events = await collect(await fetch(origin + '/api/run', { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Oqelira-Client': 'workspace' }, body: JSON.stringify({ prompt: 'hello', model: 'mai-thinking' }) }))
    assert.equal(events.filter((e) => e.type === 'text').map((e) => e.text).join(''), 'Hello world')
    assert.equal(mock.requests.length, 1)
  } finally { await host.close(); await mock.close(); await fs.rm(cwd, { recursive: true, force: true }) }
})
