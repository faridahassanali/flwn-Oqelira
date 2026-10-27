/** Shared renderer for the browser and sandboxed desktop. No credentials or model SDKs. */
export function mountWorkspace(root: HTMLElement): () => void {
  let controller = new AbortController()
  let section = 'Chat'
  let tab = 'Task'
  let messages: { role: string; text: string }[] = []
  let tasks: { text: string; done: boolean }[] = []
  const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
  const icons: Record<string, string> = { Chat: '▢', Tasks: '☑', Explorer: '▱', Terminal: '⌘', Git: '⑂', Settings: '⚙' }
  function render() {
    controller.abort()
    controller = new AbortController()
    const signal = controller.signal
    root.innerHTML = `
      <aside class="sidebar">
        <a class="brand" href="#"><span class="brand-mark">ƒ</span><span><strong>Oqelira</strong><small>by Flwn</small></span></a>
        <nav aria-label="Main navigation">${Object.entries(icons).map(([name, icon]) => `<button data-section="${name}" class="nav-item ${section === name ? 'selected' : ''}" ${section === name ? 'aria-current="page"' : ''}><span>${icon}</span>${name}</button>`).join('')}</nav>
        <div class="recent"><p class="eyebrow">Recent sessions</p><button data-action="chat" class="session">▢ &nbsp; Shared UI foundation<small>This session</small></button></div>
        <button class="new-session" data-action="new">＋ <span>New session</span></button>
      </aside>
      <header class="topbar"><div class="workspace-switch"><span>Workspace</span><strong>flwn-Oqelira</strong><span class="muted">⌄</span></div><div class="top-actions"><span class="preview-label">Local preview</span><button data-section="Settings" aria-label="Open settings">⚙</button><span class="avatar">AY</span></div></header>
      <main class="main"><div class="tabbar"><span>▢ &nbsp; ${section}</span><span class="project-tab">flwn-Oqelira</span><button data-action="new" aria-label="New session">＋</button></div>
      <div class="content" id="conversation" aria-live="polite">${section === 'Chat' ? chatContent() : panelContent()}</div>
      ${section === 'Chat' ? `<form class="composer"><label class="sr-only" for="prompt">Message Oqelira</label><textarea id="prompt" name="prompt" placeholder="Ask Oqelira anything…" rows="2" required maxlength="10000"></textarea><div class="composer-bar"><span class="mode-pill">✦ Preview mode</span><span class="composer-hint">Enter to send · Shift + Enter for a new line</span><button class="send" type="submit" aria-label="Send message">➤</button></div></form>` : ''}</main>
      <aside class="inspector"><div class="inspector-tabs" role="tablist" aria-label="Workspace details">${['Task', 'Context', 'Files'].map(name => `<button role="tab" aria-selected="${tab === name}" data-tab="${name}" class="${tab === name ? 'active' : ''}">${name}</button>`).join('')}</div><div class="inspector-content" role="tabpanel">${inspectorContent()}</div><footer>Oqelira by Flwn <span>✦</span></footer></aside>`
    root.querySelectorAll<HTMLButtonElement>('[data-section]').forEach(button => button.addEventListener('click', () => { section = button.dataset.section!; render() }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-tab]').forEach(button => button.addEventListener('click', () => { tab = button.dataset.tab!; render() }, { signal }))
    root.querySelectorAll<HTMLButtonElement>('[data-action="new"]').forEach(button => button.addEventListener('click', () => { messages = []; tasks = []; section = 'Chat'; render() }, { signal }))
    root.querySelector('[data-action="chat"]')?.addEventListener('click', () => { section = 'Chat'; render() }, { signal })
    root.querySelectorAll<HTMLButtonElement>('[data-prompt]').forEach(button => button.addEventListener('click', () => { const input = root.querySelector<HTMLTextAreaElement>('textarea')!; input.value = button.dataset.prompt!; input.focus() }, { signal }))
    const form = root.querySelector<HTMLFormElement>('form')
    form?.addEventListener('submit', event => { event.preventDefault(); submit() }, { signal })
    root.querySelector('textarea')?.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); submit() } }, { signal })
    root.querySelectorAll<HTMLInputElement>('[data-task]').forEach(input => input.addEventListener('change', () => { tasks[Number(input.dataset.task)]!.done = input.checked; input.closest('label')?.classList.toggle('done', input.checked) }, { signal }))
    if (messages.length) root.querySelector('#conversation')?.scrollTo(0, 999999)
  }
  function submit() {
    const input = root.querySelector<HTMLTextAreaElement>('textarea')
    const value = input?.value.trim()
    if (!value) return
    messages.push({ role: 'user', text: value }, { role: 'assistant', text: 'Saved in this preview session. The model connection and tool execution are not connected yet. You can explore the shared workspace, switch panels, and track this request in Tasks.' })
    tasks.push({ text: value, done: false })
    render()
    root.querySelector('textarea')?.focus()
  }
  function chatContent() {
    return messages.length ? `<div class="messages">${messages.map(message => `<article class="message ${message.role}"><span class="avatar ${message.role === 'assistant' ? 'spark' : ''}">${message.role === 'user' ? 'AY' : '✦'}</span><div>${escape(message.text)}</div></article>`).join('')}</div>` : `<div class="welcome"><span class="welcome-spark">✦</span><p class="eyebrow">YOUR WORKSPACE, A LITTLE CLEARER</p><h1>What will we build today?</h1><p>A calm place to turn your next idea into code.<br>One conversation, across web and desktop.</p><div class="suggestions"><button data-prompt="Explore the project structure"><span>▱</span><strong>Explore the project</strong><small>Find your way around the codebase</small>↗</button><button data-prompt="Plan the next feature"><span>✦</span><strong>Plan a feature</strong><small>Break your next idea into clear steps</small>↗</button><button data-prompt="Review the latest changes"><span>⑂</span><strong>Review changes</strong><small>Make room for a fresh perspective</small>↗</button></div><p class="preview-note">Interactive UI preview · No model calls or file changes</p></div>`
  }
  function panelContent() {
    if (section === 'Tasks') return `<div class="page-panel"><p class="eyebrow">A LITTLE PROGRESS, EVERY DAY</p><h1>Your tasks</h1>${tasks.length ? tasks.map((task, i) => `<label class="task-row ${task.done ? 'done' : ''}"><input type="checkbox" data-task="${i}" ${task.done ? 'checked' : ''}><span>${escape(task.text)}</span><small>Preview</small></label>`).join('') : '<p>Send a message to add your first preview task.</p>'}</div>`
    const panels: Record<string, [string, string]> = {
      Explorer: ['Project explorer', 'The project filesystem will be connected through a host adapter. This preview has no access to your files.'],
      Terminal: ['Terminal', 'Command execution will require host integration and explicit tool approvals. No commands run in this preview.'],
      Git: ['Changes', 'Repository status and diffs will appear here once the local host is connected.'],
      Settings: ['Make yourself at home', 'Web and desktop share the same UI. Model deployments will come from server configuration. Flwn memory and authentication are deferred.'],
    }
    const [title, description] = panels[section]!
    return `<div class="page-panel"><span class="welcome-spark">${icons[section]}</span><h1>${title}</h1><p>${description}</p><div class="info-card"><strong>Local preview</strong><p>Your credentials stay outside the shared UI.</p></div></div>`
  }
  function inspectorContent() {
    if (tab === 'Context') return '<h2>Workspace context</h2><div class="info-card"><strong>flwn-Oqelira</strong><p>Shared UI foundation</p><p>Flwn memory: deferred<br>Authentication: deferred</p></div>'
    if (tab === 'Files') return '<h2>Files changed <span class="count">0</span></h2><div class="empty-state">▱<p>No file changes in preview.</p><small>File tools are not connected.</small></div>'
    return `<h2>Current task <span class="muted">···</span></h2><div class="task-card"><span class="status">● ${tasks.length ? 'Queued in preview' : 'Ready when you are'}</span><h3>${tasks.length ? escape(tasks[tasks.length - 1]!.text) : 'A fresh start for your next idea'}</h3><p>${tasks.length ? 'Connect the core host to execute this request.' : 'Start a conversation and keep your work in focus.'}</p><div class="track"><span></span></div><small>${tasks.length} preview request${tasks.length === 1 ? '' : 's'}</small></div><details open><summary>Files changed <span class="count">0</span></summary><p class="muted">No changes yet</p></details><details><summary>Commands <span class="count">0</span></summary><p>No commands have run.</p></details><details><summary>Tool calls <span class="count">0</span></summary><p>Tools are not connected.</p></details>`
  }
  render()
  return () => { controller.abort(); root.replaceChildren() }
}
