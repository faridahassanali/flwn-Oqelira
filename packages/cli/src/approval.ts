import type { ApprovalRequest } from '@oqelira/core'
import { green, red, yellow } from './ui.js'

const MAX_LINES = 12

function block(prefix: string, text: string, paint: (s: string) => string): string[] {
  const lines = text.split('\n')
  const shown = lines.slice(0, MAX_LINES).map((l) => paint(`${prefix} ${l}`))
  if (lines.length > MAX_LINES) shown.push(paint(`${prefix} ...(${lines.length - MAX_LINES} more lines)`))
  return shown
}

/** What the developer sees before approving a write or a command. */
export function renderApproval(req: ApprovalRequest): string {
  const input = (req.input ?? {}) as Record<string, unknown>
  const out = [yellow(`\n? ${req.summary}`)]
  if (req.tool === 'edit_file') {
    out.push(...block('-', String(input.old_string ?? ''), red), ...block('+', String(input.new_string ?? ''), green))
  } else if (req.tool === 'write_file') {
    out.push(...block('+', String(input.content ?? ''), green))
  }
  return out.join('\n')
}
