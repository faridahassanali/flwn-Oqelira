import type { ModelConfig } from './registry.js'
import type { ModelEvent, ModelProvider, ModelRequest } from './types.js'

/**
 * Cloud model gateway adapter. The engine holds only a short-lived user token; the gateway holds the
 * Foundry credentials and maps our stable model id to a deployment. Deployment names never go on the wire.
 *
 * Wire format: POST {baseURL}/v1/model/stream, answered with NDJSON. Each line is a ModelEvent, or
 * `{type:'error'}` when the gateway stopped the stream (blocked content, quota, upstream failure).
 */
export type GatewayWireEvent = ModelEvent | { type: 'error'; code: string; message: string }

export interface GatewayOptions {
  /** Gateway origin. Set by the host from user-level config only, never from a project's .env. */
  baseURL: string
  token: string
  fetch?: typeof fetch
  /** Called with the gateway's quota warning (X-Oqelira-Quota-Warning), once per response. */
  onWarning?(warning: string): void
}

/** Gateway mode needs both values. Only the real environment, --env-file or ~/.oqelira/.env can supply them (see config/env.ts). */
export function gatewayConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { baseURL: string; token: string } | undefined {
  const baseURL = env.OQELIRA_GATEWAY_URL?.trim()
  const token = env.OQELIRA_GATEWAY_TOKEN?.trim()
  if (!baseURL && !token) return undefined
  if (!baseURL || !token) throw new Error('OQELIRA_GATEWAY_URL and OQELIRA_GATEWAY_TOKEN must both be set')
  const url = new URL(baseURL)
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password) throw new Error('OQELIRA_GATEWAY_URL must be an https URL without credentials')
  return { baseURL: baseURL.replace(/\/+$/, ''), token }
}

/** A gateway refusal with the user-facing wording already chosen; `status` and `retryAt` are there for hosts that want them. */
export class GatewayError extends Error {
  constructor(message: string, readonly status: number, readonly retryAt?: Date) {
    super(message)
    this.name = 'GatewayError'
  }
}

export function createGatewayProvider(opts: GatewayOptions): (model: ModelConfig) => ModelProvider {
  const base = opts.baseURL.replace(/\/+$/, '')
  const doFetch = opts.fetch ?? fetch
  return (model) => ({
    id: model.id,
    async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
      const res = await doFetch(`${base}/v1/model/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${opts.token}` },
        body: JSON.stringify({ model: model.id, system: req.system, messages: req.messages, tools: req.tools, maxOutputTokens: req.maxOutputTokens }),
        signal: req.signal,
      })
      if (!res.ok || !res.body) throw await refusal(res)
      const warning = res.headers.get('X-Oqelira-Quota-Warning')
      if (warning) opts.onWarning?.(warning)

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let finished = false
      try {
        for (;;) {
          const { done, value } = await reader.read()
          buffer += done ? decoder.decode() + '\n' : decoder.decode(value, { stream: true })
          for (let nl = buffer.indexOf('\n'); nl >= 0; nl = buffer.indexOf('\n')) {
            const line = buffer.slice(0, nl).trim()
            buffer = buffer.slice(nl + 1)
            if (!line) continue
            const event = JSON.parse(line) as GatewayWireEvent
            if (event.type === 'error') throw new Error(`Gateway stopped the response (${event.code}): ${event.message}`)
            if (event.type === 'finish') finished = true
            yield event
          }
          if (done) break
        }
        // A stream that ends without a finish event is incomplete. Never treat it as a finished answer.
        if (!finished) throw new Error('Gateway stream ended before the model finished')
      } finally {
        reader.releaseLock()
      }
    },
  })
}

export async function refusal(res: Response): Promise<GatewayError> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; reasons?: unknown; retryAt?: unknown }
  const reason = typeof body.error === 'string' ? body.error : res.statusText
  const reasons = Array.isArray(body.reasons) ? body.reasons.filter((r): r is string => typeof r === 'string').join('; ') : ''
  const retryAt = typeof body.retryAt === 'string' && !Number.isNaN(Date.parse(body.retryAt)) ? new Date(body.retryAt) : undefined
  if (res.status === 401) return new GatewayError('Your Oqelira session has expired or was revoked. Sign in again.', 401)
  if (res.status === 429 && retryAt) return new GatewayError(`Usage limit reached${reasons ? ` (${reasons})` : ''}. It frees up at ${retryAt.toLocaleString()}.`, 429, retryAt)
  if (res.status === 422) return new GatewayError(`Blocked by the gateway${reasons ? `: ${reasons}` : ''}.`, 422)
  return new GatewayError(`Gateway refused the request (${res.status}): ${reason}`, res.status)
}
