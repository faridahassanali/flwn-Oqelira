import { createHmac, timingSafeEqual } from 'node:crypto'

/** Short-lived user token: `base64url(claims).base64url(HMAC-SHA256)`. `exp` is epoch seconds. */
export interface TokenClaims { sub: string; org: string; dev: string; exp: number }

const sign = (payload: string, key: Buffer) => createHmac('sha256', key).update(payload).digest('base64url')

export function issueToken(claims: Omit<TokenClaims, 'exp'>, key: Buffer, ttlSeconds: number, now = Date.now()): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Math.floor(now / 1000) + ttlSeconds })).toString('base64url')
  return `${payload}.${sign(payload, key)}`
}

export function verifyToken(token: string, key: Buffer, now = Date.now()): TokenClaims | null {
  const [payload, mac, extra] = token.split('.')
  if (!payload || !mac || extra !== undefined) return null
  const expected = Buffer.from(sign(payload, key))
  const given = Buffer.from(mac)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const c = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Partial<TokenClaims>
    if (typeof c.sub !== 'string' || typeof c.org !== 'string' || typeof c.dev !== 'string' || typeof c.exp !== 'number') return null
    return c.exp * 1000 > now ? (c as TokenClaims) : null
  } catch {
    return null
  }
}
