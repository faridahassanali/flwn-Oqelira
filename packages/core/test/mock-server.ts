/**
 * Minimal OpenAI-compatible /chat/completions server that streams real SSE chunks
 * (tool-call arguments arrive in pieces, like the real thing). Chat Completions only:
 * the /responses adapter is covered by `npm run live` against real Foundry.
 */
import http from 'node:http'

export type Reply = { text: string } | { toolCall: { name: string; args: unknown } }

export interface MockOptions {
  /** Decide the reply for each request. `n` is the 0-based request count. */
  script: (body: any, n: number) => Reply
  /** Reject `max_tokens` like some Foundry deployments do. */
  rejectMaxTokens?: boolean
}

export async function startMock(opts: MockOptions) {
  const requests: any[] = []
  const server = http.createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end()
      return
    }
    const body = JSON.parse(raw)
    requests.push({ body, headers: req.headers })

    if (opts.rejectMaxTokens && body.max_tokens !== undefined) {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
            type: 'invalid_request_error',
            param: 'max_tokens',
            code: 'unsupported_parameter',
          },
        }),
      )
      return
    }

    const reply = opts.script(body, requests.length - 1)
    const base = { id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: body.model }
    const chunks: unknown[] = []
    if ('text' in reply) {
      const words = reply.text.split(/(?<= )/)
      chunks.push({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
      for (const w of words) chunks.push({ ...base, choices: [{ index: 0, delta: { content: w }, finish_reason: null }] })
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    } else {
      const args = JSON.stringify(reply.toolCall.args)
      const third = Math.ceil(args.length / 3)
      chunks.push({
        ...base,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content: null,
              tool_calls: [{ index: 0, id: `call_${requests.length}`, type: 'function', function: { name: reply.toolCall.name, arguments: '' } }],
            },
            finish_reason: null,
          },
        ],
      })
      for (let i = 0; i < args.length; i += third) {
        chunks.push({
          ...base,
          choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + third) } }] }, finish_reason: null }],
        })
      }
      chunks.push({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
    }
    chunks.push({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`)
      res.write('data: [DONE]\n\n')
      res.end()
    } else {
      res.writeHead(500).end('mock only supports stream: true')
    }
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  return {
    baseURL: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => server.close(() => r())),
  }
}
