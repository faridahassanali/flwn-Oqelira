import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import {
  DEFAULT_MODELS,
  DEFAULT_SYSTEM,
  builtinTools,
  webTools,
  createFoundry,
  findModel,
  foundryConfigFromEnv,
  runAgent,
} from '@oqelira/core'
import type { Approver, Message, ModelConfig, Risk } from '@oqelira/core'
import { renderApproval } from './approval.js'
import { loadEnvFiles } from './env.js'
import { LineReader } from './lines.js'
import { clearHistory, loadHistory, saveHistory } from './history.js'
import { bold, cyan, dim, green, red, yellow } from './ui.js'

const USAGE = `oqelira - AI coding agent by Flwn

Usage:
  oqelira                      interactive session (REPL)
  oqelira "fix the failing test"   one-shot task, then exit

Options:
  -m, --model <id>      model: ${DEFAULT_MODELS.map((m) => m.id).join(' | ')}  (default: gpt-6-sol, or $OQELIRA_MODEL)
      --cwd <dir>       project directory (default: current directory)
  -y, --yes             auto-approve file writes/edits (commands still ask)
      --yolo            auto-approve everything, including shell commands (use with care)
      --max-steps <n>   stop after n model steps (default 25)
      --env-file <f>    extra .env file (only FOUNDRY_/OQELIRA_/FLWN_/DATA_ keys are read)
      --no-history      do not load or save the local interactive session history
      --list-models     show the available models
  -h, --help            show this help

In the session:  /model <id>   /clear   /help   /exit      Ctrl+C interrupts a running task.
Project rules are read from OQELIRA.md (or AGENTS.md) in the project directory.
`

const SESSION_HELP = '/model <id>  switch model   /clear  forget saved conversation   /exit  quit   Ctrl+C  interrupt'

function readProjectRules(cwd: string): string {
  for (const name of ['OQELIRA.md', 'AGENTS.md']) {
    try {
      const text = fs.readFileSync(path.join(cwd, name), 'utf8').slice(0, 20_000)
      return `\n\nProject instructions (from ${name}):\n${text}`
    } catch {
      /* not there */
    }
  }
  return ''
}

function oneLine(text: string, max = 110): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return first.length > max ? `${first.slice(0, max)}...` : first
}

