import { parseArgs } from 'node:util'
import { createEngine } from './engine.js'
import { serve } from './serve.js'

const USAGE = `oqelira-engine - headless Oqelira engine (JSON lines on stdin/stdout)

Options:
  -m, --model <id>            default model
      --cwd <dir>             project directory (default: current directory)
  -y, --yes                   auto-approve file writes
      --yolo                  auto-approve everything (use with care)
      --max-steps <n>         stop a run after n model steps (default 25)
      --env-file <f>          extra .env file
      --no-history            do not store sessions on disk
      --context-chars <n>     summarize older turns above this request size (default 80000)
      --max-continues <n>     auto-continue this many times after the step limit (default 3)
      --approval-timeout-ms   deny an unanswered approval after this long (default 120000)
  -h, --help                  show this help
`

async function main(): Promise<number> {
  let values
  try {
    values = parseArgs({
      options: {
        model: { type: 'string', short: 'm' },
        cwd: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        yolo: { type: 'boolean' },
        'max-steps': { type: 'string' },
        'env-file': { type: 'string' },
        'approval-timeout-ms': { type: 'string' },
        'no-history': { type: 'boolean' },
        'context-chars': { type: 'string' },
        'max-continues': { type: 'string' },
        help: { type: 'boolean', short: 'h' },
      },
    }).values
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  const positive = (name: 'max-steps' | 'approval-timeout-ms' | 'context-chars' | 'max-continues') => {
    const raw = values[name]
    if (raw === undefined) return undefined
    const n = Number(raw)
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`)
    return n
  }
  try {
    const engine = await createEngine({
      cwd: values.cwd ?? process.cwd(),
      envFile: values['env-file'],
      model: values.model,
      yes: values.yes,
      yolo: values.yolo,
      maxSteps: positive('max-steps') ?? 25,
      persistHistory: !values['no-history'],
      contextChars: positive('context-chars'),
      maxContinues: positive('max-continues'),
    })
    await serve(engine, { approvalTimeoutMs: positive('approval-timeout-ms') })
    return 0
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    return 2
  }
}

main().then(
  (code) => {
    process.exitCode = code
    setTimeout(() => process.exit(code), 150).unref()
  },
  (e) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    process.exit(1)
  },
)
