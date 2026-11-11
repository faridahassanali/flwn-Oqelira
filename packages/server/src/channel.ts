import { Client } from 'pg'
import type { Pool } from 'pg'

/**
 * Cross-replica wake-up for runs. Notifications are hints only: the database holds the
 * events and approval decisions, so a lost notification delays delivery but never loses it.
 */
export interface RunChannel {
  wake(runId: string): Promise<void>
  watch(runId: string, onWake: () => void): () => void
}

export const RUN_CHANNEL = 'oq_run_wake'
export type Listen = (channel: string, onPayload: (payload: string) => void) => Promise<unknown>

export class PostgresRunChannel implements RunChannel {
  private watchers = new Map<string, Set<() => void>>()
  private constructor(private db: Pick<Pool, 'query'>) {}

  /** `listen` is the replica's own LISTEN connection; see `pgListen` for production. */
  static async open(db: Pick<Pool, 'query'>, listen: Listen): Promise<PostgresRunChannel> {
    const channel = new PostgresRunChannel(db)
    await listen(RUN_CHANNEL, runId => channel.fire(runId))
    return channel
  }
  async wake(runId: string) { await this.db.query('SELECT pg_notify($1,$2)', [RUN_CHANNEL, runId]) }
  watch(runId: string, onWake: () => void) {
    const set = this.watchers.get(runId) ?? new Set<() => void>()
    set.add(onWake); this.watchers.set(runId, set)
    return () => { set.delete(onWake); if (!set.size && this.watchers.get(runId) === set) this.watchers.delete(runId) }
  }
  private fire(runId: string) { for (const onWake of this.watchers.get(runId) ?? []) onWake() }
}

/** Dedicated LISTEN connection that reconnects after failure; watchers fall back to polling meanwhile. */
export function pgListen(connectionString: string): Listen {
  return async (channel, onPayload) => {
    let client: Client | undefined, stopped = false
    const connect = async (): Promise<void> => {
      const next = new Client({ connectionString })
      const retry = () => { if (client === next) client = undefined; if (!stopped) setTimeout(() => void connect().catch(retry), 1000) }
      next.on('notification', message => { if (message.channel === channel && message.payload) onPayload(message.payload) })
      next.once('error', retry)
      await next.connect()
      await next.query(`LISTEN ${channel}`)
      client = next
    }
    await connect()
    return async () => { stopped = true; await client?.end().catch(() => undefined) }
  }
}
