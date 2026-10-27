import fs from 'node:fs/promises'
import path from 'node:path'
import { optNum, str, truncate } from './types.js'
import type { Tool } from './types.js'

function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/**
 * Resolve `p` against the workspace and make sure the result stays inside it, even through
 * symlinks: the nearest existing ancestor is realpath'ed before the check.
 */
export async function resolveInside(cwd: string, p: string): Promise<string> {
  const root = await fs.realpath(cwd)
  const abs = path.resolve(root, p)
  let probe = abs
  for (;;) {
    try {
      const real = await fs.realpath(probe)
      const resolved = path.join(real, path.relative(probe, abs))
      if (!isInside(root, resolved)) throw new Error(`path is outside the workspace: ${p}`)
      return resolved
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      const parent = path.dirname(probe)
      if (parent === probe) throw new Error(`cannot resolve path: ${p}`)
      probe = parent
    }
  }
}

export const readFile: Tool = {
  spec: {
    name: 'read_file',
    description: 'Read a text file in the workspace. Optionally a 1-based inclusive line range.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        start_line: { type: 'integer' },
        end_line: { type: 'integer' },
      },
      required: ['path'],
    },
  },
  risk: 'read',
  describe: (i) => `read ${str(i, 'path')}`,
  async run(input, ctx) {
    const file = await resolveInside(ctx.cwd, str(input, 'path'))
    const text = await fs.readFile(file, 'utf8')
    const start = optNum(input, 'start_line')
    const end = optNum(input, 'end_line')
    if (start === undefined && end === undefined) return truncate(text)
    const lines = text.split('\n')
    return truncate(lines.slice(Math.max(0, (start ?? 1) - 1), end ?? lines.length).join('\n'))
  },
}

export const listDir: Tool = {
  spec: {
    name: 'list_dir',
    description: 'List a directory in the workspace. Directories end with "/".',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory relative to the workspace root. Use "." for the root.' } },
      required: ['path'],
    },
  },
  risk: 'read',
  describe: (i) => `list ${str(i, 'path')}`,
  async run(input, ctx) {
    const dir = await resolveInside(ctx.cwd, str(input, 'path'))
    const entries = await fs.readdir(dir, { withFileTypes: true })
    const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort()
    const shown = names.slice(0, 300)
    return shown.join('\n') + (names.length > shown.length ? `\n...[${names.length - shown.length} more]` : '')
  },
}

export const writeFile: Tool = {
  spec: {
    name: 'write_file',
    description: 'Create or overwrite a file in the workspace with the given content. Creates parent directories.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, content: { type: 'string' } },
      required: ['path', 'content'],
    },
  },
  risk: 'write',
  describe: (i) => `write ${str(i, 'path')} (${str(i, 'content').length} chars)`,
  async run(input, ctx) {
    const file = await resolveInside(ctx.cwd, str(input, 'path'))
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, str(input, 'content'), 'utf8')
    return `wrote ${str(input, 'path')}`
  },
}

export const editFile: Tool = {
  spec: {
    name: 'edit_file',
    description:
      'Replace exactly one occurrence of old_string with new_string in a file. old_string must match exactly and be unique; include surrounding lines if needed.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['path', 'old_string', 'new_string'],
    },
  },
  risk: 'write',
  describe: (i) => `edit ${str(i, 'path')}`,
  async run(input, ctx) {
    const file = await resolveInside(ctx.cwd, str(input, 'path'))
    const oldStr = str(input, 'old_string')
    if (oldStr === '') throw new Error('old_string must not be empty')
    const text = await fs.readFile(file, 'utf8')
    const count = text.split(oldStr).length - 1
    if (count === 0) throw new Error('old_string not found in file')
    if (count > 1) throw new Error(`old_string is not unique (${count} matches); add more context`)
    await fs.writeFile(file, text.replace(oldStr, () => str(input, 'new_string')), 'utf8')
    return `edited ${str(input, 'path')}`
  },
}
