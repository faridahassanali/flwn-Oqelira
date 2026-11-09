/**
 * Live prompt A/B: BASELINE_SYSTEM (pre-#19) vs DEFAULT_SYSTEM, on every configured deployment.
 *
 *   (repo root)  npm run prompt:eval
 *   Only some models:  PROMPT_EVAL_MODELS=gpt-6-sol npm run prompt:eval
 *
 * Needs FOUNDRY_KEY and FOUNDRY_ENDPOINT (see .env.example). Model ids come from OQELIRA_MODELS_JSON or the registry.
 * Writes docs/prompt-tuning.md. Never prints credentials.
 */
import fs from 'node:fs/promises'
import { DEFAULT_SYSTEM } from '../src/agent/prompt.js'
import { loadEnvFiles } from '../src/config/env.js'
import { createFoundry, foundryConfigFromEnv } from '../src/providers/foundry.js'
import { modelsFromEnv } from '../src/providers/registry.js'
import { BASELINE_SYSTEM, TASKS, renderResults, runPromptEval } from '../eval/prompt-eval.js'

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

const make = createFoundry(config)
const runs = await runPromptEval({
  models,
  prompts: { baseline: BASELINE_SYSTEM, current: DEFAULT_SYSTEM },
  provider: make,
  onRun: r => console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.model} / ${r.prompt} / ${r.task}  (${r.steps} steps)  ${r.detail}`),
})

const date = new Date().toISOString().slice(0, 10)
const body = renderResults(runs, { date, mode: 'Foundry deployments from config' })
const out = new URL('../../../docs/prompt-tuning.md', import.meta.url)
const header = '# System prompt tuning (issue #19)\n\nFixed task set: `packages/core/eval/prompt-eval.ts`. Regenerate with `npm run prompt:eval`. Columns compare the pre-#19 prompt (baseline) with the current prompt for each model.\n\n'
await fs.writeFile(out, header + body, 'utf8')
console.log(`\nWrote ${out.pathname} (${TASKS.length} tasks, ${runs.length} runs).`)
