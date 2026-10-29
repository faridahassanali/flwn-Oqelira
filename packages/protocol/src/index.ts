/** Browser-safe contracts. No Node, credentials or model SDK dependencies. */
export interface HostConfig {
  workspace: string
  models: { id: string; deployment: string }[]
  configured: boolean
  mode?: 'server'
  user?: { id: string; name: string;email?:string;emailVerified?:boolean } | null
  auth?: {signup:boolean;emailRecovery:boolean;verification:boolean;socialProviders:('google'|'github')[]}
}
export interface Approval {
  id: string
  tool: string
  risk: 'read' | 'write' | 'exec' | 'network'
  summary: string
  input: unknown
}
export type HostEvent = { sequence?: number } & (
  | { type: 'started'; runId: string; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'context-compacted'; originalChars: number; requestChars: number; archivedMessages: number }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: string; isError?: boolean }
  | { type: 'approval'; approval: Approval }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string }
  | { type: 'connection'; state: 'reconnecting' | 'connected' }
)
