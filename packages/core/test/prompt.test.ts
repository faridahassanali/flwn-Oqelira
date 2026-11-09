import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_SYSTEM } from '../src/agent/prompt.js'
import { builtinTools } from '../src/tools/index.js'
import { webSearch } from '../src/tools/web.js'

test('agent instructions require inspection, verification, and safe treatment of untrusted content', () => {
  assert.match(DEFAULT_SYSTEM, /untrusted data/)
  assert.match(DEFAULT_SYSTEM, /Understand before changing/)
  assert.match(DEFAULT_SYSTEM, /Never claim a change or test succeeded unless you ran it and checked the result/)
  assert.match(DEFAULT_SYSTEM, /denied, expired, or unavailable approval is final/)
})

test('built-in tool descriptions communicate their safety and verification boundaries', () => {
  const tool = (name: string) => builtinTools.find(item => item.spec.name === name)?.spec.description ?? ''
  assert.match(tool('read_file'), /untrusted data/)
  assert.match(tool('search_text'), /before reading or editing/)
  assert.match(tool('write_file'), /Requires write approval/)
  assert.match(tool('apply_file_change'), /stale human edit/)
  assert.match(tool('run_command'), /require approval/)
  assert.match(webSearch.spec.description, /untrusted data/)
})
