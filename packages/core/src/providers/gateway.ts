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
      if (!res.ok || !res.body) throw new Error(await refusal(res))

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

async function refusal(res: Response): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown }
  const reason = typeof body.error === 'string' ? body.error : res.statusText
  return `Gateway refused the request (${res.status}): ${reason}`
}
