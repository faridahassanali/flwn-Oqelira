import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { loadEnvFiles } from '../src/config/env.js'

const KEYS = ['FOUNDRY_KEY', 'FOUNDRY_BASE_URL', 'FOUNDRY_ENDPOINT', 'FOUNDRY_MODELS', 'OQELIRA_MODEL', 'OQELIRA_ENV', 'TAVILY_API_KEY', 'OQELIRA_NO_ENV_FILES', 'HOME']

/** Runs with a clean environment and an empty HOME so nothing real leaks in or out. */
function sandbox(fn: (dirs: { home: string; project: string }) => void) {
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-home-'))
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-proj-'))
  for (const k of KEYS) delete process.env[k]
  process.env.HOME = home
  try { fn({ home, project }) } finally {
    for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(project, { recursive: true, force: true })
  }
}

test("a project's .env cannot set connection settings, keys, or point at another env file", () => {
  sandbox(({ home, project }) => {
    fs.mkdirSync(path.join(home, '.oqelira'))
    fs.writeFileSync(path.join(home, '.oqelira', '.env'), 'FOUNDRY_KEY=mine\nFOUNDRY_ENDPOINT=https://mine.openai.azure.com\n')
    fs.writeFileSync(path.join(project, '.env'), 'FOUNDRY_BASE_URL=https://attacker.test\nFOUNDRY_KEY=theirs\nTAVILY_API_KEY=theirs\nOQELIRA_ENV=/tmp/evil.env\nOQELIRA_NO_ENV_FILES=1\nOQELIRA_MODEL=gpt-6-luna\nFOUNDRY_MODELS=a,b\n')
    const ignored: string[] = []
    loadEnvFiles({ cwd: project, onIgnored: (_f, keys) => ignored.push(...keys) })
    assert.equal(process.env.FOUNDRY_KEY, 'mine')
    assert.equal(process.env.FOUNDRY_BASE_URL, undefined)
    assert.equal(process.env.TAVILY_API_KEY, undefined)
    assert.equal(process.env.OQELIRA_ENV, undefined)
    assert.equal(process.env.OQELIRA_NO_ENV_FILES, undefined)
    assert.deepEqual(ignored.sort(), ['FOUNDRY_BASE_URL', 'FOUNDRY_KEY', 'OQELIRA_ENV', 'OQELIRA_NO_ENV_FILES', 'TAVILY_API_KEY'])
    assert.equal(process.env.OQELIRA_MODEL, 'gpt-6-luna', 'choosing among your own deployments is allowed')
    assert.equal(process.env.FOUNDRY_MODELS, 'a,b')
  })
})

test('with nothing configured elsewhere, a project .env still supplies no key; --env-file is trusted', () => {
  sandbox(({ project }) => {
    fs.writeFileSync(path.join(project, '.env'), 'FOUNDRY_KEY=k\nFOUNDRY_ENDPOINT=https://x.openai.azure.com\n')
    loadEnvFiles({ cwd: project })
    assert.equal(process.env.FOUNDRY_KEY, undefined)
    loadEnvFiles({ cwd: project, explicit: path.join(project, '.env') })
    assert.equal(process.env.FOUNDRY_KEY, 'k')
  })
})


test('runner connection settings load from an explicit trusted env file only', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-eval-env-'))
  const keys = ['PROMPT_EVAL_RUNNER_URL', 'PROMPT_EVAL_RUNNER_TOKEN', 'OQELIRA_NO_ENV_FILES']
  const saved = keys.map(key => process.env[key])
  try {
    for (const key of keys) delete process.env[key]
    const file = path.join(root, '.env')
    fs.writeFileSync(file, 'PROMPT_EVAL_RUNNER_URL=https://runner.example\nPROMPT_EVAL_RUNNER_TOKEN=fixture-only\n')
    loadEnvFiles({ cwd: root })
    assert.equal(process.env.PROMPT_EVAL_RUNNER_URL, undefined)
    assert.equal(process.env.PROMPT_EVAL_RUNNER_TOKEN, undefined)
    loadEnvFiles({ cwd: root, explicit: file })
    assert.equal(process.env.PROMPT_EVAL_RUNNER_URL, 'https://runner.example')
    assert.equal(process.env.PROMPT_EVAL_RUNNER_TOKEN, 'fixture-only')
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i] })
    fs.rmSync(root, { recursive: true, force: true })
  }
})
