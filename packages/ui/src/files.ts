/** Pure helpers for the read-only file browser. The listing format comes from the `list_dir` tool. */
export interface Entry { name: string; dir: boolean }
export interface Listing { entries: Entry[]; more: number }

/** Directories end with "/"; a trailing "...[N more]" line means the listing was cut at 300 names. */
export function parseListing(output: string): Listing {
  const entries: Entry[] = []
  let more = 0
  for (const line of output.split('\n')) {
    if (!line) continue
    const cut = /^\.\.\.\[(\d+) more\]$/.exec(line)
    if (cut) { more = Number(cut[1]); continue }
    entries.push(line.endsWith('/') ? { name: line.slice(0, -1), dir: true } : { name: line, dir: false })
  }
  // Folders first, then files, each alphabetical, so the tree reads like a file manager.
  entries.sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
  return { entries, more }
}

export const joinPath = (dir: string, name: string) => (dir === '.' || dir === '' ? name : `${dir}/${name}`)

export function crumbs(path: string): { label: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  return parts.map((label, index) => ({ label, path: parts.slice(0, index + 1).join('/') }))
}

export const lineCount = (text: string) => (text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0))
