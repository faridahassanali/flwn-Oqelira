import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createGatewayProvider } from '../src/providers/gateway.js'
import type { ModelConfig } from '../src/providers/registry.js'
import type { ModelEvent } from '../src/providers/types.js'

const model: ModelConfig = { id: 'gpt-6-sol', deployment: 'secret-deployment-name', api: 'responses', speed: 'fast' }

/** Fake gateway: writes the given NDJSON lines, optionally in two pieces with a pause between them. */
async function fakeGateway(respond: (body: Record<string, unknown>) => { status?: number; lines: string[]; split?: boolean }) {
  const seen: { headers: Record<string, string | string[] | undefined>; body: Record<string, unknown> }[] = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (c: Buffer) => { raw += c })
    req.on('end', async () => {
      const body = JSON.parse(raw) as Record<string, unknown>
      seen.push({ headers: req.headers, body })
      const r = respond(body)
      res.writeHead(r.status ?? 200, { 'Content-Type': r.status && r.status !== 200 ? 'application/json' : 'application/x-ndjson' })
      if (r.status && r.status !== 200) return res.end(r.lines.join(''))
      const text = r.lines.join('\n') + '\n'
      if (r.split) {
        const mid = Math.floor(text.length / 2)
        res.write(text.slice(0, mid))
        await new Promise((resolve) => setTimeout(resolve, 20))
        res.end(text.slice(mid))
      } else res.end(text)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { seen, baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) }
}

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const req = { messages: [{ role: 'user' as const, content: 'hi' }] }
const finish: ModelEvent = { type: 'finish', reason: 'stop', usage: { inputTokens: 3, outputTokens: 1 } }

test('sends only the user token and our model id, and passes streamed events through as they arrive', async () => {
  const gw = await fakeGateway(() => ({ lines: [JSON.stringify({ type: 'text-delta', text: 'Hel' }), JSON.stringify({ type: 'text-delta', text: 'lo' }), JSON.stringify(finish)], split: true }))
  try {
    const provider = createGatewayProvider({ baseURL: gw.baseURL + '/', token: 'user-token' })(model)
    const events = await collect(provider.stream(req))
    assert.deepEqual(events, [{ type: 'text-delta', text: 'Hel' }, { type: 'text-delta', text: 'lo' }, finish])
    assert.equal(gw.seen[0]!.headers.authorization, 'Bearer user-token')
    assert.equal(gw.seen[0]!.body.model, 'gpt-6-sol')
    assert.equal(JSON.stringify(gw.seen[0]!.body).includes('secret-deployment-name'), false, 'deployment names stay on the gateway')
  } finally {
    await gw.close()
  }
})

test('a refusal from the gateway is an error, with its reason and no partial answer', async () => {
  const gw = await fakeGateway(() => ({ status: 422, lines: [JSON.stringify({ error: 'Blocked by gateway', reasons: ['injection:override-previous'] })] }))
  try {
    const provider = createGatewayProvider({ baseURL: gw.baseURL, token: 't' })(model)
    await assert.rejects(collect(provider.stream(req)), /Gateway refused the request \(422\): Blocked by gateway/)
  } finally {
    await gw.close()
  }
})

test('an error event mid-stream ends the answer with an error; a stream without a finish is never a finished answer', async () => {
  const blocked = await fakeGateway(() => ({ lines: [JSON.stringify({ type: 'text-delta', text: 'partial' }), JSON.stringify({ type: 'error', code: 'secret:aws-access-key', message: 'Blocked by gateway' })] }))
  const cut = await fakeGateway(() => ({ lines: [JSON.stringify({ type: 'text-delta', text: 'partial' })] }))
  try {
    await assert.rejects(collect(createGatewayProvider({ baseURL: blocked.baseURL, token: 't' })(model).stream(req)), /secret:aws-access-key/)
    await assert.rejects(collect(createGatewayProvider({ baseURL: cut.baseURL, token: 't' })(model).stream(req)), /ended before the model finished/)
  } finally {
    await blocked.close()
    await cut.close()
  }
})
