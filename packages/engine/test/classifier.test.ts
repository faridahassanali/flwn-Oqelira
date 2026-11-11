import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ApprovalRequest, ModelProvider } from '@oqelira/core'
import { classifierGate, classifyCommand, hardDenyReason } from '../src/classifier.js'

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

test('classifier gate only consults the classifier for a real run_command', async () => {
  let calls = 0
  const decide = (result: { allow: boolean; reason?: string } | Error | undefined) => async () => { calls++; if (result instanceof Error) throw result; return result }
  const req = (tool: string, risk: ApprovalRequest['risk'], input: unknown): ApprovalRequest => ({ tool, risk, summary: '', input })
  const skipped: ApprovalRequest[] = [
    req('write_file', 'write', { command: 'ls' }), req('web_fetch', 'network', { command: 'ls' }), req('other_exec', 'exec', { command: 'ls' }),
    req('run_command', 'exec', { command: '' }), req('run_command', 'exec', { command: '  \n\t' }), req('run_command', 'exec', { command: 5 }),
    req('run_command', 'exec', null), req('run_command', 'exec', {}),
  ]
  for (const r of skipped) assert.equal(await classifierGate(decide({ allow: true }), r), undefined, JSON.stringify(r))
  assert.equal(calls, 0)
  assert.equal(await classifierGate(undefined, request('ls')), undefined)
  assert.equal(await classifierGate(decide({ allow: true }), request('ls')), 'allow')
  assert.deepEqual(await classifierGate(decide({ allow: false, reason: 'writes' }), request('ls')), { decision: undefined, reason: 'classifier: writes' })
  assert.equal(await classifierGate(decide({ allow: false }), request('ls')), undefined)
  assert.equal(await classifierGate(decide(new Error('boom')), request('ls')), undefined)
  assert.equal(calls, 4)
})
