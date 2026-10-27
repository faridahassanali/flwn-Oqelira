import assert from 'node:assert/strict'
import { realpath as realpathCallback } from 'node:fs'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { runAgent } from '../src/agent/loop.js'
import type { ApprovalRequest } from '../src/permissions.js'
import { createFoundry } from '../src/providers/foundry.js'
import type { ModelConfig } from '../src/providers/registry.js'
import { builtinTools } from '../src/tools/index.js'
import { startMock } from './mock-server.js'
import type { Reply } from './mock-server.js'

const model: ModelConfig = { id: 'm', deployment: 'm-deployment', api: 'chat', speed: 'fast' }

const nativeRealpath = (p: string) =>
  new Promise<string>((resolve, reject) =>
    realpathCallback.native(p, (err, resolved) => (err ? reject(err) : resolve(resolved))),
  )

async function withWorkspace<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oqelira-test-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

/** Mock model that first calls `first`, then answers with the last tool result. */
function callThenAnswer(first: { name: string; args: unknown }) {
  return (body: any, n: number): Reply => {
    if (n === 0) return { toolCall: first }
    const toolMsg = [...body.messages].reverse().find((m: any) => m.role === 'tool')
    return { text: `RESULT: ${toolMsg?.content}` }
  }
}

test('agent loop: model reads a file via a tool call and answers from it (streaming throughout)', async () => {
  await withWorkspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'hello.txt'), 'PINEAPPLE')
    const mock = await startMock({ script: callThenAnswer({ name: 'read_file', args: { path: 'hello.txt' } }) })
    try {
      const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
      const seen: string[] = []
      const result = await runAgent({
        provider,
        prompt: 'what is in hello.txt?',
        tools: builtinTools,
        cwd,
        onToolCall: (c) => seen.push(c.name),
      })
      assert.equal(result.steps, 2)
      assert.equal(result.finishReason, 'stop')
      assert.match(result.text, /RESULT: PINEAPPLE/)
      assert.deepEqual(seen, ['read_file'])
    } finally {
      await mock.close()
    }
  })
})

test('permissions: write is denied without an approver, and the file is NOT created', async () => {
  await withWorkspace(async (cwd) => {
    const mock = await startMock({
      script: callThenAnswer({ name: 'write_file', args: { path: 'out.txt', content: 'x' } }),
    })
    try {
      const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
      const result = await runAgent({ provider, prompt: 'write out.txt', tools: builtinTools, cwd })
      assert.match(result.text, /not allowed/)
      await assert.rejects(fs.access(path.join(cwd, 'out.txt')))
    } finally {
      await mock.close()
    }
  })
})

test('permissions: approver is asked with a readable summary; approving performs the write', async () => {
  await withWorkspace(async (cwd) => {
    const mock = await startMock({
      script: callThenAnswer({ name: 'write_file', args: { path: 'out.txt', content: 'hello' } }),
    })
    try {
      const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
      const asked: ApprovalRequest[] = []
      await runAgent({
        provider,
        prompt: 'write out.txt',
        tools: builtinTools,
        cwd,
        permissions: {
          autoAllow: ['read'],
          approve: async (req) => {
            asked.push(req)
            return true
          },
        },
      })
      assert.equal(asked.length, 1)
      assert.equal(asked[0]?.risk, 'write')
      assert.equal(asked[0]?.summary, 'write out.txt (5 chars)')
      assert.equal(await fs.readFile(path.join(cwd, 'out.txt'), 'utf8'), 'hello')
    } finally {
      await mock.close()
    }
  })
})

test('workspace confinement: paths outside the workspace are rejected', async () => {
  await withWorkspace(async (cwd) => {
    const mock = await startMock({
      script: callThenAnswer({ name: 'read_file', args: { path: '../../etc/passwd' } }),
    })
    try {
      const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
      const result = await runAgent({ provider, prompt: 'read it', tools: builtinTools, cwd })
      assert.match(result.text, /outside the workspace/)
    } finally {
      await mock.close()
    }
  })
})

