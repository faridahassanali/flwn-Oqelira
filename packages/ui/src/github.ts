import { api, ApiError } from './cloud.js'

export interface GithubStatus { configured: boolean; connected: boolean; login?: string }
export interface Repo { fullName: string; private: boolean; defaultBranch: string; description?: string | null; pushedAt?: string | null }
export interface RepoPage { repos: Repo[]; nextPage?: number }
export type SyncState = 'idle' | 'syncing' | 'error'
export interface GithubSource { repo: string; branch: string; commit?: string; state: SyncState; error?: string; syncedAt?: string }

/** One readable sentence for any failure, including a missing route or an unreachable server. */
export function describeFailure(error: unknown, action: string): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return `${action}: this server does not offer GitHub yet.`
    if (error.status === 401) return `${action}: sign in again to continue.`
    return `${action}: ${error.message}`
  }
  if (error instanceof TypeError) return `${action}: the server could not be reached.`
  return `${action}: ${error instanceof Error ? error.message : 'unexpected error'}`
}

/** A rejected or expired GitHub token surfaces as 401/403 from the GitHub routes. */
export const needsReconnect = (error: unknown) => error instanceof ApiError && [401, 403].includes(error.status) && /github|token|reconnect|authori/i.test(error.message)

export const githubStatus = () => api<GithubStatus>('github/status')
export const disconnectGithub = () => api<unknown>('github/disconnect', {})
export const listRepos = (query: string, page: number) => api<RepoPage>(`github/repos?query=${encodeURIComponent(query)}&page=${page}`)
export const importRepo = (projectId: string, repo: string, branch?: string) => api<{ state: SyncState }>(`projects/${encodeURIComponent(projectId)}/github/import`, { repo, ...(branch ? { branch } : {}) })
export const pullLatest = (projectId: string) => api<{ state: SyncState }>(`projects/${encodeURIComponent(projectId)}/github/pull`, {})
export const projectSource = async (projectId: string) => (await api<{ source: GithubSource | null }>(`projects/${encodeURIComponent(projectId)}/github`)).source

/** Only a GitHub authorize URL may be followed; anything else from the server is refused. */
export function safeGithubUrl(value: string | undefined): string {
  if (!value) throw new Error('GitHub did not return a connect URL')
  const target = new URL(value)
  if (target.protocol !== 'https:' || target.username || target.password || target.hostname !== 'github.com') throw new Error('Unexpected GitHub URL')
  return target.href
}
export async function connectGithub(navigate: (url: string) => void = url => location.assign(url)): Promise<void> {
  const result = await api<{ url?: string }>('auth/link-social', { provider: 'github', scopes: ['repo', 'read:user'], callbackURL: '/?github=connected' })
  navigate(safeGithubUrl(result.url))
}

/** `?github=connected` after the OAuth redirect; `?error=` is Better Auth reporting a failed link. */
export function githubReturn(search: string): 'connected' | 'error' | undefined {
  const params = new URLSearchParams(search)
  if (params.get('github') === 'connected') return params.has('error') ? 'error' : 'connected'
  return params.has('error') ? 'error' : undefined
}
export function withoutGithubReturn(url: URL): string {
  url.searchParams.delete('github'); url.searchParams.delete('error'); url.searchParams.delete('error_description')
  return url.pathname + url.search + url.hash
}

/** Calls `get` until the source leaves "syncing". Injectable wait keeps this testable without timers. */
export async function pollUntilSettled(get: () => Promise<GithubSource | null>, onUpdate: (source: GithubSource | null) => void, wait: (ms: number) => Promise<void>, signal: AbortSignal, intervalMs = 3000): Promise<void> {
  while (!signal.aborted) {
    let source: GithubSource | null
    try { source = await get() } catch { onUpdate(null); return }
    if (signal.aborted) return
    onUpdate(source)
    if (source?.state !== 'syncing') return
    await wait(intervalMs)
  }
}

export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never'
  const then = Date.parse(iso)
  if (!Number.isFinite(then)) return 'unknown'
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return 'just now'
  const steps: [number, string][] = [[60, 'min'], [3600, 'h'], [86400, 'd'], [2592000, 'mo'], [31536000, 'y']]
  let unit = 'min', size = 60
  for (const [limit, label] of steps) { if (seconds >= limit) { unit = label; size = limit } }
  return `${Math.floor(seconds / size)} ${unit} ago`
}

export const repoName = (fullName: string) => fullName.split('/').pop() ?? fullName
