import { builtinTools } from '@oqelira/core'
import type { Tool } from '@oqelira/core'
import { UUID, GitError } from './sandbox.js'
import type { Sandbox, GitRequest, GitResult } from './sandbox.js'

/** Control plane has no Docker socket. A private runner owns execution. */
export class RemoteSandbox implements Sandbox {
  constructor(private readonly url: string, private readonly token: string) {
    const target = new URL(url)
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error('Invalid runner URL')
    if (Buffer.byteLength(token) < 32) throw new Error('Runner token is too short')
  }
  /** Clone or pull on the runner. The GitHub token travels only in this JSON body, never in a URL or log. */
  async git(request: GitRequest, signal?: AbortSignal): Promise<GitResult> {
    if (!UUID.test(request.project)) throw new GitError('Invalid project ID')
    const limit = AbortSignal.timeout(10 * 60_000)
    let response: Response
    try {
      response = await fetch(new URL('/git', this.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, limit]) : limit, redirect: 'error',
      })
    } catch { throw new GitError('Isolated runner unreachable or timed out') }
    const data = await response.json().catch(() => ({})) as { ok?: boolean; error?: unknown; branch?: unknown; commit?: unknown; changed?: unknown; bytes?: unknown }
    const clean = (value: string) => value.split(request.token).join('[redacted]').slice(0, 300)
    if (!response.ok) throw new GitError(typeof data.error === 'string' && data.error ? clean(data.error) : `Runner git request failed (${response.status})`)
    if (data.ok !== true || typeof data.branch !== 'string' || typeof data.commit !== 'string') throw new GitError('Invalid runner response')
    return { branch: data.branch, commit: data.commit, ...(typeof data.changed === 'number' ? { changed: data.changed } : {}), ...(typeof data.bytes === 'number' ? { bytes: data.bytes } : {}) }
  }
  tools(project: string): Tool[] {
    if (!UUID.test(project)) throw new Error('Invalid project ID')
    return builtinTools.map(tool => ({ ...tool, run: async (input, ctx) => {
      const response = await fetch(new URL('/execute', this.url), {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ project, name: tool.spec.name, input }), signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(95000)]) : AbortSignal.timeout(95000), redirect: 'error',
      })
      if (!response.ok) throw new Error('Isolated runner unavailable')
      const result = await response.json() as { output?: string; error?: string }
      if (result.error) throw new Error(result.error)
      if (typeof result.output !== 'string') throw new Error('Invalid runner response')
      return result.output.slice(0, 30000)
    } }))
  }
}
