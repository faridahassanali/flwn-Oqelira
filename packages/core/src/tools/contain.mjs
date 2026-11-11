import fs from 'node:fs/promises'
import path from 'node:path'

/** @param {string} root @param {string} target */
export const isInside = (root, target) => {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/**
 * Resolve `p` inside `cwd` through symlinks. The nearest existing ancestor is realpath'ed; a path component that
 * exists as a symlink but cannot be resolved (dangling or looping) is refused, because a later write would follow it.
 * @param {string} cwd @param {string} p @param {RegExp} blocked tested against the workspace-relative path, before and after resolution
 */
export async function resolveInside(cwd, p, blocked) {
  const root = await fs.realpath(cwd), abs = path.resolve(root, p)
  /** @param {string} target */
  const rel = target => path.relative(root, target).replaceAll('\\', '/')
  if (!isInside(root, abs)) throw new Error(`path is outside the workspace: ${p}`)
  if (blocked.test(rel(abs))) throw new Error('Credential and internal paths are excluded')
  let probe = abs
  for (;;) {
    try {
      const real = await fs.realpath(probe), resolved = path.join(real, path.relative(probe, abs))
      if (!isInside(root, resolved)) throw new Error(`path is outside the workspace: ${p}`)
      if (blocked.test(rel(resolved))) throw new Error('Credential and internal paths are excluded')
      return resolved
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') throw e
      if (await fs.lstat(probe).then(() => true, () => false)) throw new Error(`dangling symlink in path: ${p}`)
      const parent = path.dirname(probe)
      if (parent === probe) throw new Error(`cannot resolve path: ${p}`)
      probe = parent
    }
  }
}

/** Create or truncate-and-write without following a symlink at the final component, even if it was swapped in after the check. */
/** @param {string} file @param {string} text */
export async function writeNoFollow(file, text) {
  const c = fs.constants, handle = await fs.open(file, c.O_WRONLY | c.O_CREAT | c.O_TRUNC | c.O_NOFOLLOW, 0o666)
  try { await handle.writeFile(text, 'utf8') } finally { await handle.close() }
}

/** Read without following a symlink at the final component. */
/** @param {string} file */
export async function readNoFollow(file) {
  const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)
  try { return await handle.readFile('utf8') } finally { await handle.close() }
}
