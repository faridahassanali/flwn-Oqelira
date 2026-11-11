import type { Approval, HostConfig, HostEvent } from '@oqelira/protocol'
import { approve, getConfig, run } from './transport.js'
import { ApiError, api, showSignIn, socialSignIn } from './cloud.js'
import type { Project, SavedConversation } from './cloud.js'
import { brand } from './brand.js'
import { icon } from './icons.js'
import type { IconName } from './icons.js'
import { exitElement, timing } from './motion.js'
import { navGroups, navLabel } from './nav.js'
import { parseListing } from './files.js'
import { connectionsPage, filesPage, gitPage, githubCardState, importCard, projectList, settingsConnections, sourceCard } from './views.js'
import type { GithubUi, ImportUi, TreeNode } from './views.js'
import { connectGithub, describeFailure, disconnectGithub, githubReturn, githubStatus, importRepo, listRepos, needsReconnect, pollUntilSettled, projectSource, pullLatest, repoName, withoutGithubReturn } from './github.js'
import type { GithubSource, GithubStatus, Repo } from './github.js'

/** Shared renderer for the browser and sandboxed desktop. No credentials or model SDKs. */
export function mountWorkspace(root: HTMLElement): () => void {
  let controller = new AbortController()
  let activeRun: AbortController | undefined
  let config: HostConfig | undefined
  let model = ''
  let sessionId: string | undefined
  let runId = ''
  let pending: Approval | undefined
  let approvalBusy = false
  let error = ''
  let draft = ''
  let contextCompacted = false
  let notice=''
  let teams:{id:string;name:string;role:string}[]=[]
  let teamId=''
  let teamMembers:{id:string;role:string;user:{id:string;name:string;email:string}}[]=[]
  const invitation=new URL(location.href).searchParams.get('invitation')?.slice(0,256)??''
  let disposed = false
  let frame = 0
  let moreOpen = false, inspectorOpen = false, stickToEnd = true, resetForms = false
  let lastSection = '', lastTab = '', loadingVisible = false, loadingStarted = 0
  let loadingTimer: ReturnType<typeof setTimeout> | undefined
  let loadingExit: ReturnType<typeof setTimeout> | undefined
  let viewTransition: ViewTransition | undefined
  let copiedTool = -1
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let authCleanup: (() => void) | undefined
  let projects: Project[] = []
  const projectReadOnly=()=>{const role=projects.find(project=>project.id===projectId)?.role;return config?.mode==='server'&&!!role&&!role.split(',').some(value=>['owner','admin','member'].includes(value))}
  let projectId: string | undefined
  let conversations: SavedConversation[] = []
  let memories: { id: string; content: string }[] = []
  let cloudBusy = false
  const tree = new Map<string, TreeNode>(), expanded = new Set<string>()
  let openedFile: { path: string; text?: string; error?: string; loading?: boolean } | undefined
  let editing: 'none' | 'edit' | 'new' = 'none'
  let gitRaw: string | undefined, gitLoading = false, gitError = ''
  let ghStatus: GithubStatus | undefined, ghLoading = false, ghError = '', ghReconnect = false, ghConfirm = false, ghBusy = false
  const ghUi = (): GithubUi => ({ status: ghStatus, capable: config?.githubConnect, loading: ghLoading, error: ghError, reconnect: ghReconnect, confirming: ghConfirm, busy: ghBusy })
  async function loadGithub() {
    if (config?.mode !== 'server' || ghLoading || config.githubConnect === false) return
    ghLoading = true; ghError = ''; render()
    try { ghStatus = await githubStatus() } catch (e) { ghError = describeFailure(e, 'Could not check GitHub') }
    ghLoading = false; render()
  }
  const sources = new Map<string, GithubSource | null>(), sourceFailed = new Set<string>(), watching = new Set<string>(), pollAbort = new AbortController()
  const imp = { open: false, query: '', page: 1, repos: [] as Repo[], next: undefined as number | undefined, loading: false, error: '', picked: undefined as string | undefined, branch: '', target: 'new' as 'new' | 'current', busy: false, projectId: undefined as string | undefined }
  const importUi = (): ImportUi => { const current = projects.find(p => p.id === projectId); return { ...imp, currentName: current && !sources.get(current.id) ? current.name : undefined, progress: (imp.projectId ? sources.get(imp.projectId) : undefined) ?? undefined } }
  /** Polls a project's repository source every few seconds until it stops syncing, then refreshes files and Git. */
  function watch(id: string) {
    if (watching.has(id)) return
    watching.add(id)
    void pollUntilSettled(() => projectSource(id), source => { if (source) sources.set(id, source); render() }, ms => new Promise(resolve => setTimeout(resolve, ms)), pollAbort.signal).finally(() => {
      watching.delete(id)
      if (disposed || id !== projectId || sources.get(id)?.state !== 'idle') return
      tree.clear(); expanded.clear(); openedFile = undefined; gitRaw = undefined
      if (section === 'Explorer') void loadDir('.')
      if (section === 'Git') void loadGit()
    })
  }
  async function loadSources() {
    await Promise.all(projects.filter(p => !sources.has(p.id)).map(async p => {
      try { sources.set(p.id, await projectSource(p.id)); sourceFailed.delete(p.id); if (sources.get(p.id)?.state === 'syncing') watch(p.id) }
      catch (e) { sources.set(p.id, null); if (!(e instanceof ApiError && e.status === 404)) sourceFailed.add(p.id) }
    }))
    render()
  }
  async function searchRepos(page: number) {
    imp.loading = true; imp.error = ''; imp.page = page; render()
    try { const result = await listRepos(imp.query, page); imp.repos = result.repos; imp.next = result.nextPage; if (!result.repos.some(repo => repo.fullName === imp.picked)) imp.picked = undefined }
    catch (e) { if (needsReconnect(e)) ghReconnect = true; imp.repos = []; imp.next = undefined; imp.error = describeFailure(e, 'Could not load repositories') + (needsReconnect(e) ? ' Reconnect GitHub on the Connections page.' : '') }
    imp.loading = false; render()
  }
  async function startImport() {
    if (!ghStatus && !ghError) await loadGithub()
    if (githubCardState(ghUi()) !== 'connected') { section = 'Connections'; notice = 'Connect GitHub first to import a repository.'; render(); return }
    imp.open = true; render(); void searchRepos(1)
  }
  async function runImport() {
    const repo = imp.repos.find(item => item.fullName === imp.picked)
    if (!repo || imp.busy) return
    imp.busy = true; imp.error = ''; render()
    try {
      let id = projectId
      if (imp.target !== 'current' || !id) { const created = await api<Project>('projects', { name: repoName(repo.fullName), organizationId: '' }); projects.push(created); id = created.id }
      const branch = imp.branch.trim()
      await importRepo(id, repo.fullName, branch || undefined)
      imp.projectId = id; sources.set(id, { repo: repo.fullName, branch: branch || repo.defaultBranch, state: 'syncing' }); watch(id)
    } catch (e) { if (needsReconnect(e)) ghReconnect = true; imp.error = describeFailure(e, 'Could not import') + (needsReconnect(e) ? ' Reconnect GitHub on the Connections page.' : '') }
    imp.busy = false; render()
  }
  async function pull(id: string) {
    const current = sources.get(id)
    if (!current || current.state === 'syncing') return
    try { await pullLatest(id); sources.set(id, { ...current, state: 'syncing', error: undefined }); watch(id) }
    catch (e) { sources.set(id, { ...current, state: 'error', error: describeFailure(e, 'Could not pull') }) }
    render()
  }
  const resetProjectViews =() => { tree.clear(); expanded.clear(); openedFile = undefined; editing = 'none'; gitRaw = undefined; gitLoading = false; gitError = '' }
  const activity: { id: string; name: string; input: unknown; output?: string; isError?: boolean }[] = []
  let section = 'Chat'
  let tab = 'Task'
  let messages: { role: string; text: string }[] = []
  let tasks: { text: string; done: boolean; status: string }[] = []
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const icons: Record<string, string> = Object.fromEntries((['Chat','Tasks','Explorer','Terminal','Git','Settings','Projects','Memory','Teams'] as IconName[]).map(name => [name, icon(name)]))
  const clearConversation = () => { messages = []; tasks = []; activity.length = 0; sessionId = undefined; pending = undefined; error = ''; notice=''; draft = ''; contextCompacted = false; resetForms = true; root.querySelector('#prompt')?.remove() }
  function busy(value: boolean) {
    cloudBusy = value
    clearTimeout(loadingTimer); clearTimeout(loadingExit)
    if (value) loadingTimer = setTimeout(() => { if (!disposed && cloudBusy) { loadingVisible = true; loadingStarted = performance.now(); render() } }, timing('--loading-delay'))
    else {
      const remaining = loadingVisible ? Math.max(0, timing('--loading-min') - (performance.now() - loadingStarted)) : 0
      if (remaining) loadingExit = setTimeout(() => { loadingVisible = false; render() }, remaining)
      else loadingVisible = false
    }
  }
  async function loadProject(id: string) {
    if (activeRun || cloudBusy) return
    busy(true); clearConversation(); projectId = id
    resetProjectViews()
    try { [conversations, memories] = await Promise.all([api<SavedConversation[]>('conversations?projectId=' + id), api<{id:string;content:string}[]>('memory?projectId=' + id)]); section = 'Chat' }
    catch (e) { error = e instanceof Error ? e.message : 'Could not load project' }
    finally { busy(false); render() }
  }
  async function loadCloud() {
    if (config?.mode !== 'server') return
    [projects,teams] = await Promise.all([api<Project[]>('projects'),api<typeof teams>('teams')])
    void loadSources()
    if (!projectId && projects.length) await loadProject(projects[0]!.id)
    if (!projects.length) section = 'Projects'
  }
  async function loadTeams(selected=teamId){
    teams=await api<typeof teams>('teams');teamId=teams.find(team=>team.id===selected)?.id??teams[0]?.id??''
    teamMembers=teamId?(await api<{members:typeof teamMembers}>('auth/organization/get-full-organization?organizationId='+encodeURIComponent(teamId))).members:[]
  }
  async function openConversation(id: string) {
    if (activeRun || cloudBusy) return
    busy(true)
    try {
      const saved = await api<SavedConversation>('conversation?id=' + id)
      clearConversation(); sessionId = saved.id; model = saved.model
      for (const message of saved.messages ?? []) {
        if (message.role === 'user') messages.push({ role: 'user', text: message.content })
        if (message.role === 'assistant') { if (message.text.trim()) messages.push({ role: 'assistant', text: message.text }); activity.push(...message.toolCalls) }
        if (message.role === 'tool') for (const result of message.results) { const tool = [...activity].reverse().find(t => t.id === result.id && t.output === undefined); if (tool) Object.assign(tool, result) }
      }
      tasks = [{ text: saved.title, done: saved.status === 'completed', status: saved.status }]; section = 'Chat'
    } catch (e) { error = e instanceof Error ? e.message : 'Could not open conversation' }
    finally { busy(false); render() }
  }
  /** Lists one folder. Each folder loads on demand, so a large project never lists everything at once. */
  async function loadDir(path: string) {
    const id = projectId
    if (!id) return
    tree.set(path, 'loading'); render()
    try { const result = await api<{output:string}>('files?projectId=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(path)); if (id === projectId) tree.set(path, parseListing(result.output)) }
    catch (e) { if (id === projectId) tree.set(path, { error: e instanceof Error ? e.message : 'Could not list this folder' }) }
    if (id === projectId) render()
  }
  async function openFile(path: string) {
    const id = projectId
    if (!id) return
    editing = 'none'; openedFile = { path, loading: true }; render()
    try { const result = await api<{output:string}>('file?projectId=' + encodeURIComponent(id) + '&path=' + encodeURIComponent(path)); if (id === projectId && openedFile?.path === path) openedFile = { path, text: result.output } }
    catch (e) { if (id === projectId && openedFile?.path === path) openedFile = { path, error: e instanceof Error ? e.message : 'Could not read this file' } }
    if (id === projectId) { render(); if (matchMedia('(max-width:60rem)').matches) root.querySelector('.files-viewer')?.scrollIntoView({ block: 'start' }) }
  }
  async function loadGit() {
    const id = projectId
    if (!id || gitLoading) return
    gitLoading = true; gitError = ''; render()
    try { const result = await api<{output:string}>('git?projectId=' + encodeURIComponent(id)); if (id === projectId) gitRaw = result.output }
    catch (e) { if (id === projectId) gitError = e instanceof Error ? e.message : 'Could not load Git' }
    if (id === projectId) { gitLoading = false; render() }
  }
  /** Opens a section and starts whatever data it needs the first time. */
  function enter(name: string) {
    section = name; notice = ''; moreOpen = false
    if (name === 'Teams') { busy(true); void loadTeams().then(() => { busy(false); render() }).catch(() => { error = 'Could not load teams'; busy(false); render() }) }
    if (['Connections', 'Settings'].includes(name) && !ghStatus && !ghError) void loadGithub()
    if (['Projects', 'Git'].includes(name) && config?.mode === 'server') void loadSources()
    if (config?.mode === 'server' && projectId) {
      if (name === 'Explorer' && !tree.has('.')) void loadDir('.')
      if (name === 'Git' && gitRaw === undefined && !gitLoading && !gitError) void loadGit()
    }
    render()
  }
  function render() {
    if (disposed) return
    if (lastSection && (lastSection !== section || lastTab !== tab) && typeof document.startViewTransition === 'function') {
      viewTransition?.skipTransition()
      viewTransition = document.startViewTransition(renderNow)
      return
    }
    renderNow()
  }
  function renderNow() {
    if (disposed) return
    const changingSection = lastSection !== section
    const previousScroll = root.querySelector('#conversation')?.scrollTop ?? 0
    const detailKey=(node:HTMLElement)=>{const parts:string[]=[];for(let current:HTMLElement|null=node;current&&current!==root;current=current.parentElement)if(current instanceof HTMLDetailsElement&&current.dataset.detail)parts.unshift(current.dataset.detail);return `${node.closest('.inspector')?'inspector':'main'}:${parts.join('/')}`}
    const detailStates = new Map(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-detail]')).map(node => [detailKey(node), node.open]))
    const formValues = new Map<string, string>()
    if (!changingSection && !resetForms) root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('form[id] [name]').forEach(field => { if (field.type !== 'password') formValues.set(`${field.closest('form')!.id}:${field.name}`, field.value) })
    const textarea = root.querySelector<HTMLTextAreaElement>('#prompt')
    const focused = textarea === document.activeElement
    // Re-rendering replaces every node, so keyboard focus on a keyed control is restored afterwards.
    const focusKey = root.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.fk : undefined
    if (textarea) draft = textarea.value
    controller.abort()
    controller = new AbortController()
    const signal = controller.signal
    lastSection = section
    lastTab = tab
    root.classList.toggle('inspector-open', inspectorOpen)
    const { primary, secondary } = navGroups(config?.mode === 'server')
    const navButton = (name: IconName) => `<button data-section="${name}" data-fk="nav-${name}" class="nav-item ${section === name ? 'selected' : ''}" ${section === name ? 'aria-current="page"' : ''}>${icon(name)}<span>${navLabel(name)}</span></button>`
    root.innerHTML = `
      <aside class="sidebar ${moreOpen ? 'more-open' : ''}">
        <a class="brand" href="#" aria-label="Oqelira by Flwn">${brand()}</a>
        <nav aria-label="Main navigation" class="nav-primary"><p class="eyebrow nav-label">Workspace</p>${primary.map(navButton).join('')}<button class="nav-item nav-more-toggle ${secondary.includes(section as IconName) ? 'selected' : ''}" data-action="more" data-fk="more-toggle" aria-expanded="${moreOpen}" aria-controls="more-nav">${icon('More')}<span>More</span>${icon('ChevronDown','chevron')}</button></nav>
        <nav aria-label="More tools" class="nav-secondary" id="more-nav"><p class="eyebrow nav-label">More</p>${secondary.map(navButton).join('')}</nav>
        <div class="recent"><p class="eyebrow">This conversation</p><button data-action="chat" class="session">${icon('Chat')}<span>${escape(tasks[0]?.text.slice(0, 45) ?? 'A fresh start')}<small>${tasks.length} request${tasks.length === 1 ? '' : 's'}</small></span></button></div>
        ${config?.mode === 'server' ? `<div class="saved-sessions"><p class="eyebrow">Saved conversations</p>${conversations.map(c => `<button data-conversation="${escape(c.id)}" ${activeRun || cloudBusy ? 'disabled' : ''}>${icon('Chat')}<span>${escape(c.title.slice(0, 45))}</span></button>`).join('') || '<p class="sidebar-empty">Your conversations will live here.</p>'}</div>` : '<div class="local-note"><span class="eyebrow">Your workspace</span><p>One idea at a time.</p></div>'}
        <button class="new-session" data-action="new" ${activeRun ? 'disabled' : ''}>${icon('Plus')}<span>New conversation</span></button>
      </aside>
      <header class="topbar"><a class="mobile-brand brand" href="#" aria-label="Oqelira by Flwn">${brand()}</a><div class="workspace-switch"><span>Workspace</span>${config?.mode === 'server' ? `<label class="sr-only" for="project">Project</label><select id="project" ${activeRun || cloudBusy ? 'disabled' : ''}><option value="">Choose project</option>${projects.map(p => `<option value="${escape(p.id)}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select>` : `<strong>${escape(config?.workspace ?? 'flwn-Oqelira')}</strong>`}</div><div class="top-actions"><label class="sr-only" for="model">Model</label><select id="model" ${activeRun ? 'disabled' : ''}>${config?.models.map(m => `<option value="${escape(m.id)}" ${m.id === model ? 'selected' : ''}>${escape(m.deployment)}</option>`).join('') ?? '<option>Connecting…</option>'}</select><button class="icon-button inspector-toggle" data-action="inspector" aria-label="${inspectorOpen ? 'Close' : 'Open'} workspace details" data-tooltip="Workspace details" aria-expanded="${inspectorOpen}">${icon('PanelRight')}</button>${config?.user ? `<button class="icon-button" data-action="logout" aria-label="Sign out" data-tooltip="Sign out">${icon('LogOut')}</button>` : `<button class="user-badge" data-section="Settings" aria-label="Workspace settings" data-tooltip="Settings">${icon('Settings')}</button>`}</div></header>
      <main class="main" aria-busy="${cloudBusy}"><div class="tabbar"><span>${icons[section] ?? icon('Chat')}<strong>${section === 'Explorer' ? 'Files' : section}</strong></span><span class="project-tab">${escape(projects.find(p => p.id === projectId)?.name ?? config?.workspace ?? 'flwn-Oqelira')}</span><button class="icon-button" data-action="new" aria-label="New conversation" data-tooltip="New conversation" ${activeRun ? 'disabled' : ''}>${icon('Plus')}</button></div>
      ${loadingVisible ? `<div class="load-state" role="status">${icon('LoaderCircle','spinner')}<span>Loading your workspace.</span><div class="skeleton-line"></div></div>` : ''}
      ${notice?`<div class="notice" role="status">${escape(notice)}</div>`:''}
      ${contextCompacted && section === 'Chat' ? '<div class="notice" role="status">Older context was compacted for this request. Full history is retained for this conversation.</div>' : ''}
      ${error ? `<div class="notice error" role="alert"><div>${icon('Circle')}<span>${escape(error)}</span></div><button data-action="retry">${icon('Refresh')} Try again</button></div>` : ''}
      ${config && !config.configured ? '<div class="notice">Add FOUNDRY_KEY and FOUNDRY_ENDPOINT to the host .env, then restart Oqelira. Credentials stay on your computer.</div>' : ''}
      <div class="content" id="conversation">${section === 'Chat' ? chatContent() : panelContent()}</div>
      ${pending ? approvalContent() : ''}
      ${section === 'Chat' ? `<form class="composer"><label class="sr-only" for="prompt">Message Oqelira</label><textarea id="prompt" name="prompt" ${projectReadOnly()?'readonly':''} placeholder="Ask Oqelira anything…" rows="2" required maxlength="10000" ${activeRun ? 'disabled' : ''}>${escape(draft)}</textarea><div class="composer-bar"><span class="mode-pill">${icon('ShieldCheck')}<span>${activeRun ? pending ? 'Waiting for your approval' : tasks.at(-1)?.status==='Reconnecting'?'Reconnecting to your run':'Working with your project' : projectReadOnly()?'Read-only access':'Ask before changes'}</span></span><span class="composer-hint">Enter to send · Shift + Enter for a new line</span>${activeRun ? `<button class="stop" type="button" data-action="stop">${icon('Stop')} Stop</button>` : `<button class="send" type="submit" aria-label="Send message" data-tooltip="Send message" ${!config?.configured || projectReadOnly() ? 'disabled' : ''}>${icon('Send')}</button>`}</div></form>` : ''}</main>
      ${inspectorOpen ? '<button class="inspector-scrim" data-action="inspector" aria-label="Close workspace details"></button>' : ''}<aside class="inspector" aria-label="Workspace details"><div class="inspector-tabs" role="tablist" aria-label="Workspace details">${['Task', 'Context', 'Files'].map(name => `<button role="tab" aria-selected="${tab === name}" data-tab="${name}" class="${tab === name ? 'active' : ''}">${name}</button>`).join('')}</div><div class="inspector-content" role="tabpanel">${inspectorContent()}</div><footer><span>Oqelira by Flwn</span><span class="footer-note">A little more clarity.</span></footer></aside>`
    root.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => button.addEventListener('click', () => enter(button.dataset.section!), { signal }))
    // The More group is always visible on wide screens; it only behaves as a popover when the toggle is shown (phones).
    const toggleShown = () => { const toggle = root.querySelector<HTMLElement>('[data-action="more"]'); return !!toggle && getComputedStyle(toggle).display !== 'none' }
    const closeMore = async () => { const menu = root.querySelector<HTMLElement>('.nav-secondary'); if (menu && toggleShown()) await exitElement(menu); moreOpen = false; render(); root.querySelector<HTMLButtonElement>('[data-action="more"]')?.focus() }
    const closeInspector = async () => { const panel = root.querySelector<HTMLElement>('.inspector'); if (panel) await exitElement(panel); inspectorOpen = false; render() }
    root.querySelector('[data-action="more"]')?.addEventListener('click', () => { if (moreOpen) { void closeMore(); return }; moreOpen = true; render(); root.querySelector<HTMLButtonElement>('#more-nav .nav-item')?.focus() }, { signal })
    root.querySelectorAll('[data-action="inspector"]').forEach(button => button.addEventListener('click', () => { if (inspectorOpen) { void closeInspector(); return }; inspectorOpen = true; render() }, { signal }))
    root.querySelector('[data-action="retry"]')?.addEventListener('click', () => { error = ''; if (config?.mode === 'server' && projectId) { void loadProject(projectId) } else { location.reload() } }, { signal })
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') { if (moreOpen) void closeMore(); if (inspectorOpen) void closeInspector() }
    }, { signal })
    root.addEventListener('click', event => { if (moreOpen && !(event.target as Element).closest('.sidebar')) void closeMore() }, { signal })
    root.querySelector('#conversation')?.addEventListener('scroll', event => { const node = event.target as HTMLElement; stickToEnd = node.scrollHeight - node.clientHeight - node.scrollTop < 64 }, { signal, passive: true })
    root.querySelectorAll<HTMLButtonElement>('[data-conversation]').forEach(button => button.addEventListener('click', () => { void openConversation(button.dataset.conversation!) }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-tree-dir]').forEach(button => button.addEventListener('click', () => {
      const path = button.dataset.treeDir!
      if (expanded.has(path)) expanded.delete(path); else { expanded.add(path); if (!tree.has(path)) void loadDir(path) }
      render()
    }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-tree-file]').forEach(button => button.addEventListener('click', () => { void openFile(button.dataset.treeFile!) }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-tree-retry]').forEach(button => button.addEventListener('click', () => { void loadDir(button.dataset.treeRetry!) }, { signal }))
    root.querySelector('[data-tree-refresh]')?.addEventListener('click', () => { const open = ['.', ...expanded]; tree.clear(); open.forEach(path => void loadDir(path)) }, { signal })
    root.querySelector('[data-edit-file]')?.addEventListener('click', () => { editing = 'edit'; resetForms = true; render(); root.querySelector<HTMLTextAreaElement>('#file-form textarea')?.focus() }, { signal })
    root.querySelector('[data-new-file]')?.addEventListener('click', () => { editing = 'new'; resetForms = true; render(); root.querySelector<HTMLInputElement>('#file-form input')?.focus() }, { signal })
    root.querySelector('[data-edit-cancel]')?.addEventListener('click', () => { editing = 'none'; resetForms = true; render() }, { signal })
    root.querySelector('[data-gh-retry]')?.addEventListener('click', () => { ghError = ''; ghStatus = undefined; void loadGithub() }, { signal })
    root.querySelector('[data-gh-connect]')?.addEventListener('click', () => {
      if (ghBusy) return
      ghBusy = true; ghError = ''; render()
      void connectGithub().catch(e => { ghBusy = false; ghError = describeFailure(e, 'Could not start the GitHub connection'); render() })
    }, { signal })
    root.querySelector('[data-gh-disconnect]')?.addEventListener('click', () => { ghConfirm = true; render(); root.querySelector<HTMLElement>('[data-gh-disconnect-yes]')?.focus() }, { signal })
    root.querySelector('[data-gh-disconnect-no]')?.addEventListener('click', () => { ghConfirm = false; render(); root.querySelector<HTMLElement>('[data-gh-disconnect]')?.focus() }, { signal })
    root.querySelector('[data-gh-disconnect-yes]')?.addEventListener('click', () => {
      if (ghBusy) return
      ghBusy = true; render()
      void disconnectGithub().then(() => { ghStatus = { configured: true, connected: false }; ghReconnect = false; notice = 'GitHub disconnected.' }).catch(e => { ghError = describeFailure(e, 'Could not disconnect GitHub') }).finally(() => { ghBusy = false; ghConfirm = false; render() })
    }, { signal })
    root.querySelector('[data-import-open]')?.addEventListener('click', () => { void startImport() }, { signal })
    root.querySelector<HTMLFormElement>('#repo-search')?.addEventListener('submit', event => { event.preventDefault(); imp.query = String(new FormData(event.target as HTMLFormElement).get('query') ?? '').trim(); void searchRepos(1) }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-repo]').forEach(button => button.addEventListener('click', () => { const repo = imp.repos.find(item => item.fullName === button.dataset.repo); if (!repo) return; imp.picked = repo.fullName; imp.branch = repo.defaultBranch; imp.target = 'new'; resetForms = true; render() }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-repo-page]').forEach(button => button.addEventListener('click', () => { void searchRepos(Number(button.dataset.repoPage)) }, { signal }))
    root.querySelector<HTMLFormElement>('#import-form')?.addEventListener('submit', event => { event.preventDefault(); const fields = new FormData(event.target as HTMLFormElement); imp.branch = String(fields.get('branch') ?? ''); imp.target = fields.get('target') === 'current' ? 'current' : 'new'; void runImport() }, { signal })
    root.querySelector('[data-open-imported]')?.addEventListener('click', () => { if (imp.projectId) void loadProject(imp.projectId) }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-open-project]').forEach(button => button.addEventListener('click', () => { void loadProject(button.dataset.openProject!) }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-pull]').forEach(button => button.addEventListener('click', () => { void pull(button.dataset.pull!) }, { signal }))
    root.querySelectorAll('[data-load-git]').forEach(button => button.addEventListener('click', () => { gitRaw = undefined; gitError = ''; void loadGit() }, { signal }))
    root.querySelector<HTMLFormElement>('#file-form')?.addEventListener('submit', event => {
      event.preventDefault(); if (!projectId || cloudBusy || activeRun || projectReadOnly()) return
      const fields = new FormData(event.target as HTMLFormElement), path = String(fields.get('path') ?? '').trim(), content = String(fields.get('content') ?? '')
      const id = projectId
      busy(true)
      void api('file', { projectId: id, path, content }).then(async () => {
        busy(false); editing = 'none'; openedFile = { path, text: content }
        const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
        if (tree.has(parent)) await loadDir(parent); else render()
        gitRaw = undefined
      }).catch(e => { error = e instanceof Error ? e.message : 'Could not save file'; busy(false); render() })
    }, { signal })
    const teamAction=(operation:()=>Promise<unknown>)=>{if(cloudBusy||activeRun)return;busy(true);error='';notice='';void operation().then(()=>Promise.all([loadTeams(),api<Project[]>('projects').then(value=>{projects=value;if(projectId&&!projects.some(project=>project.id===projectId)){clearConversation();projectId=undefined}})])).then(()=>{busy(false);resetForms=true;render()}).catch(e=>{error=e instanceof Error?e.message:'Team request failed';busy(false);render()})}
    root.querySelector('[data-load-teams]')?.addEventListener('click',()=>teamAction(async()=>{}),{signal})
    root.querySelector<HTMLSelectElement>('[data-team]')?.addEventListener('change',event=>{teamId=(event.target as HTMLSelectElement).value;teamAction(async()=>{})},{signal})
    root.querySelector<HTMLFormElement>('#create-team')?.addEventListener('submit',event=>{event.preventDefault();const fields=new FormData(event.target as HTMLFormElement);teamAction(async()=>{const team=await api<{id:string}>('auth/organization/create',{name:fields.get('name'),slug:fields.get('slug')});teamId=team.id;notice='Team created.'})},{signal})
    root.querySelector<HTMLFormElement>('#accept-invite')?.addEventListener('submit',event=>{event.preventDefault();const fields=new FormData(event.target as HTMLFormElement);teamAction(async()=>{await api('auth/organization/accept-invitation',{invitationId:fields.get('invitationId')});history.replaceState(null,'',location.pathname);projects=await api('projects');notice='Invitation accepted.'})},{signal})
    root.querySelector<HTMLFormElement>('#invite-member')?.addEventListener('submit',event=>{event.preventDefault();const fields=new FormData(event.target as HTMLFormElement);teamAction(async()=>{await api('auth/organization/invite-member',{organizationId:teamId,email:fields.get('email'),role:fields.get('role')});notice='Invitation queued for delivery.'})},{signal})
    root.querySelectorAll<HTMLSelectElement>('[data-member-role]').forEach(select=>select.addEventListener('change',()=>teamAction(()=>api('auth/organization/update-member-role',{organizationId:teamId,memberId:select.dataset.memberRole,role:select.value})),{signal}))
    root.querySelectorAll<HTMLButtonElement>('[data-remove-member]').forEach(button=>button.addEventListener('click',()=>teamAction(()=>api('auth/organization/remove-member',{organizationId:teamId,memberIdOrEmail:button.dataset.removeMember})),{signal}))
    root.querySelector('[data-verify-account]')?.addEventListener('click',()=>{if(!config?.user?.email)return;void api('auth/send-verification-email',{email:config.user.email,callbackURL:location.origin+'/'}).then(()=>{notice='Verification link requested. Check your email.';render()}).catch(()=>{error='Could not request a verification link';render()})},{signal})
    root.querySelectorAll<HTMLButtonElement>('[data-link-provider]').forEach(button=>button.addEventListener('click',()=>{void socialSignIn(button.dataset.linkProvider as 'google'|'github',true).catch(()=>{error='Could not connect this sign-in method';render()})},{signal}))
    root.querySelector<HTMLSelectElement>('#project')?.addEventListener('change', event => { const id = (event.target as HTMLSelectElement).value; if (id) void loadProject(id) }, { signal })
    root.querySelector('[data-action="logout"]')?.addEventListener('click', () => { activeRun?.abort(); void api('auth/sign-out', {}).then(() => location.reload()).catch(() => { error = 'Could not sign out'; render() }) }, { signal })
    root.querySelector<HTMLFormElement>('#project-form')?.addEventListener('submit', event => {
      event.preventDefault(); if (cloudBusy || activeRun) return
      const projectFields=new FormData(event.target as HTMLFormElement)
      const name = String(projectFields.get('name') ?? '').trim()
      const organizationId=String(projectFields.get('organizationId')??'')
      busy(true)
      void api<Project>('projects', { name,organizationId }).then(async project => { projects.push(project); busy(false); await loadProject(project.id) }).catch(e => { error = e instanceof Error ? e.message : 'Could not create project'; busy(false); render() })
    }, { signal })
    root.querySelector<HTMLFormElement>('#memory-form')?.addEventListener('submit', event => {
      event.preventDefault(); if (!projectId || activeRun || cloudBusy) return
      const content = String(new FormData(event.target as HTMLFormElement).get('content') ?? '').trim()
      busy(true)
      void api('memory', { projectId, content }).then(async () => { memories = await api('memory?projectId=' + projectId); resetForms = true; busy(false); render() }).catch(e => { error = e instanceof Error ? e.message : 'Could not save memory'; busy(false); render() })
    }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-forget]').forEach(button => button.addEventListener('click', () => {
      if (cloudBusy || activeRun) return
      busy(true)
      void api('memory', { projectId, action: 'forget', id: button.dataset.forget }).then(async () => { const current = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-forget]')).find(node => node.dataset.forget === button.dataset.forget); const card = current?.closest<HTMLElement>('.info-card'); if (card) await exitElement(card); memories = memories.filter(m => m.id !== button.dataset.forget); busy(false); render() }).catch(() => { error = 'Could not remove memory'; busy(false); render() })
    }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab!; render() }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-action="new"]').forEach(button => button.addEventListener('click', () => { if (activeRun) return; clearConversation(); stickToEnd = true; section = 'Chat'; moreOpen = false; render() }, { signal }))
    root.querySelector('[data-action="stop"]')?.addEventListener('click', () => activeRun?.abort(), { signal })
    root.querySelector<HTMLSelectElement>('#model')?.addEventListener('change', event => { model = (event.target as HTMLSelectElement).value }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-allow]').forEach(button => button.addEventListener('click', () => { void decide(button.dataset.allow === 'true') }, { signal }))
    root.querySelector('[data-action="chat"]')?.addEventListener('click', () => { section = 'Chat'; render() }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => { draft=button.dataset.prompt!;const input=root.querySelector<HTMLTextAreaElement>('#prompt');if(input)input.value=draft;section='Chat';render();root.querySelector<HTMLTextAreaElement>('#prompt')?.focus() }, { signal }))
    const form = root.querySelector<HTMLFormElement>('form.composer')
    form?.addEventListener('submit', event => { event.preventDefault(); submit() }, { signal })
    root.querySelector<HTMLTextAreaElement>('#prompt')?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit() } }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-copy-tool]').forEach(button => button.addEventListener('click', () => {
      const index = Number(button.dataset.copyTool), tool = activity[index]
      if (!tool) return
      void navigator.clipboard.writeText(tool.output ?? JSON.stringify(tool.input, null, 2)).then(() => { copiedTool = index; render(); clearTimeout(copyTimer); copyTimer = setTimeout(() => { copiedTool = -1; render() }, timing('--copy-hold')) }).catch(() => { error = 'Could not copy. Select the text and copy it directly.'; render() })
    }, { signal }))
    root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('form[id] [name]').forEach(field => { const value = formValues.get(`${field.closest('form')!.id}:${field.name}`); if (value !== undefined) field.value = value })
    resetForms = false
    root.querySelectorAll<HTMLDetailsElement>('details[data-detail]').forEach(node => {
      const previous = detailStates.get(detailKey(node))
      if (previous !== undefined) node.open = previous
      let closing = false
      node.querySelector(':scope > summary')?.addEventListener('click', event => {
        if (!node.open) return
        event.preventDefault()
        if (closing) return
        closing = true
        const children = Array.from(node.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.tagName !== 'SUMMARY')
        void Promise.all(children.map(exitElement)).then(() => { if (node.isConnected) node.open = false; closing = false })
      }, { signal })
    })
    const content = root.querySelector('#conversation')
    content?.scrollTo(0, section === 'Chat' && messages.length && stickToEnd ? content.scrollHeight : changingSection ? 0 : previousScroll)
    if (focused && !activeRun) root.querySelector('textarea')?.focus()
    else if (focusKey) root.querySelector<HTMLElement>(`[data-fk="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: true })
  }
  function approvalContent() {
    if (!pending) return ''
    const input = (pending.input ?? {}) as Record<string, unknown>
    let preview = JSON.stringify(input, null, 2)
    if (['apply_file_change', 'revert_file_change'].includes(pending.tool)) preview = `Path: ${String(input.path ?? '')}\nExpected version: ${String(input.expected_sha256 ?? 'new file')}\n--- Proposed content\n${input.content === null ? '[Delete file]' : String(input.content ?? '')}`
    if (pending.tool === 'edit_file') preview = `--- Existing text\n${String(input.old_string ?? '')}\n+++ Replacement\n${String(input.new_string ?? '')}`
    if (pending.tool === 'write_file') preview = String(input.content ?? '')
    return `<section class="approval-card" role="region" aria-label="Approval required"><div class="approval-heading">${icon('ShieldCheck')}<div><p class="eyebrow">Your call</p><h2>Permission needed.</h2></div><span class="chip">${escape(pending.risk)}</span></div><strong>${escape(pending.summary)}</strong><pre>${escape(preview)}</pre><p>${pending.risk === 'network' ? 'This sends the query to an external service. Do not include secrets or private code.' : pending.risk === 'exec' ? config?.mode === 'server' ? 'Review the full command before it runs in this project’s isolated workspace.' : 'Shell commands can access your computer. Review the full command.' : 'Review this change before allowing it.'} This request expires after two minutes.</p><div class="approval-actions"><button class="primary" data-allow="true" aria-busy="${approvalBusy}" ${approvalBusy ? 'disabled' : ''}>${icon(approvalBusy ? 'LoaderCircle' : 'Check', approvalBusy ? 'spinner' : 'draw-check')}<span>Allow once</span></button><button data-allow="false" ${approvalBusy ? 'disabled' : ''}>${icon('Close')} Deny</button></div></section>`
  }
  async function decide(allowed: boolean) {
    if (!pending || approvalBusy) return
    const current = pending
    approvalBusy = true; render()
    try { await approve(runId, current.id, allowed); const card = root.querySelector<HTMLElement>('.approval-card'); if (card) await exitElement(card); if (pending?.id === current.id) pending = undefined }
    catch (e) { error = e instanceof Error ? e.message : 'Could not send approval'; if (pending?.id === current.id) pending = undefined }
    finally { approvalBusy = false; render() }
  }
  async function submit() {
    const input = root.querySelector<HTMLTextAreaElement>('#prompt')
    const value = input?.value.trim()
    if (!value || activeRun || !config?.configured) return
    if (config.mode === 'server' && !projectId) { section = 'Projects'; render(); return }
    draft = ''; if (input) input.value = ''
    error = ''; pending = undefined
    const task = { text: value, done: false, status: 'In progress' }
    const answer = { role: 'assistant', text: '' }
    messages.push({ role: 'user', text: value }, answer)
    tasks.push(task)
    contextCompacted=false
    activeRun = new AbortController()
    stickToEnd = true
    const currentRun = activeRun
    render()
    const onEvent = (event: HostEvent) => {
      if (disposed) return
      switch (event.type) {
        case 'started': runId = event.runId; sessionId = event.sessionId; break
        case 'text': answer.text += event.text; break
        case 'context-compacted': contextCompacted = true; break
        case 'connection': task.status = event.state === 'reconnecting' ? 'Reconnecting' : 'In progress'; break
        case 'tool-call': if (answer.text && !answer.text.endsWith('\n\n')) answer.text += '\n\n'; activity.push(event); break
        case 'tool-result': { const tool = [...activity].reverse().find(t => t.id === event.id && t.output === undefined); if (tool) { tool.output = event.output; tool.isError = event.isError }; pending = undefined; break }
        case 'approval': pending = event.approval; break
        case 'done': task.done = event.reason === 'stop'; task.status = task.done ? 'Done' : event.reason === 'max-steps' ? 'Step limit reached' : 'Stopped'; break
        case 'error': error = event.message; task.status = 'Failed'; sessionId = undefined; break
      }
      if (event.type === 'text') {
        if (!frame) frame = requestAnimationFrame(() => {
          frame = 0
          const live = root.querySelector<HTMLElement>('[data-live-answer]')
          if (live) {
            const previous = live.textContent ?? ''
            const continuing = answer.text.startsWith(previous)
            if (!continuing) live.replaceChildren()
            const chunk = document.createElement('span')
            chunk.className = 'stream-chunk'
            chunk.textContent = continuing ? answer.text.slice(previous.length) : answer.text
            live.append(chunk)
          }
          const content = root.querySelector('#conversation')
          if (stickToEnd) content?.scrollTo(0, content.scrollHeight)
        })
      } else { if (frame) cancelAnimationFrame(frame); frame = 0; render() }
    }
    try { await run({ prompt: value, model, sessionId, projectId }, currentRun.signal, onEvent) }
    catch (e) {
      task.status = currentRun.signal.aborted ? 'Stopped' : 'Failed'
      error = currentRun.signal.aborted ? 'Run stopped. Approved changes remain on disk. Start a new session before continuing.' : e instanceof Error ? e.message : 'Host connection failed'
      sessionId = undefined
    } finally { activeRun = undefined; pending = undefined; if (config.mode === 'server' && projectId) { try { [conversations, memories] = await Promise.all([api<SavedConversation[]>('conversations?projectId=' + projectId), api<{id:string;content:string}[]>('memory?projectId=' + projectId)]) } catch { /* displayed content stays available */ } }; render(); root.querySelector('textarea')?.focus() }
  }
  function revertButton(tool:typeof activity[number]){
    if(!tool.output||tool.isError||!['apply_file_change','revert_file_change'].includes(tool.name))return ''
    try{const change=JSON.parse(tool.output) as {change_id?:string};if(!change.change_id||!/^[a-f0-9-]{36}$/.test(change.change_id))return '';return `<button class="copy-button" data-prompt="Review and revert file change ${change.change_id}. Read the change record and propose the exact revert for my approval. Do not overwrite newer edits." ${activeRun||cloudBusy||projectReadOnly()?'disabled':''}>${icon('Back')} Review revert</button>`}catch{return ''}
  }
  function toolContent(items = activity) {
    return items.length ? items.map(tool => { const index = activity.indexOf(tool); return `<details class="tool-event" data-detail="tool-${index}"><summary>${icon(tool.output === undefined ? 'LoaderCircle' : tool.isError ? 'Close' : 'Check', tool.output === undefined ? 'spinner' : 'draw-check')}<span>${escape(tool.name)}</span>${icon('ChevronDown','chevron')}</summary><div class="tool-body"><div class="tool-caption"><span class="eyebrow">${tool.output === undefined ? 'Proposed input' : 'Tool result'}</span><button class="copy-button" data-copy-tool="${index}" aria-label="Copy tool ${index + 1}">${icon(copiedTool === index ? 'Check' : 'Copy', copiedTool === index ? 'draw-check' : '')}<span>${copiedTool === index ? 'Copied' : 'Copy'}</span></button>${revertButton(tool)}</div><pre>${escape(JSON.stringify(tool.input, null, 2))}</pre>${tool.output === undefined ? '<p class="muted">Waiting for execution.</p>' : `<pre>${escape(tool.output)}</pre>`}</div></details>` }).join('') : '<p class="muted">No tools have run yet.</p>'
  }
  function chatContent() {
    return messages.length ? `<div class="messages">${messages.map((message, index) => `<article class="message ${message.role}"><span class="avatar ${message.role === 'assistant' ? 'ai-avatar' : ''}">${message.role === 'user' ? 'You' : 'AI'}</span><div ${activeRun && index === messages.length - 1 ? 'data-live-answer' : ''}>${escape(message.text || (activeRun ? 'Thinking through your request.' : 'See tool activity below.'))}</div></article>`).join('')}${activeRun ? `<div class="thinking" role="status"><span class="ai-avatar thinking-avatar">AI</span><span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>${pending ? 'Waiting for your approval.' : 'Working with your project.'}</span></div>` : ''}<section class="tool-list"><div class="section-heading"><p class="eyebrow">Behind the work</p><h2>Tool activity.</h2></div>${toolContent()}</section></div>` : `<div class="welcome"><span class="welcome-icon">${icon('Sparkles')}</span><p class="eyebrow">Your coding workspace</p><h1>Make room for<br>your next idea.</h1><p>A calm place to turn a little context into working code.<br>One conversation, across web and desktop.</p><div class="suggestions"><button data-prompt="Explore the project structure">${icon('Explorer')}<span><strong>Explore the project</strong><small>Find your way around the codebase</small></span>${icon('ArrowUpRight')}</button><button data-prompt="Plan the next feature without changing files">${icon('Tasks')}<span><strong>Plan a feature</strong><small>Give your next idea a clear first step</small></span>${icon('ArrowUpRight')}</button><button data-prompt="Review the latest changes without changing files">${icon('Git')}<span><strong>Review changes</strong><small>See what moved and what needs a look</small></span>${icon('ArrowUpRight')}</button></div><p class="preview-note">${icon('ShieldCheck')} Changes stay in your hands.${config?.mode === 'server' ? ' Conversations are saved to your project.' : ''}</p></div>`
  }
  function teamsContent(){
    const admin=teams.find(team=>team.id===teamId)?.role.split(',').some(role=>['owner','admin'].includes(role))
    return `<div class="page-panel"><p class="eyebrow">A shared place to work</p><h1>Your team.</h1><p>Invite your teammates and choose who can make changes.</p><button data-load-teams>Refresh teams</button><form id="accept-invite"><label>Invitation ID<input name="invitationId" required maxlength="256" value="${escape(invitation)}"></label><button type="submit">Accept invitation</button></form><form id="create-team"><label>Team name<input name="name" required maxlength="120"></label><label>Team handle<input name="slug" required maxlength="120" pattern="[a-z0-9]+(-[a-z0-9]+)*" placeholder="your-team"></label><button type="submit" ${config?.user?.emailVerified?'':'disabled'}>Create team</button>${!config?.user?.emailVerified?'<p>Team creation requires a verified email address.</p>':''}</form>${teams.length?`<label>Team<select data-team>${teams.map(team=>`<option value="${escape(team.id)}" ${team.id===teamId?'selected':''}>${escape(team.name)} · ${escape(team.role)}</option>`).join('')}</select></label>${admin&&config?.auth?.emailRecovery?'<form id="invite-member"><label>Email<input type="email" name="email" required maxlength="254"></label><label>Role<select name="role"><option value="member">Member</option><option value="viewer">Viewer</option><option value="admin">Admin</option></select></label><button type="submit">Send invitation</button></form>':''}${teamMembers.map(member=>`<div class="info-card"><strong>${escape(member.user.name)}</strong><p>${escape(member.user.email)} · ${escape(member.role)}</p>${admin&&!member.role.split(',').includes('owner')?`<label>Role<select data-member-role="${escape(member.id)}">${['admin','member','viewer'].map(role=>`<option value="${role}" ${member.role===role?'selected':''}>${role}</option>`).join('')}</select></label><button data-remove-member="${escape(member.id)}">Remove member</button>`:''}</div>`).join('')}`:'<p>No teams yet. Create one or accept an invitation.</p>'}</div>`
  }
  function panelContent() {
    if (config?.mode === 'server' && section === 'Explorer') return filesPage({ projectId, tree, expanded, file: openedFile, editing, readOnly: projectReadOnly(), disabled: cloudBusy || !!activeRun })
    if (config?.mode === 'server' && section === 'Git') return gitPage({ projectId, raw: gitRaw, loading: gitLoading, error: gitError, source: projectId ? sourceCard(sources.get(projectId), sourceFailed.has(projectId), projectId) : '', disabled: !!activeRun })
    if (section === 'Connections' && config?.mode === 'server') return connectionsPage(ghUi())
    if(section==='Teams')return teamsContent()
    if (section === 'Projects') return `<div class="page-panel"><h1>Your projects.</h1><p>Each project has its own files, conversations and memory.</p><form id="project-form"><label>Project name<input name="name" required maxlength="120"></label><label>Workspace<select name="organizationId"><option value="">Personal</option>${teams.filter(team=>team.role.split(',').some(role=>['owner','admin'].includes(role))).map(team=>`<option value="${escape(team.id)}">${escape(team.name)}</option>`).join('')}</select></label><button type="submit" ${cloudBusy || activeRun ? 'disabled' : ''}>Create project</button></form>${importCard(importUi())}${projectList(projects.map(p => ({ id: p.id, name: p.name, source: sources.get(p.id) })), cloudBusy || !!activeRun)}</div>`
    if (section === 'Memory') return `<div class="page-panel"><h1>Project memory.</h1><p>Notes are recalled in this project's conversations. Never save credentials here.</p>${projectId ? `<form id="memory-form"><label>Project fact<textarea name="content" required maxlength="4000"></textarea></label><button type="submit" ${cloudBusy || activeRun || projectReadOnly() ? 'disabled' : ''}>Save memory</button></form>${memories.map(m => `<div class="info-card memory-card"><p>${escape(m.content)}</p><button data-forget="${escape(m.id)}" ${cloudBusy || activeRun || projectReadOnly() ? 'disabled' : ''}>Remove</button></div>`).join('')}` : '<p>Choose a project first.</p>'}</div>`
    if (section === 'Tasks') return `<div class="page-panel"><p class="eyebrow">A LITTLE PROGRESS, EVERY DAY</p><h1>Your tasks.</h1>${tasks.length ? tasks.map(task => `<div class="task-row ${task.done ? 'done' : ''}"><span>${escape(task.text)}</span><small>${escape(task.status)}</small></div>`).join('') : '<p>Send a message to start your first task.</p>'}</div>`
    if (section === 'Terminal') return `<div class="page-panel"><h1>Commands.</h1>${toolContent(activity.filter(t => t.name === 'run_command'))}</div>`
    const panels: Record<string, [string, string]> = {
      Explorer: ['Project explorer', 'Ask Oqelira to list or read project files. A browsable file tree is coming next.'],
      Git: ['Changes', 'Ask Oqelira to inspect Git status. Commands require approval. A dedicated diff viewer is coming next.'],
      Settings: ['Make yourself at home', config?.mode === 'server' ? 'Signed in to your Oqelira account. Project memory and conversations are stored in PostgreSQL. Foundry deployment names come from server configuration. Flwn integration is separate.' : 'This is local mode. Connect Desktop to your Oqelira server for accounts, saved conversations and project memory.'],
    }
    const [title, description] = panels[section]!
    return `<div class="page-panel"><span class="welcome-spark">${icons[section]}</span><h1>${title}.</h1><p>${description}</p><div class="info-card"><strong>${escape(config?.workspace ?? 'Connecting')}</strong><p>Your credentials stay outside the shared UI.</p></div>${section==='Settings'&&config?.mode==='server'?`${settingsConnections(ghUi())}${config.auth?.emailRecovery&&!config.user?.emailVerified?'<button data-verify-account>Verify email address</button>':''}${!navigator.userAgent.includes('Electron/')?(config.auth?.socialProviders??[]).filter(provider=>provider!=='github').map(provider=>`<button class="social-button" data-link-provider="${provider}">Connect ${provider==='google'?'Google':'GitHub'}</button>`).join(''):''}`:''}</div>`
  }
  function inspectorContent() {
    const files = [...new Set(activity.filter(t => ['write_file', 'edit_file', 'apply_file_change', 'revert_file_change'].includes(t.name) && t.output !== undefined && !t.isError).map(t => String((t.input as Record<string, unknown>).path ?? '')))]
    if (tab === 'Context') return `<div class="section-heading"><p class="eyebrow">A little context</p><h2>Workspace notes.</h2></div><div class="info-card"><strong>${escape(projects.find(p => p.id === projectId)?.name ?? config?.workspace ?? '')}</strong><p>Model: ${escape(model)}</p>${config?.mode === 'server' ? `<p>Signed in as ${escape(config.user?.name ?? '')}<br>Project memory: ${memories.length} note${memories.length === 1 ? '' : 's'}<br>Your conversations are saved.</p>` : '<p>Local mode · History lasts until restart.</p>'}</div>`
    if (tab === 'Files') return `<div class="section-heading"><p class="eyebrow">In this conversation</p><h2>Files changed. <span class="count">${files.length}</span></h2></div>${files.map(file => `<div class="info-card file-card">${icon('FileText')}<span>${escape(file)}</span></div>`).join('') || `<div class="empty-state">${icon('FileText')}<p>No file changes yet.</p><small>Approved edits will appear here.</small></div>`}`
    const task = tasks[tasks.length - 1]
    return `<div class="section-heading"><p class="eyebrow">Keep it in focus</p><h2>Current task.</h2></div><div class="task-card ${pending ? 'decision-card' : activeRun ? 'progress-card' : task?.done ? 'done-card' : ''}"><span class="status"><span class="status-dot"></span>${pending ? 'Awaiting approval' : escape(task?.status ?? 'Ready when you are')}</span><h3>${escape(task?.text ?? 'A fresh start for your next idea.')}</h3><p>${activeRun ? 'Follow your agent’s progress in the conversation.' : task?.done ? 'Your result is ready in the conversation.' : 'Start a conversation and take the next step.'}</p>${task?.done ? `<div class="task-done">${icon('Check','draw-check')} Done</div>` : ''}</div><details open data-detail="changed-files"><summary><span>Files changed</span><span class="count">${files.length}</span>${icon('ChevronDown','chevron')}</summary>${files.map(file => `<p class="file-name">${icon('FileText')}${escape(file)}</p>`).join('') || '<p class="muted">No changes yet.</p>'}</details><details data-detail="commands"><summary><span>Commands</span><span class="count">${activity.filter(t => t.name === 'run_command').length}</span>${icon('ChevronDown','chevron')}</summary>${toolContent(activity.filter(t => t.name === 'run_command'))}</details><details data-detail="tools"><summary><span>Tool calls</span><span class="count">${activity.length}</span>${icon('ChevronDown','chevron')}</summary>${toolContent()}</details>`
  }
  /** Handles the redirect back from GitHub: report the result, drop the query, and refresh the status. */
  function afterSignIn() {
    const back = githubReturn(location.search)
    if (!back || config?.mode !== 'server') return
    history.replaceState(null, '', withoutGithubReturn(new URL(location.href)))
    section = 'Connections'
    if (back === 'connected') notice = 'GitHub connected. Your repositories are ready to import.'
    else { ghReconnect = true; error = 'GitHub could not be connected. Try again.' }
    void loadGithub()
  }
  render()
  void getConfig().then(async value => {
    config = value; model = value.models[0]?.id ?? ''
    if (value.mode === 'server' && (!value.user || (value.auth?.emailRecovery && new URL(location.href).searchParams.has('token')))) {
      authCleanup = showSignIn(root, value, next => { config = next; authCleanup?.(); void loadCloud().then(render).catch(() => { error = 'Could not load your projects'; render() }) })
    } else { await loadCloud(); afterSignIn(); render() }
  }).catch(() => { error = 'Cannot reach the Oqelira server. Check the service and sign in again.'; render() })
  return () => { disposed = true; pollAbort.abort(); authCleanup?.(); activeRun?.abort(); controller.abort(); cancelAnimationFrame(frame); clearTimeout(loadingTimer); clearTimeout(loadingExit); clearTimeout(copyTimer); viewTransition?.skipTransition(); root.replaceChildren() }
}
