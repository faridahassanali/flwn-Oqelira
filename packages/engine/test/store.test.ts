import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Message } from '@oqelira/core'
import { openSessionStore } from '../src/store.js'

async function project<T>(fn: (cwd: string, home: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-store-'))
  const home = `${cwd}-home`
  try { return await fn(cwd, home) } finally { await fs.rm(cwd, { recursive: true, force: true }); await fs.rm(home, { recursive: true, force: true }) }
}
const turn = (n: number): Message[] => [
  { role: 'user', content: `question ${n}` },
  { role: 'assistant', text: `answer ${n}`, toolCalls: [{ id: `c${n}`, name: 'read_file', input: { path: 'a' } }] },
  { role: 'tool', results: [{ id: `c${n}`, name: 'read_file', output: `file ${n}` }] },
]

test('sessions persist across opens; append never rewrites; snapshots version and resume', async () => {
  await project(async (cwd, home) => {
    const a = await openSessionStore(cwd, home)
    const m1 = turn(1)
    a.append('s1', m1, 0, { model: 'm' })
    a.append('s1', m1, 0, { model: 'm' }) // same batch again: idempotent
    const all = [...m1, ...turn(2)]
    a.append('s1', all, 3, { model: 'm' })
    const snap = a.saveSnapshot('s1', 'summary of turn 1', 3)
    assert.equal(snap.version, 1)
    assert.equal(a.saveSnapshot('s1', 'newer summary', 3).version, 2)

    const b = await openSessionStore(cwd, home) // a new process, a new chat
    const loaded = b.load('s1')!
    assert.deepEqual(loaded.messages, all)
    assert.equal(loaded.snapshot?.summary, 'newer summary') // latest compact version
    assert.equal(loaded.snapshot?.coversThrough, 3)
    const [info] = b.list()
    assert.equal(info!.id, 's1'); assert.equal(info!.messages, 6); assert.equal(info!.title, 'question 1')
    assert.equal(b.load('missing'), undefined)

    b.remove('s1')
    assert.equal(b.load('s1'), undefined)
    assert.deepEqual(b.list(), [])
  })
})

test('credentials are redacted before storage, and stores are separate per project', async () => {
  await project(async (cwd, home) => {
    const s = await openSessionStore(cwd, home)
    s.append('s', [{ role: 'user', content: 'use token=abc123secret and Bearer abcdef.ghi' }, { role: 'assistant', text: 'ok api_key: zzz999', toolCalls: [] }], 0, { model: 'm' })
    const text = JSON.stringify(s.load('s'))
    assert.ok(!/abc123secret|abcdef\.ghi|zzz999/.test(text), text)
    assert.match(text, /\[redacted\]/)
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-store-other-'))
    try { assert.deepEqual((await openSessionStore(other, home)).list(), []) } finally { await fs.rm(other, { recursive: true, force: true }) }
    const mode = (await fs.stat(path.join(home, 'projects'))).mode & 0o077
    assert.equal(mode, 0)
  })
})
