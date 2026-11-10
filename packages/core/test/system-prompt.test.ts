import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { DEFAULT_SYSTEM } from '../src/agent/prompt.js'
import type { ContextGateway } from '../src/memory/gateway.js'
import { builtinTools, memoryTools, webSearch } from '../src/tools/index.js'

const agentDir = fileURLToPath(new URL('../src/agent/', import.meta.url))
const file = fs.readFileSync(path.join(agentDir, 'system-prompt.txt'), 'utf8')

/** Max ~3,500 tokens by the chars/4 estimate. Every request pays for this prompt, so growth must be a conscious change. */
const MAX_CHARS = 14_000

test('system-prompt.txt exists, is non-empty, and is what DEFAULT_SYSTEM contains', () => {
  assert.ok(file.trim().length > 0)
  assert.equal(DEFAULT_SYSTEM, file.trim())
})

test('prompt size stays within the token budget', () => {
  assert.ok(file.length <= MAX_CHARS, `system-prompt.txt is ${file.length} chars (about ${Math.round(file.length / 4)} tokens); the limit is ${MAX_CHARS} chars. Cut text or raise MAX_CHARS on purpose.`)
  assert.ok(file.length >= 8_000, 'system-prompt.txt is unexpectedly short; sections may have been dropped')
})

test('required section headers and rules are present', () => {
  for (const header of ['ROLE AND ENVIRONMENT', 'WORKSPACE AND WHAT THE USER SEES', 'TOOL POLICY', 'EDIT PROTOCOL', 'VERIFICATION', 'APPROVAL PROTOCOL', 'UNTRUSTED CONTENT', 'SECRETS', 'AMBIGUITY', 'WEB RESEARCH', 'ANSWER STYLE', 'EXAMPLES']) {
    assert.match(file, new RegExp(`^${header}$`, 'm'), `missing section ${header}`)
  }
  for (const rule of [
    /untrusted data/, /Understand before changing/, /Never claim a change or test succeeded unless you ran it and checked the result/,
    /denied, expired, or unavailable approval is final/, /Never overwrite/, /expected_sha256/,
    /Do not read credential files/, /state the assumption/, /Cite the URLs/,
  ]) {
    assert.match(file, rule, `missing rule ${rule}`)
  }
  assert.match(file, /illustrations of the expected behaviour, not real history/)
})

test('a missing prompt file stops startup with a clear error', () => {
  const dir = fs.mkdtempSync(path.join(agentDir, '.missing-'))
  try {
    fs.copyFileSync(path.join(agentDir, 'prompt.ts'), path.join(dir, 'prompt.ts'))
    const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', `import('${path.join(dir, 'prompt.ts').replaceAll('\\', '/')}')`], { encoding: 'utf8', cwd: agentDir })
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /system prompt file is missing or unreadable/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// Tools that exist but are built elsewhere (the engine's delegate_task) may be named in the policy but have no spec here.
const registry = new Map([...builtinTools, ...memoryTools({} as ContextGateway), webSearch].map(t => [t.spec.name, new Set(Object.keys((t.spec.parameters as { properties: object }).properties))]))

test('every tool call in the few-shot examples uses a real tool and only real parameters', () => {
  const examples = file.slice(file.indexOf('\nEXAMPLES\n'))
  const calls = [...examples.matchAll(/^call (\S+) (\{.*\})$/gm)]
  assert.ok(calls.length >= 15, `expected the examples to contain tool calls, found ${calls.length}`)
  const seen = new Set<string>()
  for (const [, name, json] of calls) {
    const params = registry.get(name!)
    assert.ok(params, `example calls unknown tool ${name}`)
    seen.add(name!)
    let input: Record<string, unknown>
    try { input = JSON.parse(json!) } catch { assert.fail(`example call to ${name} has invalid JSON: ${json}`) }
    for (const key of Object.keys(input)) assert.ok(params.has(key), `example call to ${name} uses unknown parameter ${key}`)
  }
  assert.ok(file.match(/^call /gm)!.length === calls.length, 'a "call" line in the examples is not in the call <tool> {json} form')
  for (const needed of ['file_snapshot', 'apply_file_change', 'run_command', 'web_search', 'grep']) assert.ok(seen.has(needed), `examples never show ${needed}`)
  assert.equal([...file.matchAll(/^Example \d+:/gm)].length >= 6, true)
})

test('every tool named in the policy section exists', () => {
  const policy = file.slice(file.indexOf('TOOL POLICY'), file.indexOf('EDIT PROTOCOL'))
  const named = new Set(policy.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])
  for (const name of named) {
    if (name === 'delegate_task' || name === 'start_line' || name === 'end_line' || name === 'timeout_seconds') continue
    assert.ok(registry.has(name), `policy names unknown tool ${name}`)
  }
  for (const name of ['start_line', 'end_line']) assert.ok(registry.get('read_file')!.has(name))
  assert.ok(registry.get('run_command')!.has('timeout_seconds'))
})
