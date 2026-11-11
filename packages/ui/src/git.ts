/** Parses the combined output of `git status --short --branch; git diff` from GET /api/git. */
export interface GitFile { code: string; path: string }
export interface GitView {
  state: 'ok' | 'not-a-repo' | 'error'
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  detail?: string
  files: GitFile[]
  diff: string
}

export function parseGit(output: string): GitView {
  const view: GitView = { state: 'ok', ahead: 0, behind: 0, files: [], diff: '' }
  const text = output.trim()
  if (/not a git repository/i.test(text)) return { ...view, state: 'not-a-repo' }
  const lines = output.split('\n')
  const diffStart = lines.findIndex(line => line.startsWith('diff --git'))
  const head = diffStart < 0 ? lines : lines.slice(0, diffStart)
  view.diff = diffStart < 0 ? '' : lines.slice(diffStart).join('\n').trimEnd()
  const banner = head.find(line => line.startsWith('## '))
  if (!banner) return text ? { ...view, state: 'error', detail: text.slice(0, 500) } : { ...view, state: 'not-a-repo' }
  const noCommits = /^## (?:No commits yet on|Initial commit on) (.+)$/.exec(banner)
  if (noCommits) { view.branch = noCommits[1]; view.detail = 'No commits yet' }
  else {
    const match = /^## (.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(banner)
    if (match) {
      view.branch = match[1]; view.upstream = match[2]
      view.ahead = Number(/ahead (\d+)/.exec(match[3] ?? '')?.[1] ?? 0)
      view.behind = Number(/behind (\d+)/.exec(match[3] ?? '')?.[1] ?? 0)
    }
    if (view.branch?.startsWith('HEAD (no branch)')) { view.branch = undefined; view.detail = 'Detached HEAD' }
  }
  for (const line of head) if (line && !line.startsWith('## ')) view.files.push({ code: line.slice(0, 2).trim() || '?', path: line.slice(3) })
  return view
}

export const statusLabel = (code: string) => ({ M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', '?': 'New', '??': 'New', U: 'Conflict' } as Record<string, string>)[code] ?? 'Changed'

/** Classifies each diff line so the viewer can tint additions and removals without parsing in the template. */
export function diffLines(diff: string): { kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx'; text: string }[] {
  return diff.split('\n').map(text => {
    const kind = text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ') ? 'meta'
      : text.startsWith('@@') ? 'hunk' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'del' : 'ctx'
    return { kind, text }
  })
}
