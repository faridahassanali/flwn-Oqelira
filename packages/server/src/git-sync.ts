import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { UUID } from './sandbox.js'

/**
 * GitHub import and pull (never push).
 *
 * Networked step: runs on the runner host as the runner's own unprivileged user, in a fresh
 * 0755 temp dir holding only a bare repo. No volume, no docker socket and no model-controlled
 * container is involved, and nothing from the volume is read on the host. The token is passed
 * only through the environment of that one git process (GIT_CONFIG_COUNT), never argv (ps),
 * never disk. Files reach the project volume through a `--network none` container as uid 1000,
 * so ownership, the XFS project quota and the inode limit apply.
 */
export class GitError extends Error { constructor(readonly status: number, message: string) { super(message) } }

export interface GitRequest { action: 'clone' | 'pull'; project: string; repo: string; branch?: string; token: string }
export interface GitResult { ok: true; branch: string; commit: string; changed?: number; bytes?: number }
/** Runs `script` against the project volume (WS) with the fetched bare repo at SRC. Returns stdout. Faked in tests. */
export type VolumeExec = (project: string, script: string, env: Record<string, string>, src: string | undefined, signal: AbortSignal) => Promise<string>
export interface GitSyncOptions {
  gitBin?: string; baseUrl?: string; exec: VolumeExec; log?: (msg: string) => void
  maxBytes?: number; timeoutMs?: number; maxJobs?: number; depth?: number
}

const REPO = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})$/
const BRANCH_CHARS = /^[A-Za-z0-9._/-]{1,200}$/
export function validRepo(repo: unknown): repo is string {
  if (typeof repo !== 'string') return false
  const m = REPO.exec(repo)
  return !!m && !repo.includes('..') && m.slice(1).every(p => !p.startsWith('-') && !/^\.+$/.test(p))
}
export function validBranch(b: unknown): b is string {
  return typeof b === 'string' && BRANCH_CHARS.test(b) && !b.includes('..') && !b.includes('//') && !b.startsWith('-') && !b.startsWith('/') && !b.endsWith('/') && !b.endsWith('.') && !b.endsWith('.lock') && !b.split('/').some(s => s.startsWith('.') || s.endsWith('.lock'))
}

/** Same git safety flags on the host and in the volume container. No hooks, no helpers, no LFS, no submodules. */
const SAFE = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'core.symlinks=true', '-c', 'init.templateDir=', '-c', 'submodule.recurse=false', '-c', 'diff.external=', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '-c', 'core.askPass=', '-c', 'credential.helper=']
const SAFE_SH = SAFE.map(a => `'${a}'`).join(' ')
// Volume-side script. Params arrive as env (validated values only); the token is never here.
const PRE = `set -eu
unset GIT_TEMPLATE_DIR
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_OPTIONAL_LOCKS=0 GIT_TERMINAL_PROMPT=0 HOME=/tmp
g() { git ${SAFE_SH} -c protocol.allow=never -c protocol.file.allow=always -c safe.directory='*' "$@"; }
size() { du -sk "$WS" | cut -f1; }
cd "$WS"
`
export const SCRIPTS = {
  inspect: PRE + `if [ -z "$(ls -A)" ]; then echo empty; exit 0; fi
if [ ! -d .git ] || [ -L .git ]; then echo foreign; exit 0; fi
echo repo; g symbolic-ref --short HEAD; g rev-parse HEAD
if [ -n "$(g status --porcelain=v1 -uall --ignore-submodules=all | head -n 1)" ]; then echo dirty; else echo clean; fi
size
`,
  clone: PRE + `[ -z "$(ls -A)" ] || exit 3
g init -q -b "$BR" .
g fetch -q --no-tags --no-recurse-submodules "$SRC" "+refs/heads/fetched:refs/remotes/origin/$BR"
g remote add origin "$URL"
g checkout -q -B "$BR" "origin/$BR"
g branch -q --set-upstream-to="origin/$BR"
g rev-parse HEAD; size
`,
  // Fetches objects only (no ref moves, no FETCH_HEAD) so a refusal changes nothing visible.
  pull: PRE + `g fetch -q --no-tags --no-write-fetch-head --no-recurse-submodules "$SRC" refs/heads/fetched
if g merge-base --is-ancestor "$NEW" HEAD; then echo 0; g rev-parse HEAD; size; exit 0; fi
g merge-base --is-ancestor HEAD "$NEW" || exit 4
n=$(g diff --name-only HEAD "$NEW" | wc -l)
g merge -q --ff-only "$NEW"
g update-ref "refs/remotes/origin/$BR" "$NEW"
echo "$n"; g rev-parse HEAD; size
`,
  wipe: `set -eu\ncd "$WS"\nfind . -mindepth 1 -delete\n`,
}

