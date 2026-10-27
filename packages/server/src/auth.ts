import { betterAuth } from 'better-auth'
import type { Pool } from 'pg'
import type { serverConfig } from './config.js'

export function createAuth(pool: Pool, config: ReturnType<typeof serverConfig>) {
  return betterAuth({
    database: pool, secret: config.secret, baseURL: config.baseURL,
    trustedOrigins: [config.baseURL],
    emailAndPassword: { enabled: true, disableSignUp: !config.signup, minPasswordLength: 12, maxPasswordLength: 128 },
    session: { expiresIn: 60 * 60 * 24, updateAge: 60 * 60, cookieCache: { enabled: false } },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 30, customRules: { '/sign-in/email': { window: 60, max: 5 }, '/sign-up/email': { window: 60, max: 3 } } },
    advanced: { useSecureCookies: config.production, defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' }, disableCSRFCheck: false, disableOriginCheck: false },
    logger: { disabled: true },
  })
}
export type Auth = ReturnType<typeof createAuth>
