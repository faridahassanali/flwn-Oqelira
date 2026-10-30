import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryDir } from '@oqelira/core'
import type { ApprovalRequest } from '@oqelira/core'

/**
 * Saved always-allow rules. They live under the state root (~/.oqelira), never in the repo, so a cloned
 * project cannot grant itself permissions. Commands match exactly (a prefix match would let `git status; rm -rf`
 * through); other tools match by name. Unreadable or malformed files mean no rules: the user is asked.
 */
export interface Rule { tool: string; command?: string }

const commandOf = (req: ApprovalRequest): string | undefined => {
  if (req.risk !== 'exec') return undefined
  const command = (req.input as { command?: unknown } | null)?.command
  return typeof command === 'string' ? command : undefined
}

export function openRules(cwd: string, stateRoot = path.join(os.homedir(), '.oqelira')) {
  const files = { user: path.join(stateRoot, 'permissions.json'), project: path.join(memoryDir(cwd, stateRoot), 'permissions.json') }
  const load = (file: string): Rule[] => {
    try {
      const allow = JSON.parse(fs.readFileSync(file, 'utf8')).allow
      return Array.isArray(allow) ? allow.filter((r) => typeof r?.tool === 'string' && (r.command === undefined || typeof r.command === 'string')) : []
    } catch {
      return []
    }
  }
  const saved = { user: load(files.user), project: load(files.project) }
  return {
    files,
    allows(req: ApprovalRequest): boolean {
      // An exec request without a readable command never matches, whatever the rule says.
      const command = commandOf(req)
      if (req.risk === 'exec' && command === undefined) return false
      return [...saved.user, ...saved.project].some((r) => r.tool === req.tool && r.command === command)
    },
    /** False when refused: network never persists (a model-chosen query is an exfiltration channel), and commands and writes depend on each project's files, so they stay project-scoped. */
    add(req: ApprovalRequest, scope: 'user' | 'project'): boolean {
      const command = commandOf(req)
      if (req.risk === 'network' || (scope === 'user' && req.risk !== 'read')) return false
      if (req.risk === 'exec' && command === undefined) return false
      if (saved[scope].some((r) => r.tool === req.tool && r.command === command)) return true
      saved[scope].push(command === undefined ? { tool: req.tool } : { tool: req.tool, command })
      fs.mkdirSync(path.dirname(files[scope]), { recursive: true, mode: 0o700 })
      fs.writeFileSync(files[scope], JSON.stringify({ allow: saved[scope] }, null, 2) + '\n', { mode: 0o600 })
      return true
    },
  }
}
