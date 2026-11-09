import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { gitDiff, gitHistory, sessionFiles } from '../src/git.js'
import type { Message } from '@oqelira/core'

function repo(): string {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oqelira-git-'))
  const git = (args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' })
  git(['init', '-q'])
  git(['config', 'user.email', 'test@example.com'])
  git(['config', 'user.name', 'Test User'])
  fs.writeFileSync(path.join(cwd, 'note.txt'), 'one\n')
  git(['add', 'note.txt']); git(['commit', '-qm', 'initial'])
  fs.writeFileSync(path.join(cwd, 'note.txt'), 'two\n')
  git(['add', 'note.txt']); git(['commit', '-qm', 'update'])
  return cwd
}

test('reads commit history and a commit diff without invoking hooks', async () => {
  const cwd = repo()
  const commits = await gitHistory(cwd)
  assert.equal(commits.length, 2)
  assert.equal(commits[0].subject, 'update')
  const diff = await gitDiff(cwd, commits[0].hash)
  assert.deepEqual(diff.files, ['note.txt'])
  assert.match(diff.patch, /two/)
  await assert.rejects(() => gitDiff(cwd, 'update;touch-pwned'), /Invalid commit id/)
})

test('extracts files touched by a session from file tools only', () => {
  const messages: Message[] = [
    { role: 'assistant', text: '', toolCalls: [
      { id: '1', name: 'read_file', input: { path: 'src/index.ts' } },
      { id: '2', name: 'write_file', input: { path: 'src/index.ts', content: 'x' } },
      { id: '3', name: 'run_command', input: { command: 'cat src/index.ts' } },
      { id: '4', name: 'read_file', input: { path: '../secret' } },
    ] },
  ]
  assert.deepEqual(sessionFiles(messages), ['src/index.ts'])
})
