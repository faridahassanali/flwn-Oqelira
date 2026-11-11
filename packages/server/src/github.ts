import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Auth } from './auth.js'
import type { Store } from './store.js'
import type { Sandbox } from './sandbox.js'
import { HttpError, body as readBody, requireId } from './server.js'

export interface GithubOptions { clientId: string; clientSecret: string; apiBase?: string }
interface Access { id: string; owner_id: string }
export interface GithubContext { req: IncomingMessage; res: ServerResponse; url: URL; user: string; reply: (res: ServerResponse, status: number, data: unknown) => void; project: (id: string, write?: boolean) => Promise<Access> }

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,199}$/
const STALE_MINUTES = 12 // longer than the 10 minute runner timeout, so a live clone is never marked failed
const dots = (value: string) => value.split('/').some(part => part === '.' || part === '..')
const validRepo = (value: unknown) => typeof value === 'string' && REPO.test(value) && !dots(value)
const validBranch = (value: unknown) => typeof value === 'string' && BRANCH.test(value) && !value.includes('..') && !value.includes('//') && !value.endsWith('/') && !value.endsWith('.') && !value.split('/').some(part => part.endsWith('.lock'))

/** GitHub connection and import/pull. GitHub is never a login method and nothing is written back to it. */
export function createGithub(auth: Auth, store: Store, sandbox: Sandbox, options?: GithubOptions) {
  const api = options?.apiBase ?? 'https://api.github.com'
  const configured = !!options
  const need = () => { if (!options) throw new HttpError(503, 'GitHub is not configured on this server') }
  const accountId = async (user: string) => (await store.pool.query(`SELECT id FROM account WHERE "userId"=$1 AND "providerId"='github' AND "accessToken" IS NOT NULL LIMIT 1`, [user])).rows[0]?.id as string | undefined
  const drop = async (id: string) => { await (await auth.$context).internalAdapter.deleteAccount(id) }
  const reconnect = () => new HttpError(409, 'GitHub authorization is no longer valid; reconnect GitHub')
  /** Server-side only. Better Auth decrypts the stored token here; it is never sent anywhere except GitHub and the runner. */
  async function token(user: string): Promise<{ id: string; token: string }> {
    const id = await accountId(user)
    if (!id) throw new HttpError(409, 'Connect GitHub first')
    try {
      const result = await auth.api.getAccessToken({ body: { accountId: id, userId: user } })
      if (!result.accessToken) throw new Error()
      return { id, token: result.accessToken }
    } catch { throw reconnect() }
  }
  async function gh(user: string, path: string) {
    const credential = await token(user)
    let response: Response
    try {
      response = await fetch(api + path, { headers: { Authorization: `Bearer ${credential.token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'oqelira' }, signal: AbortSignal.timeout(10000), redirect: 'error' })
    } catch { throw new HttpError(502, 'Could not reach GitHub') }
    if (response.status === 401) { await drop(credential.id).catch(() => undefined); throw reconnect() }
    if (response.status === 429 || (response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')))) throw new HttpError(429, 'GitHub rate limit reached; try again later')
    if (!response.ok) throw new HttpError(502, 'GitHub request failed')
    return response
  }
  async function status(user: string) {
    if (!configured) return { configured: false, connected: false }
    if (!await accountId(user)) return { configured: true, connected: false }
    try {
      const profile = await (await gh(user, '/user')).json() as { login?: unknown }
      return { configured: true, connected: true, ...(typeof profile.login === 'string' ? { login: profile.login } : {}) }
    } catch (error) {
      if (error instanceof HttpError && error.status === 409) return { configured: true, connected: false }
      return { configured: true, connected: true }
    }
  }
  async function disconnect(user: string) {
    need()
    const id = await accountId(user)
    if (id) {
      try {
        const credential = await token(user)
        await fetch(`${api}/applications/${encodeURIComponent(options!.clientId)}/grant`, {
          method: 'DELETE', headers: { Authorization: 'Basic ' + Buffer.from(`${options!.clientId}:${options!.clientSecret}`).toString('base64'), Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'oqelira' },
          body: JSON.stringify({ access_token: credential.token }), signal: AbortSignal.timeout(10000), redirect: 'error',
        })
      } catch { /* best effort: the local link is removed regardless */ }
      await drop(id)
    }
    return { ok: true }
  }
  async function repos(user: string, url: URL) {
    need()
    const page = Number(url.searchParams.get('page') ?? 1), query = (url.searchParams.get('query') ?? '').trim().toLowerCase()
    if (!Number.isInteger(page) || page < 1 || page > 100 || query.length > 100) throw new HttpError(400, 'Invalid query')
    const response = await gh(user, `/user/repos?sort=pushed&per_page=30&page=${page}&affiliation=owner,collaborator,organization_member`)
    const list = await response.json().catch(() => undefined) as { full_name?: unknown; private?: unknown; default_branch?: unknown; description?: unknown; pushed_at?: unknown }[] | undefined
    if (!Array.isArray(list)) throw new HttpError(502, 'GitHub request failed')
    const repos = list.filter(r => typeof r.full_name === 'string').filter(r => !query || (r.full_name as string).toLowerCase().includes(query) || (typeof r.description === 'string' && r.description.toLowerCase().includes(query)))
      .map(r => ({ fullName: r.full_name as string, private: r.private === true, defaultBranch: typeof r.default_branch === 'string' ? r.default_branch : null, description: typeof r.description === 'string' ? r.description : null, pushedAt: typeof r.pushed_at === 'string' ? r.pushed_at : null }))
    return { repos, ...(/<[^>]*[?&]page=\d+[^>]*>;\s*rel="next"/.test(response.headers.get('link') ?? '') ? { nextPage: page + 1 } : {}) }
  }
  const sourceOf = async (project: string) => {
    const row = (await store.pool.query('SELECT repo,branch,"commit",state,error,synced_at FROM oq_project_source WHERE project_id=$1', [project])).rows[0]
    return row ? { repo: row.repo as string, branch: row.branch as string, ...(row.commit ? { commit: row.commit as string } : {}), state: row.state as string, ...(row.error ? { error: row.error as string } : {}), ...(row.synced_at ? { syncedAt: new Date(row.synced_at).toISOString() } : {}) } : null
  }
  /** Runs after the 202; never throws, always leaves the row in idle or error. */
  async function sync(action: 'clone' | 'pull', user: string, project: string, repo: string, branch: string) {
    let credential: string | undefined
    try {
      credential = (await token(user)).token
      if (!sandbox.git) throw new Error('GitHub import is not available in this deployment')
      const result = await sandbox.git({ action, project, repo, ...(branch ? { branch } : {}), token: credential })
      await store.pool.query(`UPDATE oq_project_source SET state='idle',error=NULL,branch=$2,"commit"=$3,synced_at=now(),updated_at=now() WHERE project_id=$1`, [project, result.branch, result.commit])
    } catch (error) {
      let message = error instanceof Error ? error.message : 'Sync failed'
      if (credential) message = message.split(credential).join('[redacted]')
      await store.pool.query(`UPDATE oq_project_source SET state='error',error=$2,updated_at=now() WHERE project_id=$1`, [project, message.slice(0, 300)]).catch(() => undefined)
    }
  }
  async function start(ctx: GithubContext, project: string, action: 'clone' | 'pull') {
    need()
    await ctx.project(project, true)
    let repo: string, branch: string
    const data = action === 'clone' ? await readBody(ctx.req) : undefined
    if (data && !validRepo(data.repo)) throw new HttpError(400, 'Invalid repository; use owner/name')
    if (data && data.branch !== undefined && !validBranch(data.branch)) throw new HttpError(400, 'Invalid branch name')
    if (!await store.takeQuota(ctx.user, 'github-sync', 10, 3600)) throw new HttpError(429, 'GitHub sync limit reached; wait before retrying')
    if (data) {
      repo = data.repo as string; branch = (data.branch as string | undefined) ?? ''
      // A first import that failed may be retried; any other existing source is final. The conflict clause makes this atomic across replicas.
      const claimed = await store.pool.query(`INSERT INTO oq_project_source(project_id,repo,branch,state,updated_at) VALUES($1,$2,$3,'syncing',now()) ON CONFLICT(project_id) DO UPDATE SET repo=EXCLUDED.repo,branch=EXCLUDED.branch,state='syncing',error=NULL,updated_at=now() WHERE oq_project_source."commit" IS NULL AND oq_project_source.state='error' RETURNING project_id`, [project, repo, branch])
      if (claimed.rows.length !== 1) throw new HttpError(409, 'This project already has a GitHub source')
    } else {
      const claimed = await store.pool.query(`UPDATE oq_project_source SET state='syncing',error=NULL,updated_at=now() WHERE project_id=$1 AND state<>'syncing' AND "commit" IS NOT NULL RETURNING repo,branch`, [project])
      if (claimed.rows.length !== 1) {
        const current = await sourceOf(project)
        throw new HttpError(current ? 409 : 404, !current ? 'This project has no GitHub source' : current.state === 'syncing' ? 'A sync is already running' : 'Import the repository first')
      }
      repo = claimed.rows[0].repo; branch = claimed.rows[0].branch
    }
    void sync(action, ctx.user, project, repo, branch)
    ctx.reply(ctx.res, 202, { state: 'syncing' })
  }
  return {
    /** Marks syncs a crash left behind as failed so the project is not stuck. */
    async recover() { await store.pool.query(`UPDATE oq_project_source SET state='error',error='Sync was interrupted; retry',updated_at=now() WHERE state='syncing' AND updated_at<now()-interval '${STALE_MINUTES} minutes'`) },
    /** Returns true when the request was a GitHub route. */
    async route(ctx: GithubContext): Promise<boolean> {
      const { req, res, url, user, reply } = ctx, path = url.pathname, method = req.method
      if (method === 'GET' && path === '/api/github/status') { reply(res, 200, await status(user)); return true }
      if (method === 'POST' && path === '/api/github/disconnect') { reply(res, 200, await disconnect(user)); return true }
      if (method === 'GET' && path === '/api/github/repos') { reply(res, 200, await repos(user, url)); return true }
      const match = /^\/api\/projects\/([^/]+)\/github(?:\/(import|pull))?$/.exec(path)
      if (!match) return false
      const project = requireId(match[1])
      if (method === 'GET' && !match[2]) { await ctx.project(project); reply(res, 200, { source: await sourceOf(project) }); return true }
      if (method === 'POST' && match[2]) { await start(ctx, project, match[2] === 'import' ? 'clone' : 'pull'); return true }
      return false
    },
  }
}
