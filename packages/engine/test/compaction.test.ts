import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Message, ModelProvider } from '@oqelira/core'
import { createCompactor } from '../src/compaction.js'
import type { Snapshot } from '../src/store.js'

const turns = (n: number, size = 3000): Message[] =>
  Array.from({ length: n }, (_, i): Message[] => [
    { role: 'user', content: `task ${i} ${'x'.repeat(size)}` },
    { role: 'assistant', text: `done ${i}`, toolCalls: [] },
  ]).flat()

function harness(over: { fail?: boolean; empty?: boolean } = {}) {
  let snapshot: Snapshot | undefined
  const calls: string[] = []
  const notices: string[] = []
  const provider: ModelProvider = { id: 'fake', async *stream(req) {
    calls.push(req.messages[0]!.role === 'user' ? (req.messages[0] as { content: string }).content : '')
    if (over.fail) throw new Error('model down')
    yield { type: 'text-delta', text: over.empty ? '' : `SUMMARY#${calls.length}` }
    yield { type: 'finish', reason: 'stop' }
  } }
  const compact = createCompactor({ provider, budget: 10_000, getSnapshot: () => snapshot, save: (summary, coversThrough) => (snapshot = { version: (snapshot?.version ?? 0) + 1, summary, coversThrough, createdAt: '' }), notice: (m) => notices.push(m) })
  return { compact, calls, notices, snap: () => snapshot }
}

test('a conversation that fits is untouched and never calls the model', async () => {
  const h = harness()
  const messages = turns(2, 100)
  const w = await h.compact(messages)
  assert.deepEqual(w.messages, messages); assert.equal(w.archive, ''); assert.equal(h.calls.length, 0)
})

test('over budget: older whole turns are summarized once, saved, and reused without another call', async () => {
  const h = harness()
  const messages = turns(8)
  const w = await h.compact(messages)
  assert.equal(h.calls.length, 1)
  assert.match(w.archive, /SUMMARY#1/)
  assert.equal(w.messages[0]!.role, 'user') // starts on a turn boundary, tool pairs intact
  assert.ok(w.requestChars <= 10_000, String(w.requestChars))
  assert.equal(h.snap()!.coversThrough, messages.length - w.messages.length)
  assert.match(h.notices[0]!, /summarized/)
  const again = await h.compact(messages)
  assert.equal(h.calls.length, 1) // the snapshot is reused
  assert.deepEqual(again.messages, w.messages)
  // growth folds the previous summary into a newer one
  const grown = [...messages, ...turns(4)]
  const w2 = await h.compact(grown)
  assert.equal(h.calls.length, 2)
  assert.match(h.calls[1]!, /Previous summary[\s\S]*SUMMARY#1/)
  assert.match(w2.archive, /SUMMARY#2/)
  assert.equal(h.snap()!.version, 2)
})

test('a snapshot is honored even when everything would fit (resume uses the compact version)', async () => {
  const h = harness()
  const messages = turns(8)
  await h.compact(messages)
  const covers = h.snap()!.coversThrough
  const w = await h.compact(messages.slice(0, covers + 2)) // short history again
  assert.match(w.archive, /SUMMARY#1/)
  assert.equal(w.messages.length, 2)
})

test('summary failure or empty summary falls back to excerpts instead of failing the run', async () => {
  for (const mode of [{ fail: true }, { empty: true }]) {
    const h = harness(mode)
    const w = await h.compact(turns(8))
    assert.ok(w.requestChars <= 10_000 && w.messages.length > 0)
    assert.match(h.notices.at(-1)!, /Summarizing failed/)
    assert.equal(h.snap(), undefined)
  }
})

test('one huge current turn cannot be summarized away: excerpts keep it within budget', async () => {
  const h = harness()
  const huge: Message[] = [{ role: 'user', content: 'go' }, { role: 'assistant', text: '', toolCalls: [{ id: 'c', name: 'read_file', input: {} }] }, { role: 'tool', results: [{ id: 'c', name: 'read_file', output: 'y'.repeat(50_000) }] }]
  const w = await h.compact(huge)
  assert.equal(h.calls.length, 0)
  assert.ok(w.requestChars <= 10_000, String(w.requestChars))
})

test('an aborted run is not hidden by the excerpt fallback', async () => {
  const h = harness({ fail: true })
  const c = new AbortController(); c.abort()
  await assert.rejects(h.compact(turns(8), c.signal))
})
