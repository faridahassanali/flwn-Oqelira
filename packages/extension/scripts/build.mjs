import { build } from 'esbuild'
import fs from 'node:fs'

// esbuild bundles code only; inline the system prompt text so the single dist/extension.cjs is self-contained.
const promptFile = new URL('../../core/src/agent/system-prompt.txt', import.meta.url)
const prompt = fs.readFileSync(promptFile, 'utf8')
if (!prompt.trim()) throw new Error('system-prompt.txt is empty')
await build({
  entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20', format: 'cjs',
  external: ['vscode'], outfile: 'dist/extension.cjs',
  define: { __OQELIRA_SYSTEM_PROMPT__: JSON.stringify(prompt) },
})