export function dockerGitArgs(project: string, name: string, image: string, runtime: string | undefined, script: string, env: Record<string, string>, src?: string) {
  if (!UUID.test(project) || !UUID.test(name) || !image || image.startsWith('-')) throw new Error('Invalid sandbox identity')
  return ['run', '--rm', ...(runtime ? ['--runtime', runtime] : []), '--name', `oq-git-${name}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--pids-limit', '64', '--memory', '512m', '--cpus', '1', '--user', '1000:1000', '--tmpfs', '/tmp:rw,nosuid,noexec,size=64m',
    '--mount', `type=volume,source=oq-project-${project},target=/workspace`, ...(src ? ['--mount', `type=bind,source=${src},target=/src,readonly`] : []),
    '-e', 'WS=/workspace', ...(src ? ['-e', 'SRC=/src'] : []), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '--entrypoint', 'sh', image, '-c', script]
}

function run(bin: string, args: string[], opts: { env: Record<string, string>; cwd?: string; signal: AbortSignal; watch?: () => Promise<boolean>; input?: string }) {
  return new Promise<{ code: number; stdout: string; stderr: string; tooBig: boolean }>((resolve, reject) => {
    const child = spawn(bin, args, { env: opts.env, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', tooBig = false
    const stop = () => child.kill('SIGKILL')
    opts.signal.addEventListener('abort', stop, { once: true })
    const poll = opts.watch ? setInterval(() => { void opts.watch!().then(big => { if (big) { tooBig = true; stop() } }) }, 500) : undefined
    child.stdout.on('data', (d: Buffer) => { if (stdout.length < 100_000) stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { if (stderr.length < 100_000) stderr += d.toString() })
    child.on('error', () => { clearInterval(poll); reject(new GitError(503, 'Git is unavailable on the runner')) })
    child.on('close', code => { clearInterval(poll); opts.signal.removeEventListener('abort', stop); resolve({ code: code ?? 1, stdout, stderr, tooBig }) })
  })
}

export async function dirBytes(dir: string): Promise<number> {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    total += e.isDirectory() ? await dirBytes(p) : (await lstat(p)).size
  }
  return total
}

export class GitSync {
  private readonly busy = new Set<string>()
  private readonly o: Required<Omit<GitSyncOptions, 'exec'>> & { exec: VolumeExec }
  constructor(opts: GitSyncOptions) {
    this.o = { gitBin: 'git', baseUrl: 'https://github.com', log: () => {}, maxBytes: 1024 ** 3, timeoutMs: 300_000, maxJobs: 2, depth: 50, ...opts }
  }

  async handle(raw: unknown, signal?: AbortSignal): Promise<GitResult> {
    const r = raw as Partial<GitRequest> | null
    if (!r || typeof r !== 'object' || (r.action !== 'clone' && r.action !== 'pull')) throw new GitError(400, 'Invalid action')
    if (typeof r.project !== 'string' || !UUID.test(r.project)) throw new GitError(400, 'Invalid project')
    if (!validRepo(r.repo)) throw new GitError(400, 'Invalid repository name')
    if (r.branch !== undefined && !validBranch(r.branch)) throw new GitError(400, 'Invalid branch name')
    if (typeof r.token !== 'string' || !/^[\x21-\x7e]{1,500}$/.test(r.token)) throw new GitError(400, 'Invalid token')
    if (this.busy.has(r.project)) throw new GitError(409, 'A git job is already running for this project')
    if (this.busy.size >= this.o.maxJobs) throw new GitError(429, 'Runner capacity reached')
    this.busy.add(r.project)
    const ctl = new AbortController()
    const abort = () => ctl.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, this.o.timeoutMs)
    try { return await this.work(r as GitRequest, ctl.signal) }
    catch (e) {
      if (e instanceof GitError) throw e
      this.o.log('git job failed')
      throw new GitError(503, ctl.signal.aborted ? 'Git job timed out or was cancelled' : 'Git job failed')
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); this.busy.delete(r.project) }
  }

  private async work(r: GitRequest, signal: AbortSignal): Promise<GitResult> {
    const { exec, baseUrl, maxBytes } = this.o
    const url = `${baseUrl}/${r.repo}.git`
    const plain = `https://github.com/${r.repo}.git`
    const volume = (script: string, env: Record<string, string>, src?: string) => exec(r.project, script, env, src, signal)
    let branch = r.branch
    let old = ''
    let volumeBytes = 0
    const state = (await volume(SCRIPTS.inspect, {})).trim().split('\n')
    if (r.action === 'clone') {
      if (state[0] !== 'empty') throw new GitError(409, 'The project already has files; clone needs an empty project')
    } else {
      if (state[0] !== 'repo') throw new GitError(409, 'The project is not a git checkout; nothing to pull')
      if (state[3] === 'dirty') throw new GitError(409, 'The working tree has uncommitted changes; commit or discard them first')
      if (branch && branch !== state[1]) throw new GitError(409, `The project is on branch ${state[1]}; pull only updates the current branch`)
      branch = state[1] ?? ''; old = state[2] ?? ''; volumeBytes = Number(state[4]) * 1024 || 0
      if (!validBranch(branch)) throw new GitError(409, 'The checked-out branch name is not supported')
    }
    const tmp = await mkdtemp(path.join(tmpdir(), 'oq-git-'))
    let wrote = false
    try {
      await chmod(tmp, 0o755) // the uid 1000 container must read it; holds only the fetched bare repo
      const base = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: tmp, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', LC_ALL: 'C' }
      const origin = new URL(baseUrl).origin
      const proto = new URL(baseUrl).protocol === 'https:' ? 'https' : 'file'
      const git = async (args: string[], network: boolean) => {
        const env: Record<string, string> = { ...base }
        // Token scope: only requests under the base URL. Env, not argv, so `ps` never shows it.
        if (network && proto === 'https') Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${r.token}`).toString('base64')}` })
        const res = await run(this.o.gitBin, [...SAFE, '-c', 'protocol.allow=never', '-c', `protocol.${proto}.allow=always`, '-c', 'http.followRedirects=false', '-c', 'fetch.fsckObjects=true', '-c', 'transfer.fsckObjects=true', '-c', 'gc.auto=0', ...args], { env, cwd: tmp, signal, watch: async () => (await dirBytes(tmp).catch(() => 0)) > maxBytes })
        if (res.tooBig) throw new GitError(413, 'The repository is too large to import')
        if (res.code !== 0) {
          this.o.log(`git ${args[0]} exited ${res.code}`) // never stderr: it can echo URLs
          if (signal.aborted) throw new GitError(504, 'Git job timed out')
          throw new GitError(res.code === 128 && /40[134]|denied|authentication/i.test(res.stderr) ? 403 : 502, /40[134]|denied|authentication|not found|could not read/i.test(res.stderr) ? 'GitHub refused access or the repository or branch was not found' : 'Git fetch failed')
        }
        return res.stdout
      }
      const bare = path.join(tmp, 'repo')
      await git(['init', '-q', '--bare', '--template=', bare], false)
      if (!branch) {
        const head = /ref: refs\/heads\/(\S+)\s+HEAD/.exec(await git(['ls-remote', '--symref', url, 'HEAD'], true))?.[1]
        if (!validBranch(head)) throw new GitError(502, 'Could not determine the default branch')
        branch = head
      }
      const fetch = (extra: string[]) => git(['-C', bare, 'fetch', '-q', '--no-tags', '--no-recurse-submodules', ...extra, url, `+refs/heads/${branch}:refs/heads/fetched`], true)
      await fetch(['--depth', String(this.o.depth)])
      if (old && (await run(this.o.gitBin, ['-C', bare, 'cat-file', '-e', old], { env: base, signal })).code !== 0 && existsSync(path.join(bare, 'shallow'))) await fetch(['--unshallow'])
      const fetched = await dirBytes(bare)
      if (fetched + volumeBytes > maxBytes) throw new GitError(413, 'The repository is too large to import')
      const commit = (await git(['-C', bare, 'rev-parse', 'refs/heads/fetched'], false)).trim()
      const env = { BR: branch, URL: plain, NEW: commit, OLD: old }
      wrote = r.action === 'clone'
      let out: string[]
      try { out = (await volume(SCRIPTS[r.action], env, bare)).trim().split('\n') }
      catch (e) {
        const msg = (e as { exitCode?: number }).exitCode
        if (msg === 4) throw new GitError(409, 'The local branch has diverged from GitHub; pull only fast-forwards')
        if (msg === 3) wrote = false // files appeared since inspect: they are not ours, never wipe them
        if (msg === 3) throw new GitError(409, 'The project already has files; clone needs an empty project')
        throw e
      }
      const bytes = Number(out[out.length - 1]) * 1024
      if (r.action === 'clone') {
        if (bytes > maxBytes) throw new GitError(413, 'The repository is too large to import')
        wrote = false
        return { ok: true, branch, commit: out[0] ?? '', bytes }
      }
      return { ok: true, branch, commit: out[1] ?? '', changed: Number(out[0]), bytes }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch(() => {})
      // A failed clone must leave the project empty again, not a half repo.
      if (wrote) await exec(r.project, SCRIPTS.wipe, {}, undefined, AbortSignal.timeout(60_000)).catch(() => this.o.log('cleanup of failed clone did not complete'))
    }
  }
}

/** Real Docker implementation. Only this part is not exercised by tests. */
export function dockerVolumeExec(image: string, runtime?: string): VolumeExec {
  return async (project, script, env, src, signal) => {
    const name = randomUUID()
    const killer = () => { const k = spawn('docker', ['rm', '-f', `oq-git-${name}`], { stdio: 'ignore' }); k.on('error', () => {}); k.unref() }
    // Create the volume first (as a mount would) so the host quota watcher sees it before data lands.
    await run('docker', ['volume', 'create', `oq-project-${project}`], { env: { PATH: process.env.PATH ?? '' }, signal })
    signal.addEventListener('abort', killer, { once: true })
    try {
      const res = await run('docker', dockerGitArgs(project, name, image, runtime, script, env, src), { env: { PATH: process.env.PATH ?? '' }, signal })
      if (res.code !== 0) throw Object.assign(new Error('volume step failed'), { exitCode: res.code })
      return res.stdout
    } finally { signal.removeEventListener('abort', killer); killer() }
  }
}
