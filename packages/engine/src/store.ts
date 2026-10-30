import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { memoryDir } from '@oqelira/core'
import type { Message } from '@oqelira/core'

export interface SessionInfo { id: string; title: string; model: string; createdAt: string; updatedAt: string; messages: number }
export interface Snapshot { version: number; summary: string; /** The first `coversThrough` messages are summarized. */ coversThrough: number; createdAt: string }
export interface LoadedSession { messages: Message[]; snapshot?: Snapshot }

/**
 * Durable sessions: the full message history (append-only) plus the latest compact snapshot.
 * Rows carry ids, hashes and a synced_at column so a later sync is a plain copy.
 */
export interface SessionStore {
  list(limit?: number): SessionInfo[]
  load(id: string): LoadedSession | undefined
  /** Stores `messages[from..]` for the session; already stored positions are never rewritten. */
  append(id: string, messages: Message[], from: number, meta: { model: string; title?: string }): void
  saveSnapshot(id: string, summary: string, coversThrough: number): Snapshot
  remove(id: string): void
  /** How many leading messages have already been mined for project memory. */
  getMemorized(id: string): number
  setMemorized(id: string, through: number): void
}

const secret = /((?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)[^\s"']+/gi
const bearer = /(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi
const redact = (text: string) => text.replace(secret, '$1[redacted]').replace(bearer, '$1[redacted]')

/** Caps and redacts obvious credentials before anything is written to disk. */
export function sanitize(message: Message): Message {
  if (message.role === 'user') return { role: 'user', content: redact(message.content).slice(0, 100_000) }
  if (message.role === 'assistant') return { role: 'assistant', text: redact(message.text).slice(0, 100_000), toolCalls: message.toolCalls }
  return { role: 'tool', results: message.results.map((r) => ({ ...r, output: redact(r.output).slice(0, 50_000) })) }
}

const titleOf = (messages: Message[]) => {
  const first = messages.find((m) => m.role === 'user')
  return first && first.role === 'user' ? redact(first.content).replace(/\s+/g, ' ').slice(0, 80) : 'Untitled'
}

/** A store that remembers nothing: used when node:sqlite is unavailable or persistence is off. */
export const noStore: SessionStore = { list: () => [], load: () => undefined, append() {}, saveSnapshot: (_i, summary, coversThrough) => ({ version: 0, summary, coversThrough, createdAt: new Date().toISOString() }), remove() {}, getMemorized: () => 0, setMemorized() {} }

export async function openSessionStore(cwd: string, stateRoot?: string): Promise<SessionStore> {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = memoryDir(cwd, stateRoot)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const file = path.join(dir, 'sessions.sqlite')
  const db = new DatabaseSync(file)
  fs.chmodSync(file, 0o600)
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, model TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, device_id TEXT NOT NULL, synced_at TEXT);
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL, role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL, synced_at TEXT, UNIQUE(session_id, seq));
    CREATE TABLE IF NOT EXISTS context_snapshots (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      version INTEGER NOT NULL, summary TEXT NOT NULL, covers_through INTEGER NOT NULL, created_at TEXT NOT NULL,
      content_hash TEXT NOT NULL, synced_at TEXT, UNIQUE(session_id, version));
    CREATE TABLE IF NOT EXISTS memory_marks (session_id TEXT PRIMARY KEY, through INTEGER NOT NULL);
    PRAGMA foreign_keys = ON;`)
  const deviceRow = db.prepare("SELECT value FROM meta WHERE key = 'device_id'").get() as { value: string } | undefined
  const deviceId = deviceRow?.value ?? randomUUID()
  if (!deviceRow) db.prepare("INSERT INTO meta (key, value) VALUES ('device_id', ?)").run(deviceId)

  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  return {
    list(limit = 50) {
      const rows = db.prepare(`SELECT s.id, s.title, s.model, s.created_at, s.updated_at,
        (SELECT COUNT(*) FROM messages m WHERE m.session_id = s.id) AS n FROM sessions s ORDER BY s.updated_at DESC LIMIT ?`).all(limit) as unknown as Array<{ id: string; title: string; model: string; created_at: string; updated_at: string; n: number }>
      return rows.map((r) => ({ id: r.id, title: r.title, model: r.model, createdAt: r.created_at, updatedAt: r.updated_at, messages: Number(r.n) }))
    },
    load(id) {
      if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) return undefined
      const rows = db.prepare('SELECT body FROM messages WHERE session_id = ? ORDER BY seq').all(id) as unknown as Array<{ body: string }>
      const snap = db.prepare('SELECT version, summary, covers_through, created_at FROM context_snapshots WHERE session_id = ? ORDER BY version DESC LIMIT 1').get(id) as { version: number; summary: string; covers_through: number; created_at: string } | undefined
      return { messages: rows.map((r) => JSON.parse(r.body) as Message), snapshot: snap && { version: Number(snap.version), summary: snap.summary, coversThrough: Number(snap.covers_through), createdAt: snap.created_at } }
    },
    append(id, messages, from, meta) {
      const now = new Date().toISOString()
      db.exec('BEGIN')
      try {
        if (!db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) {
          db.prepare('INSERT INTO sessions (id, title, model, created_at, updated_at, device_id) VALUES (?,?,?,?,?,?)').run(id, meta.title ?? titleOf(messages), meta.model, now, now, deviceId)
        }
        const stored = Number((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE session_id = ?').get(id) as { n: number }).n)
        const insert = db.prepare('INSERT INTO messages (id, session_id, seq, role, body, created_at, content_hash) VALUES (?,?,?,?,?,?,?)')
        for (let i = Math.max(from, stored); i < messages.length; i++) {
          const body = JSON.stringify(sanitize(messages[i]!))
          insert.run(randomUUID(), id, i, messages[i]!.role, body, now, hash(body))
        }
        db.prepare('UPDATE sessions SET updated_at = ?, model = ? WHERE id = ?').run(now, meta.model, id)
        db.exec('COMMIT')
      } catch (e) { db.exec('ROLLBACK'); throw e }
    },
    saveSnapshot(id, summary, coversThrough) {
      const last = db.prepare('SELECT COALESCE(MAX(version), 0) AS v FROM context_snapshots WHERE session_id = ?').get(id) as { v: number }
      const snap: Snapshot = { version: Number(last.v) + 1, summary: redact(summary).slice(0, 20_000), coversThrough, createdAt: new Date().toISOString() }
      if (db.prepare('SELECT 1 FROM sessions WHERE id = ?').get(id)) {
        db.prepare('INSERT INTO context_snapshots (id, session_id, version, summary, covers_through, created_at, content_hash) VALUES (?,?,?,?,?,?,?)').run(randomUUID(), id, snap.version, snap.summary, coversThrough, snap.createdAt, hash(snap.summary))
      }
      return snap
    },
    remove(id) {
      db.prepare('DELETE FROM sessions WHERE id = ?').run(id)
      db.prepare('DELETE FROM memory_marks WHERE session_id = ?').run(id)
    },
    getMemorized(id) {
      return Number((db.prepare('SELECT through FROM memory_marks WHERE session_id = ?').get(id) as { through: number } | undefined)?.through ?? 0)
    },
    setMemorized(id, through) {
      db.prepare('INSERT INTO memory_marks (session_id, through) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET through = excluded.through').run(id, through)
    },
  }
}
