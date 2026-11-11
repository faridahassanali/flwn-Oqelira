import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { PGlite } from '@electric-sql/pglite'
import { symmetricEncrypt } from 'better-auth/crypto'
import { pglitePool } from './database.js'
import { serverConfig } from '../src/config.js'
import { migrate } from '../src/migrate.js'
import { createAuth } from '../src/auth.js'
import { Store } from '../src/store.js'
import { PostgresRunChannel } from '../src/channel.js'
import { createCloudServer } from '../src/server.js'
import { RemoteSandbox } from '../src/remote-sandbox.js'
import { GitError } from '../src/sandbox.js'
import type { GitRequest, GitResult } from '../src/sandbox.js'

const TOKEN = 'gho_FIXTURE_token_that_must_never_leak_0123456789'
const listen = (handler: (req: IncomingMessage, res: ServerResponse) => void) => new Promise<{ url: string; close: () => void }>(resolve => {
  const server = createServer(handler); server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close: () => { server.closeAllConnections(); server.close() } }))
})
const freePort = async () => { const s = createNetServer(); await new Promise<void>(r => s.listen(0, '127.0.0.1', r)); const port = (s.address() as { port: number }).port; await new Promise<void>(r => s.close(() => r())); return port }
const repoList = Array.from({ length: 30 }, (_, i) => ({ full_name: `octo/repo-${i}`, private: i % 2 === 0, default_branch: 'main', description: i === 3 ? 'the special one' : null, pushed_at: '2026-01-01T00:00:00Z', secret_field: 'x' }))

