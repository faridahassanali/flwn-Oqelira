import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { glob, grep, todoWrite, webFetch, taskList } from '../src/tools/pack.js'

test('glob and regex grep stay inside the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-pack-'))
  try {
    await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const Needle = 1\n')
    await fs.writeFile(path.join(root, 'src', 'b.js'), 'needle\n')
    assert.deepEqual(JSON.parse(await glob.run({ pattern: 'src/**/*.ts' }, { cwd: root })).matches, ['src/a.ts'])
    assert.equal(JSON.parse(await grep.run({ pattern: '^const\\s+Needle', case_sensitive: true }, { cwd: root })).matches[0].path, 'src/a.ts')
    await assert.rejects(glob.run({ pattern: '../*' }, { cwd: root }))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('todo list is replaced per workspace', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-todo-'))
  try {
    await todoWrite.run({ tasks: [{ id: 'one', text: 'Do it', status: 'in_progress' }] }, { cwd })
    assert.equal(taskList(cwd)[0]?.status, 'in_progress')
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})

test('web_fetch rejects local addresses before making a request', async () => {
  await assert.rejects(webFetch.run({ url: 'http://127.0.0.1:1/' }, { cwd: '.' }), /Private and local/)
  await assert.rejects(webFetch.run({ url: 'file:///etc/passwd' }, { cwd: '.' }), /Only http/)
})
