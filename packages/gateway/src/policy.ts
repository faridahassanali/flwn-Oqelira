import type { JsonSchema, Message, ToolCall, ToolSpec } from '@oqelira/core'

/**
 * Content checks. Decisions carry reason codes only; the text that matched is never returned or stored.
 * Inbound: user, assistant and tool text. The system prompt comes from our engine and is not inspected.
 */
const INJECTION_RULES: { code: string; re: RegExp }[] = [
  { code: 'override-previous', re: /\b(ignore|disregard|forget)\s+(all\s+|any\s+|the\s+|your\s+)?(previous|prior|above|earlier|preceding)\s+(instructions?|prompts?|messages?|rules?)/i },
  { code: 'override-system', re: /\b(override|replace|overwrite|ignore)\s+(the\s+|your\s+)?system\s+(prompt|message|instructions?)/i },
  { code: 'reveal-system', re: /\b(reveal|print|show|repeat|output|leak)\s+(your\s+|the\s+)?(system\s+prompt|hidden\s+instructions)/i },
  { code: 'role-jailbreak', re: /\byou\s+are\s+now\s+(in\s+)?(developer|dan|jailbreak|unrestricted|god)\s+mode/i },
  { code: 'special-token', re: /<\|im_(start|end)\|>|<\/?system>/i },
]

export function inspectInbound(messages: readonly Message[]): string[] {
  const reasons = new Set<string>()
  for (const m of messages) {
    const text = m.role === 'user' ? m.content : m.role === 'assistant' ? m.text : m.results.map((r) => r.output).join('\n')
    for (const rule of INJECTION_RULES) if (rule.re.test(text)) reasons.add(`injection:${rule.code}`)
  }
  return [...reasons]
}

const SECRET_RULES: { code: string; re: RegExp }[] = [
  { code: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { code: 'private-key', re: /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/ },
  { code: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { code: 'api-key-prefix', re: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { code: 'credential-assignment', re: /\b(api[_-]?key|secret|token|password|passwd)\b["']?\s*[:=]\s*["']?[A-Za-z0-9_\-/+=]{16,}/i },
]

/**
 * Returns a reason code for the first secret found in `text`, or null. `known` holds exact secret values
 * the gateway itself holds (its Foundry key), which must never leave the gateway.
 */
export function scanSecrets(text: string, known: readonly string[] = []): string | null {
  for (const rule of SECRET_RULES) if (rule.re.test(text)) return `secret:${rule.code}`
  for (const value of known) if (value && text.includes(value)) return 'secret:gateway-credential'
  return null
}

/** Checks a model tool call against the tools the client declared for this request. */
export function checkToolCall(call: ToolCall, tools: readonly ToolSpec[]): string | null {
  const spec = tools.find((t) => t.name === call.name)
  if (!spec) return 'tool:undeclared'
  return violatesSchema(call.input, spec.parameters) ? 'tool:schema' : null
}

/**
 * Small JSON Schema subset: type, enum, properties, required, additionalProperties:false and items.
 * Anything outside this subset is ignored, which is why it stays a subset of the tool contract, not a validator.
 */
export function violatesSchema(value: unknown, schema: JsonSchema): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return true
  if (schema.type !== undefined && !matchesType(value, schema.type)) return true
  if (Array.isArray(value)) {
    const items = schema.items as JsonSchema | undefined
    return !!items && value.some((v) => violatesSchema(v, items))
  }
  if (value !== null && typeof value === 'object') {
    const props = (schema.properties ?? {}) as Record<string, JsonSchema>
    const obj = value as Record<string, unknown>
    if (((schema.required ?? []) as string[]).some((k) => !(k in obj))) return true
    for (const [k, v] of Object.entries(obj)) {
      if (props[k] !== undefined) {
        if (violatesSchema(v, props[k])) return true
      } else if (schema.additionalProperties === false) return true
    }
  }
  return false
}

function matchesType(value: unknown, type: unknown): boolean {
  return (Array.isArray(type) ? type : [type]).some((t) => {
    switch (t) {
      case 'null': return value === null
      case 'array': return Array.isArray(value)
      case 'object': return value !== null && typeof value === 'object' && !Array.isArray(value)
      case 'integer': return Number.isInteger(value)
      case 'number': return typeof value === 'number'
      default: return typeof value === t
    }
  })
}
