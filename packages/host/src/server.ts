import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { runAgent, builtinTools, DEFAULT_SYSTEM } from '@oqelira/core'
import type { Message, ModelConfig, ModelProvider } from '@oqelira/core'
import type { HostEvent } from '@oqelira/protocol'

interface HostOptions {
  cwd: string
  dist: string
  models: readonly ModelConfig[]
  configured: boolean
  approvalTimeoutMs?: number
  provider: (model: ModelConfig) => ModelProvider
}
interface Session { history: Message[]; busy: boolean }
interface Run {
  controller: AbortController
  pending?: { id: string; resolve: (allowed: boolean) => void }
}
class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message) }
}
async function json(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.headers['content-type'] !== 'application/json') throw new HttpError(415, 'Expected application/json')
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 32_768) throw new HttpError(413, 'Request is too large')
    chunks.push(chunk)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    return value as Record<string, unknown>
  } catch { throw new HttpError(400, 'Invalid JSON object') }
}

/** Local single-user host. One origin, fixed workspace, fail-closed approvals. */
export function createHost(opts: HostOptions) {
  const sessions = new Map<string, Session>()
  const runs = new Map<string, Run>()
  let origin = ''
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Host validation also prevents DNS rebinding; no permissive CORS headers.
    if (req.headers.host !== new URL(origin).host) throw new HttpError(403, 'Invalid host')
    if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Invalid origin')
    const url = new URL(req.url ?? '/', origin)
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST' && (req.headers.origin !== origin || req.headers['x-oqelira-client'] !== 'workspace')) {
        throw new HttpError(403, 'Use the local Oqelira workspace')
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        reply(res, 200, { workspace: path.basename(opts.cwd), models: opts.models.map(({ id, deployment }) => ({ id, deployment })), configured: opts.configured })
        return
      }
      if (req.method === 'POST' && url.pathname === '/api/approval') {
        const body = await json(req)
        if (typeof body.runId !== 'string' || typeof body.approvalId !== 'string' || typeof body.allowed !== 'boolean') throw new HttpError(400, 'Invalid approval')
        const run = runs.get(body.runId)
        if (!run?.pending || run.pending.id !== body.approvalId) throw new HttpError(409, 'Approval is no longer pending')
        const pending = run.pending
        run.pending = undefined
        pending.resolve(body.allowed)
        reply(res, 200, { ok: true })
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/api/run') throw new HttpError(404, 'Not found')
      const body = await json(req)
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 10_000) throw new HttpError(400, 'Enter a prompt of at most 10000 characters')
      const model = opts.models.find(m => m.id === body.model)
      if (!model) throw new HttpError(400, 'Choose a configured model')
      if (!opts.configured) throw new HttpError(503, 'Configure Foundry in the host .env, then restart the host')
      const provider = opts.provider(model)
      const sessionId = body.sessionId === undefined ? randomUUID() : body.sessionId
      if (typeof sessionId !== 'string' || (body.sessionId !== undefined && !sessions.has(sessionId))) throw new HttpError(404, 'Session not found; start a new session')
      // Bound in-memory history. Completed sessions expire when the host restarts.
      if (!sessions.has(sessionId) && sessions.size >= 100) throw new HttpError(429, 'Session limit reached; restart the local host')
      const session = sessions.get(sessionId) ?? { history: [], busy: false }
      if (session.busy) throw new HttpError(409, 'This session is already running')
      if (JSON.stringify(session.history).length > 1_000_000) throw new HttpError(413, 'Session is full; start a new session')
      session.busy = true
      sessions.set(sessionId, session)
      const runId = randomUUID()
      const run: Run = { controller: new AbortController() }
      runs.set(runId, run)
      const abort = () => { run.controller.abort(); run.pending?.resolve(false); run.pending = undefined }
      res.on('close', abort)
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.flushHeaders()
      const send = (event: HostEvent) => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n') }
      send({ type: 'started', runId, sessionId })
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n') }, 15_000)
      try {
        let rules = ''
        for (const name of ['OQELIRA.md', 'AGENTS.md']) {
          try { rules = `\n\nProject instructions (${name}):\n${(await fs.readFile(path.join(opts.cwd, name), 'utf8')).slice(0, 20_000)}`; break } catch { /* optional */ }
        }
        const result = await runAgent({
          cwd: opts.cwd, provider, prompt: body.prompt.trim(), history: session.history,
          tools: builtinTools, system: DEFAULT_SYSTEM + rules, signal: run.controller.signal,
          permissions: { autoAllow: ['read'], approve: request => new Promise<boolean>(resolve => {
            if (run.controller.signal.aborted) { resolve(false); return }
            const id = randomUUID()
            const timer = setTimeout(() => { if (run.pending?.id === id) { run.pending = undefined; resolve(false) } }, opts.approvalTimeoutMs ?? 120_000)
            run.pending = { id, resolve: allowed => { clearTimeout(timer); resolve(allowed) } }
            send({ type: 'approval', approval: { ...request, id } })
          }) },
          onText: text => send({ type: 'text', text }),
          onContextCompacted: info => send({ type: 'context-compacted', originalChars: info.originalChars, requestChars: info.requestChars, archivedMessages: info.archivedMessages }),
          onToolCall: call => send({ type: 'tool-call', ...call }),
          onToolResult: result => send({ type: 'tool-result', ...result }),
        })
        session.history = result.messages
        send({ type: 'done', reason: result.finishReason })
      } catch {
        // SDK errors may include upstream request headers or bodies; do not echo them.
        send({ type: 'error', message: run.controller.signal.aborted ? 'Run stopped' : 'The model run failed. Check host configuration and retry.' })
      } finally {
        clearInterval(heartbeat)
        abort()
        session.busy = false
        runs.delete(runId)
        res.end()
      }
      return
    }
    if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed')
    let relative: string
    try { relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname) } catch { throw new HttpError(400, 'Invalid path') }
    const file = path.resolve(opts.dist, '.' + relative)
    const rel = path.relative(opts.dist, file)
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new HttpError(403, 'Invalid path')
    let bytes: Buffer
    try { bytes = await fs.readFile(file) } catch { throw new HttpError(404, 'Build the web workspace first') }
    const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon', '.png': 'image/png' }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    })
    res.end(bytes)
  }
  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (res.headersSent) { res.end(); return }
      reply(res, error instanceof HttpError ? error.status : 500, { error: error instanceof HttpError ? error.message : 'Host request failed' })
    })
  })
  return {
    async listen(port = 0) {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      const address = server.address()
      if (!address || typeof address === 'string') throw new Error('Host did not bind a TCP port')
      origin = `http://127.0.0.1:${address.port}`
      return origin
    },
    async close() {
      for (const run of runs.values()) { run.controller.abort(); run.pending?.resolve(false) }
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
