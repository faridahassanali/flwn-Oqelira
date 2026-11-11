import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import http from 'node:http'
import { fetch as undiciFetch } from 'undici'
import { createWebFetch, glob, grep, pinnedAgent, todoWrite, webFetch, taskList } from '../src/tools/pack.js'

test('glob and regex grep stay inside the workspace', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-pack-'))
  try {
    await fs.mkdir(path.join(root, 'src')); await fs.writeFile(path.join(root, 'src', 'a.ts'), 'const Needle = 1\n')
    await fs.writeFile(path.join(root, 'src', 'b.js'), 'needle\n')
    assert.deepEqual(JSON.parse(await glob.run({ pattern: 'src/**/*.ts' }, { cwd: root })).matches, ['src/a.ts'])
    assert.equal(JSON.parse(await grep.run({ pattern: '^const\\s+Needle', case_sensitive: true }, { cwd: root })).matches[0].path, 'src/a.ts')
    await assert.rejects(glob.run({ pattern: '../*' }, { cwd: root }))
  } finally { await fs.rm(root, { recursive: true, force: true }) }
})

test('todo list is replaced per workspace', async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-todo-'))
  try {
    await todoWrite.run({ tasks: [{ id: 'one', text: 'Do it', status: 'in_progress' }] }, { cwd })
    assert.equal(taskList(cwd)[0]?.status, 'in_progress')
  } finally { await fs.rm(cwd, { recursive: true, force: true }) }
})

test('web_fetch rejects local addresses before making a request', async () => {
  await assert.rejects(webFetch.run({ url: 'http://127.0.0.1:1/' }, { cwd: '.' }), /Private and local/)
  await assert.rejects(webFetch.run({ url: 'file:///etc/passwd' }, { cwd: '.' }), /Only http/)
})

test('web_fetch rejects every private range, IPv6 literals and IPv4-mapped forms', async () => {
  for (const host of ['172.16.0.1', '172.31.255.255', '0.0.0.0', '100.64.0.1', '[::1]', '[::]', '[fe80::1]', '[fd00::1]', '[::ffff:127.0.0.1]', '[::ffff:10.0.0.1]', '[64:ff9b::7f00:1]', '[64:ff9b:1::1]', '[2002:7f00:1::]', '[ff02::1]', '[::127.0.0.1]', '224.0.0.1', '240.0.0.1', '2130706433', 'localhost.']) {
    await assert.rejects(webFetch.run({ url: `http://${host}:1/` }, { cwd: '.' }), /Private and local/, host)
  }
})

const serve = async (hits: string[]) => {
  const server = http.createServer((req, res) => { hits.push(String(req.headers.host)); res.end('secret') })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  return { server, port: (server.address() as { port: number }).port }
}

test('web_fetch connects only to the validated address, never a second DNS answer (rebinding)', async () => {
  const hits: string[] = [], { server, port } = await serve(hits)
  try {
    const answers = [[{ address: '8.8.8.8', family: 4 }], [{ address: '127.0.0.1', family: 4 }]]
    let calls = 0
    const tool = createWebFetch(async () => answers[Math.min(calls++, 1)]!)
    await assert.rejects(tool.run({ url: `http://rebind.test:${port}/` }, { cwd: '.', signal: AbortSignal.timeout(500) }))
    assert.deepEqual(hits, [])
    assert.equal(calls, 1)
    await assert.rejects(createWebFetch(async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }]).run({ url: `http://mixed.test:${port}/` }, { cwd: '.' }), /Private and local/)
    assert.deepEqual(hits, [])
  } finally { server.close() }
})

test('the pinned agent connects to its address while keeping the original Host', async () => {
  const hits: string[] = [], { server, port } = await serve(hits)
  const agent = pinnedAgent('127.0.0.1')
  try {
    const response = await undiciFetch(`http://public.example:${port}/`, { dispatcher: agent })
    assert.equal(await response.text(), 'secret')
    assert.deepEqual(hits, [`public.example:${port}`])
  } finally { await agent.close(); server.close() }
})
