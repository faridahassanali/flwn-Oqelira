import { optNum, str, truncate } from './types.js'
import type { Tool } from './types.js'

interface TavilyResult { title?: string; url?: string; content?: string }

export const webSearch: Tool = {
  spec: {
    name: 'web_search',
    description: 'Search the web (Tavily) for current docs, library versions, error messages or news. Returns a short answer and ranked sources. Do not put secrets or private code in the query.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, max_results: { type: 'integer', minimum: 1, maximum: 10, description: 'Default 5.' } }, required: ['query'] },
  },
  // The query leaves the machine, so it always asks; --yes (writes only) does not cover it.
  risk: 'exec',
  describe: (i) => `web search: ${str(i, 'query')}`,
  async run(input, ctx) {
    const query = str(input, 'query').trim()
    if (!query || query.length > 400) throw new Error('"query" must be 1-400 characters')
    const max = optNum(input, 'max_results') ?? 5
    if (!Number.isInteger(max) || max < 1 || max > 10) throw new Error('"max_results" must be an integer from 1 to 10')
    const key = process.env.TAVILY_API_KEY
    if (!key) throw new Error('TAVILY_API_KEY is not set')
    // Override is read from the real environment only (env.ts never loads it from .env files),
    // so a cloned project cannot redirect the API key.
    const base = process.env.TAVILY_BASE_URL ?? 'https://api.tavily.com'
    const res = await fetch(`${base}/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: max, include_answer: true }),
      signal: AbortSignal.any([...(ctx.signal ? [ctx.signal] : []), AbortSignal.timeout(20_000)]),
    })
    // Status only: the body could echo the request, and the key must never reach the model.
    if (!res.ok) throw new Error(`Tavily search failed (HTTP ${res.status})`)
    const data = (await res.json()) as { answer?: string; results?: TavilyResult[] }
    const lines = (data.results ?? []).slice(0, max).map((r, i) => `${i + 1}. ${r.title ?? ''}\n   ${r.url ?? ''}\n   ${(r.content ?? '').slice(0, 500)}`)
    return truncate([data.answer ? `Answer: ${data.answer}` : '', ...lines].filter(Boolean).join('\n\n') || 'No results.')
  },
}

/** Local-only tools: they need network, so they are never routed into the no-network sandbox. */
export function webTools(): Tool[] {
  return process.env.TAVILY_API_KEY ? [webSearch] : []
}
