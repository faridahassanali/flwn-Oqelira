import type { HostConfig, HostEvent } from '@oqelira/protocol'
async function checked(response: Response): Promise<Response> {
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(body.error ?? `Host returned ${response.status}`)
  }
  return response
}
export const getConfig = async (): Promise<HostConfig> => (await checked(await fetch('/api/config'))).json()
const headers = { 'Content-Type': 'application/json', 'X-Oqelira-Client': 'workspace' }
export async function approve(runId: string, approvalId: string, allowed: boolean): Promise<void> {
  await checked(await fetch('/api/approval', { method: 'POST', headers, body: JSON.stringify({ runId, approvalId, allowed }) }))
}
export async function run(request: { prompt: string; model: string; sessionId?: string; projectId?: string }, signal: AbortSignal, onEvent: (event: HostEvent) => void): Promise<void> {
  const response = await checked(await fetch('/api/run', { method: 'POST', headers, body: JSON.stringify(request), signal }))
  if (!response.body) throw new Error('The host did not return a stream')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let finished = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (!line) continue
        const event = JSON.parse(line) as HostEvent
        if (event.type === 'done' || event.type === 'error') finished = true
        onEvent(event)
      }
    }
    if (!finished) throw new Error('The host connection ended before the run completed')
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
