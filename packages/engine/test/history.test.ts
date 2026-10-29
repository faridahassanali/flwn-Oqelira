import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { clearHistory, loadHistory, saveHistory } from '../src/history.js'

test('local CLI history persists bounded messages, redacts obvious credentials, and clears', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-cli-history-'))
  try {
    await saveHistory(cwd, [
      { role: 'user', content: 'token=very-secret-value' },
      { role: 'assistant', text: 'done', toolCalls: [] },
      { role: 'tool', results: [{ id: '1', name: 'read_file', output: 'Bearer abcdefghijk', isError: false }] },
    ])
    const saved = await fs.readFile(path.join(cwd, '.oqelira', 'cli-history.json'), 'utf8')
    assert.doesNotMatch(saved, /very-secret-value|abcdefghijk/)
    assert.equal((await loadHistory(cwd)).length, 3)
    await clearHistory(cwd)
    assert.deepEqual(await loadHistory(cwd), [])
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})
