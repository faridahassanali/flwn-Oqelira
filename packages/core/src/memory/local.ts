import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { EmbeddingProvider } from '../providers/types.js'
import { MAX_MEMORY_CHARS } from './gateway.js'
import type { ContextGateway, MemoryEntry } from './gateway.js'

interface Row { id: string; text: string; kind: 'note' | 'summary'; source: string | null; created_at: string; embedding: Uint8Array }

const toEntry = (r: Row): MemoryEntry => ({ id: r.id, text: r.text, kind: r.kind, ...(r.source ? { source: r.source } : {}), createdAt: r.created_at })
const toBlob = (v: number[]) => new Uint8Array(new Float32Array(v).buffer)
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]! }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

/** Per-user store for one project: ~/.oqelira/projects/<hash of the real project path>/. */
export function memoryDir(cwd: string, stateRoot = path.join(os.homedir(), '.oqelira')): string {
  const id = createHash('sha256').update(fs.realpathSync(cwd)).digest('hex').slice(0, 24)
  return path.join(stateRoot, 'projects', id)
}

/**
 * Kept outside the repo on purpose: a cloned project could otherwise plant .oqelira, memory.sqlite or its
 * -journal/-wal/-shm sidecars as symlinks and redirect writes. node:sqlite is loaded lazily so hosts
 * without it (older Node) can still run, just without memory. `stateRoot` exists for tests only.
 */
export async function openLocalMemory(cwd: string, embedder: EmbeddingProvider, stateRoot?: string): Promise<ContextGateway> {
  const { DatabaseSync } = await import('node:sqlite')
  const dir = memoryDir(cwd, stateRoot)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path.join(dir, 'memory.sqlite'))
  fs.chmodSync(path.join(dir, 'memory.sqlite'), 0o600)
  db.exec(`CREATE TABLE IF NOT EXISTS memory (
    id TEXT PRIMARY KEY, text TEXT NOT NULL, kind TEXT NOT NULL, source TEXT,
    created_at TEXT NOT NULL, model TEXT NOT NULL, dim INTEGER NOT NULL, embedding BLOB NOT NULL)`)

  return {
    version: 1,
    async remember(text, opts = {}) {
      const clean = text.trim()
      if (!clean || clean.length > MAX_MEMORY_CHARS) throw new Error(`memory text must be 1-${MAX_MEMORY_CHARS} characters`)
      const [vector] = await embedder.embed([clean])
      if (!vector?.length) throw new Error('embedding service returned no vector')
      const entry: MemoryEntry = { id: randomUUID(), text: clean, kind: opts.kind ?? 'note', ...(opts.source ? { source: opts.source } : {}), createdAt: new Date().toISOString() }
      db.prepare('INSERT INTO memory (id, text, kind, source, created_at, model, dim, embedding) VALUES (?,?,?,?,?,?,?,?)')
        .run(entry.id, entry.text, entry.kind, entry.source ?? null, entry.createdAt, embedder.id, vector.length, toBlob(vector))
      return entry
    },
    async recall(query, opts = {}) {
      const [q] = await embedder.embed([query.slice(0, MAX_MEMORY_CHARS)], opts.signal)
      if (!q?.length) return []
      // Only vectors from the same model and size are comparable; a changed deployment simply hides old rows.
      const rows = db.prepare('SELECT * FROM memory WHERE model = ? AND dim = ?').all(embedder.id, q.length) as unknown as Row[]
      // ponytail: brute-force cosine, fine for a few thousand notes; add an ANN index past ~50k.
      return rows
        .map((r) => ({ ...toEntry(r), score: cosine(q, fromBlob(r.embedding)) }))
        .filter((h) => h.score >= (opts.minScore ?? 0))
        .sort((a, b) => b.score - a.score)
        .slice(0, opts.limit ?? 5)
    },
    async list(limit = 50) {
      return (db.prepare('SELECT * FROM memory ORDER BY created_at DESC LIMIT ?').all(limit) as unknown as Row[]).map(toEntry)
    },
    async forget(id) {
      // Exact id or a unique prefix (as shown to the model); never a pattern.
      if (!/^[0-9a-f-]{8,36}$/.test(id)) return false
      const hits = db.prepare('SELECT id FROM memory WHERE substr(id, 1, ?) = ?').all(id.length, id) as unknown as { id: string }[]
      if (hits.length !== 1) return false
      db.prepare('DELETE FROM memory WHERE id = ?').run(hits[0]!.id)
      return true
    },
  }
}
