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
import type { ApprovalRequest, Approver, ContextGateway, MemoryEntry, Message, ModelConfig, Permissions, Risk, Tool } from '@oqelira/core'
import type { HostEvent } from '@oqelira/protocol'
import { createCompactor } from './compaction.js'
import { extractFacts, saveFacts, selectFacts } from './memorize.js'
import { openRules } from './rules.js'
import { noStore, openSessionStore } from './store.js'
import type { SessionInfo, SessionStore, Snapshot } from './store.js'

export interface EngineOptions {
  cwd: string
  envFile?: string
  model?: string
  /** Auto-approve file writes. */
  yes?: boolean
  /** Auto-approve everything, including shell commands and network. */
  yolo?: boolean
  maxSteps?: number
  /** Keep sessions (full history plus latest compact snapshot) on disk. */
  persistHistory?: boolean
  /** Request size, in characters, above which older turns are summarized. */
  contextChars?: number
  /** At the end of a session, save durable facts to project memory (needs memory enabled). Default on. */
  autoMemory?: boolean
  /** After hitting the step limit, keep going this many more times. */
  maxContinues?: number
  /** Auto-mode hook: consulted after saved rules, before the user is asked. */
  decide?: Permissions['decide']
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
  /** Remember an approved request so it is never asked again (commands: this exact command only). */
  allowAlways(req: ApprovalRequest, scope: 'project' | 'user'): void
  history(sessionId?: string): Promise<Message[]>
  sessions(): SessionInfo[]
  /** Mines the session's new messages for durable facts and saves them. Returns what was saved. */
  endSession(sessionId?: string, io?: { signal?: AbortSignal; onEvent?(event: HostEvent): void; approve?: Approver }): Promise<MemoryEntry[]>
  memories(limit?: number): Promise<MemoryEntry[]>
  forgetMemory(id: string): Promise<boolean>
  approveMemory(id: string): Promise<boolean>
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
  // Read before any .env loads: a project's own .env must not choose where history and memory are written.
  const stateRoot = process.env.OQELIRA_HOME
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
      memory = await openLocalMemory(cwd, createFoundryEmbedder(config)(embeddingDeployment), stateRoot)
    } catch (e) {
      startupNotices.push(`Project memory disabled: ${(e as Error).message}`)
    }
  }
  const tools: Tool[] = [...builtinTools, ...webTools(), ...(memory ? memoryTools(memory) : [])]
  const autoAllow: Risk[] = ['read', ...(opts.yes || opts.yolo ? (['write'] as Risk[]) : []), ...(opts.yolo ? (['exec', 'network'] as Risk[]) : [])]
  const rules = openRules(cwd, stateRoot)
  const decide: Permissions['decide'] = (req) => (rules.allows(req) ? 'allow' : opts.decide?.(req))
  const system = DEFAULT_SYSTEM + readProjectRules(cwd)

  let store: SessionStore = noStore
  if (opts.persistHistory) {
    try {
      store = await openSessionStore(cwd, stateRoot)
    } catch (e) {
      startupNotices.push(`Session history disabled: ${(e as Error).message}`)
    }
  }
  interface State { messages: Message[]; snapshot?: Snapshot; persisted: number }
  const states = new Map<string, State>()
  const stateOf = (id: string): State => {
    let st = states.get(id)
    if (!st) {
      const loaded = store.load(id)
      st = { messages: loaded?.messages ?? [], snapshot: loaded?.snapshot, persisted: loaded?.messages.length ?? 0 }
      states.set(id, st)
    }
    return st
  }
  /**
   * Stored once per completed run segment, never mid-run: a failed or interrupted run is dropped from
   * memory, so the durable copy must drop it too or the two would drift apart.
   */
  const persist = (id: string, st: State) => {
    if (st.messages.length > st.persisted) {
      store.append(id, st.messages, st.persisted, { model: model.id })
      st.persisted = st.messages.length
    }
  }
  const contextChars = opts.contextChars ?? 80_000
  const maxContinues = opts.maxContinues ?? 3

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
    allowAlways: (req, scope) => rules.add(req, scope),
    describe(name, input) {
      const tool = tools.find((t) => t.spec.name === name)
      try {
        return tool ? tool.describe(input) : name
      } catch {
        return name // malformed input; the tool will report it
      }
    },
    async history(id = DEFAULT_SESSION) {
      return stateOf(id).messages
    },
    sessions: () => store.list(),
    memories: async (limit) => (memory ? memory.list(limit) : []),
    forgetMemory: async (id) => (memory ? memory.forget(id) : false),
    approveMemory: async (id) => (memory ? memory.approve(id) : false),
    async endSession(id = DEFAULT_SESSION, io = {}) {
      if (!memory || opts.autoMemory === false) return []
      const st = stateOf(id)
      const from = Math.min(store.getMemorized(id), st.messages.length)
      const fresh = st.messages.slice(from)
      if (fresh.length < 4) return [] // too short to have decided anything
      try {
        const candidates = await selectFacts(memory, await extractFacts(makeProvider(model), fresh, io.signal), io.signal)
        // Saved text is injected into future prompts, so saving is gated like save_memory: asked unless writes
        // are auto-allowed. Without anyone to ask (shutdown), facts are kept as `pending` and never recalled.
        let status: MemoryEntry['status'] | undefined = candidates.length ? 'pending' : undefined
        if (candidates.length && autoAllow.includes('write')) status = 'active'
        else if (candidates.length && io.approve) {
          const allowed = await io.approve({ tool: 'save_memory', risk: 'write', summary: `save ${candidates.length} ${candidates.length === 1 ? 'fact' : 'facts'} from this session to project memory`, input: { facts: candidates } })
          status = allowed ? 'active' : undefined // declined: nothing is stored, and we do not ask again for these messages
        }
        const saved = status ? await saveFacts(memory, candidates, id, status, io.signal) : []
        store.setMemorized(id, st.messages.length) // only after a successful extraction
        if (saved.length) {
          const list = saved.map((m) => `  - [${m.id.slice(0, 8)}] ${m.text}`).join('\n')
          io.onEvent?.({ type: 'notice', message: status === 'pending' ? `Proposed ${saved.length} ${saved.length === 1 ? 'memory' : 'memories'} for review (not used until approved; /memory approve <id|all>):\n${list}` : `Saved ${saved.length} ${saved.length === 1 ? 'memory' : 'memories'} from this session:\n${list}` })
        }
        return saved
      } catch (e) {
        if (io.signal?.aborted) throw e
        io.onEvent?.({ type: 'notice', message: `Could not save session memory: ${(e as Error).message}` })
        return []
      }
    },
    async clear(id = DEFAULT_SESSION) {
      states.delete(id)
      store.remove(id)
    },
    async run(prompt, io) {
      const id = io.sessionId ?? DEFAULT_SESSION
      const st = stateOf(id)
      for (const message of startupNotices.splice(0)) io.onEvent({ type: 'notice', message })
      let recalled = ''
      if (memory) {
        try {
          recalled = await recallBlock(memory, prompt, io.signal)
        } catch (e) {
          io.onEvent({ type: 'notice', message: `Memory recall skipped: ${(e as Error).message}` })
        }
      }
      const provider = makeProvider(model)
      const compact = createCompactor({
        provider,
        budget: contextChars,
        getSnapshot: () => st.snapshot,
        save: (summary, coversThrough) => (st.snapshot = store.saveSnapshot(id, summary, coversThrough)),
        notice: (message) => io.onEvent({ type: 'notice', message }),
      })
      try {
        let next = prompt
        for (let attempt = 0; ; attempt++) {
          const result = await runAgent({
            provider,
            prompt: next,
            tools,
            cwd,
            system: system + recalled,
            history: st.messages,
            maxSteps: opts.maxSteps,
            permissions: { autoAllow, decide, approve: io.approve },
            signal: io.signal,
            compact,
            onText: (text) => io.onEvent({ type: 'text', text }),
            onContextCompacted: (info) => io.onEvent({ type: 'context-compacted', ...info }),
            onToolCall: (call) => io.onEvent({ type: 'tool-call', id: call.id, name: call.name, input: call.input }),
            onToolResult: (r) => io.onEvent({ type: 'tool-result', id: r.id, name: r.name, output: r.output, isError: r.isError }),
          })
          st.messages = result.messages
          persist(id, st)
          if (result.finishReason === 'max-steps' && attempt < maxContinues) {
            io.onEvent({ type: 'notice', message: `Step limit reached; continuing automatically (${attempt + 1}/${maxContinues}).` })
            next = 'Continue the task from where you stopped. If it is already complete, say so briefly.'
            continue
          }
          io.onEvent({ type: 'done', reason: result.finishReason })
          return { ok: result.finishReason === 'stop', finishReason: result.finishReason }
        }
      } catch (e) {
        // Status and message only: SDK errors can carry upstream request headers or bodies.
        const err = e as { message?: string; statusCode?: number }
        io.onEvent({ type: 'error', message: io.signal?.aborted ? 'Run stopped' : `${err.statusCode ? `[${err.statusCode}] ` : ''}${err.message ?? String(e)}` })
        return { ok: false, finishReason: 'error' }
      }
    },
  }
}
