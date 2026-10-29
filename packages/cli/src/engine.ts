import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_SYSTEM,
  builtinTools,
  createFoundry,
  createFoundryEmbedder,
  findModel,
  foundryConfigFromEnv,
  loadEnvFiles,
  memoryTools,
  modelsFromEnv,
  openLocalMemory,
  recallBlock,
  runAgent,
  webTools,
} from '@oqelira/core'
import type { Approver, ContextGateway, Message, ModelConfig, Risk, Tool } from '@oqelira/core'
import type { HostEvent } from '@oqelira/protocol'
import { clearHistory, loadHistory, saveHistory } from './history.js'

export interface EngineOptions {
  cwd: string
  envFile?: string
  model?: string
  /** Auto-approve file writes. */
  yes?: boolean
  /** Auto-approve everything, including shell commands and network. */
  yolo?: boolean
  maxSteps?: number
  /** Keep the default session on disk (CLI only). */
  persistHistory?: boolean
}

export interface RunIO {
  sessionId?: string
  signal?: AbortSignal
  approve: Approver
  onEvent(event: HostEvent): void
}

export interface Engine {
  readonly cwd: string
  readonly models: readonly ModelConfig[]
  readonly model: ModelConfig
  readonly memory: boolean
  readonly webSearch: boolean
  setModel(id: string): ModelConfig
  /** Summary line the interfaces show for a tool call. */
  describe(name: string, input: unknown): string
  history(sessionId?: string): Message[]
  clear(sessionId?: string): Promise<void>
  run(prompt: string, io: RunIO): Promise<{ ok: boolean; finishReason: string }>
}

export const DEFAULT_SESSION = 'default'

function readProjectRules(cwd: string): string {
  for (const name of ['OQELIRA.md', 'AGENTS.md']) {
    try {
      return `\n\nProject instructions (from ${name}):\n${fs.readFileSync(path.join(cwd, name), 'utf8').slice(0, 20_000)}`
    } catch {
      /* not there */
    }
  }
  return ''
}

/** Everything an interface needs, in one place: config, provider, tools, memory, rules, permissions, history. */
export async function createEngine(opts: EngineOptions): Promise<Engine> {
  const cwd = path.resolve(opts.cwd)
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Not a directory: ${cwd}`)
  loadEnvFiles({ explicit: opts.envFile, cwd })

  let config
  try {
    config = foundryConfigFromEnv()
  } catch (e) {
    throw new Error(`${(e as Error).message}\nSet them in the environment, or in ~/.oqelira/.env, or in ./.env, or pass --env-file.`)
  }
  const models = modelsFromEnv()
  let model = findModel(opts.model ?? process.env.OQELIRA_MODEL ?? 'gpt-6-sol', models)
  const makeProvider = createFoundry(config)

  // Project memory is on only when an embedding deployment is configured (never hardcoded).
  let memory: ContextGateway | undefined
  const embeddingDeployment = process.env.OQELIRA_EMBEDDING_DEPLOYMENT?.trim()
  const startupNotices: string[] = []
  if (embeddingDeployment) {
    try {
      memory = await openLocalMemory(cwd, createFoundryEmbedder(config)(embeddingDeployment))
    } catch (e) {
      startupNotices.push(`Project memory disabled: ${(e as Error).message}`)
    }
  }
  const tools: Tool[] = [...builtinTools, ...webTools(), ...(memory ? memoryTools(memory) : [])]
  const autoAllow: Risk[] = ['read', ...(opts.yes || opts.yolo ? (['write'] as Risk[]) : []), ...(opts.yolo ? (['exec', 'network'] as Risk[]) : [])]
  const system = DEFAULT_SYSTEM + readProjectRules(cwd)

  const sessions = new Map<string, Message[]>()
  if (opts.persistHistory) sessions.set(DEFAULT_SESSION, await loadHistory(cwd))
  const persists = (id: string) => opts.persistHistory && id === DEFAULT_SESSION

  return {
    cwd,
    models,
    get model() {
      return model
    },
    memory: Boolean(memory),
    webSearch: tools.some((t) => t.spec.name === 'web_search'),
    setModel(id) {
      model = findModel(id, models)
      return model
    },
    describe(name, input) {
      const tool = tools.find((t) => t.spec.name === name)
      try {
        return tool ? tool.describe(input) : name
      } catch {
        return name // malformed input; the tool will report it
      }
    },
    history: (id = DEFAULT_SESSION) => sessions.get(id) ?? [],
    async clear(id = DEFAULT_SESSION) {
      sessions.delete(id)
      if (persists(id)) await clearHistory(cwd)
    },
    async run(prompt, io) {
      const id = io.sessionId ?? DEFAULT_SESSION
      const history = sessions.get(id) ?? []
      for (const message of startupNotices.splice(0)) io.onEvent({ type: 'notice', message })
      let recalled = ''
      if (memory) {
        try {
          recalled = await recallBlock(memory, prompt, io.signal)
        } catch (e) {
          io.onEvent({ type: 'notice', message: `Memory recall skipped: ${(e as Error).message}` })
        }
      }
      try {
        const result = await runAgent({
          provider: makeProvider(model),
          prompt,
          tools,
          cwd,
          system: system + recalled,
          history,
          maxSteps: opts.maxSteps,
          permissions: { autoAllow, approve: io.approve },
          signal: io.signal,
          onText: (text) => io.onEvent({ type: 'text', text }),
          onContextCompacted: (info) => io.onEvent({ type: 'context-compacted', ...info }),
          onToolCall: (call) => io.onEvent({ type: 'tool-call', id: call.id, name: call.name, input: call.input }),
          onToolResult: (r) => io.onEvent({ type: 'tool-result', id: r.id, name: r.name, output: r.output, isError: r.isError }),
        })
        sessions.set(id, result.messages)
        if (persists(id)) await saveHistory(cwd, result.messages)
        io.onEvent({ type: 'done', reason: result.finishReason })
        return { ok: result.finishReason === 'stop', finishReason: result.finishReason }
      } catch (e) {
        // Status and message only: SDK errors can carry upstream request headers or bodies.
        const err = e as { message?: string; statusCode?: number }
        io.onEvent({ type: 'error', message: io.signal?.aborted ? 'Run stopped' : `${err.statusCode ? `[${err.statusCode}] ` : ''}${err.message ?? String(e)}` })
        return { ok: false, finishReason: 'error' }
      }
    },
  }
}
