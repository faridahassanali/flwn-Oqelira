import { modelsFromEnv } from '@oqelira/core'
import type { ModelConfig } from '@oqelira/core'

export interface GatewayLimits {
  fiveHourTokens?: number
  weeklyTokens?: number
  userWeeklyUsd: number
  orgWeeklyUsd: number
  requestsPerMinute: number
}

export interface GatewayConfig {
  port: number
  tokenKey: Buffer
  databaseURL: string
  models: readonly ModelConfig[]
  /** USD per million tokens, keyed by model id. Every model needs a price: spend is never guessed. */
  prices: Record<string, { inputUsdPerMTok: number; outputUsdPerMTok: number }>
  limits: GatewayLimits
}

const nonNegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0

function number(env: NodeJS.ProcessEnv, key: string): number | undefined {
  const raw = env[key]?.trim()
  if (!raw) return undefined
  const value = Number(raw)
  if (!nonNegative(value)) throw new Error(`${key} must be a non-negative number`)
  return value
}

export function gatewayConfig(env: NodeJS.ProcessEnv = process.env): GatewayConfig {
  const required = (key: string) => {
    const value = env[key]?.trim()
    if (!value) throw new Error(`Missing ${key}`)
    return value
  }
  const tokenKey = Buffer.from(required('OQELIRA_GATEWAY_TOKEN_KEY'))
  if (tokenKey.length < 32) throw new Error('OQELIRA_GATEWAY_TOKEN_KEY must be at least 32 bytes')
  const models = modelsFromEnv(env)
  const prices = JSON.parse(required('OQELIRA_GATEWAY_PRICES_JSON')) as GatewayConfig['prices']
  for (const m of models) {
    const p = prices[m.id]
    if (!p || !nonNegative(p.inputUsdPerMTok) || !nonNegative(p.outputUsdPerMTok)) throw new Error(`Missing price for model ${m.id}`)
  }
  const userWeeklyUsd = number(env, 'OQELIRA_GATEWAY_USER_WEEKLY_USD')
  const orgWeeklyUsd = number(env, 'OQELIRA_GATEWAY_ORG_WEEKLY_USD')
  if (userWeeklyUsd === undefined || orgWeeklyUsd === undefined) throw new Error('Spend ceilings are required: OQELIRA_GATEWAY_USER_WEEKLY_USD and OQELIRA_GATEWAY_ORG_WEEKLY_USD')
  return {
    port: Number(env.PORT ?? 4330),
    tokenKey,
    databaseURL: required('OQELIRA_GATEWAY_DATABASE_URL'),
    models,
    prices,
    limits: {
      fiveHourTokens: number(env, 'OQELIRA_GATEWAY_5H_TOKENS'),
      weeklyTokens: number(env, 'OQELIRA_GATEWAY_WEEKLY_TOKENS'),
      userWeeklyUsd,
      orgWeeklyUsd,
      requestsPerMinute: number(env, 'OQELIRA_GATEWAY_RPM') ?? 30,
    },
  }
}
