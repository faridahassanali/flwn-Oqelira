import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { SyncMessage, SyncProjectIdentity, SyncSnapshot } from '@oqelira/protocol'

const stateDir = (root?: string) => root ?? path.join(os.homedir(), '.oqelira')
const digest = (value: string) => createHash('sha256').update(value).digest('hex')

/** Turns HTTPS, SSH and SCP-style remotes for the same repository into one stable name. */
export function canonicalRemote(remote: string): string | undefined {
  const value = remote.trim().replace(/\/+$/, '')
  if (!value) return undefined
  const scp = /^([^@\s]+@)?([^:\s/]+):(.+)$/.exec(value)
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : scp ? `ssh://${scp[1] ?? ''}${scp[2]}/${scp[3]}` : value
  try {
    const parsed = new URL(url)
    const host = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.replace(/^\/+|\/+$/g, '').replace(/\.git$/i, '')
    return host && pathname ? `${host}/${pathname}` : undefined
  } catch { return undefined }
}

export function repositoryKey(remote: string): string | undefined {
  const canonical = canonicalRemote(remote)
  return canonical ? digest(`oqelira-repository-v1\0${canonical}`) : undefined
}

/** A per-install id; it is intentionally outside every project checkout. */
export function deviceId(root?: string): string {
  const dir = stateDir(root)
  const file = path.join(dir, 'device-id')
  try {
    const existing = fs.readFileSync(file, 'utf8').trim()
    if (/^[0-9a-f-]{36}$/i.test(existing)) return existing
  } catch { /* first install */ }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const id = randomUUID()
  fs.writeFileSync(file, id + '\n', { mode: 0o600 })
  return id
}

/** Git-backed projects share an identity across clones; no-remote projects require an explicit id. */
export function projectIdentity(opts: { remote?: string; projectId?: string; stateRoot?: string }): SyncProjectIdentity {
  const key = opts.remote ? repositoryKey(opts.remote) : undefined
  const local = opts.projectId?.trim()
  if (!key && !local) throw new Error('A project without a Git remote needs an explicit project id before sync')
  return { repositoryKey: key ?? digest(`oqelira-local-project-v1\0${local}`), deviceId: deviceId(opts.stateRoot), source: key ? 'git-remote' : 'local-project-id' }
}

/** Append-only messages merge by id. Timestamp then id gives all devices the same display order. */
export function mergeMessages(local: readonly SyncMessage[], remote: readonly SyncMessage[]): SyncMessage[] {
  const byId = new Map<string, SyncMessage>()
  for (const message of [...local, ...remote]) {
    const previous = byId.get(message.id)
    if (previous && (previous.contentHash !== message.contentHash || previous.sessionId !== message.sessionId)) throw new Error(`Conflicting message id ${message.id}`)
    byId.set(message.id, message)
  }
  return [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
}

/** Last-writer-wins selects the active snapshot but retains every losing version for history. */
export function mergeSnapshots(local: readonly SyncSnapshot[], remote: readonly SyncSnapshot[]) {
  const all = [...local, ...remote]
  const unique = new Map<string, SyncSnapshot>()
  for (const snapshot of all) {
    const previous = unique.get(snapshot.id)
    if (previous && previous.contentHash !== snapshot.contentHash) throw new Error(`Conflicting snapshot id ${snapshot.id}`)
    unique.set(snapshot.id, snapshot)
  }
  const history = [...unique.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.deviceId.localeCompare(b.deviceId) || a.id.localeCompare(b.id))
  return { current: history.at(-1), history }
}
