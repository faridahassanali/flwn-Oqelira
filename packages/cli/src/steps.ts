import { plainText } from '@oqelira/core'

export interface StepRecord {
  index: number
  id: string
  name: string
  description: string
  output: string
  error: boolean
  durationMs: number
}

interface ActiveStep { id: string; name: string; description: string; started: number }

/** Keeps completed tool steps available after the live TTY view collapses them. */
export class StepLog {
  private readonly active = new Map<string, ActiveStep>()
  private readonly completed: StepRecord[] = []

  start(id: string, name: string, description: string): void {
    this.active.set(id, { id, name, description, started: Date.now() })
  }

  finish(id: string, output: string, error = false): StepRecord | undefined {
    const step = this.active.get(id)
    if (!step) return undefined
    this.active.delete(id)
    const record: StepRecord = {
      index: this.completed.length + 1,
      id,
      name: step.name,
      description: step.description,
      output: plainText(output),
      error,
      durationMs: Math.max(0, Date.now() - step.started),
    }
    this.completed.push(record)
    return record
  }

  all(): readonly StepRecord[] { return this.completed }

  activeCount(): number { return this.active.size }

  get(index: number): StepRecord | undefined { return this.completed[index - 1] }

  clear(): void {
    this.active.clear()
    this.completed.length = 0
  }
}

export function stepSummary(step: StepRecord, max = 110): string {
  const output = (step.output.split(/\r?\n/).find(line => line.trim()) ?? '').trim()
  const detail = output.length > max ? `${output.slice(0, max)}...` : output
  return `${step.error ? 'x' : 'ok'} ${step.description}${detail ? ` · ${detail}` : ''} · ${step.durationMs}ms`
}

export function stepDetails(step: StepRecord): string {
  const lines = step.output.split(/\r?\n/)
  const body = lines.length ? lines.map(line => `  ${line}`).join('\n') : '  (no output)'
  return `Step ${step.index}: ${step.description}\n${body}\n  [${step.error ? 'failed' : 'completed'} in ${step.durationMs}ms]`
}
