import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import readline from 'node:readline'
import { startMock } from '../../core/test/mock-server.js'
import type { Reply } from '../../core/test/mock-server.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'oqelira.mjs')

/** Starts `oqelira serve` and gives a tiny NDJSON client over its stdio. */
async function engine(cwd: string, baseURL: string, extra: string[] = []) {
  const env: NodeJS.ProcessEnv = { ...process.env, OQELIRA_NO_ENV_FILES: '1', FOUNDRY_BASE_URL: baseURL, FOUNDRY_KEY: 'test-key' }
  const child = spawn(process.execPath, [BIN, 'serve', '--cwd', cwd, '-m', 'mai-thinking', ...extra], { env })
  const messages: any[] = []
  const waiters: Array<() => void> = []
  readline.createInterface({ input: child.stdout }).on('line', (line) => {
    messages.push(JSON.parse(line)) // stdout must be protocol only: this throws on anything else
    waiters.splice(0).forEach((w) => w())
  })
  const send = (m: unknown) => child.stdin.write(JSON.stringify(m) + '\n')
  const until = async (pred: (m: any) => boolean, ms = 15_000): Promise<any> => {
    const deadline = Date.now() + ms
    for (;;) {
      const hit = messages.find(pred)
      if (hit) return hit
      if (Date.now() > deadline) throw new Error(`timeout; saw ${JSON.stringify(messages)}`)
      await new Promise<void>((r) => { waiters.push(r); setTimeout(r, 200) })
    }
  }
  return { send, until, messages, child, stop: () => { child.stdin.end(); child.kill() } }
}

/** Text of the nth run (streamed in chunks). */
const texts = (messages: any[], run: number) => messages.filter((m) => m.type === 'started' || m.type === 'text').reduce((acc: string[], m) => (m.type === 'started' ? [...acc, ''] : (acc[acc.length - 1] += m.text, acc)), []).at(run) ?? ''

const writeThenAnswer = (body: any, n: number): Reply =>
  n === 0 ? { toolCall: { name: 'write_file', args: { path: 'out.txt', content: 'hello' } } } : { text: `RESULT: ${[...body.messages].reverse().find((m: any) => m.role === 'tool')?.content}` }

async function withEngine(script: Parameters<typeof startMock>[0]['script'], fn: (e: Awaited<ReturnType<typeof engine>>, cwd: string) => Promise<void>, extra: string[] = []) {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oqelira-serve-'))
  const mock = await startMock({ script })
  const e = await engine(cwd, mock.baseURL, extra)
  try { await fn(e, cwd) } finally { e.stop(); await mock.close(); await fs.rm(cwd, { recursive: true, force: true }) }
}

test('serve: hello handshake, rejects unknown protocol and bad JSON', async () => {
  await withEngine(() => ({ text: 'x' }), async (e, cwd) => {
    e.send({ type: 'hello', protocol: 99 })
    assert.match((await e.until((m) => m.type === 'error')).message, /Unsupported protocol/)
    e.send({ type: 'hello', protocol: 1 })
    const ready = await e.until((m) => m.type === 'ready')
    assert.equal(ready.protocol, 1)
    assert.equal(ready.model, 'mai-thinking')
    assert.equal(await fs.realpath(ready.cwd), await fs.realpath(cwd))
    e.child.stdin.write('not json\n')
    await e.until((m) => m.type === 'error' && m.message === 'Invalid JSON request')
  })
})

test('serve: a write waits for approval over the protocol, then runs', async () => {
  await withEngine(writeThenAnswer, async (e, cwd) => {
    e.send({ type: 'run', prompt: 'write it' })
    const ask = await e.until((m) => m.type === 'approval')
    assert.equal(ask.approval.risk, 'write')
    await assert.rejects(fs.readFile(path.join(cwd, 'out.txt')), { code: 'ENOENT' }) // not written before approval
    e.send({ type: 'approval', approvalId: ask.approval.id, allowed: true })
    assert.equal((await e.until((m) => m.type === 'done')).reason, 'stop')
    assert.equal(await fs.readFile(path.join(cwd, 'out.txt'), 'utf8'), 'hello')
  })
})

test('serve: denied approval and cancel are fail-closed', async () => {
  await withEngine(writeThenAnswer, async (e, cwd) => {
    e.send({ type: 'run', prompt: 'write it' })
    const ask = await e.until((m) => m.type === 'approval')
    e.send({ type: 'approval', approvalId: ask.approval.id, allowed: false })
    await e.until((m) => m.type === 'done')
    await assert.rejects(fs.readFile(path.join(cwd, 'out.txt')), { code: 'ENOENT' })
    e.send({ type: 'approval', approvalId: ask.approval.id, allowed: true }) // stale id
    await e.until((m) => m.type === 'error' && /no longer pending/.test(m.message))
  })
  await withEngine(writeThenAnswer, async (e, cwd) => {
    e.send({ type: 'run', prompt: 'write it' })
    await e.until((m) => m.type === 'approval')
    e.send({ type: 'cancel' })
    await e.until((m) => m.type === 'tool-result' || m.type === 'error' || m.type === 'done')
    await assert.rejects(fs.readFile(path.join(cwd, 'out.txt')), { code: 'ENOENT' })
  })
})

test('serve: closing stdin mid-approval stops the run without writing', async () => {
  await withEngine(writeThenAnswer, async (e, cwd) => {
    e.send({ type: 'run', prompt: 'write it' })
    await e.until((m) => m.type === 'approval')
    e.child.stdin.end()
    await new Promise((r) => e.child.once('exit', r))
    await assert.rejects(fs.readFile(path.join(cwd, 'out.txt')), { code: 'ENOENT' })
  })
})

test('serve: history persists within a session and clear resets it', async () => {
  await withEngine((body) => ({ text: `saw ${body.messages.filter((m: any) => m.role === 'user').length} user messages` }), async (e) => {
    e.send({ type: 'run', prompt: 'one', sessionId: 's1' })
    await e.until((m) => m.type === 'done')
    e.send({ type: 'run', prompt: 'two', sessionId: 's1' })
    await e.until(() => e.messages.filter((m) => m.type === 'done').length === 2)
    assert.match(texts(e.messages, 1), /saw 2 user/)
    e.send({ type: 'clear', sessionId: 's1' })
    await e.until((m) => m.type === 'cleared')
    e.send({ type: 'run', prompt: 'three', sessionId: 's1' })
    await e.until(() => e.messages.filter((m) => m.type === 'done').length === 3)
    assert.match(texts(e.messages, 2), /saw 1 user/)
  })
})
