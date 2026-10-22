/**
 * Foundry + Vercel AI SDK spike.
 *
 * Answers one question: do the models we have on Azure AI Foundry work
 * as a coding agent through @ai-sdk/openai-compatible?
 *
 * Run it:  npm run spike
 */
import { generateText, streamText, tool, stepCountIs } from 'ai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import type { LanguageModel } from 'ai'
import { z } from 'zod'

const ENDPOINT = process.env.FOUNDRY_ENDPOINT?.replace(/\/+$/, '')
const KEY = process.env.FOUNDRY_KEY
const MODELS = (process.env.FOUNDRY_MODELS ?? 'MAI-Thinking-1,gpt-6-sol,gpt-6-luna')
  .split(',')
  .map((m) => m.trim())
  .filter(Boolean)

if (!ENDPOINT || !KEY) {
  console.error('FOUNDRY_ENDPOINT and FOUNDRY_KEY are required (see .env.example)')
  process.exit(1)
}

// ---------------------------------------------------------------------------
// fetch wrapper: the same fallback we have in flwn-ai/foundry/client.py.
// Some models accept max_tokens, others reject it and require max_completion_tokens.
// We try max_tokens first; on unsupported_parameter we retry with the other name
// and record that it happened, because that is itself an important result of the spike.
// ---------------------------------------------------------------------------
let currentModel = ''
const tokenParamFallback = new Set<string>()

const foundryFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init)
  if (res.status !== 400 || typeof init?.body !== 'string') return res

  const text = await res.clone().text()
  if (text.includes('unsupported_parameter') && text.includes('max_tokens')) {
    const body = JSON.parse(init.body)
    if (body.max_tokens !== undefined) {
      body.max_completion_tokens = body.max_tokens
      delete body.max_tokens
      tokenParamFallback.add(currentModel)
      return fetch(input, { ...init, body: JSON.stringify(body) })
    }
  }
  return res
}

// The new official route: OpenAI v1-compatible.
// Endpoint: https://<resource>.openai.azure.com  then  /openai/v1
// (The old Azure AI Inference /models route is deprecated and its SDK was retired on Aug 26, 2026.)
// Model names here are the deployment names in Foundry.
// To try a different route, set a full FOUNDRY_BASE_URL in .env (without /chat/completions).
const BASE_URL = process.env.FOUNDRY_BASE_URL?.replace(/\/+$/, '') ?? `${ENDPOINT}/openai/v1`
console.log(`baseURL: ${BASE_URL}`)

const foundry = createOpenAICompatible({
  name: 'foundry',
  baseURL: BASE_URL,
  headers: { 'api-key': KEY },
  fetch: foundryFetch,
})

// ---------------------------------------------------------------------------
// Variants: different ways to call the same model.
//   chat       : plain /chat/completions
//   chat-none  : /chat/completions with reasoning_effort = none
//                (the error seen with gpt-6-* says function tools are not supported together
//                 with reasoning_effort on chat/completions; suggested fix: none, or use /responses)
//   responses  : /responses (keeps reasoning and supports tools)
// ---------------------------------------------------------------------------
type Variant = {
  name: string
  model: (m: string) => LanguageModel
  providerOptions?: Record<string, Record<string, string>>
}

const openaiClient = createOpenAI({
  baseURL: BASE_URL,
  apiKey: KEY,
  headers: { 'api-key': KEY },
  fetch: foundryFetch,
})

const VARIANTS: Record<string, Variant> = {
  chat: { name: 'chat', model: (m) => foundry.chatModel(m) },
  'chat-none': {
    name: 'chat-none',
    model: (m) => foundry.chatModel(m),
    providerOptions: { foundry: { reasoningEffort: 'none' } },
  },
  // cast: @ai-sdk/openai ships its own nested copy of @ai-sdk/provider (minor version drift),
  // so TypeScript sees two "different" LanguageModelV4 types. Same shape at runtime.
  responses: { name: 'responses', model: (m) => openaiClient.responses(m) as unknown as LanguageModel },
}
const VARIANT_NAMES = (process.env.FOUNDRY_VARIANTS ?? 'chat')
  .split(',')
  .map((v) => v.trim())
  .filter((v) => v in VARIANTS)

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
type Outcome = { ok: boolean; detail: string }
type Test = { name: string; run: (v: Variant, model: string) => Promise<Outcome> }

const SPECIAL_TOKENS = ['<|START_TEXT|>', '<|END_TEXT|>']
const hasSpecialTokens = (s: string) => SPECIAL_TOKENS.some((t) => s.includes(t))

const addTool = tool({
  description: 'Add two integers and return the sum.',
  inputSchema: z.object({ a: z.number(), b: z.number() }),
  execute: async ({ a, b }) => ({ sum: a + b }),
})

const FILES: Record<string, string> = {
  'a.txt': 'The next file is b.txt',
  'b.txt': 'The next file is c.txt',
  'c.txt': 'The next file is d.txt',
  'd.txt': 'The secret word is PINEAPPLE',
}
const readFileTool = tool({
  description: 'Read a text file by path and return its content.',
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => ({ content: FILES[path] ?? `ENOENT: ${path}` }),
})

