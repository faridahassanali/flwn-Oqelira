import fs from 'node:fs/promises'
import path from 'node:path'
import type { Message } from '@oqelira/core'

const MAX_MESSAGES = 120
const MAX_FILE_BYTES = 500_000
const secret = /((?:api[_-]?key|token|password|secret)\s*[:=]\s*["']?)[^\s"']+/gi
const bearer = /(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi

function redact(text: string): string {
  return text.replace(secret, '$1[redacted]').replace(bearer, '$1[redacted]')
}

function sanitize(message: Message): Message {
  if (message.role === 'user') return { role: 'user', content: redact(message.content).slice(0, 20_000) }
  if (message.role === 'assistant') return { role: 'assistant', text: redact(message.text).slice(0, 40_000), toolCalls: message.toolCalls.slice(0, 20) }
  return { role: 'tool', results: message.results.slice(0, 20).map(result => ({ ...result, output: redact(result.output).slice(0, 20_000) })) }
}

async function historyPath(cwd: string): Promise<string> {
  const root = await fs.realpath(cwd)
  const dir = path.join(root, '.oqelira')
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  const stat = await fs.lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Invalid local session storage')
  return path.join(dir, 'cli-history.json')
}

export async function loadHistory(cwd: string): Promise<Message[]> {
  try {
    const file = await historyPath(cwd)
    const stat = await fs.lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return []
    const value: unknown = JSON.parse(await fs.readFile(file, 'utf8'))
    if (!Array.isArray(value)) return []
    return value.filter((message): message is Message => Boolean(message) && typeof message === 'object' && ['user', 'assistant', 'tool'].includes((message as { role?: unknown }).role as string)).slice(-MAX_MESSAGES).map(sanitize)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    return []
  }
}

export async function saveHistory(cwd: string, messages: Message[]): Promise<void> {
  const file = await historyPath(cwd)
  const content = JSON.stringify(messages.slice(-MAX_MESSAGES).map(sanitize))
  const temporary = file + '.tmp'
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 })
  try { await fs.rename(temporary, file) }
  catch (error) {
    if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error
    await fs.copyFile(temporary, file); await fs.unlink(temporary)
  }
}

export async function clearHistory(cwd: string): Promise<void> {
  try { await fs.unlink(await historyPath(cwd)) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
}
