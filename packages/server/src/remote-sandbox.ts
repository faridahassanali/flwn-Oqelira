import { builtinTools } from '@oqelira/core'
import type { Tool } from '@oqelira/core'
import { UUID } from './sandbox.js'
import type { Sandbox } from './sandbox.js'

/** Control plane has no Docker socket. A private runner owns execution. */
export class RemoteSandbox implements Sandbox {
  constructor(private readonly url: string, private readonly token: string) {
    const target = new URL(url)
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password || target.search || target.hash) throw new Error('Invalid runner URL')
    if (Buffer.byteLength(token) < 32) throw new Error('Runner token is too short')
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
