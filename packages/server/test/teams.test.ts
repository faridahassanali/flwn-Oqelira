import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PGlite} from '@electric-sql/pglite'
import {createServer as createNetServer} from 'node:net'
import {pglitePool} from './database.js'
import {serverConfig} from '../src/config.js'
import {migrate} from '../src/migrate.js'
import {createAuth} from '../src/auth.js'
import {Store} from '../src/store.js'
import {createCloudServer} from '../src/server.js'
import type {HostEvent} from '@oqelira/protocol'

test('team roles protect shared projects, invitations, runs and approvals; removal revokes creator and replay access',{timeout:90000},async()=>{
 const reservation=createNetServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()))
 const db=new PGlite(),pool=pglitePool(db),store=new Store(pool)
 const config=serverConfig({OQELIRA_SERVER_URL:`http://127.0.0.1:${port}`,OQELIRA_AUTH_SECRET:'ac0996b4c14adc375ed98a7b254e87afc8991babd58f038d9',OQELIRA_DATABASE_URL:'postgres://fixture',OQELIRA_ALLOW_SIGNUP:'true'})
 await migrate(pool,config)
 let modelCalls=0
 const server=createCloudServer({auth:createAuth(pool,config,async()=>{}),store,sandbox:{tools:()=>[]},origin:config.baseURL,dist:'.',models:[{id:'fixture',deployment:'fixture',api:'chat',speed:'fast'}],provider:()=>({id:'fixture',async *stream(){modelCalls++;yield{type:'tool-call',call:{id:'save',name:'remember_project',input:{content:'not approved'}}};yield{type:'finish',reason:'tool-calls'}}})})
 await server.listen(port)
 const request=(route:string,cookie:string,data?:unknown)=>fetch(config.baseURL+route,{headers:{Origin:config.baseURL,Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})})
 const signup=async(email:string)=>{const response=await request('/api/auth/sign-up/email','',{name:'Team fixture',email,password:'Controlled test password 2026!'});assert.equal(response.status,200);const user=(await response.json() as {user:{id:string}}).user;await pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1',[user.id]);return{id:user.id,email,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')}}
 try{
  const owner=await signup('owner@example.test'),member=await signup('member@example.test'),viewer=await signup('viewer@example.test')
  const teamResponse=await request('/api/auth/organization/create',owner.cookie,{name:'Controlled team',slug:'controlled-team'});assert.equal(teamResponse.status,200,await teamResponse.clone().text());const team=(await teamResponse.json()) as {id:string}
  const invite=async(recipient:typeof member,role:string)=>{
    const response=await request('/api/auth/organization/invite-member',owner.cookie,{organizationId:team.id,email:recipient.email,role});assert.equal(response.status,200,await response.clone().text());return(await response.json() as {id:string}).id
  }
  const viewerInvite=await invite(viewer,'viewer')
  assert.notEqual((await request('/api/auth/organization/accept-invitation',member.cookie,{invitationId:viewerInvite})).status,200)
  assert.equal((await request('/api/auth/organization/accept-invitation',viewer.cookie,{invitationId:viewerInvite})).status,200)
  const memberInvite=await invite(member,'member')
  assert.equal((await request('/api/auth/organization/accept-invitation',member.cookie,{invitationId:memberInvite})).status,200)
  const projectResponse=await request('/api/projects',owner.cookie,{name:'Shared project',organizationId:team.id});assert.equal(projectResponse.status,201);const project=await projectResponse.json() as {id:string}
  assert.ok((await(await request('/api/projects',viewer.cookie)).json() as {id:string}[]).some(value=>value.id===project.id))
  assert.equal((await request('/api/memory?projectId='+project.id,viewer.cookie)).status,200)
  assert.equal((await request('/api/file',viewer.cookie,{projectId:project.id,path:'file.txt',content:'denied'})).status,403)
  assert.equal((await request('/api/memory',viewer.cookie,{projectId:project.id,content:'denied'})).status,403)
  assert.equal((await request('/api/run',viewer.cookie,{projectId:project.id,model:'fixture',prompt:'denied'})).status,403)
  assert.equal((await request('/api/projects',member.cookie,{name:'Denied project',organizationId:team.id})).status,403)
  assert.equal(modelCalls,0)
  const membership=(await pool.query('SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2',[team.id,member.id])).rows[0].id
  assert.notEqual((await request('/api/auth/organization/update-member-role',viewer.cookie,{organizationId:team.id,memberId:membership,role:'admin'})).status,200)
  const response=await request('/api/run',member.cookie,{projectId:project.id,model:'fixture',prompt:'save',reconnectable:true})
  assert.equal(response.status,200)
  const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='',run='',conversation='',revoked=false
  for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let newline:number
   while((newline=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,newline);buffer=buffer.slice(newline+1);if(!line.trim())continue;const event=JSON.parse(line) as HostEvent
    if(event.type==='started'){run=event.runId;conversation=event.sessionId}
    if(event.type==='approval'){
     assert.equal((await request('/api/approval',owner.cookie,{runId:run,approvalId:event.approval.id,allowed:true})).status,409)
     assert.equal((await request('/api/auth/organization/update-member-role',owner.cookie,{organizationId:team.id,memberId:membership,role:'viewer'})).status,200)
     assert.notEqual((await request('/api/approval',member.cookie,{runId:run,approvalId:event.approval.id,allowed:true})).status,200);revoked=true
    }
   }
  }
  assert.equal(revoked,true);assert.equal((await(await request('/api/memory?projectId='+project.id,owner.cookie)).json() as unknown[]).length,0)
  assert.equal((await request('/api/auth/organization/remove-member',owner.cookie,{organizationId:team.id,memberIdOrEmail:membership})).status,200)
  assert.equal((await request('/api/conversation?id='+conversation,member.cookie)).status,404)
  assert.equal((await request('/api/run/events?runId='+run,member.cookie)).status,404)
  assert.ok(!(await(await request('/api/projects',member.cookie)).json() as {id:string}[]).some(value=>value.id===project.id))
  // A project creator's storage owner ID cannot bypass later team removal.
  const admin=member
  const adminInvite=await invite(admin,'admin');assert.equal((await request('/api/auth/organization/accept-invitation',admin.cookie,{invitationId:adminInvite})).status,200)
  const created=await request('/api/projects',admin.cookie,{name:'Admin-created',organizationId:team.id});assert.equal(created.status,201);const owned=await created.json() as {id:string}
  const adminMembership=(await pool.query('SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2',[team.id,admin.id])).rows[0].id
  const ownerMembership=(await pool.query('SELECT id FROM member WHERE "organizationId"=$1 AND "userId"=$2',[team.id,owner.id])).rows[0].id
  assert.notEqual((await request('/api/auth/organization/update-member-role',admin.cookie,{organizationId:team.id,memberId:ownerMembership,role:'member'})).status,200)
  assert.equal((await request('/api/auth/organization/remove-member',owner.cookie,{organizationId:team.id,memberIdOrEmail:adminMembership})).status,200)
  assert.equal((await request('/api/memory?projectId='+owned.id,admin.cookie)).status,404)
 }finally{await server.close();await db.close()}
})
