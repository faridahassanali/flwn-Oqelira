import { parseArgs } from 'node:util'
import path from 'node:path'
import { DEFAULT_MODELS, plainText } from '@oqelira/core'
import type { Approver, Risk } from '@oqelira/core'
import { renderApproval } from './approval.js'
import { createEngine, DEFAULT_SESSION, serve } from '@oqelira/engine'
import type { Engine } from '@oqelira/engine'
import { LineReader } from './lines.js'
import { bold, collapsePreviousLine, cyan, dim, green, playStartup, red, terminalEnabled, yellow } from './ui.js'
import { StepLog, stepDetails, stepSummary } from './steps.js'
import { StepRail } from './rail.js'

const USAGE = `oqelira - AI coding agent by Flwn

Usage:
  oqelira                      interactive session (REPL)
  oqelira "fix the failing test"   one-shot task, then exit

Options:
  -m, --model <id>      model: ${DEFAULT_MODELS.map((m) => m.id).join(' | ')}  (default: gpt-6-sol, or $OQELIRA_MODEL)
      --cwd <dir>       project directory (default: current directory)
  -y, --yes             auto-approve file writes/edits (commands still ask)
      --yolo            auto-approve everything, including shell commands (use with care)
      --auto            let the configured decision model approve safe shell commands
      --max-steps <n>   stop after n model steps (default 25)
      --env-file <f>    extra .env file (only FOUNDRY_/OQELIRA_/FLWN_/DATA_ keys are read)
      --no-history      do not load or save the local interactive session history
      --no-auto-memory  do not save facts to project memory when a session ends
      --list-models     show the available models
  -h, --help            show this help

Subcommands:
  oqelira serve         headless engine for the web host and VS Code (JSON lines on stdin/stdout)

In the session:  /model <id>   /resume [id]   /clear   /help   /exit      Ctrl+C interrupts a running task.
Project rules are read from OQELIRA.md (or AGENTS.md) in the project directory.
`

const SESSION_HELP = '/model <id>  switch model   /resume [id]  list or resume a session   /memory  list project memory   /steps  expand completed steps   /step <n>  expand one step   /clear  forget current session   /exit  quit   Ctrl+C  interrupt'

function oneLine(text: string, max = 110): string {
  const first = text.split(/\r?\n/).find((l) => l.trim()) ?? ''
  return first.length > max ? `${first.slice(0, max)}...` : first
}

function compactCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}m`
  if (value >= 1_000) return `${(value / 1_000).toFixed(value >= 10_000 ? 0 : 1)}k`
  return String(value)
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
        auto: { type: 'boolean' },
        'max-steps': { type: 'string' },
        'env-file': { type: 'string' },
        'list-models': { type: 'boolean' },
        'no-history': { type: 'boolean' },
        'no-auto-memory': { type: 'boolean' },
        'approval-timeout-ms': { type: 'string' },
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

  const maxSteps = values['max-steps'] ? Number(values['max-steps']) : 25
  if (!Number.isInteger(maxSteps) || maxSteps < 1) {
    process.stderr.write('--max-steps must be a positive integer\n')
    return 2
  }
  const serving = positionals[0] === 'serve'
  let engine: Engine
  try {
    engine = await createEngine({
      cwd: values.cwd ?? process.cwd(),
      envFile: values['env-file'],
      model: values.model,
      yes: values.yes,
      yolo: values.yolo,
      auto: values.auto,
      maxSteps,
      persistHistory: !values['no-history'],
      autoMemory: !values['no-auto-memory'],
    })
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`)
    return 2
  }
  if (serving) {
    const approvalTimeoutMs = values['approval-timeout-ms'] ? Number(values['approval-timeout-ms']) : undefined
    if (approvalTimeoutMs !== undefined && (!Number.isInteger(approvalTimeoutMs) || approvalTimeoutMs < 1)) {
      process.stderr.write('--approval-timeout-ms must be a positive integer\n')
      return 2
    }
    await serve(engine, { approvalTimeoutMs })
    return 0
  }
  const { cwd } = engine
  let sessionId = DEFAULT_SESSION

  const lines = new LineReader()
  const alwaysAllow = new Set<Risk>()
  const approve: Approver = async (req) => {
    if (alwaysAllow.has(req.risk)) return true
    process.stdout.write(`${renderApproval(req)}\n`)
    const answer = await lines.next(`Allow? [y]es / [n]o / [a]lways ${req.risk} this session / [p]roject (saved): `)
    const a = (answer ?? '').trim().toLowerCase()
    if (a === 'a' || a === 'always') {
      alwaysAllow.add(req.risk)
      return true
    }
    if (a === 'p') {
      if (!engine.allowAlways(req, 'project')) out(`${dim('not saved: network calls are always asked; allowed this once')}\n`)
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

  const usageLabel = (name: string, window: { used: number; limit?: number }) => `${name} ${window.limit === undefined ? 'off' : `${compactCount(window.used)}/${compactCount(window.limit)}`}`
  const statusLine = async (): Promise<string> => {
    const history = await engine.history(sessionId)
    const raw = `${engine.model.id} | ${path.basename(cwd) || cwd} | session ${sessionId === DEFAULT_SESSION ? 'default' : sessionId.slice(0, 8)} | context ${compactCount(JSON.stringify(history).length)} chars | ${usageLabel('5h', engine.usage().fiveHours)} | ${usageLabel('week', engine.usage().weekly)}`
    const width = process.stdout.columns ?? 120
    const clipped = raw.length > Math.max(48, width - 2) ? `${raw.slice(0, Math.max(45, width - 5))}...` : raw
    return `${dim('status ')}${bold(clipped)}`
  }
  const commandMenu = () => [
    `${bold('/model <id>')}  switch model`,
    `${bold('/resume [id]')}  list or resume a saved session`,
    `${bold('/memory [approve|forget]')}  review project memory`,
    `${bold('/steps')} / ${bold('/step <n>')}  review completed tool steps`,
    `${bold('/clear')}  clear the current session`,
    `${bold('/help')} / ${bold('/exit')}  show help or leave`,
  ].join('\n')
  const printStatus = async () => { ensureNewline(); out(`${await statusLine()}\n`) }

  let current: AbortController | null = null
  const steps = new StepLog()
  const rail = new StepRail()
  lines.rl.on('SIGINT', () => {
    if (current) {
      current.abort()
    } else {
      lines.close()
    }
  })

  async function runTurn(prompt: string): Promise<boolean> {
    current = new AbortController()
    let reason = ''
    const closeRail = () => {
      if (rail.active) {
        ensureNewline()
        out(`${dim(rail.end())}\n`)
      }
    }
    try {
      const result = await engine.run(prompt, {
        sessionId,
        signal: current.signal,
        approve,
        onEvent: (e) => {
          switch (e.type) {
            case 'text':
              out(plainText(e.text)) // streamed deltas: ESC is stripped, so a split sequence is just inert text
              break
            case 'context-compacted':
              out(`${dim('Older context compacted for this request; full conversation history is retained.')}\n`)
              break
            case 'notice':
              ensureNewline()
              out(`${dim(e.message)}\n`)
              break
            case 'tool-call':
              ensureNewline()
              steps.start(e.id, e.name, engine.describe(e.name, e.input))
              out(`${dim(rail.begin())}${cyan('>')} ${dim(engine.describe(e.name, e.input))}\n`)
              break
            case 'tool-result':
              {
                const canCollapse = terminalEnabled && steps.activeCount() === 1
                const step = steps.finish(e.id, e.output, e.isError)
                if (!step) {
                  out(`${dim(rail.item())}${e.isError ? red('x ') : dim('ok ')}${dim(oneLine(e.output))}\n`)
                  break
                }
                if (canCollapse) collapsePreviousLine()
                if (canCollapse) {
                  out(`${dim(rail.item())}${e.isError ? red('x ') : dim('ok ')}${dim(stepSummary(step))}\n`)
                  break
                }
                out(`${dim(rail.item())}${e.isError ? red('x ') : dim('ok ')}${dim(oneLine(e.output))}\n`)
              }
              break
            case 'done':
              reason = e.reason
              closeRail()
              break
            case 'error':
              closeRail()
              ensureNewline()
              out(e.message === 'Run stopped' ? `${yellow('(interrupted)')}\n` : `${red(`error: ${e.message}`)}\n`)
              break
          }
        },
      })
      ensureNewline()
      if (reason === 'max-steps') out(`${yellow(`Stopped after ${maxSteps} steps.`)} Say "continue" to go on.\n`)
      if (reason === 'length') out(`${yellow('The reply was cut off (output limit).')}\n`)
      if (reason === 'other') out(`${yellow('The model stream ended without a completion signal. Review the output before continuing.')}\n`)
      return result.ok
    } finally {
      closeRail()
      current = null
    }
  }

  /** End of a chat: save its durable facts to project memory (prints what was saved). */
  async function saveSessionMemory(): Promise<void> {
    if (!engine.memory) return
    const abort = new AbortController()
    current = abort
    try {
      await engine.endSession(sessionId, { signal: abort.signal, approve, onEvent: (e) => { if (e.type === 'notice') out(`${dim(e.message)}\n`) } })
    } catch {
      /* interrupted: nothing is marked as saved, so the next session retries */
    } finally {
      current = null
    }
  }

  // ---- one-shot
  if (positionals.length > 0) {
    const ok = await runTurn(positionals.join(' '))
    await saveSessionMemory()
    lines.close()
    return ok ? 0 : 1
  }

  // ---- interactive session
  await playStartup()
  out(`${await statusLine()}\n${bold('Oqelira')} ${dim(`by Flwn · ${cwd}`)}\n${dim(SESSION_HELP)}\n`)
  const pending = engine.memory ? (await engine.memories(500)).filter((m) => m.status === 'pending').length : 0
  if (pending) out(`${yellow(`${pending} proposed ${pending === 1 ? 'memory awaits' : 'memories await'} your review:`)} ${dim('/memory, then /memory approve <id|all>')}\n`)
  const restored = (await engine.history(sessionId)).length
  if (restored) out(`${dim(`restored ${restored} local history messages`)}\n`)
  let firstPrompt = true
  for (;;) {
    if (!firstPrompt) await printStatus()
    firstPrompt = false
    const line = await lines.next(`${bold('> ')}`)
    if (line === null) break
    const text = line.trim()
    if (!text) continue
    if (text === '/exit' || text === '/quit') break
    if (text === '/help') {
      out(`${commandMenu()}\n`)
      continue
    }
    if (text === '/resume' || text.startsWith('/resume ')) {
      const requested = text.split(/\s+/)[1]
      const sessions = engine.sessions()
      if (!requested) {
        out(sessions.length ? sessions.slice(0, 12).map(one => `${dim(one.id === sessionId ? '*' : ' ')} ${one.id.slice(0, 8)}  ${plainText(one.title)}  ${one.messages} msgs`).join('\n') + '\n' : `${dim('no saved sessions yet')}\n`)
      } else {
        const found = sessions.find(one => one.id === requested || one.id.startsWith(requested))
        if (!found) out(`${dim('session not found. use /resume to list saved sessions')}\n`)
        else { sessionId = found.id; out(`${green('session:')} ${plainText(found.title)} ${dim(`(${found.id.slice(0, 8)})`)}\n`) }
      }
      continue
    }
    if (text === '/steps') {
      const all = steps.all()
      out(all.length ? all.map(step => `${dim(`[${step.index}]`)} ${plainText(stepSummary(step))}`).join('\n') + '\n' : `${dim('no completed steps yet')}\n`)
      continue
    }
    if (text.startsWith('/step')) {
      const index = Number(text.split(/\s+/)[1])
      const step = Number.isInteger(index) && index > 0 ? steps.get(index) : undefined
      out(step ? `${plainText(stepDetails(step))}\n` : `${dim('unknown step. use /steps or /step <n>')}\n`)
      continue
    }
    if (text === '/memory' || text.startsWith('/memory ')) {
      const [, action, id] = text.split(/\s+/)
      if (action === 'forget') {
        out(`${dim(id && (await engine.forgetMemory(id)) ? 'forgotten' : 'no memory with that id')}\n`)
      } else if (action === 'approve') {
        const ids = id === 'all' ? (await engine.memories(500)).filter((m) => m.status === 'pending').map((m) => m.id) : id ? [id] : []
        let n = 0
        for (const one of ids) if (await engine.approveMemory(one)) n++
        out(`${dim(n ? `approved ${n}` : 'nothing to approve (use /memory approve <id|all>)')}\n`)
      } else if (!engine.memory) {
        out(`${dim('Project memory is off. Set OQELIRA_EMBEDDING_DEPLOYMENT to enable it.')}\n`)
      } else {
        const entries = await engine.memories(20)
        out(entries.length ? entries.map((m) => `${dim(`[${m.id.slice(0, 8)}]`)}${m.status === 'pending' ? yellow(' (pending review)') : ''} ${plainText(m.text)}`).join('\n') + '\n' : `${dim('no saved memory yet')}\n`)
      }
      continue
    }
    if (text === '/clear') {
      await saveSessionMemory()
      await engine.clear(sessionId)
      steps.clear()
      if (rail.active) out(`${dim(rail.end())}\n`)
      out(`${dim('conversation cleared')}\n`)
      continue
    }
    if (text.startsWith('/model')) {
      const id = text.split(/\s+/)[1]
      if (!id) {
        out(`${dim(`current: ${engine.model.id}. available: ${engine.models.map((m) => m.id).join(', ')}`)}\n`)
      } else {
        try {
          const model = engine.setModel(id)
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
    await runTurn(text)
  }
  await saveSessionMemory()
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
