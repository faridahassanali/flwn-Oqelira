import { escape } from './cloud.js'
import { icon } from './icons.js'
import { crumbs, joinPath, lineCount } from './files.js'
import type { Listing } from './files.js'
import { diffLines, parseGit, statusLabel } from './git.js'
import type { GithubStatus } from './github.js'

/** HTML builders for the Files and Git pages. State lives in the workspace; these only describe it. */
export type TreeNode = Listing | 'loading' | { error: string }
export interface FilesState {
  projectId?: string
  tree: Map<string, TreeNode>
  expanded: Set<string>
  file?: { path: string; text?: string; error?: string; loading?: boolean }
  editing: 'none' | 'edit' | 'new'
  readOnly: boolean
  disabled: boolean
}

function treeList(state: FilesState, dir: string): string {
  const node = state.tree.get(dir)
  if (node === undefined || node === 'loading') return '<li class="tree-note" role="status"><span class="skeleton-line"></span></li>'
  if ('error' in node) return `<li class="tree-note error" role="alert"><span>${escape(node.error)}</span><button data-tree-retry="${escape(dir)}" data-fk="retry-${escape(dir)}">${icon('Refresh')} Try again</button></li>`
  if (!node.entries.length) return '<li class="tree-note">This folder is empty.</li>'
  const rows = node.entries.map(entry => {
    const path = joinPath(dir, entry.name)
    if (!entry.dir) return `<li><button class="tree-row" data-tree-file="${escape(path)}" data-fk="f-${escape(path)}" ${state.file?.path === path ? 'aria-current="true"' : ''}>${icon('File')}<span>${escape(entry.name)}</span></button></li>`
    const open = state.expanded.has(path)
    return `<li><button class="tree-row" data-tree-dir="${escape(path)}" data-fk="d-${escape(path)}" aria-expanded="${open}">${icon('ChevronRight', 'chevron')}${icon(open ? 'FolderOpen' : 'Folder')}<span>${escape(entry.name)}</span></button>${open ? `<ul class="tree">${treeList(state, path)}</ul>` : ''}</li>`
  }).join('')
  return rows + (node.more ? `<li class="tree-note">${node.more} more not shown.</li>` : '')
}

function viewer(state: FilesState): string {
  const file = state.file
  if (state.editing !== 'none') {
    const isNew = state.editing === 'new'
    return `<form id="file-form" class="editor"><div class="viewer-head"><div><p class="eyebrow">${isNew ? 'New file' : 'Edit file'}</p><h2>${isNew ? 'Name it and write it.' : escape(file?.path ?? '')}</h2></div></div><label>Project-relative file path<input name="path" required maxlength="1000" value="${escape(isNew ? '' : file?.path ?? '')}" ${isNew ? '' : 'readonly'} placeholder="src/main.ts"></label><label>File content<textarea name="content" maxlength="20000" rows="16">${escape(isNew ? '' : file?.text ?? '')}</textarea></label><div class="form-actions"><button type="submit" class="save-button" ${state.disabled || state.readOnly ? 'disabled' : ''}>${icon('Check')} Save file to project</button><button type="button" data-edit-cancel>Cancel</button></div></form>`
  }
  if (!file) return `<div class="empty-state viewer-empty">${icon('FileText')}<p>Choose a file to read it.</p><small>Files open read-only. Use Edit file to change one.</small></div>`
  const path = crumbs(file.path).map(part => escape(part.label)).join(`<span class="sep" aria-hidden="true">/</span>`)
  const body = file.loading ? '<div class="load-state" role="status"><span class="skeleton-line"></span></div>'
    : file.error ? `<div class="notice error" role="alert"><div>${icon('Circle')}<span>${escape(file.error)}</span></div><button data-tree-file="${escape(file.path)}" data-fk="reopen">${icon('Refresh')} Try again</button></div>`
    : file.text === '' ? '<div class="empty-state">This file is empty.</div>'
    : `<pre class="code-view" tabindex="0" aria-label="Contents of ${escape(file.path)}">${(file.text ?? '').split('\n').map((line, index) => `<span class="code-line" data-n="${index + 1}">${escape(line)}\n</span>`).join('')}</pre>`
  return `<div class="viewer-head"><div><p class="eyebrow">Read-only</p><h2 class="path">${path}</h2>${file.text !== undefined ? `<small class="muted">${lineCount(file.text)} line${lineCount(file.text) === 1 ? '' : 's'}</small>` : ''}</div><button data-edit-file ${state.disabled || state.readOnly || file.text === undefined ? 'disabled' : ''}>${icon('Pencil')} Edit file</button></div>${body}`
}

