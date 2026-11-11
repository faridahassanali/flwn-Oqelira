import { randomUUID } from 'node:crypto'
import { builtinTools } from '../src/tools/index.js'
import type { Tool, ToolContext } from '../src/tools/types.js'

export interface EvalWorkspace {
  readonly tools: Tool[]
  initialize(): Promise<void>
  writeText(path: string, content: string): Promise<void>
  readText(path: string): Promise<string | null>
  exists(path: string): Promise<boolean>
  listing(path: string): Promise<string[]>
  testPasses(file: string): Promise<boolean>
  dispose(): Promise<void>
}

/** A runner-only tool set for live evaluation. No fixture operation touches the caller's filesystem. */
export class RunnerWorkspace implements EvalWorkspace {
  static fromEnv(): RunnerWorkspace {
    return new RunnerWorkspace(process.env.PROMPT_EVAL_RUNNER_URL ?? '', process.env.PROMPT_EVAL_RUNNER_TOKEN ?? '')
  }
  private verified?: Promise<void>
  private used = false
  readonly project = randomUUID()
  readonly tools: Tool[]

  constructor(private readonly url: string, private readonly token: string) {
    if (!url) throw new Error('Set PROMPT_EVAL_RUNNER_URL and PROMPT_EVAL_RUNNER_TOKEN for isolated evaluation')
    const target = new URL(url)
    if (target.protocol !== 'https:' || target.username || target.password || target.search || target.hash) throw new Error('PROMPT_EVAL_RUNNER_URL must be a clean HTTPS URL')
    if (Buffer.byteLength(token) < 32) throw new Error('PROMPT_EVAL_RUNNER_TOKEN is too short')
    this.tools = builtinTools.filter(t => ['read_file', 'list_dir', 'search_text', 'file_snapshot', 'apply_file_change', 'revert_file_change', 'read_file_change', 'write_file', 'edit_file', 'run_command'].includes(t.spec.name)).map(tool => ({ ...tool, run: (input, ctx) => this.call(tool.spec.name, input, ctx) }))
  }

  async call(name: string, input: unknown, ctx: ToolContext = { cwd: '/workspace' }): Promise<string> {
    await this.initialize()
    this.used = true
    const response = await fetch(new URL('/execute', this.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ project: this.project, name, input }),
      signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(95_000)]) : AbortSignal.timeout(95_000),
      redirect: 'error',
    })
    if (response.headers.get('x-oqelira-runtime') !== 'runsc') throw new Error('Evaluation requires a gVisor runsc runner')
    if (!response.ok) throw new Error('Isolated evaluation runner is unavailable')
    const result = await response.json() as { output?: string; error?: string }
    if (result.error) throw new Error(result.error)
    if (typeof result.output !== 'string') throw new Error('Invalid isolated runner response')
    return result.output.slice(0, 30_000)
  }

  async initialize(): Promise<void> { await (this.verified ??= this.verify()) }

  private async verify(): Promise<void> {
    const response = await fetch(new URL('/runtime', this.url), {
      headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(15_000), redirect: 'error',
    })
    if (!response.ok || response.headers.get('x-oqelira-runtime') !== 'runsc') {
      throw new Error('Evaluation requires a gVisor runsc runner; no local fallback is available')
    }
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.call('write_file', { path, content })
  }

  async readText(path: string): Promise<string | null> {
    try { return await this.call('read_file', { path }) }
    catch (error) { if (error instanceof Error && /ENOENT/.test(error.message)) return null; throw error }
  }

  async exists(path: string): Promise<boolean> { return await this.readText(path) !== null }

  async listing(path: string): Promise<string[]> {
    try { return (await this.call('list_dir', { path })).split('\n').filter(Boolean) }
    catch (error) { if (error instanceof Error && /ENOENT/.test(error.message)) return []; throw error }
  }

  async testPasses(file: string): Promise<boolean> {
    // The argument is task data, never executable shell text.
    const quoted = "'" + file.replaceAll("'", "'\"'\"'") + "'"
    const output = await this.call('run_command', { command: `node --test -- ${quoted}`, timeout_seconds: 60 })
    return output.endsWith('\n[exit code 0]')
  }

  async dispose(): Promise<void> {
    if (!this.used) return
    const response = await fetch(new URL(`/projects/${this.project}`, this.url), {
      method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` },
      signal: AbortSignal.timeout(95_000), redirect: 'error',
    })
    if (!response.ok) throw new Error('Isolated evaluation workspace cleanup failed')
  }
}
