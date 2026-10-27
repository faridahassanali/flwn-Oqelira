import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { startMock } from '../../core/test/mock-server.js'
import type { Reply } from '../../core/test/mock-server.js'

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'oqelira.mjs')

async function workspace<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oqelira-cli-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

function runCli(
  args: string[],
  opts: { cwd: string; baseURL?: string; stdin?: string; env?: Record<string, string> },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, OQELIRA_NO_ENV_FILES: '1', NO_COLOR: '1', ...opts.env }
    for (const k of ['FOUNDRY_KEY', 'FOUNDRY_ENDPOINT', 'FOUNDRY_BASE_URL']) delete env[k]
    if (opts.baseURL) {
      env.FOUNDRY_BASE_URL = opts.baseURL
      env.FOUNDRY_KEY = 'test-key'
    }
    Object.assign(env, opts.env)
    const child = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd, env })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`CLI hung (killed after 20s). stdout so far:\n${stdout}\nstderr:\n${stderr}`))
    }, 20_000)
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })
    child.stdin.end(opts.stdin ?? '')
  })
}

/** First request: call `first`. Later requests: answer with the last tool result. */
function callThenAnswer(first: { name: string; args: unknown }) {
  return (body: any, n: number): Reply => {
    if (n === 0) return { toolCall: first }
    const toolMsg = [...body.messages].reverse().find((m: any) => m.role === 'tool')
    return { text: `RESULT: ${toolMsg?.content}` }
  }
}

const M = ['-m', 'mai-thinking'] // chat-completions model: what the mock server speaks

test('--help and --list-models work without any configuration', async () => {
  await workspace(async (cwd) => {
    const help = await runCli(['--help'], { cwd })
    assert.equal(help.code, 0)
    assert.match(help.stdout, /Usage:/)
    const list = await runCli(['--list-models'], { cwd })
    assert.equal(list.code, 0)
    assert.match(list.stdout, /gpt-6-sol/)
    assert.match(list.stdout, /mai-thinking/)
  })
})

test('missing credentials -> exit 2 with a helpful message', async () => {
  await workspace(async (cwd) => {
    const r = await runCli(['hello'], { cwd })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /FOUNDRY_KEY/)
  })
})

test('unknown model -> exit 2 and lists the known ones', async () => {
  await workspace(async (cwd) => {
    const r = await runCli(['-m', 'nope', 'hi'], { cwd, baseURL: 'http://127.0.0.1:9/v1' })
    assert.equal(r.code, 2)
    assert.match(r.stderr, /Unknown model "nope"/)
  })
})

test('one-shot: reads a file with a tool call, streams the answer, exits 0', async () => {
  await workspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'hello.txt'), 'PINEAPPLE')
    const mock = await startMock({ script: callThenAnswer({ name: 'read_file', args: { path: 'hello.txt' } }) })
    try {
      const r = await runCli([...M, 'what is in hello.txt?'], { cwd, baseURL: mock.baseURL })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /> read hello\.txt/)
      assert.match(r.stdout, /RESULT: PINEAPPLE/)
    } finally {
      await mock.close()
    }
  })
})

test('write: shows a preview, asks, and writes when the developer answers y', async () => {
  await workspace(async (cwd) => {
    const mock = await startMock({
      script: callThenAnswer({ name: 'write_file', args: { path: 'out.txt', content: 'line one\nline two' } }),
    })
    try {
      const r = await runCli([...M, 'write out.txt'], { cwd, baseURL: mock.baseURL, stdin: 'y\n' })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.match(r.stdout, /\? write out\.txt \(17 chars\)/)
      assert.match(r.stdout, /\+ line one/)
      assert.match(r.stdout, /Allow\?/)
      assert.equal(await fs.readFile(path.join(cwd, 'out.txt'), 'utf8'), 'line one\nline two')
    } finally {
      await mock.close()
    }
  })
})

test('write: answering n denies it and nothing is written', async () => {
  await workspace(async (cwd) => {
    const mock = await startMock({
      script: callThenAnswer({ name: 'write_file', args: { path: 'out.txt', content: 'x' } }),
    })
    try {
      const r = await runCli([...M, 'write out.txt'], { cwd, baseURL: mock.baseURL, stdin: 'n\n' })
      assert.match(r.stdout, /not allowed/)
      await assert.rejects(fs.access(path.join(cwd, 'out.txt')))
    } finally {
      await mock.close()
    }
  })
})