async function main(): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        model: { type: 'string', short: 'm' },
        cwd: { type: 'string' },
        yes: { type: 'boolean', short: 'y' },
        yolo: { type: 'boolean' },
        'max-steps': { type: 'string' },
        'env-file': { type: 'string' },
        'list-models': { type: 'boolean' },
        'no-history': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    })
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n\n${USAGE}`)
    return 2
  }
  const { values, positionals } = parsed
  if (values.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (values['list-models']) {
    for (const m of DEFAULT_MODELS) process.stdout.write(`${m.id.padEnd(14)} ${m.deployment.padEnd(16)} api=${m.api}  ${m.speed}\n`)
    return 0
  }

  const cwd = path.resolve(values.cwd ?? process.cwd())
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
    process.stderr.write(`Not a directory: ${cwd}\n`)
    return 2
  }
  loadEnvFiles({ explicit: values['env-file'], cwd })

  let config
  try {
    config = foundryConfigFromEnv()
  } catch (e) {
    process.stderr.write(
      `${(e as Error).message}\nSet them in the environment, or in ~/.oqelira/.env, or in ./.env, or pass --env-file.\n`,
    )
    return 2
  }

  let model: ModelConfig
  try {
    model = findModel(values.model ?? process.env.OQELIRA_MODEL ?? 'gpt-6-sol')
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    return 2
  }
  const maxSteps = values['max-steps'] ? Number(values['max-steps']) : 25
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    process.stderr.write('--max-steps must be a positive integer\n')
    return 2
  }

  const makeProvider = createFoundry(config)
  const system = DEFAULT_SYSTEM + readProjectRules(cwd)
  const autoAllow: Risk[] = ['read', ...(values.yes || values.yolo ? (['write'] as Risk[]) : []), ...(values.yolo ? (['exec'] as Risk[]) : [])]

  const lines = new LineReader()
  const alwaysAllow = new Set<Risk>()
  const approve: Approver = async (req) => {
    if (alwaysAllow.has(req.risk)) return true
    process.stdout.write(`${renderApproval(req)}\n`)
    const answer = await lines.next(`Allow? [y]es / [n]o / [a]lways for ${req.risk} this session: `)
    const a = (answer ?? '').trim().toLowerCase()
    if (a === 'a' || a === 'always') {
      alwaysAllow.add(req.risk)
      return true
    }
    return a === 'y' || a === 'yes'
  }

  let atLineStart = true
  const out = (text: string) => {
    if (!text) return
    process.stdout.write(text)
    atLineStart = text.endsWith('\n')
  }
  const ensureNewline = () => {
    if (!atLineStart) out('\n')
  }

  let current: AbortController | null = null
  lines.rl.on('SIGINT', () => {
    if (current) {
      current.abort()
    } else {
      lines.close()
    }
  })

  const tools = [...builtinTools, ...webTools()]

  async function runTurn(prompt: string, history: Message[]): Promise<{ ok: boolean; messages: Message[] }> {
    current = new AbortController()
    try {
      const result = await runAgent({
        provider: makeProvider(model),
        prompt,
        tools,
        cwd,
        system,
        history,
        maxSteps,
        permissions: { autoAllow, approve },
        signal: current.signal,
        onText: (d) => out(d),
        onContextCompacted: () => out(`${dim('Older context compacted for this request; full conversation history is retained.')}\n`),
        onToolCall: (call) => {
          ensureNewline()
          const tool = tools.find((t) => t.spec.name === call.name)
          let summary = call.name
          try {
            summary = tool ? tool.describe(call.input) : call.name
          } catch {
            /* malformed input; the tool will report it */
          }
          out(`${cyan('>')} ${dim(summary)}\n`)
        },
        onToolResult: (r) => {
          const mark = r.isError ? red('  x ') : dim('  ok ')
          out(`${mark}${dim(oneLine(r.output))}\n`)
        },
      })
      ensureNewline()
      if (result.finishReason === 'max-steps') out(`${yellow(`Stopped after ${maxSteps} steps.`)} Say "continue" to go on.\n`)
      if (result.finishReason === 'length') out(`${yellow('The reply was cut off (output limit).')}\n`)
      if (result.finishReason === 'other') out(`${yellow('The model stream ended without a completion signal. Review the output before continuing.')}\n`)
      return { ok: result.finishReason === 'stop', messages: result.messages }
    } catch (e) {
      ensureNewline()
      if (current?.signal.aborted) {
        out(`${yellow('(interrupted)')}\n`)
      } else {
        const err = e as { message?: string; statusCode?: number; responseBody?: string }
        out(`${red(`error: ${err.statusCode ? `[${err.statusCode}] ` : ''}${err.message ?? String(e)}`)}\n`)
        if (err.responseBody) out(`${dim(err.responseBody.slice(0, 300))}\n`)
      }
      return { ok: false, messages: history }
    } finally {
      current = null
    }
  }

  // ---- one-shot
  if (positionals.length > 0) {
    const { ok } = await runTurn(positionals.join(' '), [])
    lines.close()
    return ok ? 0 : 1
  }

  // ---- interactive session
  out(`${bold('oqelira')} ${dim(`model ${model.id} (${model.api}) | ${cwd}`)}\n${dim(SESSION_HELP)}\n`)
  let history: Message[] = values['no-history'] ? [] : await loadHistory(cwd)
  if (history.length) out(`${dim(`restored ${history.length} local history messages`)}\n`)
  for (;;) {
    const line = await lines.next(`${bold('> ')}`)
    if (line === null) break
    const text = line.trim()
    if (!text) continue
    if (text === '/exit' || text === '/quit') break
    if (text === '/help') {
      out(`${dim(SESSION_HELP)}\n`)
      continue
    }
    if (text === '/clear') {
      history = []
      if (!values['no-history']) await clearHistory(cwd)
      out(`${dim('conversation cleared')}\n`)
      continue
    }
    if (text.startsWith('/model')) {
      const id = text.split(/\s+/)[1]
      if (!id) {
        out(`${dim(`current: ${model.id}. available: ${DEFAULT_MODELS.map((m) => m.id).join(', ')}`)}\n`)
      } else {
        try {
          model = findModel(id)
          out(`${green('model:')} ${model.id} ${dim(`(${model.api})`)}\n`)
        } catch (e) {
          out(`${red((e as Error).message)}\n`)
        }
      }
      continue
    }
    if (text.startsWith('/')) {
      out(`${dim(`unknown command. ${SESSION_HELP}`)}\n`)
      continue
    }
    const result = await runTurn(text, history)
    if (result.ok || result.messages !== history) {
      history = result.messages
      if (!values['no-history']) await saveHistory(cwd, history)
    }
  }
  lines.close()
  return 0
}

main().then(
  (code) => {
    process.exitCode = code
    // Idle keep-alive sockets can hold the process open for a few seconds; don't wait for them.
    setTimeout(() => process.exit(code), 150).unref()
  },
  (e) => {
    process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`)
    process.exit(1)
  },
)
