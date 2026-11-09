import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { GatewayWireEvent, Message, ModelConfig, ModelEvent, ModelProvider, ToolSpec } from '@oqelira/core'
import type { GatewayConfig } from './config.js'
import { checkToolCall, inspectInbound, scanSecrets } from './policy.js'
import { WEEK_MS, evaluateLimits } from './limits.js'
import { isRevoked, recordRequest, usageSince } from './store.js'
import type { Db, RequestRecord } from './store.js'
import { verifyToken } from './tokens.js'

/**
 * Output is held back this many characters before it is sent, so a secret split across deltas is found
 * before any of it leaves. Secrets up to this length cannot leak. Longer ones could leak their head.
 */
const HOLD_BACK = 512
const MAX_BODY = 256 * 1024

export interface GatewayDeps {
  db: Db
  config: GatewayConfig
  /** Foundry provider built from the gateway's own env. Clients never supply endpoints. */
  provider: (model: ModelConfig) => ModelProvider
  /** Exact secret values the gateway holds (for example its Foundry key). */
  knownSecrets?: string[]
  now?: () => number
}

interface Request {
  model: ModelConfig
  system?: string
  messages: Message[]
  tools?: ToolSpec[]
  maxOutputTokens?: number
}

class Refusal extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown> = {}, readonly headers: Record<string, string> = {}) { super(message) }
}

const refuse = (status: number, error: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}) => new Refusal(status, error, { error, ...body }, headers)

/** Multi-tenant model gateway: one endpoint, streams NDJSON events, every decision logged without content. */
export function createGatewayServer(deps: GatewayDeps): Server {
  const now = deps.now ?? Date.now
  return createServer((req, res) => {
    handle(deps, now, req, res).catch(() => {
      // Only reached for bugs outside the guarded paths. Nothing is forwarded from here.
      if (!res.headersSent) send(res, 500, { error: 'Gateway error' })
      else res.end()
    })
  })
}

async function handle(d: GatewayDeps, now: () => number, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://gateway')
  if (req.method !== 'POST' || url.pathname !== '/v1/model/stream') return send(res, 404, { error: 'Not found' })

  const claims = verifyToken(bearer(req) ?? '', d.config.tokenKey, now())
  if (!claims) return send(res, 401, { error: 'Invalid or expired token' })

  let request: Request
  let warnings: string[]
  const ctx: Context = { ts: new Date(now()), userId: claims.sub, orgId: claims.org, deviceId: claims.dev, model: '' }
  try {
    request = parseRequest(await readJson(req), d.config.models)
    ctx.model = request.model.id
    warnings = await admit(d, now, ctx, request)
  } catch (err) {
    if (err instanceof Refusal) return send(res, err.status, err.body, err.headers)
    // Fail closed: a check that cannot run means the request is not forwarded.
    return send(res, 503, { error: 'Gateway checks unavailable; request not forwarded' })
  }
  await forward(d, ctx, request, warnings, res)
}

interface Context { ts: Date; userId: string; orgId: string; deviceId: string; model: string }

/** Revocation, inbound content checks and quota. Every rejection is logged before it is answered. */
async function admit(d: GatewayDeps, now: () => number, ctx: Context, request: Request): Promise<string[]> {
  if (await isRevoked(d.db, ctx.userId)) throw refuse(401, 'Token revoked')

  const inbound = inspectInbound(request.messages)
  if (inbound.length) {
    await record(d, ctx, 'blocked', inbound)
    throw refuse(422, 'Blocked by gateway', { reasons: inbound })
  }

  const t = now()
  const since = new Date(t - WEEK_MS)
  const { breaches, warnings } = evaluateLimits(
    d.config.limits,
    t,
    await usageSince(d.db, 'user_id', ctx.userId, since),
    await usageSince(d.db, 'org_id', ctx.orgId, since),
  )
  if (breaches.length) {
    const reasons = breaches.map((b) => b.reason)
    await record(d, ctx, 'limited', reasons)
    const retryAt = Math.max(...breaches.map((b) => b.retryAt))
    throw refuse(429, 'Usage limit reached', { reasons, retryAt: new Date(retryAt).toISOString() }, { 'Retry-After': String(Math.max(1, Math.ceil((retryAt - t) / 1000))) })
  }
  return warnings
}

