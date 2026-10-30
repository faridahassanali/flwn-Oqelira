import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openRules } from '../src/rules.js'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'oqelira-rules-'))
const run = (command: unknown) => ({ tool: 'run_command', risk: 'exec' as const, summary: 'run', input: { command } })
const write = { tool: 'write_file', risk: 'write' as const, summary: 'write', input: { path: 'a.ts', content: 'x' } }

test('saved rules persist across opens; commands match exactly, other tools by name', () => {
  const root = tmp()
  const cwd = tmp()
  const rules = openRules(cwd, root)
  assert.equal(rules.allows(run('git status')), false)
  assert.ok(rules.add(run('git status'), 'project'))
  rules.add(write, 'project')
  const again = openRules(cwd, root)
  assert.ok(again.allows(run('git status')))
  assert.ok(!again.allows(run('git status; rm -rf ~')), 'no prefix matching')
  assert.ok(!again.allows(run('git status ')), 'exact only')
  assert.ok(again.allows({ ...write, input: { path: 'other.ts', content: 'y' } }))
  assert.ok(!openRules(tmp(), root).allows(run('git status')), 'project rules are per project')
  assert.ok(!openRules(tmp(), root).allows(write), 'writes do not leak to other projects')
})

test('a command rule never matches a request without a command, and bad files mean no rules', () => {
  const root = tmp()
  const cwd = tmp()
  const rules = openRules(cwd, root)
  rules.add(run('ls'), 'project')
  assert.ok(!rules.allows(run(undefined)))
  assert.equal(rules.add(run(undefined), 'project'), false)
  assert.deepEqual(JSON.parse(fs.readFileSync(rules.files.project, 'utf8')).allow, [{ tool: 'run_command', command: 'ls' }])
  fs.writeFileSync(rules.files.project, '{not json')
  assert.ok(!openRules(cwd, root).allows(run('ls')))
  fs.writeFileSync(rules.files.project, JSON.stringify({ allow: [{ tool: 'run_command' }, 7, { tool: 5 }] }))
  assert.ok(!openRules(cwd, root).allows(run('ls')), 'a tool-wide rule does not cover commands that were never named')
})

test('network never persists; user scope refuses commands and writes; files are private', () => {
  const rules = openRules(tmp(), tmp())
  const search = { tool: 'web_search', risk: 'network' as const, summary: 'search', input: { query: 'x' } }
  assert.equal(rules.add(search, 'project'), false)
  assert.equal(rules.add(run('ls'), 'user'), false)
  assert.equal(rules.add(write, 'user'), false)
  assert.ok(!rules.allows(search) && !fs.existsSync(rules.files.user))
  rules.add(write, 'project')
  assert.equal(fs.statSync(rules.files.project).mode & 0o077, 0)
})