export function filesPage(state: FilesState): string {
  if (!state.projectId) return `<div class="page-panel"><p class="eyebrow">Your project</p><h1>Project files.</h1><div class="empty-state">${icon('Folder')}<p>Choose a project to browse its files.</p></div></div>`
  return `<div class="page-wide"><div class="page-title"><p class="eyebrow">Your project</p><h1>Project files.</h1><p>Browse the isolated workspace. Files open read-only until you choose to edit.</p></div><div class="files-layout"><section class="files-tree" aria-label="File tree"><div class="files-tree-head"><strong>Files</strong><span class="head-actions"><button class="icon-button" data-new-file aria-label="New file" data-tooltip="New file" ${state.disabled || state.readOnly ? 'disabled' : ''}>${icon('Plus')}</button><button class="icon-button" data-tree-refresh aria-label="Refresh files" data-tooltip="Refresh files" ${state.disabled ? 'disabled' : ''}>${icon('Refresh')}</button></span></div><ul class="tree root">${treeList(state, '.')}</ul></section><section class="files-viewer" aria-label="File viewer" aria-live="polite">${viewer(state)}</section></div></div>`
}

export interface GitState {
  projectId?: string
  raw?: string
  loading: boolean
  error: string
  /** Optional extra card (repository source), built by the caller. */
  source: string
  disabled: boolean
}

export function gitPage(state: GitState): string {
  const head = `<div class="page-title"><p class="eyebrow">Your project</p><h1>Git changes.</h1><p>Read from the isolated project. Ask the agent to initialize Git or create reviewed commits.</p></div>`
  if (!state.projectId) return `<div class="page-wide">${head}<div class="empty-state">${icon('Git')}<p>Choose a project to see its repository.</p></div></div>`
  const refresh = `<button data-load-git ${state.loading || state.disabled ? 'disabled' : ''} aria-busy="${state.loading}">${icon(state.loading ? 'LoaderCircle' : 'Refresh', state.loading ? 'spinner' : '')} Refresh</button>`
  let body: string
  if (state.error) body = `<div class="notice error" role="alert"><div>${icon('Circle')}<span>${escape(state.error)}</span></div><button data-load-git data-fk="git-retry">${icon('Refresh')} Try again</button></div>`
  else if (state.raw === undefined) body = '<div class="load-state" role="status"><span class="skeleton-line"></span></div><div class="load-state"><span class="skeleton-line"></span></div>'
  else {
    const git = parseGit(state.raw)
    if (git.state === 'not-a-repo') body = `<div class="empty-state">${icon('Git')}<p>This project is not a Git repository yet.</p><small>Import a repository from GitHub on the Projects page, or ask the agent to run git init.</small></div>`
    else if (git.state === 'error') body = `<div class="notice error" role="alert"><div>${icon('Circle')}<span>Git reported a problem: ${escape(git.detail ?? 'unknown error')}</span></div></div>`
    else {
      const sync = git.upstream ? `${git.ahead ? `${git.ahead} ahead` : ''}${git.ahead && git.behind ? ', ' : ''}${git.behind ? `${git.behind} behind` : ''}` || 'Up to date' : ''
      body = `<div class="git-summary"><div class="git-card"><span class="eyebrow">Branch</span><strong class="branch">${icon('Git')}<span>${escape(git.branch ?? git.detail ?? 'Unknown')}</span></strong><small>${git.upstream ? `Tracks ${escape(git.upstream)} · ${escape(sync)}` : escape(git.branch && git.detail ? git.detail : 'No upstream')}</small></div><div class="git-card"><span class="eyebrow">Status</span><strong>${git.files.length ? `${git.files.length} changed file${git.files.length === 1 ? '' : 's'}` : 'Clean'}</strong><small>${git.files.length ? 'Uncommitted changes in the working tree' : 'Nothing to commit'}</small></div></div>${git.files.length ? `<section class="git-files" aria-label="Changed files"><h2>Changed files.</h2><ul>${git.files.map(file => `<li><span class="chip">${escape(statusLabel(file.code))}</span><code>${escape(file.path)}</code></li>`).join('')}</ul></section>` : `<div class="empty-state">${icon('Check')}<p>Working tree is clean.</p></div>`}${git.diff ? `<section class="git-diff-section" aria-label="Diff"><h2>Diff.</h2><pre class="git-diff" tabindex="0">${diffLines(git.diff).map(line => `<span class="diff-${line.kind}">${escape(line.text)}\n</span>`).join('')}</pre></section>` : ''}`
    }
  }
  return `<div class="page-wide">${head}<div class="page-actions">${refresh}</div>${state.source}${body}</div>`
}

