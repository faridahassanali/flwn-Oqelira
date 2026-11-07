import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import { ENGINE_PROTOCOL } from '@oqelira/protocol'
import type { EngineMessage, EngineRequest } from '@oqelira/protocol'

export interface EngineClient {
  /** Resolves after the protocol handshake; rejects if the engine exits first. */
  readonly ready: Promise<void>
  readonly closed: boolean
  send(request: EngineRequest): void
  onMessage(listener: (message: EngineMessage) => void): () => void
  close(): void
}

/** Path of the headless engine launcher. Evaluated lazily: a bundled interface passes its own `bin` instead. */
export function engineBin(): string {
  return fileURLToPath(new URL('../bin/oqelira-engine.mjs', import.meta.url))
}

/** Starts `oqelira-engine` for one workspace (used by every interface: host, VS Code). Fail-closed: the engine is started without --yes/--yolo. */
export function spawnEngine(opts: { cwd: string; env?: NodeJS.ProcessEnv; args?: string[]; bin?: string }): EngineClient {
  const child = spawn(process.execPath, [opts.bin ?? engineBin(), '--cwd', opts.cwd, ...(opts.args ?? [])], {
    // The host already resolved its environment. The engine must not also read the workspace's own .env,
    // or a cloned project could redirect the Foundry key (FOUNDRY_BASE_URL beats FOUNDRY_ENDPOINT).
    env: { ...(opts.env ?? process.env), OQELIRA_NO_ENV_FILES: '1' },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  const listeners = new Set<(message: EngineMessage) => void>()
  const emit = (message: EngineMessage) => { for (const l of [...listeners]) l(message) }
  let closed = false
  let isReady = false
  let resolveReady!: () => void
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  ready.catch(() => {}) // surfaced by callers that await it

  readline.createInterface({ input: child.stdout! }).on('line', (line) => {
    let message: EngineMessage
    try { message = JSON.parse(line) } catch { return } // stdout is protocol-only; ignore anything else
    if (message.type === 'ready') {
      if (message.protocol !== ENGINE_PROTOCOL) { rejectReady(new Error('Engine speaks a different protocol version')); child.kill(); return }
      isReady = true
      resolveReady()
      return
    }
    emit(message)
  })
  child.on('exit', () => {
    closed = true
    rejectReady(new Error('Engine stopped'))
    // Whatever run was in flight can never finish now; tell its listener.
    if (isReady || listeners.size) emit({ type: 'error', message: 'Engine stopped' })
  })
  child.on('error', () => { closed = true; rejectReady(new Error('Engine could not start')) })
  child.stdin!.on('error', () => {}) // EPIPE after exit is handled by 'exit'

  const send = (request: EngineRequest) => { if (!closed) child.stdin!.write(JSON.stringify(request) + '\n') }
  send({ type: 'hello', protocol: ENGINE_PROTOCOL })
  return {
    ready,
    get closed() { return closed },
    send,
    onMessage(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    // Closing stdin lets the engine save session memory and exit; kill it only if that takes too long.
    close() {
      closed = true
      child.stdin!.end()
      const timer = setTimeout(() => child.kill(), 25_000)
      child.once('exit', () => clearTimeout(timer))
    },
  }
}
