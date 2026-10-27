import type { Risk } from '../permissions.js'
import type { ToolSpec } from '../providers/types.js'

export interface ToolContext {
  /** Workspace root. Tools must never touch anything outside it. */
  cwd: string
  signal?: AbortSignal
}

export interface Tool {
  spec: ToolSpec
  risk: Risk
  /** One-liner shown in the approval prompt. */
  describe(input: unknown): string
  run(input: unknown, ctx: ToolContext): Promise<string>
}

export const MAX_OUTPUT_CHARS = 30_000

export function truncate(text: string, max = MAX_OUTPUT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]`
}

export function str(input: unknown, key: string): string {
  const v = (input as Record<string, unknown> | null)?.[key]
  if (typeof v !== 'string') throw new Error(`"${key}" must be a string`)
  return v
}

export function optNum(input: unknown, key: string): number | undefined {
  const v = (input as Record<string, unknown> | null)?.[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`"${key}" must be a number`)
  return v
}
