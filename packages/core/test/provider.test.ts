import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createFoundry } from '../src/providers/foundry.js'
import type { ModelConfig } from '../src/providers/registry.js'
import type { ModelEvent } from '../src/providers/types.js'
import { startMock } from './mock-server.js'

const model: ModelConfig = { id: 'm', deployment: 'm-deployment', api: 'chat', speed: 'fast' }
const tools = [
  {
    name: 'read_file',
    description: 'read',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  },
]

async function collect(it: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const out: ModelEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

test('streams text as several deltas, then finishes with stop', async () => {
  const mock = await startMock({ script: () => ({ text: 'hello from the mock model' }) })
  try {
    const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
    const events = await collect(provider.stream({ messages: [{ role: 'user', content: 'hi' }] }))
    const deltas = events.filter((e) => e.type === 'text-delta')
    assert.ok(deltas.length > 1, 'expected multiple text deltas (real streaming)')
    assert.equal(deltas.map((d) => (d.type === 'text-delta' ? d.text : '')).join(''), 'hello from the mock model')
    const finish = events.at(-1)
    assert.equal(finish?.type, 'finish')
    assert.equal(finish?.type === 'finish' && finish.reason, 'stop')
    assert.equal(mock.requests[0].headers['api-key'], 'k')
    assert.equal(mock.requests[0].body.model, 'm-deployment')
  } finally {
    await mock.close()
  }
})

test('streamed tool-call arguments are assembled into one tool-call event', async () => {
  const mock = await startMock({
    script: () => ({ toolCall: { name: 'read_file', args: { path: 'src/some/long/path/file.ts' } } }),
  })
  try {
    const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
    const events = await collect(provider.stream({ messages: [{ role: 'user', content: 'go' }], tools }))
    const calls = events.filter((e) => e.type === 'tool-call')
    assert.equal(calls.length, 1)
    const call = calls[0]
    assert.ok(call?.type === 'tool-call')
    assert.equal(call.call.name, 'read_file')
    assert.deepEqual(call.call.input, { path: 'src/some/long/path/file.ts' })
    const finish = events.at(-1)
    assert.equal(finish?.type === 'finish' && finish.reason, 'tool-calls')
    // the tool definition reached the server
    assert.equal(mock.requests[0].body.tools[0].function.name, 'read_file')
  } finally {
    await mock.close()
  }
})

test('max_tokens rejected by the deployment -> retried once with max_completion_tokens', async () => {
  const mock = await startMock({ rejectMaxTokens: true, script: () => ({ text: 'ok' }) })
  const fallbacks: string[] = []
  try {
    const provider = createFoundry({
      baseURL: mock.baseURL,
      apiKey: 'k',
      onTokenParamFallback: (d) => fallbacks.push(d),
    })(model)
    const events = await collect(
      provider.stream({ messages: [{ role: 'user', content: 'hi' }], maxOutputTokens: 123 }),
    )
    assert.equal(events.at(-1)?.type, 'finish')
    assert.equal(mock.requests.length, 2)
    assert.equal(mock.requests[0].body.max_tokens, 123)
    assert.equal(mock.requests[1].body.max_completion_tokens, 123)
    assert.equal(mock.requests[1].body.max_tokens, undefined)
    assert.deepEqual(fallbacks, ['m-deployment'])
  } finally {
    await mock.close()
  }
})

test('multi-turn: assistant tool calls and tool results are sent back in the right shape', async () => {
  const mock = await startMock({ script: () => ({ text: 'done' }) })
  try {
    const provider = createFoundry({ baseURL: mock.baseURL, apiKey: 'k' })(model)
    await collect(
      provider.stream({
        messages: [
          { role: 'user', content: 'read a' },
          { role: 'assistant', text: '', toolCalls: [{ id: 'call_1', name: 'read_file', input: { path: 'a' } }] },
          { role: 'tool', results: [{ id: 'call_1', name: 'read_file', output: 'contents of a' }] },
        ],
        tools,
      }),
    )
    const sent = mock.requests[0].body.messages
    const assistant = sent.find((m: any) => m.role === 'assistant')
    const toolMsg = sent.find((m: any) => m.role === 'tool')
    assert.equal(assistant.tool_calls[0].id, 'call_1')
    assert.equal(assistant.tool_calls[0].function.name, 'read_file')
    assert.deepEqual(JSON.parse(assistant.tool_calls[0].function.arguments), { path: 'a' })
    assert.equal(toolMsg.tool_call_id, 'call_1')
    assert.equal(toolMsg.content, 'contents of a')
  } finally {
    await mock.close()
  }
})
