import { embedMany, jsonSchema, streamText, tool } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { ModelConfig } from './registry.js'
import type { EmbeddingProvider, FinishReason, Message, ModelEvent, ModelProvider, ModelRequest, ToolSpec } from './types.js'

export interface FoundryOptions {
  /** e.g. https://<resource>.openai.azure.com/openai/v1 */
  baseURL: string
  apiKey: string
  fetch?: typeof fetch
  /** Called when a deployment rejected max_tokens and we retried with max_completion_tokens. */
  onTokenParamFallback?: (deployment: string) => void
}

export function foundryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): { baseURL: string; apiKey: string } {
  const apiKey = env.FOUNDRY_KEY?.trim()
  const base =
    env.FOUNDRY_BASE_URL?.trim() ||
    (env.FOUNDRY_ENDPOINT ? `${env.FOUNDRY_ENDPOINT.trim().replace(/\/+$/, '')}/openai/v1` : '')
  if (!apiKey || !base) throw new Error('FOUNDRY_KEY and FOUNDRY_ENDPOINT (or FOUNDRY_BASE_URL) are required')
  return { baseURL: base.replace(/\/+$/, ''), apiKey }
}

/**
 * Builds providers for Foundry deployments. All Foundry quirks live in this file:
 * the max_tokens / max_completion_tokens fallback, per-model API mode, reasoning effort,
 * and `store: false` on /responses so team code is not retained server-side.
 */
export function createFoundry(opts: FoundryOptions): (model: ModelConfig) => ModelProvider {
  const baseFetch = opts.fetch ?? fetch

  // Some deployments accept max_tokens, others require max_completion_tokens.
  // Try max_tokens, and on `unsupported_parameter` retry once with the other name.
  const quirkFetch: typeof fetch = async (input, init) => {
    const res = await baseFetch(input, init)
    if (res.status !== 400 || typeof init?.body !== 'string') return res
    const text = await res.clone().text()
    if (!(text.includes('unsupported_parameter') && text.includes('max_tokens'))) return res
    const body = JSON.parse(init.body)
    if (body.max_tokens === undefined) return res
    body.max_completion_tokens = body.max_tokens
    delete body.max_tokens
    opts.onTokenParamFallback?.(String(body.model))
    return baseFetch(input, { ...init, body: JSON.stringify(body) })
  }

  const chatClient = createOpenAICompatible({
    name: 'foundry',
    baseURL: opts.baseURL,
    headers: { 'api-key': opts.apiKey },
    fetch: quirkFetch,
  })
  const openaiClient = createOpenAI({
    baseURL: opts.baseURL,
    apiKey: opts.apiKey,
    headers: { 'api-key': opts.apiKey },
    fetch: quirkFetch,
  })

  return (model) => {
    // cast: @ai-sdk/openai ships a nested copy of @ai-sdk/provider (minor version drift),
    // so TypeScript sees two "different" LanguageModelV4 types. Same shape at runtime.
    const languageModel: LanguageModel =
      model.api === 'responses'
        ? (openaiClient.responses(model.deployment) as unknown as LanguageModel)
        : chatClient.chatModel(model.deployment)

    const providerOptions: Record<string, Record<string, string | boolean>> | undefined =
      model.api === 'responses'
        ? { openai: { store: false, ...(model.reasoningEffort ? { reasoningEffort: model.reasoningEffort } : {}) } }
        : model.reasoningEffort
          ? { foundry: { reasoningEffort: model.reasoningEffort } }
          : undefined

    return {
      id: model.id,
      async *stream(req: ModelRequest): AsyncGenerator<ModelEvent> {
        const result = streamText({
          model: languageModel,
          system: req.system,
          messages: toModelMessages(req.messages),
          tools: toSdkTools(req.tools),
          maxOutputTokens: req.maxOutputTokens,
          abortSignal: req.signal,
          providerOptions,
          // Errors are rethrown from the 'error' part below; stop the SDK from also dumping them to the console.
          onError: () => {},
          // No `execute` on the tools, so the SDK stops after one step and WE run the tools
          // (that is what lets us ask the developer for permission first).
        })
        for await (const part of result.fullStream) {
          switch (part.type) {
            case 'text-delta':
              yield { type: 'text-delta', text: part.text }
              break
            case 'tool-call':
              yield { type: 'tool-call', call: { id: part.toolCallId, name: part.toolName, input: part.input } }
              break
            case 'error':
              throw part.error instanceof Error ? part.error : new Error(String(part.error))
            case 'finish':
              yield {
                type: 'finish',
                reason: mapFinish(part.finishReason),
                usage: { inputTokens: part.totalUsage?.inputTokens, outputTokens: part.totalUsage?.outputTokens },
              }
              break
            default:
              break
          }
        }
      },
    }
  }
}

function mapFinish(reason: string): FinishReason {
  switch (reason) {
    case 'stop':
    case 'length':
    case 'error':
      return reason
    case 'tool-calls':
      return 'tool-calls'
    default:
      return 'other'
  }
}

function toSdkTools(specs: ToolSpec[] | undefined) {
  if (!specs?.length) return undefined
  return Object.fromEntries(
    specs.map((s) => [s.name, tool({ description: s.description, inputSchema: jsonSchema(s.parameters as never) })]),
  )
}

function toModelMessages(messages: Message[]): ModelMessage[] {
  return messages.map((m): ModelMessage => {
    switch (m.role) {
      case 'user':
        return { role: 'user', content: m.content }
      case 'assistant':
        return {
          role: 'assistant',
          content: [
            ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
            ...m.toolCalls.map((c) => ({
              type: 'tool-call' as const,
              toolCallId: c.id,
              toolName: c.name,
              input: c.input,
            })),
          ],
        }
      case 'tool':
        return {
          role: 'tool',
          content: m.results.map((r) => ({
            type: 'tool-result' as const,
            toolCallId: r.id,
            toolName: r.name,
            output: { type: r.isError ? ('error-text' as const) : ('text' as const), value: r.output },
          })),
        }
    }
  })
}

/** Embedding deployments on the same Foundry resource. The deployment name always comes from config. */
export function createFoundryEmbedder(opts: Pick<FoundryOptions, 'baseURL' | 'apiKey' | 'fetch'>): (deployment: string) => EmbeddingProvider {
  const client = createOpenAICompatible({ name: 'foundry', baseURL: opts.baseURL, headers: { 'api-key': opts.apiKey }, fetch: opts.fetch })
  return (deployment) => ({
    id: deployment,
    async embed(texts, signal) {
      const { embeddings } = await embedMany({ model: client.embeddingModel(deployment), values: texts, abortSignal: signal })
      return embeddings
    },
  })
}
