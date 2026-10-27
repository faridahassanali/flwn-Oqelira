import type { HostConfig } from '@oqelira/protocol'
import { getConfig } from './transport.js'
import { brand } from './brand.js'
import { icon } from './icons.js'
import { exitElement, timing } from './motion.js'
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
  let name = '', email = '', spinnerSince = 0
  let spinnerTimer: ReturnType<typeof setTimeout> | undefined
  let controller = new AbortController()
  function render() {
    if (disposed) return
    controller.abort(); controller = new AbortController()
    root.innerHTML = `<main class="auth-page"><div class="auth-story"><a class="brand" href="#" aria-label="Oqelira by Flwn">${brand()}</a><div class="auth-story-copy"><p class="eyebrow">A little context. A clearer next step.</p><h1>Good work starts<br>with a little context.</h1><p>Bring your ideas, code and conversations together.<br>Make something worth keeping.</p></div><div class="auth-features"><div>${icon('Chat')}<span>One conversation.<small>From the first idea to the next commit.</small></span></div><div>${icon('Memory')}<span>A workspace that remembers.<small>Project notes, right where you need them.</small></span></div><div>${icon('ShieldCheck')}<span>Changes stay in your hands.<small>Review your agent’s next move.</small></span></div></div></div><section class="auth-card"><p class="eyebrow">Your workspace is waiting</p><h2>${signup ? 'Create your account.' : 'Welcome back.'}</h2><p>${signup ? 'A place for your projects and the context behind them.' : 'Pick up where your last good idea left off.'}</p>${error ? `<div role="alert" class="notice error"><div>${icon('Circle')}<span>${escape(error)}</span></div><button type="button" data-auth-retry>${icon('Refresh')} Try again</button></div>` : ''}<form id="auth-form">${signup ? `<label>Name<input name="name" autocomplete="name" required maxlength="120" value="${escape(name)}"></label>` : ''}<label>Email<input name="email" type="email" autocomplete="username" required maxlength="254" value="${escape(email)}"></label><label>Password<input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" minlength="12" maxlength="128" required></label><button class="primary auth-submit" type="submit" aria-label="${signup ? 'Create account' : 'Sign in'}" aria-busy="false" ${busy ? 'disabled' : ''}><span class="button-label">${signup ? 'Create account' : 'Sign in'}</span><span class="button-loader" aria-hidden="true">${icon('LoaderCircle','spinner')}</span></button></form><button class="text-button" id="auth-toggle" ${busy ? 'disabled' : ''}>${signup ? 'Already have an account? Sign in' : 'Need an account? Create one'}</button><p class="auth-meta">Account creation may be restricted by your administrator.</p></section></main>`
    root.querySelector('[data-auth-retry]')?.addEventListener('click', () => { root.querySelector<HTMLInputElement>('[name="password"]')?.focus() }, { signal: controller.signal })
    root.querySelector('#auth-toggle')?.addEventListener('click', () => { if (busy) return; const panel = root.querySelector<HTMLElement>('.auth-card'); void (panel ? exitElement(panel) : Promise.resolve()).then(() => { signup = !signup; error = ''; render() }) }, { signal: controller.signal })
    root.querySelector('form')?.addEventListener('submit', event => {
      event.preventDefault()
      if (busy) return
      const fields = new FormData(event.target as HTMLFormElement)
      email = String(fields.get('email')); name = String(fields.get('name') ?? name)
      const data = { email: String(fields.get('email')), password: String(fields.get('password')), ...(signup ? { name: String(fields.get('name')) } : {}) }
      busy = true
      root.querySelector<HTMLButtonElement>('button[type=submit]')!.disabled = true
      root.querySelector<HTMLButtonElement>('#auth-toggle')!.disabled = true
      spinnerSince = 0
      spinnerTimer = setTimeout(() => { const button = root.querySelector<HTMLElement>('.auth-submit'); button?.classList.add('is-loading'); button?.setAttribute('aria-busy','true'); spinnerSince = performance.now() }, timing('--loading-delay'))
      const finishLoading = async () => { clearTimeout(spinnerTimer); if (spinnerSince) await new Promise(resolve => setTimeout(resolve, Math.max(0,timing('--loading-min') - (performance.now() - spinnerSince)))) }
      void api(signup ? 'auth/sign-up/email' : 'auth/sign-in/email', data).then(async () => {
        const next = await getConfig()
        if (!next.user) throw new Error('Sign-in did not establish a session')
        await finishLoading()
        if (!disposed) { const panel = root.querySelector<HTMLElement>('.auth-page'); if (panel) await exitElement(panel); onReady(next) }
      }).catch(async e => { await finishLoading(); error = e instanceof Error ? e.message : 'Sign-in failed'; busy = false; render() })
    }, { signal: controller.signal })
  }
  render()
  return () => { disposed = true; controller.abort(); clearTimeout(spinnerTimer) }
}
