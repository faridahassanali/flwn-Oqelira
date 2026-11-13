import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { canonicalRemote, deviceId, mergeMessages, mergeSnapshots, projectIdentity, repositoryKey } from '../src/sync-identity.js'
import type { SyncMessage, SyncSnapshot } from '@oqelira/protocol'

test('HTTPS, SSH and SCP remotes identify the same repository without storing its raw URL', async () => {
  const values = ['https://github.com/Flwn/Oqelira.git', 'git@github.com:Flwn/Oqelira.git', 'ssh://git@github.com/Flwn/Oqelira/']
  assert.deepEqual(values.map(canonicalRemote), ['github.com/Flwn/Oqelira', 'github.com/Flwn/Oqelira', 'github.com/Flwn/Oqelira'])
  const keys = values.map(value => repositoryKey(value))
  assert.ok(keys.every(key => key === keys[0]))
  assert.doesNotMatch(keys[0]!, /github|oqelira/i)
})

test('device identity is per install while a no-remote project needs an explicit local id', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-sync-id-'))
  try {
    assert.throws(() => projectIdentity({ stateRoot: root }), /explicit project id/)
    const a = projectIdentity({ remote: 'git@github.com:flwn/oqelira.git', stateRoot: root })
    const b = projectIdentity({ remote: 'https://github.com/flwn/oqelira.git', stateRoot: root })
    const local = projectIdentity({ projectId: 'chosen-local-project', stateRoot: root })
    assert.equal(a.repositoryKey, b.repositoryKey)
    assert.equal(a.deviceId, b.deviceId)
    assert.notEqual(a.repositoryKey, local.repositoryKey)
    assert.equal(deviceId(root), a.deviceId)
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('offline devices merge append-only messages once and select a deterministic snapshot without discarding history', () => {
  const a: SyncMessage = { id: 'a', sessionId: 's', deviceId: 'device-a', createdAt: '2026-01-01T00:00:00.000Z', contentHash: 'a', body: { role: 'user' } }
  const b: SyncMessage = { id: 'b', sessionId: 's', deviceId: 'device-b', createdAt: '2026-01-01T00:00:00.000Z', contentHash: 'b', body: { role: 'assistant' } }
  assert.deepEqual(mergeMessages([a], [a, b]).map(message => message.id), ['a', 'b'])
  assert.throws(() => mergeMessages([a], [{ ...a, contentHash: 'changed' }]), /Conflicting message id/)

  const old: SyncSnapshot = { id: 'one', sessionId: 's', version: 1, deviceId: 'device-a', updatedAt: '2026-01-01T00:00:00.000Z', contentHash: 'old', summary: 'old', coversThrough: 3 }
  const newer: SyncSnapshot = { id: 'two', sessionId: 's', version: 1, deviceId: 'device-b', updatedAt: '2026-01-01T00:00:00.000Z', contentHash: 'new', summary: 'new', coversThrough: 4 }
  const merged = mergeSnapshots([old], [newer])
  assert.equal(merged.current?.id, 'two')
  assert.deepEqual(merged.history.map(snapshot => snapshot.id), ['one', 'two'])
})
