/**
 * Model registry. Results of the Foundry spike (2026-10-22, see docs/spike-results.md):
 *  - MAI-Thinking-1 works with tools only on /chat/completions (/responses is unsupported). Slow (~8s to first token).
 *  - gpt-6-sol / gpt-6-luna fail tools on /chat/completions with default reasoning; they work on
 *    /responses (reasoning + tools) or on chat with reasoning_effort = 'none'. Fast (~1-2s).
 * `id` is our stable name; `deployment` is the Foundry deployment name.
 */
export type ApiMode = 'chat' | 'responses'

export interface ModelConfig {
  id: string
  deployment: string
  api: ApiMode
  /** Sent as reasoning_effort when set (e.g. 'none' on chat for gpt-6-*). */
  reasoningEffort?: string
  /** Rough guide for role assignment; not enforced. */
  speed: 'fast' | 'slow'
}

export const DEFAULT_MODELS: readonly ModelConfig[] = [
  { id: 'gpt-6-sol', deployment: 'gpt-6-sol', api: 'responses', speed: 'fast' },
  { id: 'gpt-6-luna', deployment: 'gpt-6-luna', api: 'responses', speed: 'fast' },
  { id: 'mai-thinking', deployment: 'MAI-Thinking-1', api: 'chat', speed: 'slow' },
]

export function findModel(id: string, models: readonly ModelConfig[] = DEFAULT_MODELS): ModelConfig {
  const found = models.find((m) => m.id === id)
  if (!found) throw new Error(`Unknown model "${id}". Known: ${models.map((m) => m.id).join(', ')}`)
  return found
}