test('GitHub connect, repo listing, import and pull never expose the token and never make GitHub a login', { timeout: 120000 }, async () => {
  const logs: string[] = [], out = process.stdout.write.bind(process.stdout), err = process.stderr.write.bind(process.stderr)
  const spy = (write: typeof process.stdout.write) => ((chunk: unknown, ...rest: unknown[]) => { logs.push(String(chunk)); return (write as (...a: unknown[]) => boolean)(chunk, ...rest) }) as typeof process.stdout.write
  process.stdout.write = spy(out); process.stderr.write = spy(err)
  const calls: string[] = []
  let mode: 'ok' | 'revoked' | 'limited' = 'ok'
  const fake = await listen((req, res) => {
    calls.push(`${req.method} ${req.url}`)
    if (req.method === 'DELETE' && req.url!.startsWith('/applications/')) { res.writeHead(204); res.end(); return }
    if (req.headers.authorization !== `Bearer ${TOKEN}` || mode === 'revoked') { res.writeHead(401); res.end(`{"message":"Bad credentials ${TOKEN}"}`); return }
    if (mode === 'limited') { res.writeHead(403, { 'x-ratelimit-remaining': '0' }); res.end('{}'); return }
    if (req.url === '/user') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"login":"octocat"}'); return }
    const page = Number(new URL(req.url!, 'http://x').searchParams.get('page'))
    res.writeHead(200, { 'Content-Type': 'application/json', ...(page === 1 ? { Link: '<https://api.github.com/user/repos?page=2>; rel="next"' } : {}) }); res.end(JSON.stringify(repoList))
  })
  const runs: GitRequest[] = []
  let outcome: 'ok' | 'fail' | 'hang' = 'ok', release: () => void = () => {}
  const sandbox = { tools: () => [], async git(request: GitRequest): Promise<GitResult> {
    runs.push(request)
    if (outcome === 'hang') await new Promise<void>(r => { release = r })
    if (outcome === 'fail') throw new GitError(`remote said no for ${request.token}`)
    return { branch: request.branch ?? 'main', commit: 'a'.repeat(40), changed: 3 }
  } }
  const port = await freePort(), db = new PGlite(), pool = pglitePool(db), store = new Store(pool)
  const config = serverConfig({ OQELIRA_SERVER_URL: `http://127.0.0.1:${port}`, OQELIRA_AUTH_SECRET: '3f0d1b6c8e7a4b59a2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7', OQELIRA_DATABASE_URL: 'postgres://fixture', OQELIRA_ALLOW_SIGNUP: 'true', OQELIRA_GITHUB_CLIENT_ID: 'fixture-client', OQELIRA_GITHUB_CLIENT_SECRET: 'fixture-secret' })
  await migrate(pool, config)
  const auth = createAuth(pool, config, async () => {})
  const server = createCloudServer({ auth, store, channel: await PostgresRunChannel.open(pool, (c, cb) => db.listen(c, cb)), sandbox, origin: config.baseURL, dist: '.', models: [], provider: () => { throw new Error('unused') },
    authCapabilities: { signup: true, emailRecovery: false, verification: false, socialProviders: [], githubConnect: true }, github: { clientId: 'fixture-client', clientSecret: 'fixture-secret', apiBase: fake.url } })
  await server.listen(port)
  const request = (route: string, cookie = "", data?: unknown) => fetch(config.baseURL + route, { headers: { Origin: config.baseURL, Cookie: cookie, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(data === undefined ? {} : { method: 'POST', body: JSON.stringify(data) }) })
  const signup = async (email: string) => {
    const response = await request('/api/auth/sign-up/email', '', { name: 'Fixture', email, password: 'Controlled test password 2026!' }); assert.equal(response.status, 200)
    const user = (await response.json() as { user: { id: string } }).user; await pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1', [user.id])
    return { id: user.id, email, cookie: response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') }
  }
  const connect = async (userId: string) => (await auth.$context).internalAdapter.createAccount({ userId, providerId: 'github', accountId: '4242', accessToken: await symmetricEncrypt({ key: (await auth.$context).secretConfig, data: TOKEN }), scope: 'repo,read:user' })
  const state = async (cookie: string, project: string) => (await (await request(`/api/projects/${project}/github`, cookie)).json() as { source: { state: string; repo: string; branch: string; commit?: string; error?: string } | null }).source
  const settle = async (cookie: string, project: string) => { for (let i = 0; i < 100; i++) { const s = await state(cookie, project); if (s && s.state !== 'syncing') return s; await new Promise(r => setTimeout(r, 20)) } throw new Error('still syncing') }
  const every: string[] = []
  const json = async (response: Response) => { const text = await response.text(); every.push(text); return JSON.parse(text) }
  try {
    const a = await signup('a@example.test')
    // GitHub is a connection, not a login method.
    const cfg = await json(await request('/api/config', a.cookie)) as { auth: { socialProviders: string[]; githubConnect: boolean } }
    assert.ok(!cfg.auth.socialProviders.includes('github')); assert.equal(cfg.auth.githubConnect, true)
    assert.equal((await request('/api/auth/sign-in/social', '', { provider: 'github', callbackURL: config.baseURL + '/' })).status, 403)
    assert.equal((await request('/api/auth/link-social', '', { provider: 'github', callbackURL: config.baseURL + '/' })).status, 401)
    assert.equal((await request('/api/auth/link-social', a.cookie, { provider: 'google', callbackURL: config.baseURL + '/' })).status, 403)
    const link = await request('/api/auth/link-social', a.cookie, { provider: 'github', scopes: ['repo', 'read:user'], callbackURL: config.baseURL + '/', disableRedirect: true })
    assert.equal(link.status, 200); const authorize = new URL((await link.json() as { url: string }).url)
    assert.equal(authorize.host, 'github.com'); assert.equal(authorize.searchParams.get('client_id'), 'fixture-client'); assert.ok(authorize.searchParams.get('scope')!.split(/[ ,]/).includes('repo'))
    assert.equal((await request('/api/auth/get-access-token', a.cookie, { providerId: 'github' })).status, 403)
    assert.equal((await request('/api/auth/get-access-token', a.cookie, { accountId: 'x' })).status, 403)

    assert.equal((await request('/api/github/status')).status, 401)
    assert.deepEqual(await json(await request('/api/github/status', a.cookie)), { configured: true, connected: false })
    assert.equal((await request('/api/github/repos', a.cookie)).status, 409)
    await connect(a.id)
    assert.notEqual((await pool.query(`SELECT "accessToken" FROM account WHERE "userId"=$1 AND "providerId"='github'`, [a.id])).rows[0].accessToken, TOKEN, 'token is stored encrypted')
    assert.deepEqual(await json(await request('/api/github/status', a.cookie)), { configured: true, connected: true, login: 'octocat' })

    const page = await json(await request('/api/github/repos?page=1', a.cookie)) as { repos: Record<string, unknown>[]; nextPage?: number }
    assert.equal(page.repos.length, 30); assert.equal(page.nextPage, 2); assert.deepEqual(Object.keys(page.repos[0]!).sort(), ['defaultBranch', 'description', 'fullName', 'private', 'pushedAt'])
    const filtered = await json(await request('/api/github/repos?query=SPECIAL', a.cookie)) as { repos: { fullName: string }[] }
    assert.deepEqual(filtered.repos.map(r => r.fullName), ['octo/repo-3'])
    assert.equal((await request('/api/github/repos?page=0', a.cookie)).status, 400)
    mode = 'limited'; assert.equal((await request('/api/github/repos', a.cookie)).status, 429); mode = 'ok'

    const project = (await json(await request('/api/projects', a.cookie, { name: 'P' }))) as { id: string }
    const base = `/api/projects/${project.id}/github`
    assert.deepEqual(await json(await request(base, a.cookie)), { source: null })
    for (const bad of [{ repo: 'nope' }, { repo: '../..' }, { repo: 'a/b/c' }, { repo: 'a/b;rm' }, { repo: 'a/b', branch: '--upload-pack=x' }, { repo: 'a/b', branch: 'x..y' }, { repo: 'a/b', branch: 'x y' }, { repo: 'a/b', branch: 'x.lock' }]) assert.equal((await request(base + '/import', a.cookie, bad)).status, 400, JSON.stringify(bad))
    assert.equal((await request('/api/projects/' + '00000000-0000-4000-8000-000000000000' + '/github/import', a.cookie, { repo: 'a/b' })).status, 404)
    assert.equal((await request(base + '/pull', a.cookie, {})).status, 404)
    assert.equal(runs.length, 0)

    outcome = 'fail'
    const failing = await request(base + '/import', a.cookie, { repo: 'octo/repo-1' }); assert.equal(failing.status, 202); assert.deepEqual(await failing.json(), { state: 'syncing' })
    const failed = await settle(a.cookie, project.id); assert.equal(failed.state, 'error'); assert.ok(!failed.error!.includes(TOKEN)); assert.match(failed.error!, /redacted/)
    outcome = 'hang'
    assert.equal((await request(base + '/import', a.cookie, { repo: 'octo/repo-1', branch: 'release/1.0' })).status, 202, 'a failed first import can be retried')
    assert.equal((await state(a.cookie, project.id))!.state, 'syncing')
    assert.equal((await request(base + '/import', a.cookie, { repo: 'octo/other' })).status, 409)
    assert.equal((await request(base + '/pull', a.cookie, {})).status, 409)
    release(); const imported = await settle(a.cookie, project.id)
    assert.deepEqual([imported.state, imported.repo, imported.branch, imported.commit], ['idle', 'octo/repo-1', 'release/1.0', 'a'.repeat(40)])
    assert.deepEqual(runs.at(-1), { action: 'clone', project: project.id, repo: 'octo/repo-1', branch: 'release/1.0', token: TOKEN })
    outcome = 'ok'
    assert.equal((await request(base + '/import', a.cookie, { repo: 'octo/again' })).status, 409, 'import only into a project without a source')
    assert.equal((await request(base + '/pull', a.cookie, {})).status, 202); assert.equal((await settle(a.cookie, project.id)).state, 'idle')
    assert.deepEqual([runs.at(-1)!.action, runs.at(-1)!.repo, runs.at(-1)!.branch], ['pull', 'octo/repo-1', 'release/1.0'])

    // Other users cannot see or drive the project; viewers can read but not sync.
    const b = await signup('b@example.test')
    assert.equal((await request(base, b.cookie)).status, 404); assert.equal((await request(base + '/pull', b.cookie, {})).status, 404)
    const team = await json(await request('/api/auth/organization/create', a.cookie, { name: 'Team', slug: 'team' })) as { id: string }
    const shared = await json(await request('/api/projects', a.cookie, { name: 'Shared', organizationId: team.id })) as { id: string }
    await pool.query(`INSERT INTO member(id,"organizationId","userId",role,"createdAt") VALUES('m1',$1,$2,'viewer',now())`, [team.id, b.id])
    assert.equal((await request(`/api/projects/${shared.id}/github`, b.cookie)).status, 200)
    assert.equal((await request(`/api/projects/${shared.id}/github/import`, b.cookie, { repo: 'octo/repo-1' })).status, 403)
    assert.equal((await request(`/api/projects/${shared.id}/github/import`, a.cookie, { repo: 'octo/repo-1' })).status, 202); await settle(a.cookie, shared.id)

    // A crash leaves nothing stuck.
    await pool.query(`UPDATE oq_project_source SET state='syncing',updated_at=now()-interval '30 minutes' WHERE project_id=$1`, [project.id])
    const again = createCloudServer({ auth, store, channel: await PostgresRunChannel.open(pool, (c, cb) => db.listen(c, cb)), sandbox, origin: config.baseURL, dist: '.', models: [], provider: () => { throw new Error('unused') }, github: { clientId: 'fixture-client', clientSecret: 'fixture-secret', apiBase: fake.url } })
    await again.listen(await freePort()); assert.equal((await state(a.cookie, project.id))!.state, 'error'); await again.close()
    // Rate limit: 10 per hour per user.
    let last = 0
    for (let i = 0; i < 8; i++) last = (await request(base + '/import', a.cookie, { repo: 'octo/x' })).status
    assert.equal(last, 429)

    // Revoked token maps to a reconnect error and marks the account disconnected.
    mode = 'revoked'
    const revoked = await request('/api/github/repos', a.cookie); assert.equal(revoked.status, 409); assert.match(((await json(revoked)) as { error: string }).error, /reconnect GitHub/)
    mode = 'ok'
    assert.deepEqual(await json(await request('/api/github/status', a.cookie)), { configured: true, connected: false })

    // Disconnect revokes at GitHub (best effort) and always removes the account locally.
    await connect(a.id)
    assert.deepEqual(await json(await request('/api/github/disconnect', a.cookie, {})), { ok: true })
    assert.ok(calls.some(c => c.startsWith('DELETE /applications/fixture-client/grant')))
    assert.equal((await pool.query(`SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"='github'`, [a.id])).rows.length, 0)
    await connect(a.id); fake.close()
    assert.deepEqual(await json(await request('/api/github/disconnect', a.cookie, {})), { ok: true }, 'revocation failure does not block local removal')
    assert.equal((await pool.query(`SELECT 1 FROM account WHERE "userId"=$1 AND "providerId"='github'`, [a.id])).rows.length, 0)
    await server.close()
  } finally {
    process.stdout.write = out; process.stderr.write = err; fake.close(); await db.close()
  }
  assert.ok(!every.concat(logs).some(text => text.includes(TOKEN)), 'token appeared in a response or log')
})

test('runner git client sends the token only in the JSON body and scrubs runner errors', async () => {
  let seen: { url?: string; auth?: string; body?: string } = {}, reply: [number, unknown] = [200, { ok: true, branch: 'main', commit: 'b'.repeat(40), changed: 2, bytes: 10 }]
  const runner = await listen((req, res) => { let data = ''; req.on('data', c => data += c); req.on('end', () => { seen = { url: req.url, auth: req.headers.authorization, body: data }; res.writeHead(reply[0], { 'Content-Type': 'application/json' }); res.end(JSON.stringify(reply[1])) }) })
  const sandbox = new RemoteSandbox(runner.url, 'r'.repeat(40)), project = '11111111-1111-4111-8111-111111111111'
  try {
    assert.deepEqual(await sandbox.git({ action: 'clone', project, repo: 'a/b', token: TOKEN }), { branch: 'main', commit: 'b'.repeat(40), changed: 2, bytes: 10 })
    assert.equal(seen.url, '/git'); assert.equal(seen.auth, 'Bearer ' + 'r'.repeat(40)); assert.deepEqual(JSON.parse(seen.body!), { action: 'clone', project, repo: 'a/b', token: TOKEN })
    reply = [500, { error: `fatal: bad ${TOKEN}` }]
    await assert.rejects(sandbox.git({ action: 'pull', project, repo: 'a/b', token: TOKEN }), (e: Error) => !e.message.includes(TOKEN) && /redacted/.test(e.message))
    reply = [200, { ok: true }]
    await assert.rejects(sandbox.git({ action: 'pull', project, repo: 'a/b', token: TOKEN }), /Invalid runner response/)
  } finally { runner.close() }
})
