import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { GitError, GitSync, dockerGitArgs, validBranch, validRepo } from '../src/git-sync.js'
import type { VolumeExec } from '../src/git-sync.js'

const P = '11111111-1111-4111-8111-111111111111'
const TOKEN = 'ghp_SECRETTOKENVALUE0123456789'
const sh = (cwd: string, ...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'protocol.file.allow=always', ...a], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: cwd, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
const mk = () => mkdtempSync(path.join(tmpdir(), 'oq-gt-'))

// Local "GitHub": bare repo at <root>/octo/hello.git plus a work clone to commit from.
function fixture(opts: { hostile?: boolean; big?: boolean } = {}) {
  const root = mk(), work = mk()
  mkdirSync(path.join(root, 'octo'))
  sh(root, 'init', '-q', '--bare', '-b', 'main', 'octo/hello.git')
  sh(work, 'init', '-q', '-b', 'main')
  writeFileSync(path.join(work, 'a.txt'), 'one\n')
  if (opts.hostile) {
    writeFileSync(path.join(work, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = https://example.invalid/x.git\n')
    symlinkSync('/etc', path.join(work, 'escape'))
    mkdirSync(path.join(work, 'hooks')); writeFileSync(path.join(work, 'hooks/post-checkout'), '#!/bin/sh\ntouch /tmp/oq-hook-ran\n', { mode: 0o755 })
  }
  if (opts.big) writeFileSync(path.join(work, 'big.bin'), Buffer.alloc(300_000, 7))
  sh(work, 'add', '-A'); sh(work, 'commit', '-qm', 'one')
  sh(work, 'remote', 'add', 'origin', path.join(root, 'octo/hello.git')); sh(work, 'push', '-q', 'origin', 'main')
  const push = (file: string, text: string) => { writeFileSync(path.join(work, file), text); sh(work, 'add', '-A'); sh(work, 'commit', '-qm', file); sh(work, 'push', '-q', 'origin', 'main') }
  return { root, work, push, base: `file://${root}` }
}

// Runs the real volume scripts against a local directory instead of Docker.
function fakeExec(ws: string): VolumeExec {
  return (_p, script, env, src, signal) => new Promise((resolve, reject) => {
    const c = spawn('sh', ['-c', script], { env: { PATH: process.env.PATH!, WS: ws, ...(src ? { SRC: src } : {}), ...env, GIT_TEMPLATE_DIR: '/nonexistent' }, signal })
    let out = ''
    c.stdout.on('data', d => { out += d })
    c.on('close', code => code === 0 ? resolve(out) : reject(Object.assign(new Error('x'), { exitCode: code })))
    c.on('error', reject)
  })
}
const setup = (f = fixture(), extra: Partial<ConstructorParameters<typeof GitSync>[0]> = {}) => {
  const ws = mk(), logs: string[] = []
  return { f, ws, logs, g: new GitSync({ baseUrl: f.base, exec: fakeExec(ws), log: m => logs.push(m), ...extra }) }
}
const req = (extra = {}) => ({ action: 'clone', project: P, repo: 'octo/hello', token: TOKEN, ...extra })
const code = async (p: Promise<unknown>) => { try { await p } catch (e) { return e instanceof GitError ? e.status : -1 } return 0 }

test('validation rejects bad repos and branches', async () => {
  for (const r of ['', 'a', 'a/b/c', '../x', 'a/..', '-a/b', 'a/-b', './x', 'a/.', 'a b/c', 'a/b;rm', 'a/b\n', 'a/b?x', 'a:b/c', 'x'.repeat(101) + '/y', 'a/b%2e', 'a\\b/c']) assert.equal(validRepo(r), false, r)
  assert.equal(validRepo('octo/hello.js-1_x'), true)
  for (const b of ['', '-x', '--upload-pack=x', 'a..b', 'a b', 'a\x00b', 'a\nb', '/a', 'a/', 'a//b', '.a', 'a/.b', 'a.lock', 'a.', 'a@{1}', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', 'x'.repeat(201)]) assert.equal(validBranch(b), false, JSON.stringify(b))
  assert.equal(validBranch('feature/x-1.2_y'), true)
  const { g } = setup()
  for (const bad of [{ repo: '../x' }, { branch: '-x' }, { branch: 'a..b' }, { project: 'nope' }, { token: '' }, { token: 'a b' }, { action: 'push' }]) assert.equal(await code(g.handle(req(bad))), 400, JSON.stringify(bad))
  assert.equal(await code(g.handle(null)), 400)
})

test('clone, then pull fast-forwards and reports changed files', async () => {
  const { f, ws, g } = setup(fixture({ hostile: true }))
  const r = await g.handle(req())
  assert.equal(r.branch, 'main'); assert.match(r.commit, /^[0-9a-f]{40}$/); assert.ok(r.bytes! > 0)
  assert.equal(readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'one\n')
  // Stored remote is the plain github URL, with no credentials anywhere in .git
  assert.match(sh(ws, 'config', '--get', 'remote.origin.url'), /^https:\/\/github\.com\/octo\/hello\.git$/)
  f.push('b.txt', 'two\n'); f.push('a.txt', 'changed\n')
  const p = await g.handle(req({ action: 'pull' }))
  assert.equal(p.changed, 2); assert.equal(readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'changed\n')
  assert.equal(p.commit, sh(f.work, 'rev-parse', 'HEAD'))
  assert.equal((await g.handle(req({ action: 'pull' }))).changed, 0)
})

test('hostile repo: no hooks run, no submodules, symlink stays a symlink, token not persisted or logged', async () => {
  rmSync('/tmp/oq-hook-ran', { force: true })
  const { ws, logs, g } = setup(fixture({ hostile: true }))
  await g.handle(req({ token: TOKEN }))
  assert.equal(existsSync('/tmp/oq-hook-ran'), false)
  assert.ok(lstatSync(path.join(ws, 'escape')).isSymbolicLink()); assert.equal(readlinkSync(path.join(ws, 'escape')), '/etc')
  assert.equal(existsSync(path.join(ws, 'x')), false) // submodule not materialised
  const all = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? all(path.join(d, e.name)) : e.isSymbolicLink() ? [] : [path.join(d, e.name)])
  for (const file of all(path.join(ws, '.git'))) assert.equal(readFileSync(file).includes(TOKEN), false, file)
  assert.equal(readFileSync(path.join(ws, '.git/config'), 'utf8').includes('Authorization'), false)
  assert.equal(logs.join('\n').includes(TOKEN), false)
})

test('clone refuses a non-empty project and keeps its files', async () => {
  const { ws, g } = setup()
  writeFileSync(path.join(ws, 'mine.txt'), 'x')
  assert.equal(await code(g.handle(req())), 409)
  assert.deepEqual(readdirSync(ws), ['mine.txt'])
})

test('pull refuses dirty and diverged trees and changes nothing', async () => {
  const { f, ws, g } = setup()
  await g.handle(req())
  writeFileSync(path.join(ws, 'a.txt'), 'dirty\n')
  f.push('b.txt', 'new\n')
  assert.equal(await code(g.handle(req({ action: 'pull' }))), 409)
  assert.equal(readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'dirty\n'); assert.equal(existsSync(path.join(ws, 'b.txt')), false)
  sh(ws, 'checkout', '-q', 'a.txt')
  writeFileSync(path.join(ws, 'local.txt'), 'l'); sh(ws, 'add', '-A'); sh(ws, 'commit', '-qm', 'local')
  const head = sh(ws, 'rev-parse', 'HEAD'), refs = sh(ws, 'for-each-ref')
  assert.equal(await code(g.handle(req({ action: 'pull' }))), 409)
  assert.equal(sh(ws, 'rev-parse', 'HEAD'), head); assert.equal(sh(ws, 'for-each-ref'), refs); assert.equal(sh(ws, 'status', '--porcelain'), '')
  assert.equal(existsSync(path.join(ws, 'b.txt')), false)
  assert.equal(await code(setup().g.handle(req({ action: 'pull' }))), 409) // empty project, nothing to pull
})

test('size cap refuses oversized repos and cleans up', async () => {
  const { ws, g } = setup(fixture({ big: true }), { maxBytes: 100_000 })
  assert.equal(await code(g.handle(req())), 413)
  assert.deepEqual(readdirSync(ws), [])
})

test('failed clone wipes the volume; temp dirs are removed', async () => {
  const before = readdirSync(tmpdir()).filter(n => n.startsWith('oq-git-')).length
  const { ws, g } = setup()
  assert.equal(await code(g.handle(req({ branch: 'missing' }))), 502)
  assert.deepEqual(readdirSync(ws), [])
  // volume step fails after files were written: simulate by throwing after the real clone ran
  const f = fixture(), ws2 = mk(), real = fakeExec(ws2)
  const g2 = new GitSync({ baseUrl: f.base, exec: async (p, s, e, src, sig) => { const o = await real(p, s, e, src, sig); if (src) throw new Error('boom'); return o } })
  assert.equal(await code(g2.handle(req())), 503)
  assert.deepEqual(readdirSync(ws2), [])
  assert.equal(readdirSync(tmpdir()).filter(n => n.startsWith('oq-git-')).length, before)
})

test('one job per project (409) and global cap (429)', async () => {
  const f = fixture(); let release!: () => void
  const gate = new Promise<void>(r => { release = r })
  const g = new GitSync({ baseUrl: f.base, maxJobs: 2, exec: async () => { await gate; return 'empty\n' } })
  const first = g.handle(req()).catch(() => {})
  assert.equal(await code(g.handle(req())), 409)
  const other = g.handle(req({ project: '22222222-2222-4222-8222-222222222222' })).catch(() => {})
  assert.equal(await code(g.handle(req({ project: '33333333-3333-4333-8333-333333333333' }))), 429)
  release(); await Promise.all([first, other])
  assert.equal(await code(g.handle(req({ action: 'pull' }))), 409) // slot freed again, now fails on state
})

test('docker args: no network, no token slot, bounded', () => {
  const a = dockerGitArgs(P, '22222222-2222-4222-8222-222222222222', 'img', 'runsc', 'true', { BR: 'main' }, '/tmp/s')
  assert.ok(a.join(' ').includes('--network none --read-only --cap-drop ALL')); assert.ok(a.includes('1000:1000'))
  assert.ok(a.includes('type=bind,source=/tmp/s,target=/src,readonly'))
  assert.equal(a.join(' ').includes('--privileged'), false)
  assert.throws(() => dockerGitArgs('x', 'y', 'img', undefined, '', {}))
})
