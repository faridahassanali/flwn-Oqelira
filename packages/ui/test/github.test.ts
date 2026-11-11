import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/cloud.js'
import { describeFailure, githubReturn, needsReconnect, pollUntilSettled, relativeTime, safeGithubUrl, withoutGithubReturn } from '../src/github.js'
import type { GithubSource } from '../src/github.js'
import { githubCardState } from '../src/views.js'

test('return URL handling', () => {
  assert.equal(githubReturn('?github=connected'), 'connected')
  assert.equal(githubReturn('?github=connected&error=access_denied'), 'error')
  assert.equal(githubReturn('?error=oops'), 'error')
  assert.equal(githubReturn(''), undefined)
  assert.equal(withoutGithubReturn(new URL('http://x.test/?github=connected&keep=1#h')), '/?keep=1#h')
})

test('only github.com https URLs are followed', () => {
  assert.equal(safeGithubUrl('https://github.com/login/oauth/authorize?a=1'), 'https://github.com/login/oauth/authorize?a=1')
  for (const bad of ['http://github.com/x', 'https://evil.test/x', 'https://github.com.evil.test/x', 'https://u:p@github.com/x']) assert.throws(() => safeGithubUrl(bad))
  assert.throws(() => safeGithubUrl(undefined))
})

test('failures read as sentences', () => {
  assert.match(describeFailure(new ApiError('Not found', 404), 'Could not check GitHub'), /does not offer GitHub yet/)
  assert.match(describeFailure(new TypeError('fetch failed'), 'Could not check GitHub'), /could not be reached/)
  assert.match(describeFailure(new ApiError('Boom', 500), 'x'), /Boom/)
  assert.equal(needsReconnect(new ApiError('GitHub token expired', 401)), true)
  assert.equal(needsReconnect(new ApiError('Sign in to continue', 401)), false)
})

test('card state precedence', () => {
  const base = { status: undefined, capable: undefined, error: '', reconnect: false }
  assert.equal(githubCardState(base), 'loading')
  assert.equal(githubCardState({ ...base, error: 'x' }), 'error')
  assert.equal(githubCardState({ ...base, capable: false, status: { configured: true, connected: true } }), 'unconfigured')
  assert.equal(githubCardState({ ...base, status: { configured: false, connected: false } }), 'unconfigured')
  assert.equal(githubCardState({ ...base, status: { configured: true, connected: false } }), 'disconnected')
  assert.equal(githubCardState({ ...base, status: { configured: true, connected: true, login: 'a' } }), 'connected')
  assert.equal(githubCardState({ ...base, reconnect: true, status: { configured: true, connected: true } }), 'reconnect')
})

test('polling stops when the sync settles and when aborted', async () => {
  const states: GithubSource['state'][] = ['syncing', 'syncing', 'idle']
  const seen: (string | undefined)[] = []
  const waits: number[] = []
  await pollUntilSettled(async () => ({ repo: 'a/b', branch: 'main', state: states.shift()! }), s => seen.push(s?.state), async ms => { waits.push(ms) }, new AbortController().signal, 10)
  assert.deepEqual(seen, ['syncing', 'syncing', 'idle'])
  assert.deepEqual(waits, [10, 10])
  const stop = new AbortController(); let calls = 0
  await pollUntilSettled(async () => { calls++; return { repo: 'a/b', branch: 'main', state: 'syncing' } }, () => {}, async () => { stop.abort() }, stop.signal)
  assert.equal(calls, 1)
  const failed: unknown[] = []
  await pollUntilSettled(async () => { throw new Error('down') }, s => failed.push(s), async () => {}, new AbortController().signal)
  assert.deepEqual(failed, [null])
})

test('relative time', () => {
  const now = Date.parse('2026-11-11T12:00:00Z')
  assert.equal(relativeTime('2026-11-11T11:59:40Z', now), 'just now')
  assert.equal(relativeTime('2026-11-11T11:30:00Z', now), '30 min ago')
  assert.equal(relativeTime('2026-11-09T12:00:00Z', now), '2 d ago')
  assert.equal(relativeTime(null, now), 'never')
  assert.equal(relativeTime('garbage', now), 'unknown')
})
