/**
 * Live prompt A/B: BASELINE_SYSTEM (pre-#19) vs DEFAULT_SYSTEM, on every configured deployment.
 *
 *   (repo root)  npm run prompt:eval
 *   Only some models:  PROMPT_EVAL_MODELS=gpt-6-sol npm run prompt:eval
 *
 * Needs PROMPT_EVAL_RUNNER_URL (HTTPS), PROMPT_EVAL_RUNNER_TOKEN, and a runsc runner.
 * Needs FOUNDRY_KEY and FOUNDRY_ENDPOINT (see .env.example). Model ids come from OQELIRA_MODELS_JSON or the registry.
 * PROMPT_EVAL_SET=easy|hard|all (default easy), PROMPT_EVAL_REPEATS=n, PROMPT_EVAL_CONCURRENCY=n.
 * For durable batches, set PROMPT_EVAL_JOURNAL=path and PROMPT_EVAL_SHARD=i/n (1-based).
 * Completed cells are appended as JSON Lines and are skipped on a later invocation.
 * PROMPT_EVAL_OUT=path writes the final table only after every expected cell is journaled.
 * Never prints credentials.
 */
import fs from 'node:fs/promises'
import { RunnerWorkspace } from '../eval/prompt/runner-workspace.js'
import { DEFAULT_SYSTEM } from '../src/agent/prompt.js'
import { loadEnvFiles } from '../src/config/env.js'
import { createFoundry, foundryConfigFromEnv } from '../src/providers/foundry.js'
import { modelsFromEnv } from '../src/providers/registry.js'
import { BASELINE_SYSTEM, evalRunKey, HARD_TASKS, TASKS, renderResults, runPromptEval } from '../eval/prompt/harness.js'
import type { EvalRun } from '../eval/prompt/harness.js'

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
if (!['easy', 'hard', 'all'].includes(set)) throw new Error('PROMPT_EVAL_SET must be easy, hard, or all')
const tasks = set === 'hard' ? HARD_TASKS : set === 'all' ? [...TASKS, ...HARD_TASKS] : TASKS
const only = process.env.PROMPT_EVAL_TASKS?.split(',').map(s => s.trim()).filter(Boolean)

const selectedTasks = tasks.filter(t => !only?.length || only.includes(t.id))
if (!selectedTasks.length) throw new Error('No tasks matched PROMPT_EVAL_TASKS')
const repeats = Number(process.env.PROMPT_EVAL_REPEATS ?? 1)
const concurrency = Number(process.env.PROMPT_EVAL_CONCURRENCY ?? 1)
if (!Number.isSafeInteger(repeats) || repeats < 1) throw new Error('PROMPT_EVAL_REPEATS must be a positive integer')
if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error('PROMPT_EVAL_CONCURRENCY must be between 1 and 3')

const journal = process.env.PROMPT_EVAL_JOURNAL?.trim()
const shard = parseShard(process.env.PROMPT_EVAL_SHARD)
if (shard && !journal) throw new Error('PROMPT_EVAL_SHARD requires PROMPT_EVAL_JOURNAL so completed cells can be resumed')

const completed = new Map<string, EvalRun>()
if (journal) {
  const text = await fs.readFile(journal, 'utf8').catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
    throw error
  })
  for (const [line, value] of text.split(/\r?\n/).entries()) {
    if (!value.trim()) continue
    let run: unknown
    try { run = JSON.parse(value) } catch { throw new Error(`Invalid JSON in PROMPT_EVAL_JOURNAL at line ${line + 1}`) }
    if (!isEvalRun(run)) throw new Error(`Invalid evaluation record in PROMPT_EVAL_JOURNAL at line ${line + 1}`)
    completed.set(evalRunKey(run), run)
  }
}

const expected = models.length * 2 * selectedTasks.length * repeats
const expectedKeys = new Set(
  models.flatMap(model => ['baseline', 'current'].flatMap(prompt =>
    selectedTasks.flatMap(task => Array.from({ length: repeats }, (_, index) =>
      evalRunKey({ model: model.id, prompt, task: task.id, rep: index + 1 }),
    )),
  )),
)
if ([...completed].some(([key]) => !expectedKeys.has(key))) throw new Error('PROMPT_EVAL_JOURNAL does not match the selected models, tasks, or repeat count')
if (completed.size > expected) throw new Error('PROMPT_EVAL_JOURNAL has more records than the selected evaluation')

const make = createFoundry(config)
const runs = await runPromptEval({
  models,
  workspace: () => RunnerWorkspace.fromEnv(),
  prompts: { baseline: BASELINE_SYSTEM, current: DEFAULT_SYSTEM },
  tasks: selectedTasks,
  repeats,
  concurrency,
  provider: make,
  shouldRun: (job, index) => !completed.has(evalRunKey(job)) && (!shard || index % shard.total === shard.index),
  onRun: async r => {
    if (journal) await fs.appendFile(journal, JSON.stringify(r) + '\n', 'utf8')
    completed.set(evalRunKey(r), r)
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.model} / ${r.prompt} / ${r.task} #${r.rep}  (${r.steps} steps)  ${r.detail}`)
  },
})

const allRuns = journal ? [...completed.values()] : runs
const complete = allRuns.length === expected
if (complete) {
  const body = renderResults(allRuns, { date: new Date().toISOString().slice(0, 10), mode: 'Foundry deployments from config; fixtures and checks in gVisor' })
  console.log('\n' + body)
  if (process.env.PROMPT_EVAL_OUT) await fs.writeFile(process.env.PROMPT_EVAL_OUT, body, 'utf8')
} else {
  console.log(`Evaluation progress: ${allRuns.length}/${expected} cells journaled.${shard ? ` Finished shard ${shard.index + 1}/${shard.total}.` : ''}`)
}

if (runs.some(run => !run.ok)) process.exitCode = 1

function parseShard(value: string | undefined): { index: number; total: number } | undefined {
  if (!value?.trim()) return undefined
  const match = /^(\d+)\/(\d+)$/.exec(value.trim())
  if (!match) throw new Error('PROMPT_EVAL_SHARD must use 1-based i/n syntax, for example 1/30')
  const index = Number(match[1]) - 1
  const total = Number(match[2])
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || index < 0 || index >= total) throw new Error('PROMPT_EVAL_SHARD is out of range')
  return { index, total }
}

function isEvalRun(value: unknown): value is EvalRun {
  if (!value || typeof value !== 'object') return false
  const run = value as Partial<EvalRun>
  return typeof run.model === 'string' && typeof run.prompt === 'string' && typeof run.task === 'string' && typeof run.rep === 'number' && Number.isSafeInteger(run.rep) && run.rep > 0 && typeof run.ok === 'boolean' && typeof run.detail === 'string' && typeof run.steps === 'number' && Number.isSafeInteger(run.steps)
}
