import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PGlite} from '@electric-sql/pglite'
import {pglitePool} from './database.js'
import {serverConfig} from '../src/config.js'
import {migrate} from '../src/migrate.js'
import {createAuth} from '../src/auth.js'
import {deliverAccountMail,enqueueAccountMail,smtpDelivery} from '../src/mail.js'
import type {AccountEmail} from '../src/mail.js'

test('email verification and single-use password recovery use durable mail, revoke sessions and do not reveal unknown accounts',{timeout:60000},async()=>{
 const db=new PGlite(),pool=pglitePool(db)
 const config=serverConfig({OQELIRA_SERVER_URL:'http://127.0.0.1:4378',OQELIRA_AUTH_SECRET:'6e3790171e9e50414e9abe99078f1efa05f59e72b4ca839d',OQELIRA_DATABASE_URL:'postgres://fixture',OQELIRA_ALLOW_SIGNUP:'true',OQELIRA_REQUIRE_VERIFIED_EMAIL:'true',OQELIRA_SMTP_URL:'smtps://mail.example.test',OQELIRA_SMTP_FROM:'accounts@example.test'})
 const mails:AccountEmail[]=[];const send=async(email:AccountEmail)=>{mails.push(email)}
 await migrate(pool,config);const auth=createAuth(pool,config,send)
 const post=(route:string,data:unknown,cookie='')=>auth.handler(new Request(config.baseURL+'/api/auth/'+route,{method:'POST',headers:{Origin:config.baseURL,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(data)}))
 try{
  const credentials={email:'verified@example.test',password:'Original fixture password 2026!'}
  assert.equal((await post('sign-up/email',{...credentials,name:'Verified fixture',callbackURL:config.baseURL+'/'})).status,200)
  assert.equal((await post('sign-in/email',credentials)).status,403)
  await deliverAccountMail(pool,send);assert.equal(mails[0]?.kind,'verify')
  const verification=await auth.handler(new Request(mails[0]!.url,{headers:{Origin:config.baseURL}}));assert.ok([200,302].includes(verification.status))
  const signed=await post('sign-in/email',credentials);assert.equal(signed.status,200)
  const cookie=signed.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')
  assert.ok(await auth.api.getSession({headers:new Headers({Cookie:cookie})}))
  const known=await post('request-password-reset',{email:credentials.email,redirectTo:config.baseURL+'/'})
  const unknown=await post('request-password-reset',{email:'unknown@example.test',redirectTo:config.baseURL+'/'})
  assert.equal(known.status,200);assert.equal(unknown.status,200);assert.deepEqual(await known.json(),await unknown.json())
  for(let i=0;i<3;i++)await deliverAccountMail(pool,send)
  const reset=mails.find(message=>message.kind==='reset');assert.ok(reset)
  const redirect=await auth.handler(new Request(reset.url,{headers:{Origin:config.baseURL}}))
  const token=new URL(redirect.headers.get('location')!,config.baseURL).searchParams.get('token');assert.ok(token)
  assert.equal((await post('reset-password',{token,newPassword:'Replacement fixture password 2026!'})).status,200)
  assert.equal(await auth.api.getSession({headers:new Headers({Cookie:cookie})}),null)
  assert.equal((await post('reset-password',{token,newPassword:'Another fixture password 2026!'})).status,400)
  assert.equal((await post('sign-in/email',{email:credentials.email,password:'Replacement fixture password 2026!'})).status,200)
  assert.ok(!mails.some(message=>message.to==='unknown@example.test'))
 }finally{await db.close()}
})

test('provider sign-in starts with state and identity-only scopes without enabling implicit account merging',{timeout:60000},async()=>{
 const db=new PGlite(),pool=pglitePool(db)
 const config=serverConfig({OQELIRA_SERVER_URL:'http://127.0.0.1:4379',OQELIRA_AUTH_SECRET:'6588a644c68d594f1f1177e4ba664648b48d4d9c72989f17',OQELIRA_DATABASE_URL:'postgres://fixture',OQELIRA_GOOGLE_CLIENT_ID:'fixture-google-client',OQELIRA_GOOGLE_CLIENT_SECRET:'fixture-google-secret',OQELIRA_GITHUB_CLIENT_ID:'fixture-github-client',OQELIRA_GITHUB_CLIENT_SECRET:'fixture-github-secret'})
 await migrate(pool,config);const auth=createAuth(pool,config)
 try{
  for(const provider of ['google','github']){
   const response=await auth.handler(new Request(config.baseURL+'/api/auth/sign-in/social',{method:'POST',headers:{Origin:config.baseURL,'Content-Type':'application/json'},body:JSON.stringify({provider,callbackURL:config.baseURL+'/'})}))
   assert.equal(response.status,200)
   const result=await response.json() as {url:string};const url=new URL(result.url)
   assert.equal(url.protocol,'https:');assert.ok(url.searchParams.get('state'))
   assert.ok(!url.searchParams.get('scope')?.includes('repo'));assert.ok(!url.searchParams.get('scope')?.includes('gmail'))
  }
  assert.equal(auth.options.account?.accountLinking?.disableImplicitLinking,true)
  assert.equal((await pool.query('SELECT count(*) AS count FROM "user"')).rows[0].count,0)
 }finally{await db.close()}
})


test('mail outbox retries delivery failures without exposing tokens and drops expired account links',async()=>{
 const db=new PGlite(),pool=pglitePool(db)
 const config=serverConfig({OQELIRA_SERVER_URL:'http://127.0.0.1:4380',OQELIRA_AUTH_SECRET:'a52a03ac0f6e141d311d8ae6a7ad01c10d5770fcaeb9e31c',OQELIRA_DATABASE_URL:'postgres://fixture'})
 await migrate(pool,config)
 try{
  await enqueueAccountMail(pool,{to:'fixture@example.test',url:config.baseURL+'/?token=fixture',kind:'reset'})
  await deliverAccountMail(pool,async()=>{throw new Error('SMTP fixture unavailable')})
  assert.equal((await pool.query('SELECT attempts FROM oq_account_mail')).rows[0].attempts,1)
  let delivered=0;await deliverAccountMail(pool,async()=>{delivered++});assert.equal(delivered,0)
  await pool.query('UPDATE oq_account_mail SET available_at=now()')
  await deliverAccountMail(pool,async()=>{delivered++});assert.equal(delivered,1)
  assert.equal(Number((await pool.query('SELECT count(*) AS count FROM oq_account_mail')).rows[0].count),0)
  await enqueueAccountMail(pool,{to:'expired@example.test',url:config.baseURL+'/?token=expired-fixture',kind:'verify'})
  await pool.query("UPDATE oq_account_mail SET created_at=now()-interval '16 minutes'")
  await deliverAccountMail(pool,async()=>{delivered++});assert.equal(delivered,1)
  assert.throws(()=>smtpDelivery('invalid-fixture','sender@example.test',config.baseURL),/Invalid SMTP configuration/)
 }finally{await db.close()}
})
