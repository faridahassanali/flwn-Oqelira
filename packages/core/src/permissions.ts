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
}

export const READ_ONLY: Permissions = { autoAllow: ['read'] }

export async function checkPermission(
  perms: Permissions,
  req: ApprovalRequest,
): Promise<{ allowed: boolean; reason?: string }> {
  if (perms.autoAllow.includes(req.risk)) return { allowed: true }
  if (!perms.approve) return { allowed: false, reason: `${req.tool} needs approval but no approver is configured` }
  const ok = await perms.approve(req)
  return ok ? { allowed: true } : { allowed: false, reason: `the user denied: ${req.summary}` }
}
