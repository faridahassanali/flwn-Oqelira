import { randomUUID } from 'node:crypto'
import readline from 'node:readline'
import { ENGINE_PROTOCOL } from '@oqelira/protocol'
import type { EngineMessage, EngineRequest } from '@oqelira/protocol'
import { DEFAULT_SESSION } from './engine.js'
import type { Engine } from './engine.js'

const APPROVAL_TIMEOUT_MS = 120_000
interface ActiveRun { controller: AbortController; pending?: { id: string; resolve(allowed: boolean): void } }

/**
 * Headless engine: NDJSON requests on stdin, NDJSON messages on stdout (stdout carries protocol only;
 * diagnostics go to stderr). Fail-closed: an approval nobody answers is denied.
 */
export interface ServeOptions { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream; version?: string; approvalTimeoutMs?: number }
export async function serve(engine: Engine, { input = process.stdin, output = process.stdout, version = '0.0.0', approvalTimeoutMs = APPROVAL_TIMEOUT_MS }: ServeOptions = {}): Promise<void> {
  const send = (message: EngineMessage) => { output.write(JSON.stringify(message) + '\n') }
  let run: ActiveRun | undefined
  const touched = new Set<string>() // sessions with new work, mined for memory when we shut down

  /** Approval requests go to the interface and wait; unanswered, cancelled or timed out means denied. */
  const approverFor = (current: ActiveRun) => (request: Parameters<Parameters<Engine['run']>[1]['approve']>[0]) =>
    new Promise<boolean>((resolve) => {
      if (current.controller.signal.aborted) { resolve(false); return }
      const id = randomUUID()
      const timer = setTimeout(() => { if (current.pending?.id === id) { current.pending = undefined; resolve(false) } }, approvalTimeoutMs)
      current.pending = { id, resolve: (allowed) => { clearTimeout(timer); resolve(allowed) } }
      send({ type: 'approval', approval: { ...request, id } })
    })

  const abort = () => {
    run?.controller.abort()
    run?.pending?.resolve(false)
  }
  const handle = async (req: EngineRequest) => {
    switch (req.type) {
      case 'hello':
        if (req.protocol !== ENGINE_PROTOCOL) {
          send({ type: 'error', message: `Unsupported protocol ${req.protocol}; this engine speaks ${ENGINE_PROTOCOL}` })
          return
        }
        send({ type: 'ready', protocol: ENGINE_PROTOCOL, version, cwd: engine.cwd, model: engine.model.id, models: engine.models.map(({ id, deployment }) => ({ id, deployment })), memory: engine.memory, webSearch: engine.webSearch })
        return
      case 'cancel':
        abort()
        return
      case 'approval': {
        const pending = run?.pending
        if (!pending || pending.id !== req.approvalId) { send({ type: 'error', message: 'Approval is no longer pending' }); return }
        if (run) run.pending = undefined
        pending.resolve(req.allowed === true)
        return
      }
      case 'end': {
        if (run) { send({ type: 'error', message: 'Cannot end a session while a run is active' }); return }
        // The interface is present, so it is asked to approve what gets saved (cancel/stdin close deny it).
        const current: ActiveRun = { controller: new AbortController() }
        run = current
        try {
          const saved = await engine.endSession(req.sessionId, { onEvent: send, signal: current.controller.signal, approve: approverFor(current) })
          touched.delete(req.sessionId ?? DEFAULT_SESSION)
          send({ type: 'ended', saved: saved.length })
        } finally {
          run = undefined
        }
        return
      }
      case 'memory': {
        if (req.action === 'forget') {
          if (typeof req.id !== 'string') { send({ type: 'error', message: 'Memory id required' }); return }
          const forgotten = await engine.forgetMemory(req.id)
          send({ type: 'memory', entries: [], forgotten })
          return
        }
        if (req.action === 'approve') {
          if (typeof req.id !== 'string') { send({ type: 'error', message: 'Memory id required' }); return }
          const ids = req.id === 'all' ? (await engine.memories(500)).filter((m) => m.status === 'pending').map((m) => m.id) : [req.id]
          let approved = 0
          for (const id of ids) if (await engine.approveMemory(id)) approved++
          send({ type: 'memory', entries: [], approved })
          return
        }
        send({ type: 'memory', entries: (await engine.memories(50)).map(({ id, text, kind, status, createdAt }) => ({ id, text, kind, status, createdAt })) })
        return
      }
      case 'sessions':
        send({ type: 'sessions', sessions: engine.sessions() })
        return
      case 'history':
        send({ type: 'history', sessionId: req.sessionId ?? DEFAULT_SESSION, messages: await engine.history(req.sessionId) })
        return
      case 'clear':
        if (run) { send({ type: 'error', message: 'Cannot clear while a run is active' }); return }
        await engine.clear(req.sessionId)
        send({ type: 'cleared' })
        return
      case 'run': {
        if (run) { send({ type: 'error', message: 'A run is already active' }); return }
        if (typeof req.prompt !== 'string' || !req.prompt.trim() || req.prompt.length > 100_000) { send({ type: 'error', message: 'Enter a prompt of at most 100000 characters' }); return }
        try { if (req.model) engine.setModel(req.model) } catch (e) { send({ type: 'error', message: (e as Error).message }); return }
        const current: ActiveRun = { controller: new AbortController() }
        run = current
        touched.add(req.sessionId ?? DEFAULT_SESSION)
        send({ type: 'started', runId: randomUUID(), sessionId: req.sessionId ?? 'default' })
        try {
          await engine.run(req.prompt.trim(), {
            sessionId: req.sessionId,
            signal: current.controller.signal,
            onEvent: send,
            approve: approverFor(current),
          })
        } finally {
          run = undefined
        }
        return
      }
    }
  }

  const rl = readline.createInterface({ input, crlfDelay: Infinity })
  const inflight = new Set<Promise<void>>()
  for await (const line of rl) {
    if (!line.trim()) continue
    let req: EngineRequest
    try {
      req = JSON.parse(line)
      if (!req || typeof req !== 'object' || typeof req.type !== 'string') throw new Error()
    } catch {
      send({ type: 'error', message: 'Invalid JSON request' })
      continue
    }
    // Requests run concurrently so `cancel` and `approval` can arrive while a run is active.
    const task = handle(req).catch((e) => send({ type: 'error', message: (e as Error).message })).finally(() => inflight.delete(task))
    inflight.add(task)
  }
  abort() // stdin closed: the interface is gone, so stop any run and deny its pending approval
  await Promise.allSettled(inflight)
  // Closing the app ends the chats: save what they decided (best effort, bounded).
  for (const id of touched) await engine.endSession(id, { signal: AbortSignal.timeout(20_000) }).catch(() => {})
}
