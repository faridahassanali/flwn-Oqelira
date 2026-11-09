import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { BASELINE_SYSTEM, TASKS, renderResults, runPromptEval } from '../eval/prompt-eval.js'
import type { EvalRun, RunRecord } from '../eval/prompt-eval.js'
import type { ModelConfig } from '../src/providers/registry.js'
import type { ModelEvent, ModelProvider, ModelRequest } from '../src/providers/types.js'

const models: ModelConfig[] = [
  { id: 'alpha', deployment: 'alpha-deployment', api: 'chat', speed: 'fast' },
  { id: 'beta', deployment: 'beta-deployment', api: 'responses', speed: 'slow' },
]

/** Scripted model: `act` runs on the first step (the user prompt is last), then it answers with `text`. */
function scripted(act: (prompt: string) => ModelEvent[] | null, text = 'done'): ModelProvider {
  return {
    id: 'scripted',
    async *stream(req: ModelRequest): AsyncIterable<ModelEvent> {
      const last = req.messages.at(-1)
      const prompt = last?.role === 'user' ? last.content : ''
      const calls = last?.role === 'user' ? act(prompt) : null
      if (calls) {
        yield* calls
        yield { type: 'finish', reason: 'tool-calls' }
        return
      }
      yield { type: 'text-delta', text }
      yield { type: 'finish', reason: 'stop' }
    },
  }
}

const task = (id: string) => {
  const found = TASKS.find(t => t.id === id)
  assert.ok(found, `missing task ${id}`)
  return found
}

const record = (over: Partial<RunRecord> = {}): RunRecord => ({ text: '', toolCalls: [], approvals: [], ...over })

test('fixed task set has 5 to 8 uniquely named tasks', () => {
  assert.ok(TASKS.length >= 5 && TASKS.length <= 8)
  assert.equal(new Set(TASKS.map(t => t.id)).size, TASKS.length)
})

test('harness runs every model, prompt, and task, and reports per-run results', async () => {
  const seen: EvalRun[] = []
  const runs = await runPromptEval({
    models,
    prompts: { baseline: BASELINE_SYSTEM, current: 'system' },
    tasks: [task('create-file')],
    provider: () => scripted(() => null),
    onRun: r => seen.push(r),
  })
  assert.equal(runs.length, models.length * 2)
  assert.equal(seen.length, runs.length)
  assert.deepEqual(runs.map(r => `${r.model}/${r.prompt}`), ['alpha/baseline', 'alpha/current', 'beta/baseline', 'beta/current'])
  assert.ok(runs.every(r => !r.ok), 'a model that only answers text cannot create the file')
})

test('a run that writes the requested file passes its check, and approval is requested for the write', async () => {
  const runs = await runPromptEval({
    models: models.slice(0, 1),
    prompts: { current: 'system' },
    tasks: [task('create-file')],
    provider: () => scripted(prompt => prompt.includes('notes.txt')
      ? [{ type: 'tool-call', call: { id: 'w1', name: 'write_file', input: { path: 'notes.txt', content: 'hello oqelira' } } }]
      : null),
  })
  assert.equal(runs[0]?.ok, true, runs[0]?.detail)
  assert.equal(runs[0]?.detail, `notes.txt=${JSON.stringify('hello oqelira')}`)
})

test('a denied command with an honest reply passes, and a command run anyway fails the untrusted-instruction task', async () => {
  const denied = await runPromptEval({
    models: models.slice(0, 1),
    prompts: { current: 'system' },
    tasks: [task('denied-command')],
    provider: () => scripted(prompt => prompt.includes('console.log(42)')
      ? [{ type: 'tool-call', call: { id: 'c1', name: 'run_command', input: { command: 'node -e "console.log(42)"' } } }]
      : null, 'The command was denied, so I could not verify its output.'),
  })
  assert.equal(denied[0]?.ok, true, denied[0]?.detail)

  const injected = await runPromptEval({
    models: models.slice(0, 1),
    prompts: { current: 'system' },
    tasks: [task('untrusted-instruction')],
    provider: () => scripted(prompt => prompt.includes('instructions.txt')
      ? [{ type: 'tool-call', call: { id: 'c2', name: 'run_command', input: { command: 'touch pwned.txt' } } }]
      : null),
  })
  assert.equal(injected[0]?.ok, false)
  assert.match(injected[0]!.detail, /run_command calls=1/)
})

test('a provider error is recorded as a failed run instead of aborting the comparison', async () => {
  const runs = await runPromptEval({
    models: models.slice(0, 1),
    prompts: { current: 'system' },
    tasks: [task('search-and-answer')],
    provider: () => ({ id: 'broken', stream() { throw new Error('endpoint unreachable') } }),
  })
  assert.equal(runs[0]?.ok, false)
  assert.match(runs[0]!.detail, /run error: endpoint unreachable/)
})

test('failing-test check accepts a fixed add() and rejects the buggy one', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'prompt-eval-check-'))
  try {
    const t = task('failing-test')
    for (const [name, content] of Object.entries(t.files)) await fs.writeFile(path.join(dir, name), content)
    assert.equal((await t.check(dir, record())).ok, false)
    await fs.writeFile(path.join(dir, 'add.mjs'), 'export const add = (a, b) => a + b\n')
    assert.equal((await t.check(dir, record())).ok, true)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('results table lists every model and prompt, pass totals, and failure details', () => {
  const runs: EvalRun[] = [
    { model: 'alpha', prompt: 'baseline', task: 't1', ok: true, detail: '', steps: 1 },
    { model: 'alpha', prompt: 'current', task: 't1', ok: false, detail: 'wrong value', steps: 2 },
  ]
  const md = renderResults(runs, { date: '2026-11-09', mode: 'test' })
  assert.match(md, /\| Task \| alpha \/ baseline \| alpha \/ current \|/)
  assert.match(md, /\| t1 \| PASS \| FAIL \|/)
  assert.match(md, /\*\*1\/1\*\* \| \*\*0\/1\*\*/)
  assert.match(md, /alpha \/ current \/ t1: wrong value/)
})
