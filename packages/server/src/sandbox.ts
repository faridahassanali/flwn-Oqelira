import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { builtinTools } from '@oqelira/core'
import type { Tool } from '@oqelira/core'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
export interface Sandbox { tools(project: string): Tool[] }
const MIB = (v: string, name: string) => {
  const m = /^([1-9]\d{0,5})([mg])$/.exec(v.trim().toLowerCase())
  if (!m) throw new Error(`${name} must look like 512m or 1g, got "${v}"`)
  return Number(m[1]) * (m[2] === 'g' ? 1024 : 1)
}
// Runner-only limits, read from the runner's own environment; no request field can reach them.
export function runnerLimits(env: Record<string, string | undefined> = process.env) {
  const memory = (env.OQELIRA_WORKER_MEMORY ?? '1g').trim().toLowerCase()
  const memoryMiB = MIB(memory, 'OQELIRA_WORKER_MEMORY')
  const rawJobs = env.OQELIRA_RUNNER_MAX_JOBS ?? '3'
  if (!/^\d{1,3}$/.test(rawJobs.trim()) || Number(rawJobs) < 1) throw new Error(`OQELIRA_RUNNER_MAX_JOBS must be a positive integer, got "${rawJobs}"`)
  const maxJobs = Number(rawJobs)
  const budgetMiB = MIB(env.OQELIRA_RUNNER_MEMORY_BUDGET ?? '3g', 'OQELIRA_RUNNER_MEMORY_BUDGET')
  if (memoryMiB < 256) throw new Error('OQELIRA_WORKER_MEMORY must be at least 256m')
  if (memoryMiB * maxJobs > budgetMiB) throw new Error(`Worker memory ${memory} x ${maxJobs} jobs exceeds the runner memory budget of ${budgetMiB} MiB (OQELIRA_RUNNER_MEMORY_BUDGET)`)
  return { memory, maxJobs }
}
export function dockerArgs(project: string, container: string, image: string, runtime?: string, memory = '1g') {
  if (!UUID.test(project) || !UUID.test(container)) throw new Error('Invalid sandbox identity')
  if (!image || image.startsWith('-')) throw new Error('Invalid sandbox image')
  return ['run', '--rm', '-i', ...(runtime ? ['--runtime', runtime] : []), '--name', `oq-run-${container}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', memory, '--cpus', '1', '--user', '1000:1000', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m', '--mount', `type=volume,source=oq-project-${project},target=/workspace`, '--workdir', '/workspace', image]
}
export class DockerSandbox implements Sandbox {
  constructor(private readonly image = 'oqelira-worker:local', private readonly runtime?: string, private readonly memory = '1g') {}
  tools(project: string): Tool[] {
    return builtinTools.map(tool => ({ ...tool, run: async (input, ctx) => {
      ctx.signal?.throwIfAborted()
      const container = randomUUID()
      return new Promise<string>((resolve, reject) => {
        const child = spawn('docker', dockerArgs(project, container, this.image, this.runtime, this.memory), { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        let output = '', error = '', settled = false
        const cleanup = () => { clearTimeout(timer); ctx.signal?.removeEventListener('abort', abort) }
        const stop = () => {
          // Killing the docker client alone does not kill its container.
          const killer = spawn('docker', ['rm', '-f', `oq-run-${container}`], { windowsHide: true, stdio: 'ignore' })
          killer.on('error', () => {}); killer.unref(); child.kill()
        }
        const abort = () => { if (!settled) { settled = true; stop(); cleanup(); reject(new Error('Sandbox run stopped')) } }
        const timer = setTimeout(abort, 90_000)
        ctx.signal?.addEventListener('abort', abort, { once: true })
        if (ctx.signal?.aborted) { abort(); return }
        child.stdout.on('data', (data: Buffer) => { output += data.toString(); if (output.length > 200_000) abort() })
        child.stderr.on('data', (data: Buffer) => { error += data.toString(); if (error.length > 20_000) abort() })
        child.on('error', () => { if (!settled) { settled = true; cleanup(); reject(new Error('Sandbox service unavailable')) } })
        child.on('close', code => {
          if (settled) return
          settled = true; cleanup()
          if (code !== 0) { reject(new Error('Isolated tool failed; inspect the input and retry only after review')); return }
          try {
            const result = JSON.parse(output) as { output?: string; error?: string }
            if (result.error) reject(new Error(result.error))
            else if (typeof result.output === 'string') resolve(result.output)
            else reject(new Error('Invalid sandbox response'))
          } catch { reject(new Error('Invalid sandbox response')) }
        })
        child.stdin.on('error', () => {})
        child.stdin.end(JSON.stringify({ name: tool.spec.name, input }))
      })
    } }))
  }
}
