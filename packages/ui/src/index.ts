import type { Approval, HostConfig, HostEvent } from '@oqelira/protocol'
import { approve, getConfig, run } from './transport.js'
import { api, showSignIn } from './cloud.js'
import type { Project, SavedConversation } from './cloud.js'
import { brand } from './brand.js'
import { icon } from './icons.js'
import type { IconName } from './icons.js'
import { exitElement, timing } from './motion.js'

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
  let moreOpen = false, inspectorOpen = false, stickToEnd = true, resetForms = false
  let lastSection = '', lastTab = '', loadingVisible = false, loadingStarted = 0
  let loadingTimer: ReturnType<typeof setTimeout> | undefined
  let loadingExit: ReturnType<typeof setTimeout> | undefined
  let viewTransition: ViewTransition | undefined
  let copiedTool = -1
  let copyTimer: ReturnType<typeof setTimeout> | undefined
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
  const icons: Record<string, string> = Object.fromEntries((['Chat','Tasks','Explorer','Terminal','Git','Settings','Projects','Memory'] as IconName[]).map(name => [name, icon(name)]))
  const clearConversation = () => { messages = []; tasks = []; activity.length = 0; sessionId = undefined; pending = undefined; error = ''; draft = ''; resetForms = true; root.querySelector('#prompt')?.remove() }
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
    directory = '.'; listing = []; filePath = ''; fileText = ''; gitDiff = ''
    try { [conversations, memories] = await Promise.all([api<SavedConversation[]>('conversations?projectId=' + id), api<{id:string;content:string}[]>('memory?projectId=' + id)]); section = 'Chat' }
    catch (e) { error = e instanceof Error ? e.message : 'Could not load project' }
    finally { busy(false); render() }
  }
  async function loadCloud() {
    if (config?.mode !== 'server') return
    projects = await api<Project[]>('projects')
    if (!projectId && projects.length) await loadProject(projects[0]!.id)
    if (!projects.length) section = 'Projects'
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
  async function loadFiles(path = '.') {
    if (!projectId || cloudBusy || activeRun) return
    busy(true)
    try { const result = await api<{output:string}>('files?projectId=' + projectId + '&path=' + encodeURIComponent(path)); listing = result.output.split('\n').filter(Boolean); directory = path }
    catch (e) { error = e instanceof Error ? e.message : 'Could not list files' }
    finally { busy(false); render() }
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
    const detailStates = new Map(Array.from(root.querySelectorAll<HTMLDetailsElement>('details[data-detail]')).map(node => [node.dataset.detail, node.open]))
    const formValues = new Map<string, string>()
    if (!changingSection && !resetForms) root.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('form[id] [name]').forEach(field => { if (field.type !== 'password') formValues.set(`${field.closest('form')!.id}:${field.name}`, field.value) })
    const textarea = root.querySelector<HTMLTextAreaElement>('#prompt')
    const focused = textarea === document.activeElement
    if (textarea) draft = textarea.value
    controller.abort()
    controller = new AbortController()
    const signal = controller.signal
    lastSection = section
    lastTab = tab
    root.classList.toggle('inspector-open', inspectorOpen)
    const primary: IconName[] = config?.mode === 'server' ? ['Chat','Projects','Explorer','Git'] : ['Chat','Explorer','Git']
    const secondary: IconName[] = config?.mode === 'server' ? ['Tasks','Terminal','Memory','Settings'] : ['Tasks','Terminal','Settings']
    root.innerHTML = `
      <aside class="sidebar">
        <a class="brand" href="#" aria-label="Oqelira by Flwn">${brand()}</a>
        <nav aria-label="Main navigation">${primary.map(name => `<button data-section="${name}" class="nav-item ${section === name ? 'selected' : ''}" ${section === name ? 'aria-current="page"' : ''}>${icon(name)}<span>${name === 'Explorer' ? 'Files' : name}</span></button>`).join('')}<div class="nav-more"><button class="nav-item ${secondary.includes(section as IconName) ? 'selected' : ''}" data-action="more" aria-haspopup="menu" aria-expanded="${moreOpen}" aria-controls="tools-menu">${icon('More')}<span>Tools</span>${icon('ChevronDown','chevron')}</button>${moreOpen ? `<div class="tools-menu" id="tools-menu" role="menu" aria-label="Workspace tools">${secondary.map(name => `<button role="menuitem" data-section="${name}">${icon(name)}<span>${name}</span></button>`).join('')}</div>` : ''}</div></nav>
        <div class="recent"><p class="eyebrow">This conversation</p><button data-action="chat" class="session">${icon('Chat')}<span>${escape(tasks[0]?.text.slice(0, 45) ?? 'A fresh start')}<small>${tasks.length} request${tasks.length === 1 ? '' : 's'}</small></span></button></div>
        ${config?.mode === 'server' ? `<div class="saved-sessions"><p class="eyebrow">Saved conversations</p>${conversations.map(c => `<button data-conversation="${escape(c.id)}" ${activeRun || cloudBusy ? 'disabled' : ''}>${icon('Chat')}<span>${escape(c.title.slice(0, 45))}</span></button>`).join('') || '<p class="sidebar-empty">Your conversations will live here.</p>'}</div>` : '<div class="local-note"><span class="eyebrow">Your workspace</span><p>One idea at a time.</p></div>'}
        <button class="new-session" data-action="new" ${activeRun ? 'disabled' : ''}>${icon('Plus')}<span>New conversation</span></button>
      </aside>
      <header class="topbar"><a class="mobile-brand brand" href="#" aria-label="Oqelira by Flwn">${brand()}</a><div class="workspace-switch"><span>Workspace</span>${config?.mode === 'server' ? `<label class="sr-only" for="project">Project</label><select id="project" ${activeRun || cloudBusy ? 'disabled' : ''}><option value="">Choose project</option>${projects.map(p => `<option value="${escape(p.id)}" ${p.id === projectId ? 'selected' : ''}>${escape(p.name)}</option>`).join('')}</select>` : `<strong>${escape(config?.workspace ?? 'flwn-Oqelira')}</strong>`}</div><div class="top-actions"><label class="sr-only" for="model">Model</label><select id="model" ${activeRun ? 'disabled' : ''}>${config?.models.map(m => `<option value="${escape(m.id)}" ${m.id === model ? 'selected' : ''}>${escape(m.deployment)}</option>`).join('') ?? '<option>Connecting…</option>'}</select><button class="icon-button inspector-toggle" data-action="inspector" aria-label="${inspectorOpen ? 'Close' : 'Open'} workspace details" data-tooltip="Workspace details" aria-expanded="${inspectorOpen}">${icon('PanelRight')}</button>${config?.user ? `<button class="icon-button" data-action="logout" aria-label="Sign out" data-tooltip="Sign out">${icon('LogOut')}</button>` : `<button class="user-badge" data-section="Settings" aria-label="Workspace settings" data-tooltip="Settings">${icon('Settings')}</button>`}</div></header>
      <main class="main" aria-busy="${cloudBusy}"><div class="tabbar"><span>${icons[section] ?? icon('Chat')}<strong>${section === 'Explorer' ? 'Files' : section}</strong></span><span class="project-tab">${escape(projects.find(p => p.id === projectId)?.name ?? config?.workspace ?? 'flwn-Oqelira')}</span><button class="icon-button" data-action="new" aria-label="New conversation" data-tooltip="New conversation" ${activeRun ? 'disabled' : ''}>${icon('Plus')}</button></div>
      ${loadingVisible ? `<div class="load-state" role="status">${icon('LoaderCircle','spinner')}<span>Loading your workspace.</span><div class="skeleton-line"></div></div>` : ''}
      ${error ? `<div class="notice error" role="alert"><div>${icon('Circle')}<span>${escape(error)}</span></div><button data-action="retry">${icon('Refresh')} Try again</button></div>` : ''}
      ${config && !config.configured ? '<div class="notice">Add FOUNDRY_KEY and FOUNDRY_ENDPOINT to the host .env, then restart Oqelira. Credentials stay on your computer.</div>' : ''}
      <div class="content" id="conversation">${section === 'Chat' ? chatContent() : panelContent()}</div>
      ${pending ? approvalContent() : ''}
      ${section === 'Chat' ? `<form class="composer"><label class="sr-only" for="prompt">Message Oqelira</label><textarea id="prompt" name="prompt" placeholder="Ask Oqelira anything…" rows="2" required maxlength="10000" ${activeRun ? 'disabled' : ''}>${escape(draft)}</textarea><div class="composer-bar"><span class="mode-pill">${icon('ShieldCheck')}<span>${activeRun ? pending ? 'Waiting for your approval' : 'Working with your project' : 'Ask before changes'}</span></span><span class="composer-hint">Enter to send · Shift + Enter for a new line</span>${activeRun ? `<button class="stop" type="button" data-action="stop">${icon('Stop')} Stop</button>` : `<button class="send" type="submit" aria-label="Send message" data-tooltip="Send message" ${!config?.configured ? 'disabled' : ''}>${icon('Send')}</button>`}</div></form>` : ''}</main>
      ${inspectorOpen ? '<button class="inspector-scrim" data-action="inspector" aria-label="Close workspace details"></button>' : ''}<aside class="inspector" aria-label="Workspace details"><div class="inspector-tabs" role="tablist" aria-label="Workspace details">${['Task', 'Context', 'Files'].map(name => `<button role="tab" aria-selected="${tab === name}" data-tab="${name}" class="${tab === name ? 'active' : ''}">${name}</button>`).join('')}</div><div class="inspector-content" role="tabpanel">${inspectorContent()}</div><footer><span>Oqelira by Flwn</span><span class="footer-note">A little more clarity.</span></footer></aside>`
    root.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => button.addEventListener('click', () => { section = button.dataset.section!; moreOpen = false; render() }, { signal }))
    const closeMore = async () => { const menu = root.querySelector<HTMLElement>('.tools-menu'); if (menu) await exitElement(menu); moreOpen = false; render(); root.querySelector<HTMLButtonElement>('[data-action="more"]')?.focus() }
    const closeInspector = async () => { const panel = root.querySelector<HTMLElement>('.inspector'); if (panel) await exitElement(panel); inspectorOpen = false; render() }
    root.querySelector('[data-action="more"]')?.addEventListener('click', () => { if (moreOpen) { void closeMore(); return }; moreOpen = true; render(); root.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus() }, { signal })
    root.querySelectorAll('[data-action="inspector"]').forEach(button => button.addEventListener('click', () => { if (inspectorOpen) { void closeInspector(); return }; inspectorOpen = true; render() }, { signal }))
    root.querySelector('[data-action="retry"]')?.addEventListener('click', () => { error = ''; if (config?.mode === 'server' && projectId) { void loadProject(projectId) } else { location.reload() } }, { signal })
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape') { if (moreOpen) void closeMore(); if (inspectorOpen) void closeInspector() }
      if (moreOpen && ['ArrowDown','ArrowUp'].includes(event.key)) { event.preventDefault(); const items = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')); const current = items.indexOf(document.activeElement as HTMLButtonElement); items[(current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus() }
    }, { signal })
    root.addEventListener('click', event => { if (moreOpen && !(event.target as Element).closest('.nav-more')) void closeMore() }, { signal })
    root.querySelector('#conversation')?.addEventListener('scroll', event => { const node = event.target as HTMLElement; stickToEnd = node.scrollHeight - node.clientHeight - node.scrollTop < 64 }, { signal, passive: true })
    root.querySelectorAll<HTMLButtonElement>('[data-conversation]').forEach(button => button.addEventListener('click', () => { void openConversation(button.dataset.conversation!) }, { signal }))
    root.querySelector('[data-load-files]')?.addEventListener('click', () => { void loadFiles(directory) }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-open-path]').forEach(button => button.addEventListener('click', () => {
      if (!projectId || cloudBusy || activeRun) return
      const path = button.dataset.openPath!
      if (path.endsWith('/')) { void loadFiles(path.slice(0,-1)); return }
      busy(true)
      void api<{output:string}>('file?projectId=' + projectId + '&path=' + encodeURIComponent(path)).then(result => { filePath = path; fileText = result.output; resetForms = true; busy(false); render() }).catch(e => { error = e instanceof Error ? e.message : 'Could not read file'; busy(false); render() })
    }, { signal }))
    root.querySelector('[data-load-git]')?.addEventListener('click', () => {
      if (!projectId || cloudBusy || activeRun) return
      busy(true)
      void api<{output:string}>('git?projectId=' + projectId).then(result => { gitDiff = result.output; busy(false); render() }).catch(e => { error = e instanceof Error ? e.message : 'Could not load Git'; busy(false); render() })
    }, { signal })
    root.querySelector<HTMLFormElement>('#file-form')?.addEventListener('submit', event => {
      event.preventDefault(); if (!projectId || cloudBusy || activeRun) return
      const fields = new FormData(event.target as HTMLFormElement), path = String(fields.get('path') ?? ''), content = String(fields.get('content') ?? '')
      busy(true)
      void api('file', { projectId, path, content }).then(async () => { filePath = path; fileText = content; busy(false); await loadFiles(directory) }).catch(e => { error = e instanceof Error ? e.message : 'Could not save file'; busy(false); render() })
    }, { signal })
    root.querySelector<HTMLSelectElement>('#project')?.addEventListener('change', event => { const id = (event.target as HTMLSelectElement).value; if (id) void loadProject(id) }, { signal })
    root.querySelector('[data-action="logout"]')?.addEventListener('click', () => { activeRun?.abort(); void api('auth/sign-out', {}).then(() => location.reload()).catch(() => { error = 'Could not sign out'; render() }) }, { signal })
    root.querySelector<HTMLFormElement>('#project-form')?.addEventListener('submit', event => {
      event.preventDefault(); if (cloudBusy || activeRun) return
      const name = String(new FormData(event.target as HTMLFormElement).get('name') ?? '').trim()
      busy(true)
      void api<Project>('projects', { name }).then(async project => { projects.push(project); busy(false); await loadProject(project.id) }).catch(e => { error = e instanceof Error ? e.message : 'Could not create project'; busy(false); render() })
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
    root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => { const input = root.querySelector<HTMLTextAreaElement>('textarea')!; input.value = button.dataset.prompt!; input.focus() }, { signal }))
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
      const previous = detailStates.get(node.dataset.detail)
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
  }
  function approvalContent() {
    if (!pending) return ''
    const input = (pending.input ?? {}) as Record<string, unknown>
    let preview = JSON.stringify(input, null, 2)
    if (pending.tool === 'edit_file') preview = `--- Existing text\n${String(input.old_string ?? '')}\n+++ Replacement\n${String(input.new_string ?? '')}`
    if (pending.tool === 'write_file') preview = String(input.content ?? '')
    return `<section class="approval-card" role="region" aria-label="Approval required"><div class="approval-heading">${icon('ShieldCheck')}<div><p class="eyebrow">Your call</p><h2>Permission needed.</h2></div><span class="chip">${escape(pending.risk)}</span></div><strong>${escape(pending.summary)}</strong><pre>${escape(preview)}</pre><p>${pending.risk === 'exec' ? config?.mode === 'server' ? 'Review the full command before it runs in this project’s isolated workspace.' : 'Shell commands can access your computer. Review the full command.' : 'Review this change before allowing it.'} This request expires after two minutes.</p><div class="approval-actions"><button class="primary" data-allow="true" aria-busy="${approvalBusy}" ${approvalBusy ? 'disabled' : ''}>${icon(approvalBusy ? 'LoaderCircle' : 'Check', approvalBusy ? 'spinner' : 'draw-check')}<span>Allow once</span></button><button data-allow="false" ${approvalBusy ? 'disabled' : ''}>${icon('Close')} Deny</button></div></section>`
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
    activeRun = new AbortController()
    stickToEnd = true
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
  function toolContent(items = activity) {
    return items.length ? items.map(tool => { const index = activity.indexOf(tool); return `<details class="tool-event" data-detail="tool-${index}"><summary>${icon(tool.output === undefined ? 'LoaderCircle' : tool.isError ? 'Close' : 'Check', tool.output === undefined ? 'spinner' : 'draw-check')}<span>${escape(tool.name)}</span>${icon('ChevronDown','chevron')}</summary><div class="tool-body"><div class="tool-caption"><span class="eyebrow">${tool.output === undefined ? 'Proposed input' : 'Tool result'}</span><button class="copy-button" data-copy-tool="${index}" aria-label="Copy tool ${index + 1}">${icon(copiedTool === index ? 'Check' : 'Copy', copiedTool === index ? 'draw-check' : '')}<span>${copiedTool === index ? 'Copied' : 'Copy'}</span></button></div><pre>${escape(JSON.stringify(tool.input, null, 2))}</pre>${tool.output === undefined ? '<p class="muted">Waiting for execution.</p>' : `<pre>${escape(tool.output)}</pre>`}</div></details>` }).join('') : '<p class="muted">No tools have run yet.</p>'
  }
  function chatContent() {
    return messages.length ? `<div class="messages">${messages.map((message, index) => `<article class="message ${message.role}"><span class="avatar ${message.role === 'assistant' ? 'ai-avatar' : ''}">${message.role === 'user' ? 'You' : 'AI'}</span><div ${activeRun && index === messages.length - 1 ? 'data-live-answer' : ''}>${escape(message.text || (activeRun ? 'Thinking through your request.' : 'See tool activity below.'))}</div></article>`).join('')}${activeRun ? `<div class="thinking" role="status"><span class="ai-avatar thinking-avatar">AI</span><span class="thinking-dots" aria-hidden="true"><span></span><span></span><span></span></span><span>${pending ? 'Waiting for your approval.' : 'Working with your project.'}</span></div>` : ''}<section class="tool-list"><div class="section-heading"><p class="eyebrow">Behind the work</p><h2>Tool activity.</h2></div>${toolContent()}</section></div>` : `<div class="welcome"><span class="welcome-icon">${icon('Sparkles')}</span><p class="eyebrow">Your coding workspace</p><h1>Make room for<br>your next idea.</h1><p>A calm place to turn a little context into working code.<br>One conversation, across web and desktop.</p><div class="suggestions"><button data-prompt="Explore the project structure">${icon('Explorer')}<span><strong>Explore the project</strong><small>Find your way around the codebase</small></span>${icon('ArrowUpRight')}</button><button data-prompt="Plan the next feature without changing files">${icon('Tasks')}<span><strong>Plan a feature</strong><small>Give your next idea a clear first step</small></span>${icon('ArrowUpRight')}</button><button data-prompt="Review the latest changes without changing files">${icon('Git')}<span><strong>Review changes</strong><small>See what moved and what needs a look</small></span>${icon('ArrowUpRight')}</button></div><p class="preview-note">${icon('ShieldCheck')} Changes stay in your hands.${config?.mode === 'server' ? ' Conversations are saved to your project.' : ''}</p></div>`
  }
  function panelContent() {
    if (config?.mode === 'server' && section === 'Explorer') return `<div class="page-panel"><h1>Project files.</h1><p>Files are inside this project's isolated workspace. Saving writes the text you explicitly submit.</p>${projectId ? `<button data-load-files ${cloudBusy || activeRun ? 'disabled' : ''}>Refresh ${escape(directory)}</button><div class="file-tree">${directory !== '.' ? '<button data-open-path="./">Back to project root</button>' : ''}${listing.map(name => `<button data-open-path="${escape((directory === '.' ? '' : directory + '/') + name)}" ${cloudBusy || activeRun ? 'disabled' : ''}>${escape(name)}</button>`).join('')}</div><form id="file-form"><label>Project-relative file path<input name="path" required maxlength="1000" value="${escape(filePath)}" placeholder="src/main.ts"></label><label>File content<textarea name="content" maxlength="20000" rows="12">${escape(fileText)}</textarea></label><button type="submit" ${cloudBusy || activeRun ? 'disabled' : ''}>Save file to project</button></form>` : '<p>Choose a project first.</p>'}</div>`
    if (config?.mode === 'server' && section === 'Git') return `<div class="page-panel"><h1>Git changes.</h1><p>Status and diff are read from the isolated project. Ask the agent to initialize Git or create reviewed commits.</p><button data-load-git ${cloudBusy || activeRun || !projectId ? 'disabled' : ''}>Refresh status and diff</button><pre class="git-diff">${escape(gitDiff || 'No Git data loaded yet.')}</pre></div>`
    if (section === 'Projects') return `<div class="page-panel"><h1>Your projects.</h1><p>Each project has its own files, conversations and memory.</p><form id="project-form"><label>Project name<input name="name" required maxlength="120"></label><button type="submit" ${cloudBusy || activeRun ? 'disabled' : ''}>Create project</button></form>${projects.map(p => `<div class="info-card">${escape(p.name)}</div>`).join('')}</div>`
    if (section === 'Memory') return `<div class="page-panel"><h1>Project memory.</h1><p>Notes are recalled in this project's conversations. Never save credentials here.</p>${projectId ? `<form id="memory-form"><label>Project fact<textarea name="content" required maxlength="4000"></textarea></label><button type="submit" ${cloudBusy || activeRun ? 'disabled' : ''}>Save memory</button></form>${memories.map(m => `<div class="info-card memory-card"><p>${escape(m.content)}</p><button data-forget="${escape(m.id)}" ${cloudBusy || activeRun ? 'disabled' : ''}>Remove</button></div>`).join('')}` : '<p>Choose a project first.</p>'}</div>`
    if (section === 'Tasks') return `<div class="page-panel"><p class="eyebrow">A LITTLE PROGRESS, EVERY DAY</p><h1>Your tasks.</h1>${tasks.length ? tasks.map(task => `<div class="task-row ${task.done ? 'done' : ''}"><span>${escape(task.text)}</span><small>${escape(task.status)}</small></div>`).join('') : '<p>Send a message to start your first task.</p>'}</div>`
    if (section === 'Terminal') return `<div class="page-panel"><h1>Commands.</h1>${toolContent(activity.filter(t => t.name === 'run_command'))}</div>`
    const panels: Record<string, [string, string]> = {
      Explorer: ['Project explorer', 'Ask Oqelira to list or read project files. A browsable file tree is coming next.'],
      Git: ['Changes', 'Ask Oqelira to inspect Git status. Commands require approval. A dedicated diff viewer is coming next.'],
      Settings: ['Make yourself at home', config?.mode === 'server' ? 'Signed in to your Oqelira account. Project memory and conversations are stored in PostgreSQL. Foundry deployment names come from server configuration. Flwn integration is separate.' : 'This is local mode. Connect Desktop to your Oqelira server for accounts, saved conversations and project memory.'],
    }
    const [title, description] = panels[section]!
    return `<div class="page-panel"><span class="welcome-spark">${icons[section]}</span><h1>${title}.</h1><p>${description}</p><div class="info-card"><strong>${escape(config?.workspace ?? 'Connecting')}</strong><p>Your credentials stay outside the shared UI.</p></div></div>`
  }
  function inspectorContent() {
    const files = [...new Set(activity.filter(t => ['write_file', 'edit_file'].includes(t.name) && t.output !== undefined && !t.isError).map(t => String((t.input as Record<string, unknown>).path ?? '')))]
    if (tab === 'Context') return `<div class="section-heading"><p class="eyebrow">A little context</p><h2>Workspace notes.</h2></div><div class="info-card"><strong>${escape(projects.find(p => p.id === projectId)?.name ?? config?.workspace ?? '')}</strong><p>Model: ${escape(model)}</p>${config?.mode === 'server' ? `<p>Signed in as ${escape(config.user?.name ?? '')}<br>Project memory: ${memories.length} note${memories.length === 1 ? '' : 's'}<br>Your conversations are saved.</p>` : '<p>Local mode · History lasts until restart.</p>'}</div>`
    if (tab === 'Files') return `<div class="section-heading"><p class="eyebrow">In this conversation</p><h2>Files changed. <span class="count">${files.length}</span></h2></div>${files.map(file => `<div class="info-card file-card">${icon('FileText')}<span>${escape(file)}</span></div>`).join('') || `<div class="empty-state">${icon('FileText')}<p>No file changes yet.</p><small>Approved edits will appear here.</small></div>`}`
    const task = tasks[tasks.length - 1]
    return `<div class="section-heading"><p class="eyebrow">Keep it in focus</p><h2>Current task.</h2></div><div class="task-card ${pending ? 'decision-card' : activeRun ? 'progress-card' : task?.done ? 'done-card' : ''}"><span class="status"><span class="status-dot"></span>${pending ? 'Awaiting approval' : escape(task?.status ?? 'Ready when you are')}</span><h3>${escape(task?.text ?? 'A fresh start for your next idea.')}</h3><p>${activeRun ? 'Follow your agent’s progress in the conversation.' : task?.done ? 'Your result is ready in the conversation.' : 'Start a conversation and take the next step.'}</p>${task?.done ? `<div class="task-done">${icon('Check','draw-check')} Done</div>` : ''}</div><details open data-detail="changed-files"><summary><span>Files changed</span><span class="count">${files.length}</span>${icon('ChevronDown','chevron')}</summary>${files.map(file => `<p class="file-name">${icon('FileText')}${escape(file)}</p>`).join('') || '<p class="muted">No changes yet.</p>'}</details><details data-detail="commands"><summary><span>Commands</span><span class="count">${activity.filter(t => t.name === 'run_command').length}</span>${icon('ChevronDown','chevron')}</summary>${toolContent(activity.filter(t => t.name === 'run_command'))}</details><details data-detail="tools"><summary><span>Tool calls</span><span class="count">${activity.length}</span>${icon('ChevronDown','chevron')}</summary>${toolContent()}</details>`
  }
  render()
  void getConfig().then(async value => {
    config = value; model = value.models[0]?.id ?? ''
    if (value.mode === 'server' && !value.user) {
      authCleanup = showSignIn(root, value, next => { config = next; authCleanup?.(); void loadCloud().then(render).catch(() => { error = 'Could not load your projects'; render() }) })
    } else { await loadCloud(); render() }
  }).catch(() => { error = 'Cannot reach the Oqelira server. Check the service and sign in again.'; render() })
  return () => { disposed = true; authCleanup?.(); activeRun?.abort(); controller.abort(); cancelAnimationFrame(frame); clearTimeout(loadingTimer); clearTimeout(loadingExit); clearTimeout(copyTimer); viewTransition?.skipTransition(); root.replaceChildren() }
}
