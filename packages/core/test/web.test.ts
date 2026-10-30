import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { webSearch, webTools } from '../src/tools/web.js'

test('web_search calls Tavily with bearer key, formats results, and hides failures', async () => {
  let seen: { auth?: string; body?: Record<string, unknown> } = {}
  let status = 200
  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      seen = { auth: req.headers.authorization, body: JSON.parse(raw) }
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(status === 200 ? { answer: 'Use X.', results: [{ title: 'Doc', url: 'https://e.x/d', content: 'body' }] } : { detail: 'secret-echo' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const env = { ...process.env }
  process.env.TAVILY_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  process.env.TAVILY_API_KEY = 'tvly-test'
  try {
    assert.equal(webTools().length, 1)
    const out = await webSearch.run({ query: 'node fetch', max_results: 3 }, { cwd: '.' })
    assert.equal(seen.auth, 'Bearer tvly-test')
    assert.equal(seen.body?.max_results, 3)
    assert.match(out, /Answer: Use X\.[\s\S]*1\. Doc\n\s+https:\/\/e\.x\/d/)
    for (const input of [{ query: '' }, { query: 'x', max_results: 11 }, { query: 'x'.repeat(401) }]) await assert.rejects(webSearch.run(input, { cwd: '.' }))
    status = 500
    await assert.rejects(webSearch.run({ query: 'x' }, { cwd: '.' }), (e: Error) => /HTTP 500/.test(e.message) && !/secret-echo|tvly-test/.test(e.message))
    delete process.env.TAVILY_API_KEY
    assert.equal(webTools().length, 0)
    await assert.rejects(webSearch.run({ query: 'x' }, { cwd: '.' }), /TAVILY_API_KEY/)
  } finally {
    process.env.TAVILY_BASE_URL = env.TAVILY_BASE_URL
    if (env.TAVILY_API_KEY) process.env.TAVILY_API_KEY = env.TAVILY_API_KEY
    if (env.TAVILY_BASE_URL === undefined) delete process.env.TAVILY_BASE_URL
    server.close()
  }
})

test('web_search has its own risk class and TAVILY_API_KEY is not read from the project .env', async () => {
  assert.equal(webSearch.risk, 'network')
  const fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path')
  const { loadEnvFiles } = await import('../src/config/env.js')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-env-'))
  const saved = process.env.TAVILY_API_KEY, savedNo = process.env.OQELIRA_NO_ENV_FILES
  delete process.env.TAVILY_API_KEY; delete process.env.OQELIRA_NO_ENV_FILES
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'TAVILY_API_KEY=project\n')
    loadEnvFiles({ cwd: dir })
    assert.equal(process.env.TAVILY_API_KEY, undefined)
    loadEnvFiles({ cwd: '/nonexistent', explicit: path.join(dir, '.env') })
    assert.equal(process.env.TAVILY_API_KEY, 'project')
  } finally {
    if (saved === undefined) delete process.env.TAVILY_API_KEY; else process.env.TAVILY_API_KEY = saved
    if (savedNo !== undefined) process.env.OQELIRA_NO_ENV_FILES = savedNo
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
