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
 * - Reads match by tool name. Network never persists, and writes without a file path (memory tools) are always asked.
 */
export interface Rule { tool: string; command?: string; fingerprint?: string; dir?: string }

const COMMAND_FILES = ['package.json', 'makefile', 'justfile', 'taskfile.yml', 'pyproject.toml', 'setup.py', 'setup.cfg', 'tox.ini', 'conftest.py', 'cargo.toml', 'build.rs', 'go.mod', 'composer.json', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'pom.xml', 'rakefile', 'gemfile', 'cmakelists.txt']
/** Names that decide what commands run, compared lowercase (macOS and Windows filesystems ignore case). */
const definesCommands = (name: string) => COMMAND_FILES.includes(name.toLowerCase()) || /\.config\.[cm]?[jt]sx?$/i.test(name)

/** Rememberable by tool identity, never by the shape of the input: only these tools have a file or command to bind a rule to. */
const FILE_TOOLS = new Set(['write_file', 'edit_file', 'apply_file_change'])
const COMMAND_TOOL = 'run_command'

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const commandOf = (req: ApprovalRequest) => (req.risk === 'exec' && req.tool === COMMAND_TOOL ? str((req.input as { command?: unknown } | null)?.command) : undefined)

const SKIP_ROOT = new Set(['.git', '.oqelira', 'node_modules'])
const MAX_FILES = 2000
const MAX_BYTES = 512_000_000 // total hashed per fingerprint

/**
 * Hash of what decides what commands do: every file directly in the project root, plus any file the command itself names (so a new or renamed build file
 * cannot slip past a name list), root dot-directories (.cargo...) and scripts/, recursively, following symlinks.
 * null when it cannot be computed with confidence (too deep, too many files, unreadable): then no rule matches.
 */
function fingerprint(cwd: string, command: string): string | null {
  const hash = crypto.createHash('sha256')
  const seen = new Set<string>()
  let count = 0
  let bytes = 0
  const feed = (rel: string): boolean => {
    try {
      const full = path.join(cwd, rel)
      const real = fs.realpathSync(full)
      const st = fs.statSync(full)
      if (st.isDirectory()) {
        if (seen.has(real)) return true // loop
        seen.add(real)
        for (const e of fs.readdirSync(full).sort()) if (!feedChild(path.join(rel, e))) return false
        return true
      }
      if (++count > MAX_FILES || rel.split(path.sep).length > 6) return false // past the cap: do not pretend we looked
      hash.update(rel + '\0' + st.size + '\0')
      const fd = fs.openSync(full, 'r') // streamed: any file size, whole content
      try {
        const chunk = Buffer.allocUnsafe(1 << 20)
        for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0; ) {
          if ((bytes += n) > MAX_BYTES) return false
          hash.update(chunk.subarray(0, n))
        }
      } finally {
        fs.closeSync(fd)
      }
      return true
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'ENOENT' // a dangling link or vanished file contributes only its name; anything else (permissions...) fails closed
    }
  }
  const feedChild = (rel: string) => { hash.update(rel + '\0'); return feed(rel) }
  let names: string[]
  try { names = fs.readdirSync(cwd).sort() } catch { return null }
  for (const n of names) {
    if (SKIP_ROOT.has(n)) continue
    const isDir = fs.statSync(path.join(cwd, n), { throwIfNoEntry: false })?.isDirectory()
    if (isDir && n.toLowerCase() !== 'scripts' && !n.startsWith('.')) continue // source directories are not build definitions
    if (!feedChild(n)) return null
  }
  // Files the command names (`node src/build.js`, `./run.sh`) run whatever they now contain. Directories are not
  // hashed (`eslint src` would then go stale on every edit); imports of a named file are not followed.
  let realCwd: string
  try { realCwd = fs.realpathSync(cwd) } catch { return null }
  // Only plain words joined by && || ; | are saved. Quotes, substitutions, globs, redirects, escapes and the like make
  // "which files does this run" unknowable here, so those commands are asked every time.
  const tokens = plainCommandWords(command)
  if (!tokens) return null
  for (const token of tokens) {
    let real: string
    // A name that is not a file today is recorded as missing, so creating it later changes the fingerprint.
    try { real = fs.realpathSync(path.resolve(cwd, token)) } catch { hash.update('missing\0' + token + '\0'); continue }
    const rel = path.relative(realCwd, real)
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !fs.statSync(real).isFile()) continue
    if (!feedChild(path.relative(cwd, path.resolve(cwd, token)))) return null
  }
  return hash.digest('hex')
}

const WORD = /^[\w./:@%+,=-]+$/
const OPERATORS = /\s*(?:&&|\|\||;|\|)\s*/
const REDIRECTS_OR_WORKDIR = new Set(['cd', 'pushd', 'popd', 'eval', 'source', '.', 'exec', 'env', 'xargs', 'command', 'builtin', '-C', '-m', '-r', '--prefix', '--cwd', '--dir', '--directory', '--chdir', '--project', '--manifest-path', '--require', '--import', '--workspace', '--filter'])

/** The words of a command made only of plain words and && || ; |, or null if it is anything else. */
function plainCommandWords(command: string): string[] | null {
  const words: string[] = []
  for (const part of command.trim().split(OPERATORS)) {
    if (!part) return null
    for (const word of part.split(/\s+/)) {
      if (!WORD.test(word) || REDIRECTS_OR_WORKDIR.has(word.split('=')[0] ?? '')) return null
      words.push(word)
    }
  }
  return [...new Set(words)]
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
  if (parts[0]?.toLowerCase() === 'scripts') return null // fingerprinted: edits there already invalidate command rules, and writes ask
  const dir = path.dirname(rel)
  return dir === '.' ? null : dir // the project root holds the build files; never covered
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
      const print = fingerprint(cwd, command ?? '')
      return command === undefined || print === null ? null : { tool: req.tool, command, fingerprint: print }
    }
    if (req.risk === 'write') {
      if (!FILE_TOOLS.has(req.tool)) return null
      const dir = writeDir(cwd, req)
      // A write with no path (save_memory...) has nothing narrow to bind a rule to: always asked.
      return dir === null || dir === undefined ? null : { tool: req.tool, dir }
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
