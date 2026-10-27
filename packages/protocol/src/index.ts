/** Browser-safe contracts. No Node, credentials or model SDK dependencies. */
export interface HostConfig {
  workspace: string
  models: { id: string; deployment: string }[]
  configured: boolean
}
export interface Approval {
  id: string
  tool: string
  risk: 'read' | 'write' | 'exec'
  summary: string
  input: unknown
}
export type HostEvent =
  | { type: 'started'; runId: string; sessionId: string }
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; id: string; name: string; output: string; isError?: boolean }
  | { type: 'approval'; approval: Approval }
  | { type: 'done'; reason: string }
  | { type: 'error'; message: string }
