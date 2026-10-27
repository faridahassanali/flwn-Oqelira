export function serverConfig(env: NodeJS.ProcessEnv = process.env) {
  const required = (key: string) => { const value = env[key]?.trim(); if (!value) throw new Error(`Missing ${key}`); return value }
  const baseURL = new URL(required('OQELIRA_SERVER_URL'))
  const production = env.NODE_ENV === 'production'
  // Public enrollment remains closed until team authorization is wired and tested.
  // A deployment flag alone must not expose unverified production registration.
  if (production && env.OQELIRA_ALLOW_SIGNUP === 'true') throw new Error('Public signup is unavailable in production until deployment isolation and live identity delivery are validated')
  if (production && baseURL.protocol !== 'https:') throw new Error('Production requires an HTTPS server URL')
  if (!['http:', 'https:'].includes(baseURL.protocol) || baseURL.username || baseURL.password || baseURL.pathname !== '/' || baseURL.search || baseURL.hash) throw new Error('OQELIRA_SERVER_URL must be an origin')
  const secret = required('OQELIRA_AUTH_SECRET')
  if (Buffer.byteLength(secret) < 32 || /^(change|example|test|your)/i.test(secret)) throw new Error('Use a random OQELIRA_AUTH_SECRET of at least 32 bytes')
  const databaseURL = required('OQELIRA_DATABASE_URL')
  const database = new URL(databaseURL)
  if (!['postgres:', 'postgresql:'].includes(database.protocol)) throw new Error('Use PostgreSQL for server persistence')
  if (production && database.searchParams.get('sslmode') !== 'verify-full') throw new Error('Production PostgreSQL requires sslmode=verify-full')
  const port = Number(env.PORT ?? 4320)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid PORT')
  const provider=(name:'GOOGLE'|'GITHUB')=>{
    const clientId=env[`OQELIRA_${name}_CLIENT_ID`]?.trim(),clientSecret=env[`OQELIRA_${name}_CLIENT_SECRET`]?.trim()
    if(!!clientId!==!!clientSecret)throw new Error(`Configure both OQELIRA_${name}_CLIENT_ID and OQELIRA_${name}_CLIENT_SECRET`)
    return clientId&&clientSecret?{clientId,clientSecret}:undefined
  }
  return { baseURL: baseURL.origin, secret, databaseURL, port, production, signup: env.OQELIRA_ALLOW_SIGNUP === 'true', requireEmailVerification:production||env.OQELIRA_REQUIRE_VERIFIED_EMAIL==='true', smtpURL:env.OQELIRA_SMTP_URL?.trim(),smtpFrom:env.OQELIRA_SMTP_FROM?.trim(),google:provider('GOOGLE'),github:provider('GITHUB') }
}
