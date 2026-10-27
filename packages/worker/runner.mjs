import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { searchWorkspace } from '../core/src/tools/search-engine.mjs'
import { snapshotFile, applyFileChange, readFileChange } from '../core/src/tools/changes.mjs'

const root = await fs.realpath(process.env.OQELIRA_WORKER_ROOT ?? '/workspace')
const isInside = p => { const rel = path.relative(root, p); return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) }
const blocked = /(^|\/)(\.env(?!\.example(?:\/|$))(?:\.[^/]*)?|\.git|\.oqelira|\.ssh|\.azure|\.aws|node_modules)(\/|$)|\.(pem|key|pfx|p12)$/i
const truncate = text => text.length > 30000 ? text.slice(0, 30000) + '\n[truncated]' : text
function str(input, key) { if (typeof input?.[key] !== 'string') throw new Error(`Expected ${key}`); return input[key] }
async function inside(p) {
  if (blocked.test(p.replaceAll('\\', '/'))) throw new Error('Credential and internal paths are excluded')
  const abs = path.resolve(root, p)
  if (!isInside(abs)) throw new Error('Path is outside project')
  let probe = abs
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      const resolved = path.join(real, path.relative(probe, abs))
      if (!isInside(resolved)) throw new Error('Symlink escapes project')
      if (blocked.test(path.relative(root, resolved).replaceAll('\\', '/'))) throw new Error('Credential and internal paths are excluded')
      return resolved
    } catch (e) {
      if (e.code !== 'ENOENT') throw e
      const parent = path.dirname(probe)
      if (parent === probe) throw new Error('Cannot resolve project path')
      probe = parent
    }
  }
}
async function tool(name, input) {
  if (name === 'file_snapshot') return JSON.stringify(await snapshotFile(root, str(input, 'path')))
  if (name === 'apply_file_change' || name === 'revert_file_change') return applyFileChange(root, input, name === 'revert_file_change')
  if (name === 'read_file_change') return JSON.stringify(await readFileChange(root, str(input, 'change_id')))
  if (name === 'search_text') return searchWorkspace(root, input)
  if (name === 'run_command') {
    const command = str(input, 'command')
    const timeout = input.timeout_seconds ?? 60
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 60) throw new Error('Command timeout must be between 1 and 60 seconds')
    return new Promise((resolve, reject) => {
      // No server environment, database URL, auth cookie or Foundry key is passed.
      const child = spawn('/bin/sh', ['-c', command], { cwd: root, detached: true, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp', TMPDIR: '/tmp' } })
      let output = '', timedOut = false
      const kill = () => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
      const timer = setTimeout(() => { timedOut = true; kill() }, timeout * 1000)
      const append = data => { output += data.toString(); if (output.length > 60000) kill() }
      child.stdout.on('data', append); child.stderr.on('data', append)
      child.on('error', e => { clearTimeout(timer); reject(e) })
      child.on('close', code => { clearTimeout(timer); resolve(truncate(output) + `\n[${timedOut ? 'timed out' : `exit code ${code}`}]`) })
    })
  }
  const file = await inside(str(input, 'path'))
  if (name === 'list_dir') return (await fs.readdir(file, { withFileTypes: true })).filter(e => !blocked.test(e.name)).slice(0, 300).map(e => e.name + (e.isDirectory() ? '/' : '')).sort().join('\n')
  if (name === 'read_file') {
    const stat = await fs.stat(file)
    if (stat.size > 1_000_000) throw new Error('File is too large')
    const text = await fs.readFile(file, 'utf8')
    if (text.includes('\0')) throw new Error('Binary files are unsupported')
    const start = input.start_line ?? 1, end = input.end_line
    if (!Number.isInteger(start) || start < 1 || (end !== undefined && (!Number.isInteger(end) || end < start))) throw new Error('Invalid line range')
    return truncate(text.split('\n').slice(start - 1, end).join('\n'))
  }
  if (name === 'write_file') { const text = str(input, 'content'); if (text.length > 1_000_000) throw new Error('File is too large'); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); return 'wrote ' + input.path }
  if (name === 'edit_file') {
    const old = str(input, 'old_string'), replacement = str(input, 'new_string')
    if (!old) throw new Error('Empty match')
    const stat = await fs.stat(file); if (stat.size > 1_000_000) throw new Error('File is too large')
    const text = await fs.readFile(file, 'utf8')
    if (text.split(old).length !== 2) throw new Error('Match must occur exactly once')
    await fs.writeFile(file, text.replace(old, () => replacement)); return 'edited ' + input.path
  }
  throw new Error('Unknown tool')
}
try {
  let input = ''
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 1_100_000) throw new Error('Tool input is too large') }
  const request = JSON.parse(input)
  process.stdout.write(JSON.stringify({ output: await tool(request.name, request.input) }))
} catch (e) { process.stdout.write(JSON.stringify({ error: e instanceof Error ? e.message : 'Tool failed' })) }
