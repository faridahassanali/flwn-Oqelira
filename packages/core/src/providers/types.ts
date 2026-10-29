/**
 * Our own model-facing types. The agent loop depends ONLY on these; nothing outside
 * `providers/` may import `ai` or `@ai-sdk/*` (see AGENTS.md).
 */
export type JsonSchema = Record<string, unknown>

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema for the tool input (type: 'object'). */
  parameters: JsonSchema
}

export interface ToolCall {
  id: string
  name: string
  input: unknown
}

export interface ToolResult {
  id: string
  name: string
  output: string
  isError?: boolean
}

export type Message =
  | { role: 'user'; content: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] }

export type FinishReason = 'stop' | 'tool-calls' | 'length' | 'error' | 'other'

export type ModelEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; call: ToolCall }
  | {
      type: 'finish'
      reason: FinishReason
      usage?: { inputTokens?: number; outputTokens?: number }
    }

export interface ModelRequest {
  system?: string
  messages: Message[]
  tools?: ToolSpec[]
  maxOutputTokens?: number
  signal?: AbortSignal
}

/** One model, one streaming call = ONE step (the model may answer with tool calls). */
export interface ModelProvider {
  readonly id: string
  stream(req: ModelRequest): AsyncIterable<ModelEvent>
}

/** Turns text into vectors. Like ModelProvider, the rest of the code never sees the SDK behind it. */
export interface EmbeddingProvider {
  readonly id: string
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]>
}
