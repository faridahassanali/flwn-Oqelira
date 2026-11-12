// Only used with trusted scripted providers in unit tests. Live evaluation never imports this module.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { builtinTools } from '../../src/tools/index.js'
import { scrubEnv } from '../../src/tools/shell.js'
import type { EvalWorkspace } from '../../eval/prompt/runner-workspace.js'

export function localWorkspace(): EvalWorkspace {
  const root = fs.mkdtemp(path.join(os.tmpdir(), 'prompt-eval-unit-'))
  return {
    async initialize() {},
    async reset(files = {}) {
      const dir = await root
      for (const name of await fs.readdir(dir)) await fs.rm(path.join(dir, name), { recursive: true, force: true })
      for (const [file, content] of Object.entries(files)) await this.writeText(file, content)
    },
    tools: builtinTools.map(tool => ({ ...tool, run: async (input, ctx) => tool.run(input, { ...ctx, cwd: await root }) })),
    async writeText(file, content) { const target = path.join(await root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content) },
    async readText(file) { return fs.readFile(path.join(await root, file), 'utf8').catch(() => null) },
    async exists(file) { return fs.access(path.join(await root, file)).then(() => true, () => false) },
    async listing(file) { return fs.readdir(path.join(await root, file)).catch(() => []) },
    async testPasses(file) {
      const env = scrubEnv(process.env); delete env.NODE_TEST_CONTEXT
      return spawnSync(process.execPath, ['--test', file], { cwd: await root, env, timeout: 60_000, windowsHide: true }).status === 0
    },
    async dispose() { await fs.rm(await root, { recursive: true, force: true }) },
  }
}
