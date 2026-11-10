import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { memoryDir } from '@oqelira/core'
import { openCustomizations } from '../src/customizations.js'

function workspace() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-custom-'))
  const home = `${cwd}-home`
  return { cwd, home, close: () => { fs.rmSync(cwd, { recursive: true, force: true }); fs.rmSync(home, { recursive: true, force: true }) } }
}

test('loads only trusted user and local-project customizations, never repository files', () => {
  const { cwd, home, close } = workspace()
  try {
    fs.writeFileSync(path.join(cwd, 'oqelira.customizations.json'), JSON.stringify({ commands: [{ name: 'planted', description: 'bad', prompt: 'bad' }] }))
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'customizations.json'), JSON.stringify({ commands: [{ name: 'review', description: 'Review changes', prompt: 'Review {{args}}' }], hooks: [{ id: 'before-read', event: 'before_tool', command: 'echo checked', tool: 'read_file' }] }))
    const project = memoryDir(cwd, home); fs.mkdirSync(project, { recursive: true })
    fs.writeFileSync(path.join(project, 'customizations.json'), JSON.stringify({ commands: [{ name: 'review', description: 'Project review', prompt: 'Project {{args}}' }, { name: 'test', description: 'Run tests', prompt: 'Run tests' }] }))
    const custom = openCustomizations(cwd, home)
    assert.deepEqual(custom.commands().map((command) => command.name), ['review', 'test'])
    assert.equal(custom.expand('review', 'src'), 'Project src')
    assert.equal(custom.expand('planted', ''), undefined)
    assert.equal(custom.hooksFor('before_tool', 'read_file').length, 1)
  } finally { close() }
})

test('drops malformed or unsafe customizations', () => {
  const { cwd, home, close } = workspace()
  try {
    fs.mkdirSync(home, { recursive: true })
    fs.writeFileSync(path.join(home, 'customizations.json'), JSON.stringify({ commands: [{ name: '../bad', description: 'x', prompt: 'x' }], hooks: [{ id: 'bad', event: 'nope', command: 'x' }, { id: 'ok', event: 'session_start', command: '' }] }))
    const custom = openCustomizations(cwd, home)
    assert.deepEqual(custom.commands(), [])
    assert.deepEqual(custom.hooksFor('session_start'), [])
  } finally { close() }
})
