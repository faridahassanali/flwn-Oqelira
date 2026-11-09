export type Risk = 'read' | 'write' | 'exec' | 'network'

export interface ApprovalRequest {
  tool: string
  risk: Risk
  /** Human-readable one-liner, e.g. "write src/a.ts (120 chars)". */
  summary: string
  input: unknown
  /** Why an automatic decision was refused; shown with the approval prompt. */
  reason?: string
}

export type Approver = (req: ApprovalRequest) => Promise<boolean>

export interface Permissions {
  /** Risks that never ask. Default: read only. */
  autoAllow: Risk[]
  /** Asked for everything else. No approver = deny (fail closed). */
  approve?: Approver
  /** Requests that must ask even when their risk is otherwise auto-allowed. */
  alwaysAsk?: (req: ApprovalRequest) => string | undefined
  /**
   * Runs before the approver for risks not in autoAllow: saved always-allow rules, and the hook point for
   * an auto-mode classifier. 'allow'/'deny' settle it; undefined falls through to the approver.
   */
  decide?: (req: ApprovalRequest) => Decision | Promise<Decision>
}
/** A decision may optionally explain why it fell through to a human. */
export type Decision = 'allow' | 'deny' | undefined | { decision: 'allow' | 'deny' | undefined; reason?: string }

export const READ_ONLY: Permissions = { autoAllow: ['read'] }

export async function checkPermission(
  perms: Permissions,
  req: ApprovalRequest,
): Promise<{ allowed: boolean; reason?: string }> {
  const forcedReason = perms.alwaysAsk?.(req)
  if (forcedReason) {
    const forced = { ...req, reason: forcedReason }
    if (!perms.approve) return { allowed: false, reason: `needs approval: ${forcedReason}` }
    const ok = await perms.approve(forced)
    return ok ? { allowed: true } : { allowed: false, reason: `the user denied: ${req.summary}` }
  }
  if (perms.autoAllow.includes(req.risk)) return { allowed: true }
  const outcome = await perms.decide?.(req)
  const decision = typeof outcome === 'object' && outcome !== null ? outcome.decision : outcome
  const decisionReason = typeof outcome === 'object' && outcome !== null ? outcome.reason : undefined
  if (decision === 'allow') return { allowed: true }
  if (decision === 'deny') return { allowed: false, reason: decisionReason ?? `blocked by permission rules: ${req.summary}` }
  if (!perms.approve) return { allowed: false, reason: `${req.tool} needs approval but no approver is configured` }
  const ok = await perms.approve(decisionReason ? { ...req, reason: decisionReason } : req)
  return ok ? { allowed: true } : { allowed: false, reason: `the user denied: ${req.summary}` }
}
