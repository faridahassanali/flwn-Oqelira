import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { memoryDir } from '@oqelira/core'
import type { ApprovalRequest } from '@oqelira/core'

/**
 * Saved always-allow rules. They live under the state root (~/.oqelira), never in the repo, so a cloned
 * project cannot grant itself permissions. Unreadable or malformed files mean no rules: the user is asked.
 *
 * - Commands match exactly (a prefix match would let `git status; rm -rf ~` through) and are bound to a
 *   fingerprint of the files that define what commands do (package.json, Makefile, scripts/...). If those
 *   change, the rule stops matching and the user is asked again. ponytail: a command that runs some other
 *   file (`node build.js`) is not covered; hash that file too if it matters.
 * - Writes match by directory (not recursive), and never cover files that can become code or config
 *   (any dot-file or dot-directory, node_modules, the command-defining files) - those always ask.
 * - Other tools (no path, no command) match by name. Network never persists (see add).
 */
export interface Rule { tool: string; command?: string; fingerprint?: string; dir?: string }

const COMMAND_FILES = ['package.json', 'makefile', 'justfile', 'taskfile.yml', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'conftest.py', 'cargo.toml', 'build.rs', 'go.mod', 'composer.json', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml', 'rakefile', 'gemfile', 'cmakelists.txt']
/** Names that decide what commands run, compared lowercase (macOS and Windows filesystems ignore case). */
const definesCommands = (name: string) => COMMAND_FILES.includes(name.toLowerCase()) || /\.config\.[cm]?[jt]sx?$/i.test(name)

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const commandOf = (req: ApprovalRequest) => (req.risk === 'exec' ? str((req.input as { command?: unknown } | null)?.command) : undefined)

function fingerprint(cwd: string): string {
  const hash = crypto.createHash('sha256')
  const feed = (rel: string) => {
    try { hash.update(rel + '\0').update(fs.readFileSync(path.join(cwd, rel))) } catch { /* missing or unreadable */ }
  }
  const walk = (rel: string, depth: number): string[] => {
    try {
      return fs.readdirSync(path.join(cwd, rel), { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name)).flatMap((e) => (e.isDirectory() ? (depth < 4 ? walk(path.join(rel, e.name), depth + 1) : []) : [path.join(rel, e.name)]))
    } catch {
      return [] // missing or unreadable
    }
  }
  // Dotfiles at the root (.npmrc, .yarnrc, .pnpmfile.cjs, .cargo/config.toml...) change behaviour too; symlinks are read through.
  let names: string[] = []
  try { names = fs.readdirSync(cwd) } catch { /* unreadable */ }
  const rootFiles = names.filter((n) => definesCommands(n) || n.startsWith('.')).filter((n) => n !== '.git' && n !== '.oqelira')
  rootFiles.sort().forEach((n) => (fs.statSync(path.join(cwd, n), { throwIfNoEntry: false })?.isDirectory() ? walk(n, 1).forEach(feed) : feed(n)))
  walk('scripts', 1).forEach(feed)
  return hash.digest('hex')
}

/** realpath of the deepest existing ancestor plus the missing tail, so symlinks cannot hide where a write lands; null for a dangling link. */
function realPath(p: string): string | null {
  const tail: string[] = []
  for (let cur = p; ; cur = path.dirname(cur)) {
    try { return path.join(fs.realpathSync(cur), ...tail) } catch { /* missing, or a dangling link: checked below */ }
    // An entry that exists but cannot be resolved is a dangling symlink; a write would create its target. Refuse.
    if (fs.lstatSync(cur, { throwIfNoEntry: false })) return null
    if (path.dirname(cur) === cur) return p
    tail.unshift(path.basename(cur))
  }
}

/** Directory (relative to cwd) of the file a write targets; undefined if there is no path, it escapes cwd, or it is protected. */
function writeDir(cwd: string, req: ApprovalRequest): string | null | undefined {
  const target = str((req.input as { path?: unknown } | null)?.path)
  if (target === undefined) return undefined // not a file tool
  const lexical = path.relative(cwd, path.resolve(cwd, target))
  const [realCwd, realTarget] = [realPath(cwd), realPath(path.resolve(cwd, target))]
  if (realCwd === null || realTarget === null) return null
  const rel = path.relative(realCwd, realTarget)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || lexical.startsWith('..')) return null
  // Both the named path and where it really lands. Any dot-segment (.git, .github, .env, .npmrc, .cargo...) is protected.
  const parts = [...rel.split(path.sep), ...lexical.split(path.sep)].filter((p) => p && p !== '.')
  if (parts.some((p) => p.startsWith('.') || p.toLowerCase() === 'node_modules' || definesCommands(p))) return null
  return path.dirname(rel)
}

export function openRules(cwd: string, stateRoot = path.join(os.homedir(), '.oqelira')) {
  const files = { user: path.join(stateRoot, 'permissions.json'), project: path.join(memoryDir(cwd, stateRoot), 'permissions.json') }
  const load = (file: string): Rule[] => {
    try {
      const allow = JSON.parse(fs.readFileSync(file, 'utf8')).allow
      const ok = (v: unknown) => v === undefined || typeof v === 'string'
      return Array.isArray(allow) ? allow.filter((r) => typeof r?.tool === 'string' && ok(r.command) && ok(r.fingerprint) && ok(r.dir)) : []
    } catch {
      return []
    }
  }
  const saved = { user: load(files.user), project: load(files.project) }

  /** The rule this request would be, or null if it can never be covered by one. */
  const ruleFor = (req: ApprovalRequest): Rule | null => {
    if (req.risk === 'network') return null
    if (req.risk === 'exec') {
      const command = commandOf(req)
      return command === undefined ? null : { tool: req.tool, command, fingerprint: fingerprint(cwd) }
    }
    if (req.risk === 'write') {
      const dir = writeDir(cwd, req)
      return dir === null ? null : dir === undefined ? { tool: req.tool } : { tool: req.tool, dir }
    }
    return { tool: req.tool }
  }
  const same = (a: Rule, b: Rule) => a.tool === b.tool && a.command === b.command && a.fingerprint === b.fingerprint && a.dir === b.dir

  return {
    files,
    allows(req: ApprovalRequest): boolean {
      const want = ruleFor(req)
      return want !== null && [...saved.user, ...saved.project].some((r) => same(r, want))
    },
    /** False when refused: network never persists (a model-chosen query is an exfiltration channel), user scope only holds reads, and protected files always ask. */
    add(req: ApprovalRequest, scope: 'user' | 'project'): boolean {
      const rule = ruleFor(req)
      if (!rule || (scope === 'user' && req.risk !== 'read')) return false
      // A command rule saved under an older fingerprint is replaced, not left to pile up.
      saved[scope] = saved[scope].filter((r) => !(r.tool === rule.tool && r.command === rule.command && r.dir === rule.dir))
      saved[scope].push(rule)
      fs.mkdirSync(path.dirname(files[scope]), { recursive: true, mode: 0o700 })
      fs.writeFileSync(files[scope], JSON.stringify({ allow: saved[scope] }, null, 2) + '\n', { mode: 0o600 })
      return true
    },
  }
}
