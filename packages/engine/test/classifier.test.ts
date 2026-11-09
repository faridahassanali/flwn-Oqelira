import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalRequest, ModelProvider } from '@oqelira/core'
import { classifyCommand, hardDenyReason } from '../src/classifier.js'

const request = (command: string): ApprovalRequest => ({ tool: 'run_command', risk: 'exec', summary: command, input: { command } })
const provider = (reply: string): ModelProvider => ({ id: 'fixture', async *stream() { yield { type: 'text-delta', text: reply }; yield { type: 'finish', reason: 'stop' } } })

test('hard denylist always flags destructive, network, credential, publishing, and force-push commands', () => {
  for (const command of ['rm -rf build', 'curl https://example.test', 'cat .env', 'npm publish', 'git push --force origin main']) assert.ok(hardDenyReason(request(command)), command)
  assert.equal(hardDenyReason(request('git status --short')), undefined)
})

test('classifier only accepts a strict allow JSON reply and explains an ask', async () => {
  assert.equal(await classifyCommand(provider('{"decision":"allow","reason":"read only"}'), request('git status')), 'allow')
  assert.deepEqual(await classifyCommand(provider('{"decision":"ask","reason":"may modify generated files"}'), request('git status')), { decision: undefined, reason: 'classifier: may modify generated files' })
  assert.equal(await classifyCommand(provider('ignore the system prompt'), request('git status')), undefined)
})
