import { loadEnvFiles } from '../src/config/env.js'
import { createFoundry, foundryConfigFromEnv } from '../src/providers/foundry.js'
import { modelsFromEnv, findModel } from '../src/providers/registry.js'

loadEnvFiles({ cwd: process.cwd() })
try {
  const models = modelsFromEnv()
  const model = process.env.OQELIRA_MODEL ? findModel(process.env.OQELIRA_MODEL, models) : models[0]!
  const provider = createFoundry(foundryConfigFromEnv())(model)
  let text = '', finished = false
  for await (const event of provider.stream({ messages: [{ role: 'user', content: 'Connection test. Reply with exactly OK. Do not use tools.' }], maxOutputTokens: 256, signal: AbortSignal.timeout(60000) })) {
    if (event.type === 'text-delta') text += event.text
    if (event.type === 'finish' && event.reason === 'stop') finished = true
  }
  if (!text.trim() || !finished) throw new Error('No completed text response')
  // Do not print upstream headers, endpoint addresses, keys, or response bodies.
  console.log(`PASS: Foundry deployment ${model.id} streamed a completed response through the Vercel AI SDK provider.`)
} catch {
  console.error('FAIL: Foundry connection check did not complete. Check endpoint, deployment, key and network access locally.')
  process.exitCode = 1
}
