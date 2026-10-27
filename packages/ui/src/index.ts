import type { Approval, HostConfig, HostEvent } from '@oqelira/protocol'
import { approve, getConfig, run } from './transport.js'
import { api, showSignIn } from './cloud.js'
import type { Project, SavedConversation } from './cloud.js'

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
  let disposed = false
  let frame = 0
  let authCleanup: (() => void) | undefined
  let projects: Project[] = []
  let projectId: string | undefined
  let conversations: SavedConversation[] = []
  let memories: { id: string; content: string }[] = []
  let cloudBusy = false
  let directory = '.', listing: string[] = [], filePath = '', fileText = '', gitDiff = ''
  const activity: { id: string; name: string; input: unknown; output?: string; isError?: boolean }[] = []
  let section = 'Chat'
  let tab = 'Task'
  let messages: { role: string; text: string }[] = []
  let tasks: { text: string; done: boolean; status: string }[] = []
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const icons: Record<string, string> = { Chat: '▢', Tasks: '☑', Explorer: '▱', Terminal: '⌘', Git: '⑂', Settings: '⚙' }
  const clearConversation = () => { messages = []; tasks = []; activity.length = 0; sessionId = undefined; pending = undefined; error = ''; draft = ''; root.querySelector('textarea')?.remove() }
  async function loadProject(id: string) {
    if (activeRun || cloudBusy) return
    cloudBusy = true; clearConversation(); projectId = id
    directory = '.'; listing = []; filePath = ''; fileText = ''; gitDiff = ''
    try { [conversations, memories] = await Promise.all([api<SavedConversation[]>('conversations?projectId=' + id), api<{id:string;content:string}[]>('memory?projectId=' + id)]); section = 'Chat' }
    catch (e) { error = e instanceof Error ? e.message : 'Could not load project' }
    finally { cloudBusy = false; render() }
  }
  async function loadCloud() {
    if (config?.mode !== 'server') return
    projects = await api<Project[]>('projects')
    if (!projectId && projects.length) await loadProject(projects[0]!.id)
    if (!projects.length) section = 'Projects'
  }
  async function openConversation(id: string) {
    if (activeRun || cloudBusy) return
    cloudBusy = true
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
    finally { cloudBusy = false; render() }
  }
  async function loadFiles(path = '.') {
    if (!projectId || cloudBusy || activeRun) return
    cloudBusy = true
    try { const result = await api<{output:string}>('files?projectId=' + projectId + '&path=' + encodeURIComponent(path)); listing = result.output.split('\n').filter(Boolean); directory = path }
    catch (e) { error = e instanceof Error ? e.message : 'Could not list files' }
    finally { cloudBusy = false; render() }
  }
  function render() {
    if (disposed) return
    const textarea = root.querySelector<HTMLTextAreaElement>('#prompt')
    const focused = textarea === document.activeElement
    if (textarea) draft = textarea.value
    controller.abort()
    controller = new AbortController()
    const signal = controller.signal
    root.innerHTML = `
      <aside class="sidebar">
        <a class="brand" href="#"><span class="brand-mark">ƒ</span><span><strong>Oqelira</strong><small>by Flwn</small></span></a>
        <nav aria-label="Main navigation">${Object.entries({ ...icons, ...(config?.mode === 'server' ? { Projects: '▣', Memory: '✦' } : {}) }).map(([name, icon]) => `<button data-section="${name}" class="nav-item ${section === name ? 'selected' : ''}" ${section === name ? 'aria-current="page"' : ''}><span>${icon}</span>${name}</button>`).join('')}</nav>
        <div class="recent"><p class="eyebrow">Current session</p><button data-action="chat" class="session">▢ &nbsp; ${escape(tasks[0]?.text.slice(0, 35) ?? 'A fresh start')}<small>${tasks.length} request(s)</small></button></div>
        ${config?.mode === 'server' ? `<div class="saved-sessions"><p class="eyebrow">Saved conversations</p>${conversations.map(c => `<button data-conversation="${escape(c.id)}" ${activeRun || cloudBusy ? 'disabled' : ''}>${escape(c.title.slice(0, 45))}</button>`).join('')}</div>` : ''}
        <button class="new-session" data-action="new" ${activeRun ? 'disabled' : ''}>＋ <span>New session</span></button>
      </aside>
      <header class="topbar"><div class="workspace-switch"><span>Workspace</span>${config?.mode === 'server' ? `<label class="sr-only" for="project">Project</label><select id="project" ${activeRun || cloudBusy ? 'disabled' : ''}><option value="">Choose project</option>${projects.map(p => `<option value="${escape(p.id)}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select>` : `<strong>${escape(config?.workspace ?? 'flwn-Oqelira')}</strong>`}</div><div class="top-actions"><label class="sr-only" for="model">Model</label><select id="model" ${activeRun ? 'disabled' : ''}>${config?.models.map(m => `<option value="${escape(m.id)}" ${m.id === model ? 'selected' : ''}>${escape(m.deployment)}</option>`).join('') ?? '<option>Connecting…</option>'}</select><button data-section="Settings" aria-label="Open settings">⚙</button>${config?.user ? '<button data-action="logout">Sign out</button>' : '<span class="avatar">You</span>'}</div></header>
      <main class="main"><div class="tabbar"><span>▢ &nbsp; ${section}</span><span class="project-tab">flwn-Oqelira</span><button data-action="new" aria-label="New session">＋</button></div>
      ${error ? `<div class="notice error" role="alert">${escape(error)}</div>` : ''}
      ${config && !config.configured ? '<div class="notice">Add FOUNDRY_KEY and FOUNDRY_ENDPOINT to the host .env, then restart Oqelira. Credentials stay on your computer.</div>' : ''}
      <div class="content" id="conversation">${section === 'Chat' ? chatContent() : panelContent()}</div>
      ${pending ? approvalContent() : ''}
      ${section === 'Chat' ? `<form class="composer"><label class="sr-only" for="prompt">Message Oqelira</label><textarea id="prompt" name="prompt" placeholder="Ask Oqelira anything…" rows="2" required maxlength="10000" ${activeRun ? 'disabled' : ''}>${escape(draft)}</textarea><div class="composer-bar"><span class="mode-pill">✦ ${activeRun ? 'Working' : 'Ask before changes'}</span><span class="composer-hint">Enter to send · Shift + Enter for a new line</span>${activeRun ? '<button type="button" data-action="stop">Stop</button>' : `<button class="send" type="submit" aria-label="Send message" ${!config?.configured ? 'disabled' : ''}>➤</button>`}</div></form>` : ''}</main>
      <aside class="inspector"><div class="inspector-tabs" role="tablist" aria-label="Workspace details">${['Task', 'Context', 'Files'].map(name => `<button role="tab" aria-selected="${tab === name}" data-tab="${name}" class="${tab === name ? 'active' : ''}">${name}</button>`).join('')}</div><div class="inspector-content" role="tabpanel">${inspectorContent()}</div><footer>Oqelira by Flwn <span>✦</span></footer></aside>`
    root.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => button.addEventListener('click', () => { section = button.dataset.section!; render() }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-conversation]').forEach(button => button.addEventListener('click', () => { void openConversation(button.dataset.conversation!) }, { signal }))
    root.querySelector('[data-load-files]')?.addEventListener('click', () => { void loadFiles(directory) }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-open-path]').forEach(button => button.addEventListener('click', () => {
      if (!projectId || cloudBusy || activeRun) return
      const path = button.dataset.openPath!
      if (path.endsWith('/')) { void loadFiles(path.slice(0,-1)); return }
      cloudBusy = true
      void api<{output:string}>('file?projectId=' + projectId + '&path=' + encodeURIComponent(path)).then(result => { filePath = path; fileText = result.output; cloudBusy = false; render() }).catch(e => { error = e instanceof Error ? e.message : 'Could not read file'; cloudBusy = false; render() })
    }, { signal }))
    root.querySelector('[data-load-git]')?.addEventListener('click', () => {
      if (!projectId || cloudBusy || activeRun) return
      cloudBusy = true
      void api<{output:string}>('git?projectId=' + projectId).then(result => { gitDiff = result.output; cloudBusy = false; render() }).catch(e => { error = e instanceof Error ? e.message : 'Could not load Git'; cloudBusy = false; render() })
    }, { signal })
    root.querySelector<HTMLFormElement>('#file-form')?.addEventListener('submit', event => {
      event.preventDefault(); if (!projectId || cloudBusy || activeRun) return
      const fields = new FormData(event.target as HTMLFormElement), path = String(fields.get('path') ?? ''), content = String(fields.get('content') ?? '')
      cloudBusy = true
      void api('file', { projectId, path, content }).then(async () => { filePath = path; fileText = content; cloudBusy = false; await loadFiles(directory) }).catch(e => { error = e instanceof Error ? e.message : 'Could not save file'; cloudBusy = false; render() })
    }, { signal })
    root.querySelector<HTMLSelectElement>('#project')?.addEventListener('change', event => { const id = (event.target as HTMLSelectElement).value; if (id) void loadProject(id) }, { signal })
    root.querySelector('[data-action="logout"]')?.addEventListener('click', () => { activeRun?.abort(); void api('auth/sign-out', {}).then(() => location.reload()).catch(() => { error = 'Could not sign out'; render() }) }, { signal })
    root.querySelector<HTMLFormElement>('#project-form')?.addEventListener('submit', event => {
      event.preventDefault(); if (cloudBusy || activeRun) return
      const name = String(new FormData(event.target as HTMLFormElement).get('name') ?? '').trim()
      cloudBusy = true
      void api<Project>('projects', { name }).then(async project => { projects.push(project); cloudBusy = false; await loadProject(project.id) }).catch(e => { error = e instanceof Error ? e.message : 'Could not create project'; cloudBusy = false; render() })
    }, { signal })
    root.querySelector<HTMLFormElement>('#memory-form')?.addEventListener('submit', event => {
      event.preventDefault(); if (!projectId || activeRun || cloudBusy) return
      const content = String(new FormData(event.target as HTMLFormElement).get('content') ?? '').trim()
      cloudBusy = true
      void api('memory', { projectId, content }).then(async () => { memories = await api('memory?projectId=' + projectId); cloudBusy = false; render() }).catch(e => { error = e instanceof Error ? e.message : 'Could not save memory'; cloudBusy = false; render() })
    }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-forget]').forEach(button => button.addEventListener('click', () => {
      if (cloudBusy || activeRun) return
      cloudBusy = true
      void api('memory', { projectId, action: 'forget', id: button.dataset.forget }).then(() => { memories = memories.filter(m => m.id !== button.dataset.forget); cloudBusy = false; render() }).catch(() => { error = 'Could not remove memory'; cloudBusy = false; render() })
    }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab!; render() }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-action="new"]').forEach(button => button.addEventListener('click', () => { if (activeRun) return; messages = []; tasks = []; activity.length = 0; sessionId = undefined; pending = undefined; error = ''; draft = ''; root.querySelector('textarea')?.remove(); section = 'Chat'; render() }, { signal }))
    root.querySelector('[data-action="stop"]')?.addEventListener('click', () => activeRun?.abort(), { signal })
    root.querySelector<HTMLSelectElement>('#model')?.addEventListener('change', event => { model = (event.target as HTMLSelectElement).value }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-allow]').forEach(button => button.addEventListener('click', () => { void decide(button.dataset.allow === 'true') }, { signal }))
    root.querySelector('[data-action="chat"]')?.addEventListener('click', () => { section = 'Chat'; render() }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => { const input = root.querySelector<HTMLTextAreaElement>('textarea')!; input.value = button.dataset.prompt!; input.focus() }, { signal }))
    const form = root.querySelector<HTMLFormElement>('form.composer')
    form?.addEventListener('submit', event => { event.preventDefault(); submit() }, { signal })
    root.querySelector<HTMLTextAreaElement>('#prompt')?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit() } }, { signal })
    if (messages.length) root.querySelector('#conversation')?.scrollTo(0, 999999)
    if (focused && !activeRun) root.querySelector('textarea')?.focus()
  }
  function approvalContent() {
    if (!pending) return ''
    const input = (pending.input ?? {}) as Record<string, unknown>
    let preview = JSON.stringify(input, null, 2)
    if (pending.tool === 'edit_file') preview = `--- Existing text\n${String(input.old_string ?? '')}\n+++ Replacement\n${String(input.new_string ?? '')}`
    if (pending.tool === 'write_file') preview = String(input.content ?? '')
    return `<section class="approval-card" role="region" aria-label="Approval required"><h2>Permission needed · ${escape(pending.risk)}</h2><strong>${escape(pending.summary)}</strong><pre>${escape(preview)}</pre><p>${pending.risk === 'exec' ? 'Shell commands can access your computer. Review the entire command.' : 'Review this change before allowing it.'} This request expires after two minutes.</p><button data-allow="true" ${approvalBusy ? 'disabled' : ''}>✓ Allow once</button> <button data-allow="false" ${approvalBusy ? 'disabled' : ''}>✕ Deny</button></section>`
  }
  async function decide(allowed: boolean) {
    if (!pending || approvalBusy) return
    const current = pending
    approvalBusy = true; render()
    try { await approve(runId, current.id, allowed); if (pending?.id === current.id) pending = undefined }
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
    activeRun = new AbortController()
    const currentRun = activeRun
    render()
    const onEvent = (event: HostEvent) => {
      if (disposed) return
      switch (event.type) {
        case 'started': runId = event.runId; sessionId = event.sessionId; break
        case 'text': answer.text += event.text; break
        case 'tool-call': if (answer.text && !answer.text.endsWith('\n\n')) answer.text += '\n\n'; activity.push(event); break
        case 'tool-result': { const tool = [...activity].reverse().find(t => t.id === event.id && t.output === undefined); if (tool) { tool.output = event.output; tool.isError = event.isError }; pending = undefined; break }
        case 'approval': pending = event.approval; break
        case 'done': task.done = event.reason === 'stop'; task.status = task.done ? 'Completed' : event.reason === 'max-steps' ? 'Step limit reached' : 'Stopped'; break
        case 'error': error = event.message; task.status = 'Failed'; sessionId = undefined; break
      }
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; render() })
    }
    try { await run({ prompt: value, model, sessionId, projectId }, currentRun.signal, onEvent) }
    catch (e) {
      task.status = currentRun.signal.aborted ? 'Stopped' : 'Failed'
      error = currentRun.signal.aborted ? 'Run stopped. Approved changes remain on disk. Start a new session before continuing.' : e instanceof Error ? e.message : 'Host connection failed'
      sessionId = undefined
    } finally { activeRun = undefined; pending = undefined; if (config.mode === 'server' && projectId) { try { [conversations, memories] = await Promise.all([api<SavedConversation[]>('conversations?projectId=' + projectId), api<{id:string;content:string}[]>('memory?projectId=' + projectId)]) } catch { /* displayed content stays available */ } }; render(); root.querySelector('textarea')?.focus() }
  }
  function toolContent(items = activity) {
    return items.length ? items.map(tool => `<details class="tool-event"><summary>${tool.output === undefined ? '◌' : tool.isError ? '✕' : '✓'} ${escape(tool.name)}</summary><pre>${escape(JSON.stringify(tool.input, null, 2))}</pre>${tool.output === undefined ? '<p>Waiting for execution</p>' : `<pre>${escape(tool.output)}</pre>`}</details>`).join('') : '<p class="muted">No tools have run in this session.</p>'
  }
  function chatContent() {
    return messages.length ? `<div class="messages">${messages.map(message => `<article class="message ${message.role}"><span class="avatar ${message.role === 'assistant' ? 'spark' : ''}">${message.role === 'user' ? 'You' : '✦'}</span><div>${escape(message.text || (activeRun ? 'Working…' : 'See tool activity below.'))}</div></article>`).join('')}<section class="tool-list"><h2>Tool activity</h2>${toolContent()}</section></div>` : `<div class="welcome"><span class="welcome-spark">✦</span><p class="eyebrow">YOUR WORKSPACE, A LITTLE CLEARER</p><h1>What will we build today?</h1><p>A calm place to turn your next idea into code.<br>One conversation, across web and desktop.</p><div class="suggestions"><button data-prompt="Explore the project structure"><span>▱</span><strong>Explore the project</strong><small>Find your way around the codebase</small>↗</button><button data-prompt="Plan the next feature without changing files"><span>✦</span><strong>Plan a feature</strong><small>Break your next idea into clear steps</small>↗</button><button data-prompt="Review the latest changes without changing files"><span>⑂</span><strong>Review changes</strong><small>Make room for a fresh perspective</small>↗</button></div><p class="preview-note">Writes and commands need your approval · Sessions last until restart</p></div>`
  }
  function panelContent() {
    if (config?.mode === 'server' && section === 'Explorer') return `<div class="page-panel"><h1>Project files</h1><p>Files are inside this project's isolated workspace. Saving writes the text you explicitly submit.</p>${projectId ? `<button data-load-files ${cloudBusy || activeRun ? 'disabled' : ''}>Refresh ${escape(directory)}</button><div class="file-tree">${directory !== '.' ? '<button data-open-path="./">Back to project root</button>' : ''}${listing.map(name => `<button data-open-path="${escape((directory === '.' ? '' : directory + '/') + name)}" ${cloudBusy || activeRun ? 'disabled' : ''}>${escape(name)}</button>`).join('')}</div><form id="file-form"><label>Project-relative file path<input name="path" required maxlength="1000" value="${escape(filePath)}" placeholder="src/main.ts"></label><label>File content<textarea name="content" maxlength="20000" rows="12">${escape(fileText)}</textarea></label><button type="submit" ${cloudBusy || activeRun ? 'disabled' : ''}>Save file to project</button></form>` : '<p>Choose a project first.</p>'}</div>`
    if (config?.mode === 'server' && section === 'Git') return `<div class="page-panel"><h1>Git changes</h1><p>Status and diff are read from the isolated project. Ask the agent to initialize Git or create reviewed commits.</p><button data-load-git ${cloudBusy || activeRun || !projectId ? 'disabled' : ''}>Refresh status and diff</button><pre class="git-diff">${escape(gitDiff || 'No Git data loaded yet.')}</pre></div>`
    if (section === 'Projects') return `<div class="page-panel"><h1>Your projects</h1><p>Each project has its own files, conversations and memory.</p><form id="project-form"><label>Project name<input name="name" required maxlength="120"></label><button type="submit" ${cloudBusy || activeRun ? 'disabled' : ''}>Create project</button></form>${projects.map(p => `<div class="info-card">${escape(p.name)}</div>`).join('')}</div>`
    if (section === 'Memory') return `<div class="page-panel"><h1>Project memory</h1><p>Notes are recalled in this project's conversations. Never save credentials here.</p>${projectId ? `<form id="memory-form"><label>Project fact<textarea name="content" required maxlength="4000"></textarea></label><button type="submit" ${cloudBusy || activeRun ? 'disabled' : ''}>Save memory</button></form>${memories.map(m => `<div class="info-card"><p>${escape(m.content)}</p><button data-forget="${escape(m.id)}" ${cloudBusy || activeRun ? 'disabled' : ''}>Remove</button></div>`).join('')}` : '<p>Choose a project first.</p>'}</div>`
    if (section === 'Tasks') return `<div class="page-panel"><p class="eyebrow">A LITTLE PROGRESS, EVERY DAY</p><h1>Your tasks</h1>${tasks.length ? tasks.map(task => `<div class="task-row ${task.done ? 'done' : ''}"><span>${escape(task.text)}</span><small>${escape(task.status)}</small></div>`).join('') : '<p>Send a message to start your first task.</p>'}</div>`
    if (section === 'Terminal') return `<div class="page-panel"><h1>Commands</h1>${toolContent(activity.filter(t => t.name === 'run_command'))}</div>`
    const panels: Record<string, [string, string]> = {
      Explorer: ['Project explorer', 'Ask Oqelira to list or read project files. A browsable file tree is coming next.'],
      Git: ['Changes', 'Ask Oqelira to inspect Git status. Commands require approval. A dedicated diff viewer is coming next.'],
      Settings: ['Make yourself at home', config?.mode === 'server' ? 'Signed in to your Oqelira account. Project memory and conversations are stored in PostgreSQL. Foundry deployment names come from server configuration. Flwn integration is separate.' : 'This is local mode. Connect Desktop to your Oqelira server for accounts, saved conversations and project memory.'],
    }
    const [title, description] = panels[section]!
    return `<div class="page-panel"><span class="welcome-spark">${icons[section]}</span><h1>${title}</h1><p>${description}</p><div class="info-card"><strong>${escape(config?.workspace ?? 'Connecting')}</strong><p>Your credentials stay outside the shared UI.</p></div></div>`
  }
  function inspectorContent() {
    const files = [...new Set(activity.filter(t => ['write_file', 'edit_file'].includes(t.name) && t.output !== undefined && !t.isError).map(t => String((t.input as Record<string, unknown>).path ?? '')))]
    if (tab === 'Context') return `<h2>Workspace context</h2><div class="info-card"><strong>${escape(config?.workspace ?? '')}</strong><p>Model: ${escape(model)}</p>${config?.mode === 'server' ? `<p>Signed in as ${escape(config.user?.name ?? '')}<br>Project memory: ${memories.length} note(s)<br>Conversations: saved in PostgreSQL</p>` : '<p>Local mode · History lasts until restart.</p>'}<p>Flwn integration is separate.</p></div>`
    if (tab === 'Files') return `<h2>Files changed <span class="count">${files.length}</span></h2>${files.map(file => `<div class="info-card">${escape(file)}</div>`).join('') || '<p>No approved file changes yet.</p>'}`
    const task = tasks[tasks.length - 1]
    return `<h2>Current task</h2><div class="task-card"><span class="status">● ${pending ? 'Awaiting approval' : escape(task?.status ?? 'Ready when you are')}</span><h3>${escape(task?.text ?? 'A fresh start for your next idea')}</h3><p>${activeRun ? 'Follow streamed replies and tools in the conversation.' : 'Start a conversation and keep your work in focus.'}</p></div><details open><summary>Files changed <span class="count">${files.length}</span></summary>${files.map(file => `<p>${escape(file)}</p>`).join('') || '<p>No changes yet</p>'}</details><details><summary>Commands <span class="count">${activity.filter(t => t.name === 'run_command').length}</span></summary>${toolContent(activity.filter(t => t.name === 'run_command'))}</details><details><summary>Tool calls <span class="count">${activity.length}</span></summary>${toolContent()}</details>`
  }
  render()
  void getConfig().then(async value => {
    config = value; model = value.models[0]?.id ?? ''
    if (value.mode === 'server' && !value.user) {
      authCleanup = showSignIn(root, value, next => { config = next; authCleanup?.(); void loadCloud().then(render).catch(() => { error = 'Could not load your projects'; render() }) })
    } else { await loadCloud(); render() }
  }).catch(() => { error = 'Cannot reach the Oqelira server. Check the service and sign in again.'; render() })
  return () => { disposed = true; authCleanup?.(); activeRun?.abort(); controller.abort(); cancelAnimationFrame(frame); root.replaceChildren() }
}
