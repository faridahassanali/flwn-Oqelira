import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Message } from '@oqelira/core'

const execFileAsync = promisify(execFile)
const HEX_COMMIT = /^[0-9a-f]{7,64}$/i
const FILE_TOOLS = new Set(['read_file', 'write_file', 'edit_file', 'file_snapshot', 'apply_file_change', 'read_file_change', 'revert_file_change'])

export interface GitCommitSummary {
  hash: string
  shortHash: string
  author: string
  date: string
  subject: string
}

export interface GitCommitDiff {
  hash: string
  patch: string
  files: string[]
}

async function git(cwd: string, args: string[], maxBuffer = 2_000_000): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '--no-optional-locks', ...args], {
    cwd,
    windowsHide: true,
    timeout: 30_000,
    maxBuffer,
    encoding: 'utf8',
  })
  return result.stdout
}

export async function gitHistory(cwd: string, limit = 20): Promise<GitCommitSummary[]> {
  const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const output = await git(cwd, ['log', `-n${safeLimit}`, '--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e'])
  return output.split('\x1e').filter(Boolean).map((row) => {
    const [hash, shortHash, author, date, subject] = row.trim().split('\x1f')
    return hash && shortHash && author && date && subject ? { hash, shortHash, author, date, subject } : undefined
  }).filter((commit): commit is GitCommitSummary => Boolean(commit))
}

export async function gitDiff(cwd: string, commit: string): Promise<GitCommitDiff> {
  if (!HEX_COMMIT.test(commit)) throw new Error('Invalid commit id')
  const patch = await git(cwd, ['show', '--format=fuller', '--no-ext-diff', '--no-textconv', '--no-renames', commit], 5_000_000)
  const files = [...patch.matchAll(/^diff --git a\/(.*?) b\/(.*?)$/gm)].map((match) => match[2]).filter((file): file is string => Boolean(file))
  return { hash: commit, patch, files: [...new Set(files)] }
}

function toolPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || typeof (input as { path?: unknown }).path !== 'string') return undefined
  const value = (input as { path: string }).path.trim().replaceAll('\\', '/')
  if (!value || value.startsWith('/') || value.split('/').includes('..')) return undefined
  return value
}

export function sessionFiles(messages: Message[]): string[] {
  const files = new Set<string>()
  for (const message of messages) {
    if (message.role !== 'assistant') continue
    for (const call of message.toolCalls) if (FILE_TOOLS.has(call.name)) {
      const file = toolPath(call.input)
      if (file && !file.startsWith('.git/') && !file.startsWith('.oqelira/')) files.add(file)
    }
  }
  return [...files].sort()
}
