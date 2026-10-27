import { checkPermission, READ_ONLY } from '../permissions.js'
import type { Permissions } from '../permissions.js'
import type { FinishReason, Message, ModelProvider, ToolCall, ToolResult } from '../providers/types.js'
import type { Tool } from '../tools/types.js'
import { truncate } from '../tools/types.js'
import { DEFAULT_SYSTEM } from './prompt.js'

export interface AgentOptions {
  provider: ModelProvider
  prompt: string
  tools: Tool[]
  /** Workspace root for tools. */
  cwd: string
  permissions?: Permissions
  system?: string
  /** Earlier turns, for multi-turn sessions. */
  history?: Message[]
  maxSteps?: number
  maxOutputTokens?: number
  signal?: AbortSignal
  onText?: (delta: string) => void
  onToolCall?: (call: ToolCall) => void
  onToolResult?: (result: ToolResult) => void
  /** Persist complete/partial turns without coupling core to a database. */
  onCheckpoint?: (messages: Message[]) => Promise<void>
}

export interface AgentResult {
  messages: Message[]
  steps: number
  text: string
  finishReason: FinishReason | 'max-steps'
}

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const messages: Message[] = [...(opts.history ?? []), { role: 'user', content: opts.prompt }]
  const toolMap = new Map(opts.tools.map((t) => [t.spec.name, t]))
  const specs = opts.tools.map((t) => t.spec)
  const permissions = opts.permissions ?? READ_ONLY
  const maxSteps = opts.maxSteps ?? 25
  let steps = 0
  await opts.onCheckpoint?.(messages)

  while (steps < maxSteps) {
    opts.signal?.throwIfAborted()
    steps++
    let text = ''
    const calls: ToolCall[] = []
    let reason: FinishReason = 'other'

    for await (const ev of opts.provider.stream({
      system: opts.system ?? DEFAULT_SYSTEM,
      messages,
      tools: specs,
      maxOutputTokens: opts.maxOutputTokens,
      signal: opts.signal,
    })) {
      if (ev.type === 'text-delta') {
        text += ev.text
        opts.onText?.(ev.text)
      } else if (ev.type === 'tool-call') {
        calls.push(ev.call)
        opts.onToolCall?.(ev.call)
      } else {
        reason = ev.reason
      }
    }

    messages.push({ role: 'assistant', text, toolCalls: calls })
    await opts.onCheckpoint?.(messages)
    if ((reason === 'length' || reason === 'error') && calls.length) {
      const skipped = calls.map(call => ({ id: call.id, name: call.name, output: `Not executed: ${reason === 'length' ? 'model output limit reached' : 'model generation failed'}. Inspect the workspace before trying again.`, isError: true }))
      messages.push({ role: 'tool', results: skipped })
      for (const result of skipped) opts.onToolResult?.(result)
      await opts.onCheckpoint?.(messages)
    }
    if (reason === 'error') throw new Error('Model generation failed')
    if (calls.length === 0 || reason === 'length') return { messages, steps, text, finishReason: reason }

    const results: ToolResult[] = []
    messages.push({ role: 'tool', results })
    for (const call of calls) {
      const result = await executeTool(call, toolMap, permissions, opts)
      opts.onToolResult?.(result)
      results.push(result)
      await opts.onCheckpoint?.(messages)
    }
  }

  const last = [...messages].reverse().find((m) => m.role === 'assistant')
  return { messages, steps, text: last?.role === 'assistant' ? last.text : '', finishReason: 'max-steps' }
}

async function executeTool(
  call: ToolCall,
  tools: Map<string, Tool>,
  permissions: Permissions,
  opts: AgentOptions,
): Promise<ToolResult> {
  const fail = (output: string): ToolResult => ({ id: call.id, name: call.name, output, isError: true })
  const tool = tools.get(call.name)
  if (!tool) return fail(`unknown tool "${call.name}"`)
  try {
    const verdict = await checkPermission(permissions, {
      tool: call.name,
      risk: tool.risk,
      summary: tool.describe(call.input),
      input: call.input,
    })
    if (!verdict.allowed) return fail(`not allowed: ${verdict.reason ?? 'denied'}`)
    opts.signal?.throwIfAborted()
    const output = await tool.run(call.input, { cwd: opts.cwd, signal: opts.signal })
    return { id: call.id, name: call.name, output: truncate(output) }
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e))
  }
}
