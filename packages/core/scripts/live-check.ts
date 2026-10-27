/**
 * Live check against the real Foundry deployments, using the REAL provider + agent loop
 * (streaming and tools together, permissions, edits, file writes). Nothing is mocked.
 *
 *   (repo root)  copy .env.example .env   # fill FOUNDRY_ENDPOINT / FOUNDRY_KEY
 *   (repo root)  npm run live
 *
 * It creates a temp workspace per scenario and deletes it afterwards.
 */
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runAgent } from '../src/agent/loop.js'
import { createFoundry, foundryConfigFromEnv } from '../src/providers/foundry.js'
import { DEFAULT_MODELS } from '../src/providers/registry.js'
import { builtinTools } from '../src/tools/index.js'
import type { ModelConfig } from '../src/providers/registry.js'

const cfg = foundryConfigFromEnv()
console.log(`baseURL: ${cfg.baseURL}`)

const wanted = process.env.LIVE_MODELS?.split(',').map((s) => s.trim()).filter(Boolean)
const models: ModelConfig[] = wanted ? DEFAULT_MODELS.filter((m) => wanted.includes(m.id)) : [...DEFAULT_MODELS]

const fallbacks = new Set<string>()
const make = createFoundry({ ...cfg, onTokenParamFallback: (d) => fallbacks.add(d) })

type Outcome = { ok: boolean; detail: string; steps?: number; firstEventMs?: number }
type Scenario = { name: string; run: (model: ModelConfig, cwd: string) => Promise<Outcome> }

async function withWorkspace<T>(fn: (cwd: string) => Promise<T>): Promise<T> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oqelira-live-'))
  try {
    return await fn(cwd)
  } finally {
    await fs.rm(cwd, { recursive: true, force: true })
  }
}

/** Wraps runAgent and records time to the first streamed event (text or tool call). */
async function agent(model: ModelConfig, cwd: string, prompt: string, approve?: (summary: string) => boolean) {
  const started = Date.now()
  let firstEventMs: number | undefined
  const tick = () => (firstEventMs ??= Date.now() - started)
  const toolCalls: string[] = []
  const asked: string[] = []
  const result = await runAgent({
    provider: make(model),
    prompt,
    tools: builtinTools,
    cwd,
    maxSteps: 12,
    maxOutputTokens: 4000,
    permissions: {
      autoAllow: ['read'],
      approve: async (req) => {
        asked.push(req.summary)
        return approve ? approve(req.summary) : false
      },
    },
    onText: tick,
    onToolCall: (c) => {
      tick()
      toolCalls.push(c.name)
    },
  })
  return { result, firstEventMs, toolCalls, asked }
}

const scenarios: Scenario[] = [
  {
    name: 'follow a file chain with read tools (streaming + tools)',
    async run(model, cwd) {
      await fs.writeFile(path.join(cwd, 'a.txt'), 'The next file is b.txt')
      await fs.writeFile(path.join(cwd, 'b.txt'), 'The next file is c.txt')
      await fs.writeFile(path.join(cwd, 'c.txt'), 'The next file is d.txt')
      await fs.writeFile(path.join(cwd, 'd.txt'), 'The secret word is PINEAPPLE')
      const { result, firstEventMs, toolCalls } = await agent(
        model,
        cwd,
        'Start at a.txt. Each file names the next one. Follow the chain until you find the secret word and reply with only that word.',
      )
      const reads = toolCalls.filter((n) => n === 'read_file').length
      return {
        ok: /pineapple/i.test(result.text) && reads >= 4,
        detail: `${reads} read_file calls, reply="${result.text.slice(0, 40)}", finish=${result.finishReason}`,
        steps: result.steps,
        firstEventMs,
      }
    },
  },
  {
    name: 'write a file after the developer approves',
    async run(model, cwd) {
      const { result, firstEventMs, asked } = await agent(
        model,
        cwd,
        'Create a file notes.txt in the project root containing exactly: hello oqelira',
        () => true,
      )
      const content = await fs.readFile(path.join(cwd, 'notes.txt'), 'utf8').catch(() => null)
      return {
        ok: content?.trim() === 'hello oqelira' && asked.length >= 1,
        detail: `asked=${JSON.stringify(asked)}, file=${JSON.stringify(content)}`,
        steps: result.steps,
        firstEventMs,
      }
    },
  },
  {
    name: 'respect a denied write (no retry loop, nothing written)',
    async run(model, cwd) {
      const { result, firstEventMs, asked } = await agent(
        model,
        cwd,
        'Create a file notes.txt in the project root containing exactly: hello oqelira',
        () => false,
      )
      const exists = await fs.access(path.join(cwd, 'notes.txt')).then(() => true, () => false)
      return {
        ok: !exists && result.finishReason !== 'max-steps' && asked.length <= 3 && result.text.trim().length > 0,
        detail: `asked ${asked.length}x, file created=${exists}, finish=${result.finishReason}, reply="${result.text.slice(0, 60)}"`,
        steps: result.steps,
        firstEventMs,
      }
    },
  },
  {
    name: 'fix a bug with edit_file, then verify with run_command',
    async run(model, cwd) {
      await fs.writeFile(path.join(cwd, 'calc.mjs'), 'export const add = (a, b) => a - b\n')
      const { result, firstEventMs, toolCalls } = await agent(
        model,
        cwd,
        'calc.mjs exports add(a, b) but it has a bug: it should return the sum. Fix it with a minimal edit, then run a quick command to confirm add(2, 3) is 5.',
        () => true,
      )
      let works = false
      try {
        const mod = await import(`${pathToFileURL(path.join(cwd, 'calc.mjs')).href}?t=${Date.now()}`)
        works = mod.add(2, 3) === 5
      } catch {
        works = false
      }
      return {
        ok: works && toolCalls.includes('run_command'),
        detail: `add(2,3)===5: ${works}, tools=${toolCalls.join(',')}`,
        steps: result.steps,
        firstEventMs,
      }
    },
  },
]

const rows: { model: string; scenario: string; result: string; ms: number; steps?: number; firstEventMs?: number }[] = []
for (const model of models) {
  console.log(`\n=== ${model.id} (${model.deployment}, api=${model.api}) ===`)
  for (const sc of scenarios) {
    const started = Date.now()
    let out: Outcome
    try {
      out = await withWorkspace((cwd) => sc.run(model, cwd))
    } catch (e) {
      const err = e as { message?: string; statusCode?: number; responseBody?: string }
      out = { ok: false, detail: `${err.statusCode ? `[${err.statusCode}] ` : ''}${err.message ?? e}${err.responseBody ? ` | ${err.responseBody.slice(0, 300)}` : ''}` }
    }
    const ms = Date.now() - started
    console.log(`${out.ok ? 'PASS' : 'FAIL'}  ${sc.name}  (${ms}ms, ${out.steps ?? '-'} steps, first event ${out.firstEventMs ?? '-'}ms)\n      ${out.detail}`)
    rows.push({ model: model.id, scenario: sc.name, result: out.ok ? 'PASS' : 'FAIL', ms, steps: out.steps, firstEventMs: out.firstEventMs })
  }
}

console.log('\n=== Summary ===')
console.table(rows)
if (fallbacks.size) console.log(`\nNote: max_tokens was rejected and retried as max_completion_tokens for: ${[...fallbacks].join(', ')}`)
process.exit(rows.some((r) => r.result === 'FAIL') ? 1 : 0)
