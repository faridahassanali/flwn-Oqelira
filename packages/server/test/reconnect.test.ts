import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PGlite} from '@electric-sql/pglite'
import {createServer as createNetServer} from 'node:net'
import type {HostEvent} from '@oqelira/protocol'
import {pglitePool} from './database.js'
import {serverConfig} from '../src/config.js'
import {migrate} from '../src/migrate.js'
import {createAuth} from '../src/auth.js'
import {Store} from '../src/store.js'
import {createCloudServer} from '../src/server.js'

async function* events(response:Response){
 assert.equal(response.status,200)
 const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer=''
 try{for(;;){const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});let index:number
 while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index).trim();buffer=buffer.slice(index+1);if(line)yield JSON.parse(line) as HostEvent}
 }}finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
}
test('dropped streams reconnect through durable events without repeating model calls or approvals; cross-user replay/stop are denied',{timeout:60000},async()=>{
 const reservation=createNetServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()))
 const db=new PGlite(),pool=pglitePool(db)
 const config=serverConfig({OQELIRA_SERVER_URL:`http://127.0.0.1:${port}`,OQELIRA_AUTH_SECRET:'a52a03ac0f6e141d311d8ae6a7ad01c10d5770fcaeb9e31c',OQELIRA_DATABASE_URL:'postgres://fixture',OQELIRA_ALLOW_SIGNUP:'true'})
 await migrate(pool,config)
 let calls=0
 const server=createCloudServer({auth:createAuth(pool,config),store:new Store(pool),sandbox:{tools:()=>[]},origin:config.baseURL,dist:'.',models:[{id:'fixture',deployment:'fixture',api:'chat',speed:'fast'}],provider:()=>({id:'fixture',async *stream(request){calls++;if(request.messages.at(-1)?.role==='user'){yield{type:'tool-call',call:{id:'memory',name:'remember_project',input:{content:'remembered once'}}};yield{type:'finish',reason:'tool-calls'}}else{yield{type:'text-delta',text:'Saved once'};yield{type:'finish',reason:'stop'}}}})})
 await server.listen(port)
 const request=(route:string,cookie='',data?:unknown)=>fetch(config.baseURL+route,{headers:{Origin:config.baseURL,Cookie:cookie,...(data===undefined?{}:{'Content-Type':'application/json'})},...(data===undefined?{}:{method:'POST',body:JSON.stringify(data)})})
 const signup=async(email:string)=>{const response=await request('/api/auth/sign-up/email','',{name:'Fixture',email,password:'Temporary test password 2026!'});assert.equal(response.status,200);return response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')}
 try{
  const owner=await signup('replay-owner@example.test'),other=await signup('replay-other@example.test')
  const project=await(await request('/api/projects',owner,{name:'Replay test'})).json() as {id:string}
  let run='',cursor=0
  for await(const event of events(await request('/api/run',owner,{projectId:project.id,model:'fixture',prompt:'remember',reconnectable:true}))){if(event.type==='started'){run=event.runId;cursor=event.sequence!;break}}
  assert.ok(run);assert.ok(cursor)
  assert.equal((await request('/api/run/events?runId='+run,other)).status,404)
  assert.equal((await request('/api/run/stop',other,{runId:run})).status,404)
  let approvalCount=0,done=false,last=cursor
  for await(const event of events(await request(`/api/run/events?runId=${run}&after=${cursor}`,owner))){assert.ok(event.sequence!>last);last=event.sequence!
   if(event.type==='approval'){approvalCount++;assert.equal((await request('/api/approval',owner,{runId:run,approvalId:event.approval.id,allowed:true})).status,200)}
   if(event.type==='done')done=true
  }
  assert.equal(done,true);assert.equal(approvalCount,1);assert.equal(calls,2)
  const memory=await(await request('/api/memory?projectId='+project.id,owner)).json() as unknown[];assert.equal(memory.length,1)
  const replay:HostEvent[]=[];for await(const event of events(await request('/api/run/events?runId='+run,owner)))replay.push(event)
  assert.equal(replay.at(-1)?.type,'done');assert.equal(calls,2)
  // Explicit Stop, rather than dropping the response, cancels a reconnectable run.
  let stopped=''
  for await(const event of events(await request('/api/run',owner,{projectId:project.id,model:'fixture',prompt:'stop',reconnectable:true}))){if(event.type==='started'){stopped=event.runId;break}}
  assert.equal((await request('/api/run/stop',owner,{runId:stopped})).status,200)
  let ended=false;for await(const event of events(await request('/api/run/events?runId='+stopped,owner)))if(event.type==='error'||event.type==='done')ended=true
  assert.equal(ended,true)
 }finally{await server.close();await db.close()}
})
