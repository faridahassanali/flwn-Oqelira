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
  | { type: 'notice'; message: string }
)

/**
 * Engine protocol: newline-delimited JSON over stdio (`oqelira serve`). The CLI is the engine; the web host
 * and VS Code are interfaces that speak this. Credentials travel in the engine's environment, never here.
 */
export const ENGINE_PROTOCOL = 1
export type EngineRequest =
  | { type: 'hello'; protocol: number }
  | { type: 'run'; prompt: string; model?: string; sessionId?: string }
  | { type: 'approval'; approvalId: string; allowed: boolean }
  | { type: 'cancel' }
  | { type: 'clear'; sessionId?: string }
export type EngineMessage =
  | { type: 'ready'; protocol: number; version: string; cwd: string; model: string; models: { id: string; deployment: string }[]; memory: boolean; webSearch: boolean }
  | { type: 'cleared' }
  | HostEvent
