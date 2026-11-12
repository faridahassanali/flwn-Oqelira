import { randomUUID } from 'node:crypto'
import { builtinTools } from '../src/tools/index.js'
import type { Tool, ToolContext } from '../src/tools/types.js'

export interface EvalWorkspace {
  readonly tools: Tool[]
  initialize(): Promise<void>
  reset(files?: Record<string, string>): Promise<void>
  writeText(path: string, content: string): Promise<void>
  readText(path: string): Promise<string | null>
  exists(path: string): Promise<boolean>
  listing(path: string): Promise<string[]>
  testPasses(file: string): Promise<boolean>
  dispose(): Promise<void>
}

// Reserved evaluation namespace, also matched by the VM-only volume garbage collector.
export const EVAL_PROJECT_PREFIX = 'e7a1e7a1-e7a1-'
const quote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
const existenceProbe = `const fs=require("node:fs"),p=require("node:path");const f=p.resolve("/workspace",process.argv[1]);if(f!=="/workspace"&&!f.startsWith("/workspace/"))throw new Error("Path outside fixture");try{fs.accessSync(f);console.log(true)}catch(e){if(e.code!=="ENOENT")throw e;console.log(false)}`
const clearFixture = `node -e 'const fs=require("node:fs");const root="/workspace";for(const name of fs.readdirSync(root)){fs.rmSync(root+"/"+name,{recursive:true,force:true})}if(fs.readdirSync(root).length)process.exit(1)'`

/** A runner-only tool set for live evaluation. No fixture operation touches the caller's filesystem. */
export class RunnerWorkspace implements EvalWorkspace {
  static fromEnv(): RunnerWorkspace {
    return new RunnerWorkspace(process.env.PROMPT_EVAL_RUNNER_URL ?? '', process.env.PROMPT_EVAL_RUNNER_TOKEN ?? '')
  }
  private verified?: Promise<void>
  private used = false
  private isolated = false
  readonly project = EVAL_PROJECT_PREFIX + randomUUID().slice(EVAL_PROJECT_PREFIX.length)
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
    return this.execute(name, input, ctx)
  }

  private async execute(name: string, input: unknown, ctx: ToolContext = { cwd: '/workspace' }): Promise<string> {
    this.used = true
    const response = await fetch(new URL('/execute', this.url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.token}` },
      body: JSON.stringify({ project: this.project, name, input }),
      signal: ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(95_000)]) : AbortSignal.timeout(95_000),
      redirect: 'error',
    })
    if (!response.ok) throw new Error(`Isolated evaluation runner is unavailable (HTTP ${response.status})`)
    const result = await response.json() as { output?: string; error?: string }
    if (result.error) throw new Error(result.error)
    if (typeof result.output !== 'string') throw new Error('Invalid isolated runner response')
    return result.output.slice(0, 30_000)
  }

  async initialize(): Promise<void> { await (this.verified ??= this.verify()) }

  private async verify(): Promise<void> {
    // Compatible with the existing /execute API. This fixed probe runs no fixture code.
    const kernel = await this.execute('run_command', { command: 'cat /proc/version', timeout_seconds: 5 })
    if (!/Linux version [^\n]*gvisor/i.test(kernel) || !kernel.endsWith('\n[exit code 0]')) {
      throw new Error('Evaluation requires a gVisor runner; no local fallback is available')
    }
    this.isolated = true
  }

  async reset(files: Record<string, string> = {}): Promise<void> {
    const output = await this.call('run_command', { command: clearFixture, timeout_seconds: 60 })
    if (!output.endsWith('\n[exit code 0]')) throw new Error('Isolated evaluation fixture reset failed')
    for (const [path, content] of Object.entries(files)) await this.writeText(path, content)
  }

  async writeText(path: string, content: string): Promise<void> {
    await this.call('write_file', { path, content })
  }

  async readText(path: string): Promise<string | null> {
    try { return await this.call('read_file', { path }) }
    catch (error) {
      if (error instanceof Error && /ENOENT/.test(error.message)) return null
      // The deployed runner deliberately masks worker errors as HTTP 503.
      if (error instanceof Error && /HTTP 503/.test(error.message) && !await this.exists(path)) return null
      throw error
    }
  }

  async exists(path: string): Promise<boolean> {
    const output = await this.call('run_command', { command: `node -e ${quote(existenceProbe)} -- ${quote(path)}`, timeout_seconds: 5 })
    const suffix = '\n[exit code 0]'
    if (!output.endsWith(suffix)) throw new Error('Isolated fixture existence check failed')
    const value = output.slice(0, -suffix.length).trim()
    if (value !== 'true' && value !== 'false') throw new Error('Invalid isolated fixture existence response')
    return value === 'true'
  }

  async listing(path: string): Promise<string[]> {
    try { return (await this.call('list_dir', { path })).split('\n').filter(Boolean) }
    catch (error) {
      if (error instanceof Error && /ENOENT/.test(error.message)) return []
      if (error instanceof Error && /HTTP 503/.test(error.message) && !await this.exists(path)) return []
      throw error
    }
  }

  async testPasses(file: string): Promise<boolean> {
    // The argument is task data, never executable shell text.
    const quoted = quote(file)
    const output = await this.call('run_command', { command: `node --test -- ${quoted}`, timeout_seconds: 60 })
    return output.endsWith('\n[exit code 0]')
  }

  async dispose(): Promise<void> {
    if (this.isolated && this.used) await this.reset()
  }
}
