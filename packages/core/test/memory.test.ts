import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { memoryDir, openLocalMemory } from '../src/memory/local.js'
import { recallBlock } from '../src/memory/gateway.js'
import { memoryTools } from '../src/tools/memory.js'
import type { LocalMemory } from '../src/memory/local.js'
import type { EmbeddingProvider } from '../src/providers/types.js'

/** Close all handles before deleting the fixture, including when an assertion fails. */
function memoryFixture() {
  const opened: LocalMemory[] = []
  return {
    async open(...args: Parameters<typeof openLocalMemory>) {
      const gateway = await openLocalMemory(...args)
      opened.push(gateway)
      return gateway
    },
    close() { for (const gateway of opened.reverse()) gateway.close() },
  }
}

/** Deterministic bag-of-words embedder: shared words => similar vectors. */
const fake = (id = 'fake'): EmbeddingProvider => ({
  id,
  async embed(texts) {
    return texts.map((t) => {
      const v = new Array(64).fill(0)
      for (const w of t.toLowerCase().match(/[a-z]+/g) ?? []) { let h = 0; for (const c of w) h = (h * 31 + c.charCodeAt(0)) % 64; v[h] += 1 }
      return v
    })
  },
})

test('memory persists across opens, ranks by meaning, hides other models, and forgets safely', async () => {
  const memories = memoryFixture()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-'))
  try {
    const a = await memories.open(root, fake(), root + '-state')
    const db = await a.remember('We use postgres with pgvector for embeddings')
    await a.remember('The CLI prints diffs before approval')
    a.close()
    a.close() // closing twice is safe; reopening must use only persisted state
    // new chat = new gateway instance over the same project dir
    const b = await memories.open(root, fake(), root + '-state')
    const hits = await b.recall('which database stores embeddings', { limit: 1 })
    assert.equal(hits[0]?.id, db.id)
    assert.match(await recallBlock(b, 'postgres embeddings'), /untrusted[\s\S]*pgvector/)
    assert.equal(await recallBlock(b, 'zzzz qqqq'), '')
    assert.equal((await (await memories.open(root, fake('other-model'), root + '-state')).recall('postgres')).length, 0)
    await assert.rejects(b.remember(' '))
    await assert.rejects(b.remember('x'.repeat(2001)))
    assert.equal(await b.forget('%%%%%%%%'), false)
    assert.equal((await b.list()).length, 2)
    assert.equal(await b.forget(db.id.slice(0, 8)), true)
    assert.equal((await b.list()).length, 1)
  } finally { memories.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(root + '-state', { recursive: true, force: true }) }
})

test('memory tools: recall is read, save/forget need approval', async () => {
  const memories = memoryFixture()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-tools-'))
  try {
    const tools = Object.fromEntries(memoryTools(await memories.open(root, fake(), root)).map((t) => [t.spec.name, t]))
    assert.deepEqual([tools.recall_memory!.risk, tools.save_memory!.risk, tools.forget_memory!.risk], ['read', 'write', 'write'])
    assert.match(await tools.save_memory!.run({ text: 'deploy runs on friday' }, { cwd: root }), /Saved memory/)
    assert.match(await tools.recall_memory!.run({ query: 'when is deploy' }, { cwd: root }), /deploy runs on friday/)
    await assert.rejects(tools.recall_memory!.run({ query: 'x', limit: 11 }, { cwd: root }))
  } finally { memories.close(); await fs.rm(root, { recursive: true, force: true }) }
})

test('memory lives in the per-user state dir, not in the project, even if the project ships .oqelira as a link', async () => {
  const memories = memoryFixture()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-proj-'))
  const state = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-state-'))
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-target-'))
  try {
    await fs.symlink(elsewhere, path.join(root, '.oqelira'), 'dir')
    await (await memories.open(root, fake(), state)).remember('hello world')
    assert.deepEqual(await fs.readdir(elsewhere), [])
    assert.deepEqual(await fs.readdir(root), ['.oqelira'])
    const dir = memoryDir(root, state)
    assert.ok(dir.startsWith(state))
    // Windows privacy is controlled by ACLs; POSIX mode bits are not portable there.
    if (process.platform !== 'win32') assert.equal((await fs.stat(path.join(dir, 'memory.sqlite'))).mode & 0o777, 0o600)
    assert.notEqual(memoryDir(root, state), memoryDir(elsewhere, state))
  } finally { memories.close(); for (const d of [root, state, elsewhere]) await fs.rm(d, { recursive: true, force: true }) }
})

test('pending memories are listed but never recalled until approved; approve and forget take unique prefixes only', async () => {
  const memories = memoryFixture()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-pending-'))
  try {
    const gw = await memories.open(root, fake(), `${root}-state`)
    const p = await gw.remember('deploys only happen on fridays', { kind: 'summary', status: 'pending' })
    assert.equal(p.status, 'pending')
    assert.equal((await gw.recall('when are deploys fridays')).length, 0) // not used while pending
    assert.equal((await gw.list()).find((e) => e.id === p.id)?.status, 'pending')
    assert.equal(await gw.approve('%%%%%%%%'), false)
    assert.equal(await gw.approve(p.id.slice(0, 8)), true)
    assert.equal(await gw.approve(p.id), false) // already active
    assert.equal((await gw.recall('when are deploys fridays'))[0]?.id, p.id)
    assert.match(await recallBlock(gw, 'deploys fridays'), /\(auto-saved\)/) // auto-saved memories are labeled for the model
    assert.equal((await gw.remember('a deliberate note')).status, 'active')
  } finally { memories.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(`${root}-state`, { recursive: true, force: true }) }
})

test('a memory database created before the status column opens, and its rows stay active', async () => {
  const memories = memoryFixture()
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-migrate-'))
  const state = `${root}-state`
  try {
    const gw = await memories.open(root, fake(), state)
    await gw.remember('old note about postgres')
    gw.close()
    const { DatabaseSync } = await import('node:sqlite')
    const { memoryDir } = await import('../src/memory/local.js')
    const db = new DatabaseSync(path.join(memoryDir(root, state), 'memory.sqlite'))
    db.exec('ALTER TABLE memory DROP COLUMN status') // simulate the old schema
    db.close()
    const reopened = await memories.open(root, fake(), state)
    const [entry] = await reopened.list()
    assert.equal(entry!.status, 'active')
    assert.equal((await reopened.recall('postgres')).length, 1)
  } finally { memories.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(state, { recursive: true, force: true }) }
})
