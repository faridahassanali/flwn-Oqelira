/** Versioned, content-free envelope used by the engine sync client and cloud API. */
export interface SyncMessage {
  id: string
  sessionId: string
  deviceId: string
  createdAt: string
  contentHash: string
  body: unknown
}

export interface SyncSnapshot {
  id: string
  sessionId: string
  version: number
  deviceId: string
  updatedAt: string
  contentHash: string
  summary: string
  coversThrough: number
}

export interface SyncProjectIdentity {
  /** SHA-256 of the canonical remote, never the raw remote itself. */
  repositoryKey: string
  deviceId: string
  /** A project without a Git remote uses an explicit local-only project id. */
  source: 'git-remote' | 'local-project-id'
}
