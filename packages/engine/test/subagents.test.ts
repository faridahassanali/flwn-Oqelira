import assert from 'node:assert/strict'
import test from 'node:test'
import { createSubagentTool } from '../src/subagents.js'
import type { ModelProvider, ModelRequest, Tool } from '@oqelira/core'

function tool(name: string, risk: Tool['risk'], output = 'raw tool output that must not reach the parent'): Tool {
  return { spec: { name, description: name, parameters: {} }, risk, describe: () => name, run: async () => output }
}

test('subagent receives isolated context, read-only tools, and returns only its summary', async () => {
  const requests: ModelRequest[] = []
  let turn = 0
  const provider: ModelProvider = { id: 'fixture', async *stream(request) {
    requests.push({ ...request, messages: [...request.messages], tools: [...(request.tools ?? [])] })
    if (turn++ === 0) { yield { type: 'tool-call', call: { id: 'read', name: 'read_file', input: {} } }; yield { type: 'finish', reason: 'tool-calls' }; return }
    yield { type: 'text-delta', text: 'The target file contains the required setting.' }; yield { type: 'finish', reason: 'stop' }
  } }
  const delegate = createSubagentTool({ provider: () => provider, tools: [tool('read_file', 'read'), tool('write_file', 'write')] })
  const output = await delegate.run({ task: 'Inspect the setting', context: 'Use src/config.ts only.', tools: ['read_file'] }, { cwd: process.cwd() })
  assert.match(output, /The target file contains the required setting/)
  assert.doesNotMatch(output, /raw tool output/)
  assert.equal(requests[0]?.messages.length, 1, 'parent history is not forwarded')
  assert.match((requests[0]?.messages[0] as { content: string }).content, /Use src\/config\.ts only/)
  assert.deepEqual(requests[0]?.tools?.map((entry) => entry.name), ['read_file'])
})

test('subagent rejects write, network, and unknown tool requests', async () => {
  const provider: ModelProvider = { id: 'fixture', async *stream() { yield { type: 'finish', reason: 'stop' } } }
  const delegate = createSubagentTool({ provider: () => provider, tools: [tool('read_file', 'read'), tool('write_file', 'write'), tool('web_fetch', 'network')] })
  for (const tools of [['write_file'], ['web_fetch'], ['delegate_task']]) await assert.rejects(delegate.run({ task: 'x', tools }, { cwd: process.cwd() }), /read-only tools/)
})

test('subagent cannot delegate again and stops at its own step budget', async () => {
  const requests: ModelRequest[] = []
  const provider: ModelProvider = { id: 'fixture', async *stream(request) {
    requests.push({ ...request, messages: [...request.messages], tools: [...(request.tools ?? [])] })
    yield { type: 'tool-call', call: { id: 'nested', name: 'delegate_task', input: { task: 'again' } } }
    yield { type: 'finish', reason: 'tool-calls' }
  } }
  const delegate = createSubagentTool({ provider: () => provider, tools: [tool('read_file', 'read')] })
  const output = await delegate.run({ task: 'x', max_steps: 1 }, { cwd: process.cwd() })
  assert.match(output, /max-steps/)
  assert.equal(requests[0]?.tools?.some((entry) => entry.name === 'delegate_task'), false)
})
