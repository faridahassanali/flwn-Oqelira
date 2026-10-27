import type { HostConfig } from '@oqelira/protocol'
import { getConfig } from './transport.js'
import { brand } from './brand.js'
import { icon } from './icons.js'
import { exitElement, timing } from './motion.js'
export interface Project { id: string; name: string;role?:string }
export interface SavedConversation { id: string; title: string; model: string; status: string; messages?: ({role:'user';content:string}|{role:'assistant';text:string;toolCalls:{id:string;name:string;input:unknown}[]}|{role:'tool';results:{id:string;name:string;output:string;isError?:boolean}[]})[] }
export const escape = (text: string) => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
export async function api<T>(route: string, data?: unknown): Promise<T> {
  const response = await fetch('/api/' + route, data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  const result = await response.json() as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(result.message ?? result.error ?? 'Request failed')
  return result
}

export async function socialSignIn(provider:'google'|'github',link=false){
  const result=await api<{url?:string}>(link?'auth/link-social':'auth/sign-in/social',{provider,callbackURL:location.origin+'/'})
  if(!result.url)throw new Error('The provider did not return a sign-in URL')
  const target=new URL(result.url)
  if(target.protocol!=='https:'||target.username||target.password||!['accounts.google.com','github.com'].includes(target.hostname))throw new Error('Unexpected identity provider URL')
  location.assign(target.href)
}
/** Passwords and recovery tokens live only in the current form/closure. */
export function showSignIn(root:HTMLElement,config:HostConfig,onReady:(config:HostConfig)=>void){
  let mode:'signin'|'signup'|'forgot'|'reset'='signin',busy=false,error='',message='',name='',email='',disposed=false
  let token=new URL(location.href).searchParams.get('token')??''
  if(token&&config.auth?.emailRecovery){mode='reset';history.replaceState(null,'',location.pathname)}
  if(new URL(location.href).searchParams.has('error'))error='Sign-in could not be completed. Try again or use your existing sign-in method.'
  let controller=new AbortController(),spinnerTimer:ReturnType<typeof setTimeout>|undefined,spinnerSince=0
  const desktop=navigator.userAgent.includes('Electron/')
  async function perform(action:()=>Promise<void>){
    if(busy)return
    busy=true;error='';message=''
    root.querySelectorAll<HTMLButtonElement>('button').forEach(button=>button.disabled=true)
    spinnerSince=0
    spinnerTimer=setTimeout(()=>{const button=root.querySelector('.auth-submit');button?.classList.add('is-loading');button?.setAttribute('aria-busy','true');spinnerSince=performance.now()},timing('--loading-delay'))
    try{await action()}catch(e){error=e instanceof Error?e.message:'The request could not be completed'}
    finally{clearTimeout(spinnerTimer);if(spinnerSince)await new Promise(resolve=>setTimeout(resolve,Math.max(0,timing('--loading-min')-(performance.now()-spinnerSince))));busy=false;if(!disposed)render()}
  }
  function render(){
    if(disposed)return
    controller.abort();controller=new AbortController()
    const recovery=mode==='forgot'||mode==='reset',signup=mode==='signup'
    const label=mode==='forgot'?'Send reset link':mode==='reset'?'Save new password':signup?'Create account':'Sign in'
    const title=mode==='forgot'?'Find your way back.':mode==='reset'?'A fresh password.':signup?'Create your account.':'Welcome back.'
    const description=mode==='forgot'?'Enter your email. If an account exists, we will send a reset link.':mode==='reset'?'Choose a new password. Your other sessions will be signed out.':signup?'A place for your projects and the context behind them.':'Pick up where your last good idea left off.'
    root.innerHTML=`<main class="auth-page"><div class="auth-story"><a class="brand" href="#" aria-label="Oqelira by Flwn">${brand()}</a><div class="auth-story-copy"><p class="eyebrow">A little context. A clearer next step.</p><h1>Good work starts<br>with a little context.</h1><p>Bring your ideas, code and conversations together.<br>Make something worth keeping.</p></div><div class="auth-features"><div>${icon('Chat')}<span>One conversation.<small>From the first idea to the next commit.</small></span></div><div>${icon('Memory')}<span>A workspace that remembers.<small>Project notes, right where you need them.</small></span></div><div>${icon('ShieldCheck')}<span>Changes stay in your hands.<small>Review your agent’s next move.</small></span></div></div></div><section class="auth-card"><p class="eyebrow">Your workspace is waiting</p><h2>${title}</h2><p>${description}</p>${error?`<div role="alert" class="notice error">${escape(error)}</div>`:''}${message?`<div role="status" class="notice">${escape(message)}</div>`:''}<form id="auth-form">${signup?`<label>Name<input name="name" autocomplete="name" required maxlength="120" value="${escape(name)}"></label>`:''}${mode!=='reset'?`<label>Email<input name="email" type="email" autocomplete="username" required maxlength="254" value="${escape(email)}"></label>`:''}${mode!=='forgot'?`<label>${mode==='reset'?'New password':'Password'}<input name="password" type="password" autocomplete="${signup||mode==='reset'?'new-password':'current-password'}" minlength="12" maxlength="128" required></label>`:''}${mode==='reset'?'<label>Confirm password<input name="confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label>':''}<button class="primary auth-submit" type="submit" aria-label="${label}" aria-busy="false"><span class="button-label">${label}</span><span class="button-loader" aria-hidden="true">${icon('LoaderCircle','spinner')}</span></button></form>${recovery?'<button class="text-button" data-mode="signin">Back to sign in</button>':`${config.auth?.signup?`<button class="text-button" data-mode="${signup?'signin':'signup'}">${signup?'Already have an account? Sign in':'Need an account? Create one'}</button>`:''}${!signup&&config.auth?.emailRecovery?'<button class="text-button" data-mode="forgot">Forgot password?</button>':''}${!signup&&config.auth?.verification?'<button class="text-button" data-verify>Resend verification email</button>':''}${!desktop?(config.auth?.socialProviders??[]).map(provider=>`<button class="social-button" data-social="${provider}">${icon('ArrowUpRight')} Continue with ${provider==='google'?'Google':'GitHub'}</button>`).join(''):''}` }<p class="auth-meta">${desktop&&config.auth?.socialProviders.length?'Google and GitHub sign-in are currently available in the web app.':'Account creation may be restricted by your administrator.'}</p></section></main>`
    root.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach(button=>button.addEventListener('click',()=>{if(busy)return;const fields=root.querySelector<HTMLFormElement>('form');if(fields){const values=new FormData(fields);email=String(values.get('email')??email);name=String(values.get('name')??name)};const next=button.dataset.mode as typeof mode;void exitElement(root.querySelector<HTMLElement>('.auth-card')!).then(()=>{mode=next;error='';message='';render()})},{signal:controller.signal}))
    root.querySelectorAll<HTMLButtonElement>('[data-social]').forEach(button=>button.addEventListener('click',()=>{void perform(()=>socialSignIn(button.dataset.social as 'google'|'github'))},{signal:controller.signal}))
    root.querySelector('[data-verify]')?.addEventListener('click',()=>{const field=root.querySelector<HTMLInputElement>('[name="email"]');if(!field?.reportValidity()||!field.value)return;email=field.value;void perform(async()=>{await api('auth/send-verification-email',{email,callbackURL:location.origin+'/'});message='If your account needs verification, a new link is on its way.'})},{signal:controller.signal})
    root.querySelector('form')?.addEventListener('submit',event=>{event.preventDefault();const fields=new FormData(event.target as HTMLFormElement);email=String(fields.get('email')??email);name=String(fields.get('name')??name);const password=String(fields.get('password')??'')
      void perform(async()=>{
        if(mode==='forgot'){await api('auth/request-password-reset',{email,redirectTo:location.origin+'/'});message='If an account exists, a password reset link is on its way.';return}
        if(mode==='reset'){if(password!==fields.get('confirm'))throw new Error('The passwords do not match');await api('auth/reset-password',{newPassword:password,token});token='';mode='signin';message='Password saved. Sign in with your new password.';return}
        await api(mode==='signup'?'auth/sign-up/email':'auth/sign-in/email',{email,password,...(mode==='signup'?{name,callbackURL:location.origin+'/'}:{})})
        const next=await getConfig()
        if(!next.user){if(mode==='signup'&&config.auth?.verification){mode='signin';message='Check your email to verify your account before signing in.';return};throw new Error('Sign-in did not establish a session')}
        if(!disposed){clearTimeout(spinnerTimer);if(spinnerSince)await new Promise(resolve=>setTimeout(resolve,Math.max(0,timing('--loading-min')-(performance.now()-spinnerSince))));await exitElement(root.querySelector<HTMLElement>('.auth-page')!);onReady(next)}
      })
    },{signal:controller.signal})
  }
  render()
  return ()=>{disposed=true;controller.abort();clearTimeout(spinnerTimer)}
}
