import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTerminalUi, playStartup } from '../src/ui.js'

test('terminal theme emits plain text when colour is disabled', () => {
  const ui = createTerminalUi({ enabled: false })
  assert.equal(ui.wordmark(), 'flwn')
  assert.equal(ui.yellow('needs approval'), 'needs approval')
  assert.ok(ui.startupFrames().every(frame => !frame.includes('\x1b')))
})

test('terminal theme uses the approved Flwn palette and readable light/dark anchors', () => {
  const dark = createTerminalUi({ enabled: true, background: 'dark' })
  const light = createTerminalUi({ enabled: true, background: 'light' })
  assert.match(dark.wordmark(), /247;243;234/) // cream on dark terminals
  assert.match(light.wordmark(), /0;31;85/) // navy on light terminals
  assert.match(dark.yellow('approval'), /248;219;153/) // approved gold
  assert.equal(dark.startupFrames().at(-1)?.replace(/\x1b\[[0-9;]*m/g, ''), 'flwn')
})

test('startup animation is silent when color output is disabled', async () => {
  const writes: string[] = []
  const output = { write: (value: string | Uint8Array) => { writes.push(String(value)); return true } } as Pick<NodeJS.WriteStream, 'write'>
  await playStartup(output, createTerminalUi({ enabled: false }))
  assert.deepEqual(writes, [])
})