const tests: Test[] = [
  {
    name: '1. plain text streaming',
    async run(v, model) {
      const started = Date.now()
      let firstChunkMs = -1
      let chunks = 0
      let streamError: unknown

      const result = streamText({
        model: v.model(model),
        providerOptions: v.providerOptions,
        prompt: 'In two short sentences, explain what a git rebase does.',
        maxOutputTokens: 600,
        onError: ({ error }) => {
          streamError = error
        },
      })
      for await (const _ of result.textStream) {
        if (chunks === 0) firstChunkMs = Date.now() - started
        chunks++
      }
      if (streamError) throw streamError
      const text = await result.text
      if (!text.trim()) return { ok: false, detail: 'empty reply' }
      if (hasSpecialTokens(text)) return { ok: false, detail: 'special tokens found in the reply' }
      return {
        ok: chunks > 1,
        detail: `${chunks} chunks, first chunk after ${firstChunkMs}ms${chunks <= 1 ? ' (no real streaming)' : ''}`,
      }
    },
  },
  {
    name: '2. single tool call + final answer',
    async run(v, model) {
      const result = await generateText({
        model: v.model(model),
        providerOptions: v.providerOptions,
        tools: { add: addTool },
        stopWhen: stepCountIs(4),
        maxOutputTokens: 800,
        prompt: 'What is 1234 + 5678? You must use the add tool, then state the result.',
      })
      const calls = result.steps.flatMap((s) => s.toolCalls)
      if (calls.length === 0) return { ok: false, detail: 'the model did not call the tool' }
      if (!result.text.replace(/[,\s]/g, '').includes('6912'))
        return { ok: false, detail: `final answer wrong or empty: "${result.text.slice(0, 80)}"` }
      return { ok: true, detail: `${calls.length} tool call(s), ${result.steps.length} steps` }
    },
  },
  {
    name: '3. multi-step loop (4 consecutive tool calls)',
    async run(v, model) {
      const result = await generateText({
        model: v.model(model),
        providerOptions: v.providerOptions,
        tools: { read_file: readFileTool },
        stopWhen: stepCountIs(10),
        maxOutputTokens: 1500,
        prompt:
          'Start by reading a.txt. Each file tells you the next file to read. ' +
          'Keep following the chain until you find the secret word. Reply with only that word.',
      })
      const calls = result.steps.flatMap((s) => s.toolCalls)
      const found = /pineapple/i.test(result.text)
      return {
        ok: found && calls.length >= 4,
        detail: `${calls.length} tool calls, finish=${result.finishReason}, reply="${result.text.slice(0, 40)}"`,
      }
    },
  },
  {
    name: '4. non-empty reply under heavy reasoning',
    async run(v, model) {
      const result = await generateText({
        model: v.model(model),
        providerOptions: v.providerOptions,
        maxOutputTokens: 4000,
        prompt:
          'A function takes a sorted array and returns the index of the first element >= target ' +
          'using binary search. Write it in TypeScript and list the three most common off-by-one bugs.',
      })
      if (!result.text.trim())
        return {
          ok: false,
          detail: `empty reply, finish=${result.finishReason}, usage=${JSON.stringify(result.usage)}`,
        }
      if (hasSpecialTokens(result.text)) return { ok: false, detail: 'special tokens found' }
      return { ok: true, detail: `${result.text.length} chars, finish=${result.finishReason}` }
    },
  },
]

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
function describeError(e: unknown): string {
  const err = e as { message?: string; statusCode?: number; responseBody?: string }
  const body = err.responseBody ? ` | body: ${err.responseBody.slice(0, 300)}` : ''
  const status = err.statusCode ? `[${err.statusCode}] ` : ''
  return `${status}${err.message ?? String(e)}${body}`
}

const rows: { model: string; test: string; result: string; ms: number; detail: string }[] = []

for (const model of MODELS) for (const vname of VARIANT_NAMES) {
  const v = VARIANTS[vname]
  currentModel = model
  console.log(`\n=== ${model}  [${vname}] ===`)
  {
  for (const t of tests) {
    const started = Date.now()
    let outcome: Outcome
    try {
      outcome = await t.run(v, model)
    } catch (e) {
      outcome = { ok: false, detail: describeError(e) }
    }
    const ms = Date.now() - started
    console.log(`${outcome.ok ? 'PASS' : 'FAIL'}  ${t.name}  (${ms}ms)\n      ${outcome.detail}`)
    rows.push({ model: `${model} [${vname}]`, test: t.name, result: outcome.ok ? 'PASS' : 'FAIL', ms, detail: outcome.detail })
  }
  }
}

console.log('\n=== Summary ===')
console.table(rows.map(({ model, test, result, ms }) => ({ model, test, result, ms })))

if (tokenParamFallback.size) {
  console.log(
    `\nNote: these models rejected max_tokens and were retried with max_completion_tokens: ${[...tokenParamFallback].join(', ')}`,
  )
}

process.exit(rows.some((r) => r.result === 'FAIL') ? 1 : 0)
