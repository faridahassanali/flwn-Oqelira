/**
 * Live prompt A/B: BASELINE_SYSTEM (pre-#19) vs COMPACT_SYSTEM (8 lines) vs DEFAULT_SYSTEM (system-prompt.txt), on every configured deployment.
 *
 *   (repo root)  npm run prompt:eval
 *   Only some models:  PROMPT_EVAL_MODELS=gpt-6-sol npm run prompt:eval
 *
 * Needs FOUNDRY_KEY and FOUNDRY_ENDPOINT (see .env.example). Model ids come from OQELIRA_MODELS_JSON or the registry.
 * PROMPT_EVAL_SET=easy|hard|all (default easy), PROMPT_EVAL_REPEATS=n, PROMPT_EVAL_CONCURRENCY=n (default 1: one request in flight, which keeps a token-rate-limited deployment under its limit),
 * PROMPT_EVAL_OUT=path to also write the markdown table. Never prints credentials.
 */
import fs from 'node:fs/promises'
import { DEFAULT_SYSTEM } from '../src/agent/prompt.js'
import { loadEnvFiles } from '../src/config/env.js'
import { createFoundry, foundryConfigFromEnv } from '../src/providers/foundry.js'
import { modelsFromEnv } from '../src/providers/registry.js'
import type { EvalRun } from '../eval/prompt-eval.js'
import { BASELINE_SYSTEM, COMPACT_SYSTEM, HARD_TASKS, TASKS, renderResults, runPromptEval } from '../eval/prompt-eval.js'

loadEnvFiles({ cwd: process.cwd() })

let config: ReturnType<typeof foundryConfigFromEnv>
try {
  config = foundryConfigFromEnv()
} catch {
  console.error('Model credentials are not configured. Set FOUNDRY_KEY and FOUNDRY_ENDPOINT in the environment or ~/.oqelira/.env, then rerun.')
  process.exit(2)
}

const wanted = process.env.PROMPT_EVAL_MODELS?.split(',').map(s => s.trim()).filter(Boolean)
const models = modelsFromEnv().filter(m => !wanted?.length || wanted.includes(m.id))
if (!models.length) {
  console.error('No models matched PROMPT_EVAL_MODELS.')
  process.exit(2)
}

const set = process.env.PROMPT_EVAL_SET ?? 'easy'
const tasks = set === 'hard' ? HARD_TASKS : set === 'all' ? [...TASKS, ...HARD_TASKS] : TASKS
const only = process.env.PROMPT_EVAL_TASKS?.split(',').map(s => s.trim()).filter(Boolean)

const make = createFoundry(config)
// Guard so a rate-limit storm cannot burn the budget: stop when retries pile up or most runs so far are ERROR.
const maxRetries = Number(process.env.PROMPT_EVAL_MAX_RETRIES ?? 150)
const seen: EvalRun[] = []
const runs = await runPromptEval({
  models,
  prompts: { baseline: BASELINE_SYSTEM, compact: COMPACT_SYSTEM, file: DEFAULT_SYSTEM },
  tasks: tasks.filter(t => !only?.length || only.includes(t.id)),
  repeats: Number(process.env.PROMPT_EVAL_REPEATS ?? 1),
  concurrency: Number(process.env.PROMPT_EVAL_CONCURRENCY ?? 1),
  provider: make,
  onRun: r => {
    console.log(`${r.error ? 'ERROR' : r.ok ? 'PASS' : 'FAIL'}  ${r.model} / ${r.prompt} / ${r.task} #${r.rep}  (${r.steps} steps, ${r.requests} requests, ${r.retries} retries)  ${r.detail}`)
    seen.push(r)
    const retried = seen.reduce((n, x) => n + (x.retries ?? 0), 0)
    if (retried > maxRetries || (seen.length >= 10 && seen.filter(x => x.error).length / seen.length > 0.5)) {
      console.error(`Stopping early: ${retried} retries and ${seen.filter(x => x.error).length}/${seen.length} ERROR runs. Partial table follows.`)
      console.log('\n' + renderResults(seen, { date: new Date().toISOString().slice(0, 10), mode: 'PARTIAL, stopped early' }))
      process.exit(3)
    }
  },
})

const body = renderResults(runs, { date: new Date().toISOString().slice(0, 10), mode: 'Foundry deployments from config' })
console.log('\n' + body)
if (process.env.PROMPT_EVAL_OUT) await fs.writeFile(process.env.PROMPT_EVAL_OUT, body, 'utf8')
