import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ModelConfig } from '@oqelira/core'
import type { HostEvent } from '@oqelira/protocol'
import type { EngineClient } from './engine-client.js'

interface HostOptions {
  cwd: string
  dist: string
  models: readonly ModelConfig[]
  configured: boolean
  /** Per-launch secret from the desktop app. Requests without it are refused, so a browser tab cannot use the host. */
  launchToken: string
  /** Starts (or restarts) the engine this host is an interface to. */
  startEngine: () => EngineClient
}
interface Run { pending?: string }
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

/**
 * Internal host of the desktop app: the window's interface to the engine. It owns the HTTP security
 * (launch token, origin, CSRF header, CSP) and nothing about the agent. One origin, fixed workspace.
 */
export function createHost(opts: HostOptions) {
  const sessions = new Set<string>()
  const runs = new Map<string, Run>()
  let engine: EngineClient | undefined
  let active = false
  let origin = ''
  const reply = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(value))
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    // Host validation also prevents DNS rebinding; no permissive CORS headers.
    if (req.headers.host !== new URL(origin).host) throw new HttpError(403, 'Invalid host')
    if (req.headers.origin && req.headers.origin !== origin) throw new HttpError(403, 'Invalid origin')
    const token = Buffer.from(String(req.headers['x-oqelira-launch'] ?? ''))
    const expected = Buffer.from(opts.launchToken)
    if (token.length !== expected.length || !timingSafeEqual(token, expected)) throw new HttpError(403, 'Open Oqelira from the desktop app')
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
        if (typeof body.runId !== 'string' || typeof body.approvalId !== 'string' || typeof body.allowed !== 'boolean' || (body.always !== undefined && body.always !== 'project' && body.always !== 'user')) throw new HttpError(400, 'Invalid approval')
        const run = runs.get(body.runId)
        if (!run?.pending || run.pending !== body.approvalId) throw new HttpError(409, 'Approval is no longer pending')
        run.pending = undefined
        engine?.send({ type: 'approval', approvalId: body.approvalId, allowed: body.allowed, always: body.always })
        reply(res, 200, { ok: true })
        return
      }
      if (req.method !== 'POST' || url.pathname !== '/api/run') throw new HttpError(404, 'Not found')
      const body = await json(req)
      if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 10_000) throw new HttpError(400, 'Enter a prompt of at most 10000 characters')
      const model = opts.models.find(m => m.id === body.model)
      if (!model) throw new HttpError(400, 'Choose a configured model')
      if (!opts.configured) throw new HttpError(503, 'Configure Foundry in the host .env, then restart the host')
      if (body.sessionId !== undefined && (typeof body.sessionId !== 'string' || !sessions.has(body.sessionId))) throw new HttpError(404, 'Session not found; start a new session')
      // Bound in-memory session ids. History itself lives in the engine.
      if (body.sessionId === undefined && sessions.size >= 100) throw new HttpError(429, 'Session limit reached; restart the local host')
      if (active) throw new HttpError(409, 'A run is already active')
      if (!engine || engine.closed) engine = opts.startEngine()
      const eng = engine
      try { await eng.ready } catch { throw new HttpError(503, 'The engine could not start; check host configuration') }
      if (active) throw new HttpError(409, 'A run is already active') // another request won while we awaited
      active = true
      const sessionId = (body.sessionId as string | undefined) ?? crypto.randomUUID()
      sessions.add(sessionId)
      let runId = ''
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
      res.flushHeaders()
      const send = (event: HostEvent) => { if (!res.destroyed) res.write(JSON.stringify(event) + '\n') }
      const heartbeat = setInterval(() => { if (!res.destroyed) res.write('\n') }, 15_000)
      // `active` stays set until the engine reports the run finished, even if the browser left,
      // so the engine never receives a second run while it is still unwinding the first.
      const finish = () => { off(); clearInterval(heartbeat); active = false; if (runId) runs.delete(runId); if (!res.destroyed) res.end() }
      const off = eng.onMessage(message => {
        switch (message.type) {
          case 'started': runId = message.runId; runs.set(runId, {}); send({ type: 'started', runId, sessionId }); return
          case 'approval': { const run = runs.get(runId); if (run) run.pending = message.approval.id; send(message); return }
          case 'done': send(message); finish(); return
          // SDK errors may include upstream request headers or bodies; do not echo them.
          case 'error': send({ type: 'error', message: message.message === 'Run stopped' ? 'Run stopped' : 'The model run failed. Check host configuration and retry.' }); finish(); return
          case 'ready': case 'cleared': case 'sessions': case 'history': case 'ended': case 'memory': return
          default: send(message)
        }
      })
      res.on('close', () => { if (active) eng.send({ type: 'cancel' }) })
      eng.send({ type: 'run', prompt: body.prompt.trim(), model: model.id, sessionId })
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
      if (active) engine?.send({ type: 'cancel' })
      engine?.close()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}
