import * as vscode from 'vscode'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawnEngine } from '@oqelira/engine/client'
import type { EngineClient } from '@oqelira/engine/client'
import { readFileChange, applyFileChange } from '@oqelira/core'
import type { Approval, EngineMessage } from '@oqelira/protocol'
import { engineEnv, foundryEndpoint, proposedContent, secretName } from './policy.js'
import type { Setup } from './policy.js'

/**
 * VS Code is an interface to oqelira-engine: it sends requests and renders events. Tools, permissions, history,
 * compaction and memory all live in the engine. What stays here is native: SecretStorage, diff review, prompts.
 */
interface Running { client: EngineClient; key: string }
const engines = new Map<string, Running>() // by workspace folder, keyed also on the setup so a reconfigure restarts
let runningAbort: (() => void) | undefined

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('Oqelira by Flwn')
  const previews = new Map<string, string>()
  const recentChanges: { label: string; id: string; cwd: string }[] = []
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('oqelira-preview', { provideTextDocumentContent: (uri) => previews.get(uri.toString()) ?? '' }))

  const stopEngines = () => { for (const { client } of engines.values()) client.close(); engines.clear() }
  context.subscriptions.push(output, { dispose: () => { runningAbort?.(); stopEngines() } })

  const enginePath = () => {
    const configured = vscode.workspace.getConfiguration('oqelira').inspect<string>('enginePath')?.globalValue?.trim() // user settings only
    return configured || path.join(context.extensionPath, '..', 'engine', 'bin', 'oqelira-engine.mjs')
  }

  async function engineFor(cwd: string): Promise<EngineClient | undefined> {
    const setup = context.globalState.get<Setup>('oqelira.setup')
    if (!setup) { void vscode.window.showInformationMessage('Run Oqelira: Configure Foundry first.'); return }
    let endpoint: string
    try { endpoint = foundryEndpoint(setup.endpoint) } catch { void vscode.window.showErrorMessage('Reconfigure the Foundry endpoint.'); return }
    const key = await context.secrets.get(secretName(endpoint))
    if (!key) { void vscode.window.showInformationMessage('Run Oqelira: Configure Foundry to save your key.'); return }
    const identity = cwd + JSON.stringify(setup) + key
    const existing = engines.get(cwd)
    if (existing && !existing.client.closed && existing.key === identity) return existing.client
    existing?.client.close()
    const bin = enginePath()
    if (!existsSync(bin)) { void vscode.window.showErrorMessage('Oqelira engine not found. Set oqelira.enginePath in your user settings.'); return }
    const client = spawnEngine({ cwd, bin, env: engineEnv(process.env, setup, key) })
    try { await client.ready } catch { void vscode.window.showErrorMessage('Oqelira engine did not start. Check your Node runtime and configuration.'); client.close(); return }
    engines.set(cwd, { client, key: identity })
    return client
  }

  /** Native review: a diff for file changes, a modal for everything. Resolves to what to send back to the engine. */
  async function review(approval: Approval, cwd: string): Promise<{ allowed: boolean; always?: 'project' }> {
    const input = (approval.input ?? {}) as Record<string, unknown>
    const detail = JSON.stringify(approval.input, null, 2)
    if (detail.length > 30000) { output.appendLine('Denied: change is too large to review.'); return { allowed: false } }
    const rel = typeof input.path === 'string' ? input.path : undefined
    if (rel) {
      const target = path.resolve(cwd, rel)
      if (path.relative(cwd, target).startsWith('..')) return { allowed: false }
      const before = await fs.readFile(target, 'utf8').catch(() => null)
      const after = proposedContent(approval.tool, approval.input, before)
      if (after !== undefined) {
        const id = randomUUID(), name = path.basename(rel)
        const left = vscode.Uri.from({ scheme: 'oqelira-preview', path: `/${id}/before/${name}` }), right = vscode.Uri.from({ scheme: 'oqelira-preview', path: `/${id}/after/${name}` })
        while (previews.size > 30) previews.delete(previews.keys().next().value!)
        previews.set(left.toString(), before ?? ''); previews.set(right.toString(), after ?? '')
        await vscode.commands.executeCommand('vscode.diff', left, right, `Oqelira: ${rel}`, { preview: true })
      }
    }
    const note = approval.risk === 'network' ? 'This sends the query to an external service.\n\n' : approval.risk === 'exec' ? 'This local shell command can access your computer.\n\n' : 'Review the proposed change.\n\n'
    // Network calls are never remembered by the engine, so the option is not offered for them.
    const choices = approval.risk === 'network' ? ['Allow once', 'Deny'] : ['Allow once', 'Always allow in this project', 'Deny']
    const answer = await vscode.window.showWarningMessage(approval.summary, { modal: true, detail: note + detail }, ...choices)
    if (answer === 'Allow once') return { allowed: true }
    if (answer === 'Always allow in this project') return { allowed: true, always: 'project' }
    return { allowed: false }
  }

  /** Sends one request and renders its events until the engine says it is finished with it. */
  function converse(client: EngineClient, cwd: string, start: () => void, finishOn: (m: EngineMessage) => boolean): Promise<EngineMessage | undefined> {
    return new Promise((resolve) => {
      const off = client.onMessage((m) => {
        switch (m.type) {
          case 'text': output.append(m.text); break
          case 'tool-call': output.appendLine('\nTool: ' + m.name); break
          case 'tool-result':
            output.appendLine((m.isError ? 'Failed: ' : 'Result: ') + m.output)
            if (!m.isError && (m.name === 'apply_file_change' || m.name === 'revert_file_change')) {
              try { const c = JSON.parse(m.output) as { change_id: string; path: string }; recentChanges.unshift({ label: c.path, id: c.change_id, cwd }); recentChanges.splice(100) } catch { /* not a tracked change */ }
            }
            break
          case 'context-compacted': output.appendLine('\nOlder context summarized; the full session history is kept.'); break
          case 'notice': output.appendLine('\n' + m.message); break
          case 'approval':
            void review(m.approval, cwd).then((r) => client.send({ type: 'approval', approvalId: m.approval.id, allowed: r.allowed, always: r.always }), () => client.send({ type: 'approval', approvalId: m.approval.id, allowed: false }))
            break
        }
        // A late answer to an approval that already timed out is not the end of the conversation.
        if (m.type === 'error' && m.message === 'Approval is no longer pending') return
        if (finishOn(m)) { off(); resolve(m) }
      })
      start()
    })
  }

  const folderPick = async () => {
    if (!vscode.workspace.isTrusted) { void vscode.window.showWarningMessage('Trust this workspace before running Oqelira.'); return }
    const folders = vscode.workspace.workspaceFolders
    if (!folders?.length) { void vscode.window.showWarningMessage('Open a local project folder first.'); return }
    const folder = folders.length === 1 ? folders[0] : await vscode.window.showWorkspaceFolderPick({ placeHolder: 'Choose the project Oqelira may access' })
    return folder && folder.uri.scheme === 'file' ? folder.uri.fsPath : undefined
  }

  const register = (name: string, action: () => unknown) => context.subscriptions.push(vscode.commands.registerCommand(name, action))
  register('oqelira.stop', () => runningAbort?.())

  register('oqelira.ask', async () => {
    if (runningAbort) { void vscode.window.showWarningMessage('Oqelira is already running. Use Oqelira: Stop first.'); return }
    const cwd = await folderPick(); if (!cwd) return
    const prompt = await vscode.window.showInputBox({ title: 'Ask Oqelira', prompt: 'Read tools run automatically. Changes and shell commands need your approval.', ignoreFocusOut: true })
    if (!prompt?.trim()) return
    const client = await engineFor(cwd); if (!client) return
    let cancelled = false
    runningAbort = () => { cancelled = true; client.send({ type: 'cancel' }) }
    output.show(true); output.appendLine('\nYou: ' + prompt); output.appendLine('Oqelira:')
    try {
      const last = await converse(client, cwd, () => client.send({ type: 'run', prompt }), (m) => m.type === 'done' || m.type === 'error')
      output.appendLine(last?.type === 'done' ? '\nStatus: ' + last.reason : cancelled ? '\nStopped. Already approved changes remain.' : '\nRun failed: ' + (last as { message?: string } | undefined)?.message)
      if (last?.type === 'error' && !cancelled) void vscode.window.showErrorMessage('Oqelira stopped. See its output channel for status.')
    } finally { runningAbort = undefined }
  })

  register('oqelira.clear', async () => {
    if (runningAbort) { void vscode.window.showWarningMessage('Stop the current run first.'); return }
    const cwd = await folderPick(); if (!cwd) return
    const client = engines.get(cwd)?.client
    if (client && !client.closed) {
      // Ending the chat lets the engine propose what it learned; you approve or decline it like any other change.
      runningAbort = () => client.send({ type: 'cancel' })
      try { await converse(client, cwd, () => client.send({ type: 'end' }), (m) => m.type === 'ended' || m.type === 'error') } finally { runningAbort = undefined }
      client.send({ type: 'clear' })
    }
    output.clear()
  })

  register('oqelira.memory', async () => {
    const cwd = await folderPick(); if (!cwd) return
    const client = await engineFor(cwd); if (!client) return
    const list = await converse(client, cwd, () => client.send({ type: 'memory', action: 'list' }), (m) => m.type === 'memory' || m.type === 'error')
    if (list?.type !== 'memory') return
    if (!list.entries.length) { void vscode.window.showInformationMessage('No project memory yet.'); return }
    const pick = await vscode.window.showQuickPick(list.entries.map((e) => ({ label: e.text.slice(0, 100), description: e.status === 'pending' ? 'pending review' : e.kind, id: e.id, status: e.status })), { title: 'Project memory (pending items are not used until approved)' })
    if (!pick) return
    const actions = pick.status === 'pending' ? ['Approve', 'Forget'] : ['Forget']
    const action = await vscode.window.showQuickPick(actions, { title: pick.label })
    if (action) await converse(client, cwd, () => client.send({ type: 'memory', action: action === 'Approve' ? 'approve' : 'forget', id: pick.id }), (m) => m.type === 'memory' || m.type === 'error')
  })

  register('oqelira.revert', async () => {
    if (runningAbort || !vscode.workspace.isTrusted) return
    const available = recentChanges.filter((change) => vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === 'file' && folder.uri.fsPath === change.cwd))
    const change = await vscode.window.showQuickPick(available, { title: 'Revert a reviewed file change' })
    if (!change) return
    const controller = new AbortController(); runningAbort = () => controller.abort()
    try {
      const input = await readFileChange(change.cwd, change.id)
      const answer = await vscode.window.showWarningMessage('Revert ' + input.path, { modal: true, detail: 'Refused if the file has been edited since.' }, 'Revert')
      if (answer === 'Revert') output.appendLine(await applyFileChange(change.cwd, input, true, controller.signal))
    } catch { void vscode.window.showErrorMessage('The file changed or the revert could not be verified. Inspect it before retrying.') }
    finally { runningAbort = undefined }
  })

  register('oqelira.configure', async () => {
    if (runningAbort) { void vscode.window.showWarningMessage('Stop the current run before changing credentials.'); return }
    const endpointInput = await vscode.window.showInputBox({ title: 'Azure Foundry endpoint', prompt: 'HTTPS endpoint for your existing Foundry resource. Saved in your user profile only.', ignoreFocusOut: true })
    if (!endpointInput) return
    let endpoint: string
    try { endpoint = foundryEndpoint(endpointInput) } catch { void vscode.window.showErrorMessage('Use a valid HTTPS Azure Foundry endpoint.'); return }
    const deployment = await vscode.window.showInputBox({ title: 'Foundry deployment name', prompt: 'The deployment name from your Azure configuration.', ignoreFocusOut: true, validateInput: (value) => value.trim() ? undefined : 'Enter a deployment name' })
    if (!deployment) return
    const api = await vscode.window.showQuickPick(['responses', 'chat'], { title: 'API supported by this deployment' })
    if (api !== 'responses' && api !== 'chat') return
    const key = await vscode.window.showInputBox({ title: 'Foundry API key', prompt: 'Stored in VS Code SecretStorage, never in workspace settings.', password: true, ignoreFocusOut: true })
    if (!key) return
    await context.secrets.store(secretName(endpoint), key.trim())
    await context.globalState.update('oqelira.setup', { endpoint, model: { id: deployment.trim(), deployment: deployment.trim(), api, speed: 'fast' } } satisfies Setup)
    stopEngines() // the next run starts an engine with the new settings
    void vscode.window.showInformationMessage('Oqelira Foundry configuration saved.')
  })
}
export function deactivate() { runningAbort?.(); for (const { client } of engines.values()) client.close(); engines.clear() }
