import fs from 'node:fs/promises'
import path from 'node:path'

const excluded = /(^|\/)(\.[^/]+|node_modules|dist|build|coverage|vendor|__pycache__)(\/|$)|\.(pem|key|pfx|p12)$/i
/** @param {string} root @param {string} target */
const within = (root, target) => { const relative = path.relative(root, target); return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative)) }
/** Literal, bounded search shared by the local agent and the network-isolated worker.
 * @param {string} cwd
 * @param {unknown} value
 * @param {AbortSignal} [signal]
 */
export async function searchWorkspace(cwd, value, signal) {
  const input = /** @type {Record<string, unknown>} */ (value && typeof value === 'object' ? value : {})
  if (typeof input?.query !== 'string' || !input.query.trim() || input.query.length > 200 || /[\r\n\0]/.test(input.query)) throw new Error('query must be a non-empty single line of at most 200 characters')
  const relative = input.path ?? '.'
  if (typeof relative !== 'string' || relative.includes('\0')) throw new Error('path must be a project-relative path')
  if (input.case_sensitive !== undefined && typeof input.case_sensitive !== 'boolean') throw new Error('case_sensitive must be boolean')
  const limit = input.max_results ?? 100
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error('max_results must be between 1 and 200')
  const root = await fs.realpath(cwd), requested = path.resolve(root, relative)
  if (!within(root, requested) || excluded.test(path.relative(root, requested).replaceAll('\\', '/'))) throw new Error('Search path is outside the workspace or excluded')
  let ancestor = root
  for (const segment of path.relative(root, requested).split(path.sep).filter(Boolean)) {
    ancestor = path.join(ancestor, segment)
    if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('Symlink search paths are excluded')
  }
  const start = await fs.realpath(requested)
  if (!within(root, start) || excluded.test(path.relative(root, start).replaceAll('\\', '/'))) throw new Error('Search path is outside the workspace or excluded')
  const pending = [start], matches = []
  const needle = input.case_sensitive ? input.query : input.query.toLowerCase()
  let visited = 0, scanned = 0, skipped = 0, bytesRead = 0, outputSize = 0, limited = false
  const deadline = Date.now() + 5000
  while (pending.length) {
    signal?.throwIfAborted()
    if (++visited > 2000 || Date.now() > deadline || bytesRead >= 8_000_000) { limited = true; break }
    const file = /** @type {string} */ (pending.pop())
    try {
      const stat = await fs.lstat(file)
      if (stat.isSymbolicLink()) { skipped++; continue }
      const name = path.relative(root, file).replaceAll('\\', '/')
      if (name && excluded.test(name)) { skipped++; continue }
      if (stat.isDirectory()) {
        const entries = []
        const directory = await fs.opendir(file)
        for await (const entry of directory) {
          signal?.throwIfAborted()
          if (entries.length + pending.length >= 2000 || Date.now() > deadline) { limited = true; break }
          if (entry.isSymbolicLink() || excluded.test(entry.name)) { skipped++; continue }
          entries.push(path.join(file, entry.name))
        }
        pending.push(...entries.sort().reverse())
        continue
      }
      if (!stat.isFile() || stat.size > 256_000) { skipped++; continue }
      // Read through a bounded buffer; a growing file cannot defeat the size limit.
      const handle = await fs.open(file, 'r')
      let buffer
      try { const chunk = Buffer.alloc(256_001); const result = await handle.read(chunk, 0, chunk.length, 0); buffer = chunk.subarray(0, result.bytesRead) } finally { await handle.close() }
      bytesRead += buffer.length
      if (buffer.length > 256_000 || buffer.includes(0)) { skipped++; continue }
      scanned++
      const lines = buffer.toString('utf8').split(/\r?\n/)
      for (const [index, line] of lines.entries()) {
        if ((input.case_sensitive ? line : line.toLowerCase()).includes(needle)) {
          const match = { path: name, line: index + 1, text: line.slice(0, 500) }
          const size = JSON.stringify(match).length + 1
          if (outputSize + size > 24_000) { limited = true; break }
          matches.push(match); outputSize += size
          if (matches.length >= limit) { limited = true; break }
        }
      }
      if (limited || matches.length >= limit) break
    } catch (error) {
      signal?.throwIfAborted()
      if (!(error instanceof Error) || !['ENOENT', 'EACCES', 'EPERM', 'EISDIR'].includes(/** @type {NodeJS.ErrnoException} */ (error).code ?? '')) throw error
      skipped++
    }
  }
  return JSON.stringify({ matches, scanned_files: scanned, skipped_entries: skipped, limit_reached: limited, note: limited ? 'Search stopped at a resource or result limit. Narrow path or query to continue.' : 'Hidden, credential, generated and dependency paths are excluded; this is not a complete Git-ignore parser.' })
}
