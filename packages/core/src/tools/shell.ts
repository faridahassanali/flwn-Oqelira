import { spawn } from 'node:child_process'
import { optNum, str, truncate } from './types.js'
import type { Tool } from './types.js'

/** Never hand our own credentials to commands the model runs. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) {
    if (/^FOUNDRY_|KEY|TOKEN|SECRET|PASSWORD/i.test(k)) continue
    out[k] = v
  }
  return out
}

export const runCommand: Tool = {
  spec: {
    name: 'run_command',
    description:
      'Run a shell command in the workspace root and return its combined stdout/stderr and exit code. Use for tests, builds, git, etc.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        timeout_seconds: { type: 'integer', description: 'Default 60.' },
      },
      required: ['command'],
    },
  },
  risk: 'exec',
  describe: (i) => `run: ${str(i, 'command')}`,
  run(input, ctx) {
    const command = str(input, 'command')
    const timeoutMs = (optNum(input, 'timeout_seconds') ?? 60) * 1000
    return new Promise((resolve, reject) => {
      const child = spawn(command, { cwd: ctx.cwd, shell: true, env: scrubEnv(process.env), signal: ctx.signal })
      let out = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill()
      }, timeoutMs)
      child.stdout?.on('data', (d) => (out += d))
      child.stderr?.on('data', (d) => (out += d))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        const status = timedOut ? `timed out after ${timeoutMs / 1000}s` : `exit code ${code}`
        resolve(`${truncate(out)}\n[${status}]`)
      })
    })
  },
}
