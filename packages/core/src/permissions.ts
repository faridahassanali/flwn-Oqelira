export type Risk = 'read' | 'write' | 'exec' | 'network'

export interface ApprovalRequest {
  tool: string
  risk: Risk
  /** Human-readable one-liner, e.g. "write src/a.ts (120 chars)". */
  summary: string
  input: unknown
}

export type Approver = (req: ApprovalRequest) => Promise<boolean>

export interface Permissions {
  /** Risks that never ask. Default: read only. */
  autoAllow: Risk[]
  /** Asked for everything else. No approver = deny (fail closed). */
  approve?: Approver
  /**
   * Runs before the approver for risks not in autoAllow: saved always-allow rules, and the hook point for
   * an auto-mode classifier. 'allow'/'deny' settle it; undefined falls through to the approver.
   */
  decide?: (req: ApprovalRequest) => Decision | Promise<Decision>
}
export type Decision = 'allow' | 'deny' | undefined

export const READ_ONLY: Permissions = { autoAllow: ['read'] }

export async function checkPermission(
  perms: Permissions,
  req: ApprovalRequest,
): Promise<{ allowed: boolean; reason?: string }> {
  if (perms.autoAllow.includes(req.risk)) return { allowed: true }
  const decision = await perms.decide?.(req)
  if (decision === 'allow') return { allowed: true }
  if (decision === 'deny') return { allowed: false, reason: `blocked by permission rules: ${req.summary}` }
  if (!perms.approve) return { allowed: false, reason: `${req.tool} needs approval but no approver is configured` }
  const ok = await perms.approve(req)
  return ok ? { allowed: true } : { allowed: false, reason: `the user denied: ${req.summary}` }
}