export interface GithubUi {
  status?: GithubStatus
  /** From /api/config; false hides the Connect button even before the status call answers. */
  capable?: boolean
  loading: boolean
  error: string
  reconnect: boolean
  confirming: boolean
  busy: boolean
}

export type GithubCardState = 'loading' | 'error' | 'unconfigured' | 'reconnect' | 'disconnected' | 'connected'
/** Single source of truth for which GitHub card state shows; tested without a browser. */
export function githubCardState(s: Pick<GithubUi, 'status' | 'capable' | 'error' | 'reconnect'>): GithubCardState {
  if (s.error) return 'error'
  if (s.capable === false) return 'unconfigured'
  if (!s.status) return 'loading'
  if (!s.status.configured) return 'unconfigured'
  if (s.reconnect) return 'reconnect'
  return s.status.connected ? 'connected' : 'disconnected'
}

export function githubCard(s: GithubUi): string {
  const state = githubCardState(s)
  const busy = s.busy ? 'disabled' : ''
  const head = (chip: string) => `<div class="connection-head"><span class="connection-mark">${icon('Plug')}</span><div><h2>GitHub.</h2><small class="muted">Import repositories and keep them in sync.</small></div>${chip}</div>`
  let body: string
  switch (state) {
    case 'loading': return `<section class="connection-card" aria-busy="true" aria-label="GitHub">${head('')}<div class="load-state" role="status"><span class="skeleton-line"></span></div></section>`
    case 'error': body = `${head('')}<div class="notice error" role="alert"><div>${icon('Circle')}<span>${escape(s.error)}</span></div><button data-gh-retry data-fk="gh-retry">${icon('Refresh')} Try again</button></div>`; break
    case 'unconfigured': body = `${head('<span class="chip">Not set up</span>')}<p>GitHub is not set up on this server. An administrator needs to add a GitHub app to the server configuration before anyone can connect.</p>`; break
    case 'reconnect': body = `${head('<span class="chip warn">Needs attention</span>')}<div class="notice error" role="alert"><div>${icon('Circle')}<span>GitHub needs to be reconnected. Your access expired or was revoked.</span></div></div><div class="form-actions"><button class="primary" data-gh-connect data-fk="gh-connect" ${busy}>${icon('Plug')} Reconnect GitHub</button></div>`; break
    case 'disconnected': body = `${head('<span class="chip">Not connected</span>')}<p>Connect GitHub to import a repository into a project. Oqelira asks for read access to your repositories and your profile name.</p><div class="form-actions"><button class="primary" data-gh-connect data-fk="gh-connect" ${busy}>${icon('Plug')} Connect GitHub</button></div>`; break
    default: body = `${head('<span class="chip ok">Connected</span>')}<p>Connected as <strong>${escape(s.status?.login ?? 'your GitHub account')}</strong>.</p>${s.confirming ? `<div class="confirm" role="alertdialog" aria-label="Disconnect GitHub"><p>Disconnect GitHub? Imported projects keep their files, but you cannot import or pull until you connect again.</p><div class="form-actions"><button data-gh-disconnect-yes data-fk="gh-yes" ${busy}>Disconnect</button><button data-gh-disconnect-no data-fk="gh-no">Keep connected</button></div></div>` : `<div class="form-actions"><button data-gh-disconnect data-fk="gh-disconnect" ${busy}>${icon('Unplug')} Disconnect</button></div>`}`
  }
  return `<section class="connection-card" aria-label="GitHub">${body}</section>`
}

export function connectionsPage(s: GithubUi): string {
  return `<div class="page-wide"><div class="page-title"><p class="eyebrow">Your accounts</p><h1>Connections.</h1><p>Link outside services so projects can use them. Nothing is shared until you connect.</p></div>${githubCard(s)}</div>`
}

/** Short row for Settings that points to the full Connections page. */
export function settingsConnections(s: GithubUi): string {
  const state = githubCardState(s)
  const text = { loading: 'Checking GitHub.', error: 'Could not check GitHub.', unconfigured: 'Not set up on this server.', reconnect: 'Needs to be reconnected.', disconnected: 'Not connected.', connected: `Connected as ${s.status?.login ?? 'your account'}.` }[state]
  return `<section class="info-card settings-connections"><p class="eyebrow">Connections</p><strong>GitHub</strong><p>${escape(text)}</p><button data-section="Connections" data-fk="settings-connections">Manage connections</button></section>`
}