test('write: stdin closed (EOF) is a denial, not a hang', async () => {
  await workspace(async (cwd) => {
    const mock = await startMock({
      script: callThenAnswer({ name: 'write_file', args: { path: 'out.txt', content: 'x' } }),
    })
    try {
      const r = await runCli([...M, 'write out.txt'], { cwd, baseURL: mock.baseURL })
      assert.match(r.stdout, /not allowed/)
      await assert.rejects(fs.access(path.join(cwd, 'out.txt')))
    } finally {
      await mock.close()
    }
  })
})

test('--yes auto-approves writes without asking', async () => {
  await workspace(async (cwd) => {
    const mock = await startMock({
      script: callThenAnswer({ name: 'write_file', args: { path: 'out.txt', content: 'auto' } }),
    })
    try {
      const r = await runCli([...M, '--yes', 'write out.txt'], { cwd, baseURL: mock.baseURL })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.doesNotMatch(r.stdout, /Allow\?/)
      assert.equal(await fs.readFile(path.join(cwd, 'out.txt'), 'utf8'), 'auto')
    } finally {
      await mock.close()
    }
  })
})

test('--yes does NOT auto-approve shell commands', async () => {
  await workspace(async (cwd) => {
    const mock = await startMock({
      script: callThenAnswer({ name: 'run_command', args: { command: 'node -e "require(\'fs\').writeFileSync(\'ran.txt\',\'x\')"' } }),
    })
    try {
      const r = await runCli([...M, '--yes', 'run it'], { cwd, baseURL: mock.baseURL })
      assert.match(r.stdout, /Allow\?|not allowed/)
      await assert.rejects(fs.access(path.join(cwd, 'ran.txt')))
    } finally {
      await mock.close()
    }
  })
})

test('edit: the approval prompt shows a - / + preview of the change', async () => {
  await workspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'a.ts'), 'const x = 1\n')
    const mock = await startMock({
      script: callThenAnswer({ name: 'edit_file', args: { path: 'a.ts', old_string: 'const x = 1', new_string: 'const x = 2' } }),
    })
    try {
      const r = await runCli([...M, 'bump x'], { cwd, baseURL: mock.baseURL, stdin: 'y\n' })
      assert.match(r.stdout, /- const x = 1/)
      assert.match(r.stdout, /\+ const x = 2/)
      assert.equal(await fs.readFile(path.join(cwd, 'a.ts'), 'utf8'), 'const x = 2\n')
    } finally {
      await mock.close()
    }
  })
})

test('interactive session: keeps history between turns, /clear forgets it, /exit quits', async () => {
  await workspace(async (cwd) => {
    const mock = await startMock({ script: (_b, n) => ({ text: `answer ${n}` }) })
    try {
      const r = await runCli(M, {
        cwd,
        baseURL: mock.baseURL,
        stdin: 'first question\nsecond question\n/clear\nthird question\n/exit\n',
      })
      assert.equal(r.code, 0, r.stdout + r.stderr)
      assert.equal(mock.requests.length, 3)
      const users = (i: number) => mock.requests[i].body.messages.filter((m: any) => m.role === 'user').map((m: any) => m.content)
      assert.deepEqual(users(0), ['first question'])
      assert.deepEqual(users(1), ['first question', 'second question']) // history kept
      assert.deepEqual(users(2), ['third question']) // after /clear
      assert.match(r.stdout, /answer 0/)
    } finally {
      await mock.close()
    }
  })
})

test('project rules in AGENTS.md are added to the system prompt', async () => {
  await workspace(async (cwd) => {
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), 'Always use tabs, never spaces.')
    const mock = await startMock({ script: () => ({ text: 'ok' }) })
    try {
      await runCli([...M, 'hi'], { cwd, baseURL: mock.baseURL })
      const system = mock.requests[0].body.messages.find((m: any) => m.role === 'system')
      assert.match(system.content, /Always use tabs/)
    } finally {
      await mock.close()
    }
  })
})

test('API error is reported cleanly (exit 1), not as a stack trace', async () => {
  await workspace(async (cwd) => {
    const r = await runCli([...M, 'hi'], { cwd, baseURL: 'http://127.0.0.1:9/v1' })
    assert.equal(r.code, 1)
    assert.match(r.stdout, /error:/)
    assert.doesNotMatch(r.stderr, /at .*\.ts/)
  })
})