async function forward(d: GatewayDeps, ctx: Context, request: Request, warnings: string[], res: ServerResponse): Promise<void> {
  const abort = new AbortController()
  res.on('close', () => { if (!res.writableEnded) abort.abort() })
  const input = { system: request.system, messages: request.messages, tools: request.tools, maxOutputTokens: request.maxOutputTokens, signal: abort.signal }
  const iterator = d.provider(request.model).stream(input)[Symbol.asyncIterator]()

  // Errors before the first event can still get a real HTTP status.
  let step: IteratorResult<ModelEvent>
  try {
    step = await iterator.next()
  } catch {
    await record(d, ctx, 'failed', ['upstream:error'], estimate(input, '', []))
    return send(res, 502, { error: 'Upstream model failed' })
  }

  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', ...(warnings.length ? { 'X-Oqelira-Quota-Warning': warnings.join(',') } : {}) })
  const write = (e: GatewayWireEvent) => { if (!res.destroyed) res.write(JSON.stringify(e) + '\n') }

  let text = ''
  let sent = 0
  let toolCalls: unknown[] = []
  let usage: { inputTokens?: number; outputTokens?: number } | undefined
  let finished = false
  let blocked: string | null = null
  let failure: string | null = null
  const flush = (all: boolean) => {
    const upto = all ? text.length : Math.max(sent, text.length - HOLD_BACK)
    if (upto > sent) { write({ type: 'text-delta', text: text.slice(sent, upto) }); sent = upto }
  }

  try {
    while (!step.done) {
      const e = step.value
      if (e.type === 'text-delta') {
        text += e.text
        blocked = scanSecrets(text, d.knownSecrets)
        if (!blocked) flush(false)
      } else if (e.type === 'tool-call') {
        blocked = checkToolCall(e.call, request.tools ?? [])
        if (!blocked) { flush(true); toolCalls.push(e.call.input ?? null); write(e) }
      } else if (e.type === 'finish') {
        flush(true)
        usage = e.usage
        finished = true
        write(e)
      }
      if (blocked || finished) break
      step = await iterator.next()
    }
    if (!blocked && !finished) failure = 'upstream:incomplete'
  } catch {
    failure = abort.signal.aborted ? 'client:disconnected' : 'upstream:error'
  }
  // Releases the upstream call when we stopped early (blocked, or the client went away).
  await iterator.return?.(undefined).catch(() => {})

  if (blocked) {
    abort.abort()
    write({ type: 'error', code: blocked, message: 'Blocked by gateway' })
  } else if (failure) {
    write({ type: 'error', code: failure, message: 'Model stream stopped' })
  }
  const decision = blocked ? 'blocked' : failure ? 'failed' : 'allowed'
  // Usage comes from Foundry when it reported it. Otherwise (aborted, or no usage field) estimate it, never zero.
  const counted = usage?.inputTokens !== undefined && usage.outputTokens !== undefined
    ? { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, source: 'foundry' as const }
    : estimate(input, text, toolCalls)
  try {
    await record(d, ctx, decision, blocked ? [blocked] : failure ? [failure] : [], counted, d.config.prices)
  } catch {
    // Content has already been streamed, so this cannot change the answer. Log the fact, not the content.
    process.stderr.write(`gateway: usage record failed for model ${ctx.model}\n`)
  }
  if (!res.destroyed) res.end()
}

/** Rough estimate for when the provider gives no usage: about four characters per token. */
function estimate(input: { system?: string; messages: Message[]; tools?: ToolSpec[] }, output: string, toolInputs: unknown[]) {
  const tokens = (s: string) => Math.ceil(s.length / 4)
  return {
    inputTokens: tokens(JSON.stringify({ system: input.system, messages: input.messages, tools: input.tools })),
    outputTokens: tokens(output) + tokens(JSON.stringify(toolInputs)),
    source: 'estimate' as const,
  }
}

async function record(
  d: GatewayDeps,
  ctx: Context,
  decision: RequestRecord['decision'],
  reasons: string[],
  usage?: { inputTokens: number; outputTokens: number; source: RequestRecord['usageSource'] },
  prices?: GatewayConfig['prices'],
): Promise<void> {
  const price = prices?.[ctx.model]
  const costMicro = usage && price ? Math.round(usage.inputTokens * price.inputUsdPerMTok + usage.outputTokens * price.outputUsdPerMTok) : 0
  await recordRequest(d.db, {
    ts: ctx.ts,
    userId: ctx.userId,
    orgId: ctx.orgId,
    deviceId: ctx.deviceId,
    model: ctx.model,
    decision,
    reasons,
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    costMicro,
    usageSource: usage?.source ?? 'none',
  })
}

function parseRequest(value: unknown, models: readonly ModelConfig[]): Request {
  const b = value as Record<string, unknown>
  const model = models.find((m) => m.id === b.model)
  if (!model) throw refuse(400, 'Unknown model')
  if (b.system !== undefined && typeof b.system !== 'string') throw refuse(400, 'system must be a string')
  if (!Array.isArray(b.messages) || !b.messages.every(isMessage)) throw refuse(400, 'messages are invalid')
  if (b.tools !== undefined && !(Array.isArray(b.tools) && b.tools.every(isToolSpec))) throw refuse(400, 'tools are invalid')
  if (b.maxOutputTokens !== undefined && !(Number.isInteger(b.maxOutputTokens) && (b.maxOutputTokens as number) > 0)) throw refuse(400, 'maxOutputTokens is invalid')
  return {
    model,
    system: b.system as string | undefined,
    messages: b.messages as Message[],
    tools: b.tools as ToolSpec[] | undefined,
    maxOutputTokens: b.maxOutputTokens as number | undefined,
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v)
const isMessage = (m: unknown): boolean => {
  if (!isObject(m)) return false
  if (m.role === 'user') return typeof m.content === 'string'
  if (m.role === 'assistant') return typeof m.text === 'string' && Array.isArray(m.toolCalls)
  if (m.role === 'tool') return Array.isArray(m.results)
  return false
}
const isToolSpec = (t: unknown): boolean => isObject(t) && typeof t.name === 'string' && typeof t.description === 'string' && isObject(t.parameters)

function bearer(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization ?? ''
  return header.startsWith('Bearer ') ? header.slice(7) : undefined
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  if (!req.headers['content-type']?.startsWith('application/json')) throw refuse(415, 'Expected JSON')
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw refuse(413, 'Request too large')
    chunks.push(chunk as Buffer)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw refuse(400, 'Invalid JSON')
  }
}

function send(res: ServerResponse, status: number, body: Record<string, unknown>, headers: Record<string, string> = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}
