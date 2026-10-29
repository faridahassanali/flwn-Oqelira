import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { openLocalMemory } from '../src/memory/local.js'
import { recallBlock } from '../src/memory/gateway.js'
import { memoryTools } from '../src/tools/memory.js'
import type { EmbeddingProvider } from '../src/providers/types.js'

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-'))
  try {
    const a = await openLocalMemory(root, fake())
    const db = await a.remember('We use postgres with pgvector for embeddings')
    await a.remember('The CLI prints diffs before approval')
    // new chat = new gateway instance over the same project dir
    const b = await openLocalMemory(root, fake())
    const hits = await b.recall('which database stores embeddings', { limit: 1 })
    assert.equal(hits[0]?.id, db.id)
    assert.match(await recallBlock(b, 'postgres embeddings'), /untrusted[\s\S]*pgvector/)
    assert.equal(await recallBlock(b, 'zzzz qqqq'), '')
    assert.equal((await (await openLocalMemory(root, fake('other-model'))).recall('postgres')).length, 0)
    await assert.rejects(a.remember(' '))
    await assert.rejects(a.remember('x'.repeat(2001)))
    assert.equal(await b.forget('%%%%%%%%'), false)
    assert.equal((await b.list()).length, 2)
    assert.equal(await b.forget(db.id.slice(0, 8)), true)
    assert.equal((await b.list()).length, 1)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('memory tools: recall is read, save/forget need approval', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-tools-'))
  try {
    const tools = Object.fromEntries(memoryTools(await openLocalMemory(root, fake())).map((t) => [t.spec.name, t]))
    assert.deepEqual([tools.recall_memory!.risk, tools.save_memory!.risk, tools.forget_memory!.risk], ['read', 'write', 'write'])
    assert.match(await tools.save_memory!.run({ text: 'deploy runs on friday' }, { cwd: root }), /Saved memory/)
    assert.match(await tools.recall_memory!.run({ query: 'when is deploy' }, { cwd: root }), /deploy runs on friday/)
    await assert.rejects(tools.recall_memory!.run({ query: 'x', limit: 11 }, { cwd: root }))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('memory refuses a .oqelira directory or database that is a symlink', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-link-'))
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-mem-target-'))
  try {
    await fs.symlink(elsewhere, path.join(root, '.oqelira'), 'dir')
    await assert.rejects(openLocalMemory(root, fake()), /real directory/)
    await fs.rm(path.join(root, '.oqelira'))
    await fs.mkdir(path.join(root, '.oqelira'))
    await fs.symlink(path.join(elsewhere, 'x.sqlite'), path.join(root, '.oqelira', 'memory.sqlite'))
    await assert.rejects(openLocalMemory(root, fake()), /regular file/)
    assert.deepEqual(await fs.readdir(elsewhere), [])
  } finally { await fs.rm(root, { recursive: true, force: true }); await fs.rm(elsewhere, { recursive: true, force: true }) }
})