test('workspace confinement: a symlink pointing outside cannot be used to escape', async () => {
  await withWorkspace(async (cwd) => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'oqelira-outside-'))
    await fs.writeFile(path.join(outside, 'secret.txt'), 'SECRET')
    try {
      await fs.symlink(outside, path.join(cwd, 'link'), 'dir')
    } catch {
      await fs.rm(outside, { recursive: true, force: true })
      return // symlinks not permitted on this machine (e.g. Windows without privileges)
    }
    const mock = await startMock({ script: callThenAnswer({ name: 'read_file', args: { path: 'link/secret.txt' } }) })
    try {
      const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
      const result = await runAgent({ provider, prompt: 'read it', tools: builtinTools, cwd })
      assert.match(result.text, /outside the workspace/)
      assert.doesNotMatch(result.text, /SECRET/)
    } finally {
      await mock.close()
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

test('edit_file: unique match is replaced, ambiguous match is refused', async () => {
  await withWorkspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'a.ts'), 'const x = 1\nconst y = 1\n')
    const ctx = { cwd }
    const edit = builtinTools.find((t) => t.spec.name === 'edit_file')!
    await assert.rejects(edit.run({ path: 'a.ts', old_string: '= 1', new_string: '= 2' }, ctx), /not unique/)
    await edit.run({ path: 'a.ts', old_string: 'const x = 1', new_string: 'const x = 2' }, ctx)
    assert.equal(await fs.readFile(path.join(cwd, 'a.ts'), 'utf8'), 'const x = 2\nconst y = 1\n')
  })
})

test('run_command: needs approval, runs in the workspace, and does not leak FOUNDRY_* env vars', async () => {
  await withWorkspace(async (cwd) => {
    process.env.FOUNDRY_KEY = 'super-secret-key'
    const mock = await startMock({
      script: callThenAnswer({
        name: 'run_command',
        args: { command: 'node -e "console.log(process.cwd() + \'|\' + (process.env.FOUNDRY_KEY ?? \'unset\'))"' },
      }),
    })
    try {
      const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
      const result = await runAgent({
        provider,
        prompt: 'run it',
        tools: builtinTools,
        cwd,
        permissions: { autoAllow: ['read'], approve: async () => true },
      })
      // Output looks like: "RESULT: <cwd>|<key state>\n\n[exit code 0]"
      const firstLine = result.text.replace(/^RESULT: /, '').split(/\r?\n/)[0] ?? ''
      const sep = firstLine.lastIndexOf('|')
      const reported = firstLine.slice(0, sep)
      const keyState = firstLine.slice(sep + 1)
      const detail = `full output: ${JSON.stringify(result.text)}`
      assert.ok(sep > 0, `command did not print "<cwd>|<key>" (did it fail?). ${detail}`)
      // Compare through realpath.native: on Windows the temp dir can be an 8.3 short path
      // (e.g. C:\\Users\\FARIDA~1\\...) and drive-letter case can differ.
      const norm = async (p: string) => {
        const r = await nativeRealpath(p)
        return process.platform === 'win32' ? r.toLowerCase() : r
      }
      assert.equal(await norm(reported), await norm(cwd), `command ran in a different directory. ${detail}`)
      assert.equal(keyState, 'unset', `FOUNDRY_KEY was not scrubbed. ${detail}`)
      assert.ok(!result.text.includes('super-secret-key'), detail)
    } finally {
      delete process.env.FOUNDRY_KEY
      await mock.close()
    }
  })
})

test('maxSteps stops a model that keeps calling tools', async () => {
  await withWorkspace(async (cwd) => {
    const mock = await startMock({ script: () => ({ toolCall: { name: 'list_dir', args: { path: '.' } } }) })
    try {
      const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
      const result = await runAgent({ provider, prompt: 'loop forever', tools: builtinTools, cwd, maxSteps: 3 })
      assert.equal(result.finishReason, 'max-steps')
      assert.equal(result.steps, 3)
    } finally {
      await mock.close()
    }
  })
})
