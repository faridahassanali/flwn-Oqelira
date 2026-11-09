import type { ApprovalRequest } from '@oqelira/core'
import { cyan, dim, green, red, yellow } from './ui.js'

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
  const tone = req.risk === 'network' ? cyan : req.risk === 'read' ? dim : yellow
  const out = [tone(`\n? ${req.summary}`), dim(`  risk: ${req.risk}`)]
  if (req.reason) out.push(yellow(`  Why approval is required: ${req.reason}`))
  if (req.tool === 'edit_file') {
    out.push(...block('-', String(input.old_string ?? ''), red), ...block('+', String(input.new_string ?? ''), green))
  } else if (req.tool === 'save_memory' && Array.isArray(input.facts)) {
    out.push(...block('+', input.facts.map(String).join('\n'), green))
  } else if (req.tool === 'write_file') {
    out.push(...block('+', String(input.content ?? ''), green))
  } else if (req.tool === 'run_command') {
    out.push(...block('$', String(input.command ?? ''), red))
  } else if (req.tool === 'web_search') {
    out.push(...block('?', String(input.query ?? ''), cyan))
  }
  return out.join('\n')
}
