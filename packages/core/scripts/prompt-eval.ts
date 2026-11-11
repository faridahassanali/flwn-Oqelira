/**
 * Live prompt A/B: BASELINE_SYSTEM (pre-#19) vs DEFAULT_SYSTEM, on every configured deployment.
 *
 *   (repo root)  npm run prompt:eval
 *   Only some models:  PROMPT_EVAL_MODELS=gpt-6-sol npm run prompt:eval
 *
 * Needs PROMPT_EVAL_RUNNER_URL (HTTPS), PROMPT_EVAL_RUNNER_TOKEN, and a runsc runner.
 * Needs FOUNDRY_KEY and FOUNDRY_ENDPOINT (see .env.example). Model ids come from OQELIRA_MODELS_JSON or the registry.
 * PROMPT_EVAL_SET=easy|hard|all (default easy), PROMPT_EVAL_REPEATS=n, PROMPT_EVAL_CONCURRENCY=n,
 * PROMPT_EVAL_OUT=path to also write the markdown table. Never prints credentials.
 */
import fs from 'node:fs/promises'
import { RunnerWorkspace } from '../eval/runner-workspace.js'
import { DEFAULT_SYSTEM } from '../src/agent/prompt.js'
import { loadEnvFiles } from '../src/config/env.js'
import { createFoundry, foundryConfigFromEnv } from '../src/providers/foundry.js'
import { modelsFromEnv } from '../src/providers/registry.js'
import { BASELINE_SYSTEM, HARD_TASKS, TASKS, renderResults, runPromptEval } from '../eval/prompt-eval.js'

loadEnvFiles({ cwd: process.cwd() })

// Validate isolation configuration before any model request.
try { RunnerWorkspace.fromEnv() } catch (error) {
  console.error(error instanceof Error ? error.message : 'Invalid runner configuration')
  process.exit(2)
}

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
const runs = await runPromptEval({
  models,
  prompts: { baseline: BASELINE_SYSTEM, current: DEFAULT_SYSTEM },
  tasks: tasks.filter(t => !only?.length || only.includes(t.id)),
  repeats: Number(process.env.PROMPT_EVAL_REPEATS ?? 1),
  concurrency: Number(process.env.PROMPT_EVAL_CONCURRENCY ?? 1),
  provider: make,
  onRun: r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.model} / ${r.prompt} / ${r.task} #${r.rep}  (${r.steps} steps)  ${r.detail}`),
})

const body = renderResults(runs, { date: new Date().toISOString().slice(0, 10), mode: 'Foundry deployments from config' })
console.log('\n' + body)
if (process.env.PROMPT_EVAL_OUT) await fs.writeFile(process.env.PROMPT_EVAL_OUT, body, 'utf8')
