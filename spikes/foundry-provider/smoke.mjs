// Cross-platform smoke test (Windows/macOS/Linux). Tries each model on each Foundry route
// and prints the HTTP status, so we can see what works where.
//
// Usage:  npm run smoke        (reads the .env at the repo root)
//
// Needs in the root .env: FOUNDRY_KEY and either FOUNDRY_RESOURCE (just the name, e.g. aif-flwn-fc-01)
// or FOUNDRY_ENDPOINT (any of your hosts; the resource name is taken from it).

const key = process.env.FOUNDRY_KEY
let resource = process.env.FOUNDRY_RESOURCE?.trim()
if (!resource && process.env.FOUNDRY_ENDPOINT) {
  resource = new URL(process.env.FOUNDRY_ENDPOINT).hostname.split('.')[0]
}
if (!key || !resource) {
  console.error('Missing FOUNDRY_KEY and/or FOUNDRY_RESOURCE (or FOUNDRY_ENDPOINT) in .env')
  process.exit(1)
}

const models = (process.env.FOUNDRY_MODELS ?? 'MAI-Thinking-1,gpt-6-sol,gpt-6-luna')
  .split(/[,\s]+/)
  .filter(Boolean)

// B is a guess (not listed on the docs page); a 404 there is fine.
const routes = [
  ['A-openai-v1', `https://${resource}.openai.azure.com/openai/v1/chat/completions`],
  ['B-services-v1', `https://${resource}.services.ai.azure.com/openai/v1/chat/completions`],
  [
    'C-legacy-models',
    `https://${resource}.services.ai.azure.com/models/chat/completions?api-version=2024-05-01-preview`,
  ],
]

async function call(url, model, tokenParam) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
        [tokenParam]: 200,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    return { status: res.status, body: await res.text() }
  } catch (e) {
    return { status: 'ERR', body: String(e?.cause?.code ?? e?.message ?? e) }
  }
}

const rows = []
for (const model of models) {
  for (const [label, url] of routes) {
    let r = await call(url, model, 'max_tokens')
    let note = ''
    if (r.status === 400 && /max_completion_tokens|unsupported_parameter/.test(r.body)) {
      r = await call(url, model, 'max_completion_tokens')
      note = '(needs max_completion_tokens) '
    }
    if (r.status !== 200) note += r.body.replace(/\s+/g, ' ').slice(0, 160)
    rows.push({ model, route: label, status: r.status, note: note.trim() })
    console.log(`${model}  ${label}  ${r.status}  ${note.trim()}`)
  }
}

console.log('\n=== summary ===')
console.table(rows.map(({ model, route, status }) => ({ model, route, status })))
