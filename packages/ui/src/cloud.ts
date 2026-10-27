import type { HostConfig } from '@oqelira/protocol'
import { getConfig } from './transport.js'
export interface Project { id: string; name: string }
export interface SavedConversation { id: string; title: string; model: string; status: string; messages?: ({role:'user';content:string}|{role:'assistant';text:string;toolCalls:{id:string;name:string;input:unknown}[]}|{role:'tool';results:{id:string;name:string;output:string;isError?:boolean}[]})[] }
export const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export async function api<T>(route: string, data?: unknown): Promise<T> {
  const response = await fetch('/api/' + route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json() as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(result.message ?? result.error ?? 'Request failed')
  return result
}
/** Authentication gate shared by web and desktop; credentials are never persisted in JS storage. */
export function showSignIn(root: HTMLElement, config: HostConfig, onReady: (config: HostConfig) => void) {
  let signup = false, busy = false, error = '', disposed = false
  let controller = new AbortController()
  function render() {
    if (disposed) return
    controller.abort(); controller = new AbortController()
    root.innerHTML = `<main class="auth-page"><section class="auth-card"><span class="brand-mark">ƒ</span><h1>Oqelira <small>by Flwn</small></h1><h2>${signup ? 'Create your account' : 'Welcome back'}</h2><p>Your projects, conversations and project memory in one workspace.</p>${error ? `<p role="alert" class="notice error">${escape(error)}</p>` : ''}<form id="auth-form">${signup ? '<label>Name<input name="name" autocomplete="name" required maxlength="120"></label>' : ''}<label>Email<input name="email" type="email" autocomplete="username" required maxlength="254"></label><label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="12" maxlength="128" required></label><button type="submit" ${busy ? 'disabled' : ''}>${busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}</button></form><button id="auth-toggle" ${busy ? 'disabled' : ''}>${signup ? 'Already have an account? Sign in' : 'Need an account? Create one'}</button><p class="muted">Account creation may be restricted by your administrator.</p></section></main>`
    root.querySelector('#auth-toggle')?.addEventListener('click', () => { signup = !signup; error = ''; render() }, { signal: controller.signal })
    root.querySelector('form')?.addEventListener('submit', event => {
      event.preventDefault()
      if (busy) return
      const fields = new FormData(event.target as HTMLFormElement)
      const data = { email: String(fields.get('email')), password: String(fields.get('password')), ...(signup ? { name: String(fields.get('name')) } : {}) }
      busy = true
      root.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = true
      void api(signup ? 'auth/sign-up/email' : 'auth/sign-in/email', data).then(async () => {
        const next = await getConfig()
        if (!next.user) throw new Error('Sign-in did not establish a session')
        if (!disposed) onReady(next)
      }).catch(e => { error = e instanceof Error ? e.message : 'Sign-in failed'; busy = false; render() })
    }, { signal: controller.signal })
  }
  render()
  return () => { disposed = true; controller.abort() }
}
