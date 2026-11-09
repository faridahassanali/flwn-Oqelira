import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PGlite} from '@electric-sql/pglite'
import {randomUUID} from 'node:crypto'
import {Pool} from 'pg'
import type {ModelProvider} from '@oqelira/core'
import {createServer as createNetServer} from 'node:net'
import type {HostEvent} from '@oqelira/protocol'
import {pglitePool} from './database.js'
import {serverConfig} from '../src/config.js'
import {migrate} from '../src/migrate.js'
import {createAuth} from '../src/auth.js'
import {Store} from '../src/store.js'
import {PostgresRunChannel,pgListen} from '../src/channel.js'
import type {Listen} from '../src/channel.js'
import {createCloudServer} from '../src/server.js'

async function* events(response:Response){
 assert.equal(response.status,200)
 const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer=''
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let index:number
 while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(line)yield JSON.parse(line) as HostEvent}
 }}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
// Set OQELIRA_TEST_DATABASE_URL to run the same flow against a real PostgreSQL server (use a fresh database).
const url=process.env.OQELIRA_TEST_DATABASE_URL
async function freePort(){const reservation=createNetServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const address=reservation.address();assert.ok(address&&typeof address!=='string');await new Promise<void>(resolve=>reservation.close(()=>resolve()));return address.port}

test('replicas share one database and channel: approvals from any replica reach the run, and live events follow the run across replicas',{timeout:90000},async()=>{
 const portA=await freePort(),portB=await freePort()
 const db=url?undefined:new PGlite(),pool=db?pglitePool(db):new Pool({connectionString:url,max:10})
 const stops:(()=>Promise<void>)[]=[]
 const common={OQELIRA_AUTH_SECRET:'a52a03ac0f6e141d311d8ae6a7ad01c10d5770fcaeb9e31c',OQELIRA_DATABASE_URL:'postgres://fixture',OQELIRA_ALLOW_SIGNUP:'true'}
 const configA=serverConfig({...common,OQELIRA_SERVER_URL:`http://127.0.0.1:${portA}`}),configB=serverConfig({...common,OQELIRA_SERVER_URL:`http://127.0.0.1:${portB}`})
 await migrate(pool,configA)
 let calls=0
 const provider=():ModelProvider=>({id:'fixture',async *stream(request){calls++;if(request.messages.at(-1)?.role==='user'){yield{type:'tool-call',call:{id:'memory',name:'remember_project',input:{content:'remembered once'}}};yield{type:'finish',reason:'tool-calls'}}else{yield{type:'text-delta',text:'Saved once'};yield{type:'finish',reason:'stop'}}}})
 const listen:Listen=db?(channel,callback)=>db.listen(channel,callback):async(channel,callback)=>{stops.push(await pgListen(url!)(channel,callback) as ()=>Promise<void>)}
 // Two replicas: separate run maps, separate origins and channel listeners, one database.
 const replica=async(config:typeof configA)=>createCloudServer({auth:createAuth(pool,config),store:new Store(pool),channel:await PostgresRunChannel.open(pool,listen),sandbox:{tools:()=>[]},origin:config.baseURL,dist:'.',models:[{id:'fixture',deployment:'fixture',api:'chat',speed:'fast'}],provider})
 const serverA=await replica(configA),serverB=await replica(configB)
 await serverA.listen(portA);await serverB.listen(portB)
 const send=(config:typeof configA,route:string,cookie='',data?:unknown)=>fetch(config.baseURL+route,{headers:{Origin:config.baseURL,Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})})
 const onA=(route:string,cookie='',data?:unknown)=>send(configA,route,cookie,data),onB=(route:string,cookie='',data?:unknown)=>send(configB,route,cookie,data)
 try{
  const signup=async(email:string)=>{const response=await onA('/api/auth/sign-up/email','',{name:'Fixture',email,password:'Temporary test password 2026!'});assert.equal(response.status,200);return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')}
  const owner=await signup(`replica-owner-${randomUUID()}@example.test`)
  const project=await(await onA('/api/projects',owner,{name:'Replica test'})).json() as {id:string}

  // The run lives on replica A. A reconnecting client attaches to replica B and must see the approval live.
  let run='',cursor=0
  for await(const event of events(await onA('/api/run',owner,{projectId:project.id,model:'fixture',prompt:'remember',reconnectable:true}))){if(event.type==='started'){run=event.runId;cursor=event.sequence!;break}}
  assert.ok(run)
  let approvals=0,done=false,stale:HostEvent|undefined
  for await(const event of events(await onB(`/api/run/events?runId=${run}&after=${cursor}`,owner))){
   if(event.type==='approval'){approvals++;stale=event;assert.equal((await onB('/api/approval',owner,{runId:run,approvalId:event.approval.id,allowed:true})).status,200)}
   if(event.type==='done')done=true
  }
  assert.equal(done,true);assert.equal(approvals,1);assert.equal(calls,2)
  // A decision for a finished run is refused on any replica, and an unknown run is not found.
  assert.ok(stale?.type==='approval')
  assert.equal((await onB('/api/approval',owner,{runId:run,approvalId:stale.approval.id,allowed:true})).status,409)
  assert.equal((await onA('/api/approval',owner,{runId:run,approvalId:stale.approval.id,allowed:true})).status,409)
  assert.equal((await onB('/api/approval',owner,{runId:'33333333-3333-4333-8333-333333333333',approvalId:stale.approval.id,allowed:true})).status,404)

  // A run without a reconnectable journal has its stream only on replica A; replica B still delivers its approval.
  let plainRun='',plainApprovals=0,plainDone=false
  for await(const event of events(await onA('/api/run',owner,{projectId:project.id,model:'fixture',prompt:'remember'}))){
   if(event.type==='started')plainRun=event.runId
   if(event.type==='approval'){plainApprovals++;assert.equal((await onB('/api/approval',owner,{runId:plainRun,approvalId:event.approval.id,allowed:true})).status,200)}
   if(event.type==='done')plainDone=true
  }
  assert.equal(plainDone,true);assert.equal(plainApprovals,1);assert.equal(calls,4)
  assert.equal((await(await onB('/api/memory?projectId='+project.id,owner)).json() as unknown[]).length,2)
 }finally{await serverA.close();await serverB.close();await Promise.all(stops.map(stop=>stop()));await(db?db.close():pool.end())}
})
