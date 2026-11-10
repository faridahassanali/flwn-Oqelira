import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PGlite} from '@electric-sql/pglite'
import {createServer as createNetServer} from 'node:net'
import {pglitePool} from './database.js'
import {serverConfig} from '../src/config.js'
import {migrate} from '../src/migrate.js'
import {createAuth} from '../src/auth.js'
import {Store} from '../src/store.js'
import {PostgresRunChannel} from '../src/channel.js'
import {createCloudServer} from '../src/server.js'
import {verifyToken} from '@oqelira/gateway/tokens'
import {migrate as migrateGateway,isRevoked} from '@oqelira/gateway/store'

test('gateway token issuer: sign-in, own orgs only, revocation',{timeout:90000},async()=>{
 const reservation=createNetServer();await new Promise<void>(resolve=>reservation.listen(0,'127.0.0.1',resolve));const address=reservation.address();assert.ok(address&&typeof address!=='string');const port=address.port;await new Promise<void>(resolve=>reservation.close(()=>resolve()))
 const db=new PGlite(),pool=pglitePool(db),gwDb=pglitePool(new PGlite())
 const tokenKey=Buffer.from('k'.repeat(40))
 const base={OQELIRA_SERVER_URL:`http://127.0.0.1:${port}`,OQELIRA_AUTH_SECRET:'ac0996b4c14adc375ed98a7b254e87afc8991babd58f038d9',OQELIRA_DATABASE_URL:'postgres://fixture',OQELIRA_ALLOW_SIGNUP:'true'}
 assert.throws(()=>serverConfig({...base,OQELIRA_GATEWAY_TOKEN_KEY:'k'.repeat(40)}),/both/)
 assert.throws(()=>serverConfig({...base,OQELIRA_GATEWAY_TOKEN_KEY:'short',OQELIRA_GATEWAY_DATABASE_URL:'postgres://gw'}),/32 bytes/)
 const config=serverConfig(base)
 await migrate(pool,config);await migrateGateway(gwDb)
 const server=createCloudServer({auth:createAuth(pool,config,async()=>{}),store:new Store(pool),channel:await PostgresRunChannel.open(pool,(c,cb)=>db.listen(c,cb)),sandbox:{tools:()=>[]},origin:config.baseURL,dist:'.',models:[],provider:()=>{throw new Error('unused')},gateway:{tokenKey,db:gwDb}})
 await server.listen(port)
 const request=(route:string,cookie:string,data?:unknown)=>fetch(config.baseURL+route,{method:'POST',headers:{Origin:config.baseURL,Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(data??{})})
 const signup=async(email:string)=>{const response=await request('/api/auth/sign-up/email','',{name:'Fixture',email,password:'Controlled test password 2026!'});assert.equal(response.status,200);const user=(await response.json() as {user:{id:string}}).user;await pool.query('UPDATE "user" SET "emailVerified"=true WHERE id=$1',[user.id]);return{id:user.id,cookie:response.headers.getSetCookie().map(value=>value.split(';')[0]).join('; ')}}
 try{
  const alice=await signup('alice@example.test'),bob=await signup('bob@example.test')
  const org=await(await request('/api/auth/organization/create',alice.cookie,{name:'Alice team',slug:'alice-team'})).json() as {id:string}
  assert.equal((await request('/api/gateway/token','',{organizationId:org.id,deviceId:'d1'})).status,401)
  assert.equal((await request('/api/gateway/token',bob.cookie,{organizationId:org.id,deviceId:'d1'})).status,403)
  assert.equal((await request('/api/gateway/token',alice.cookie,{organizationId:org.id})).status,400)
  const res=await request('/api/gateway/token',alice.cookie,{organizationId:org.id,deviceId:'d1',sub:bob.id})
  assert.equal(res.status,200)
  const {token}=await res.json() as {token:string}
  const claims=verifyToken(token,tokenKey)
  assert.ok(claims);assert.equal(claims.sub,alice.id);assert.equal(claims.org,org.id);assert.equal(claims.dev,'d1')
  assert.ok(claims.exp*1000-Date.now()<=900_000)
  assert.equal(verifyToken(token,Buffer.from('x'.repeat(40))),null)
  await pool.query('INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())',['m-viewer',org.id,bob.id,'viewer'])
  assert.equal((await request('/api/gateway/token',bob.cookie,{organizationId:org.id,deviceId:'d1'})).status,403)
  assert.equal((await request('/api/gateway/revoke','',{})).status,401)
  const wait=()=>new Promise(r=>setTimeout(r,5))
  const mint=async(u:{cookie:string},o:string)=>{const r=await request('/api/gateway/token',u.cookie,{organizationId:o,deviceId:'d1'});return r.status===200?(await r.json() as {token:string}).token:r.status}
  const dead=(t:string|number,u:{id:string},o:string)=>{assert.equal(typeof t,'string');return isRevoked(gwDb,u.id,o,verifyToken(t as string,tokenKey)!.iat)}
  // self revoke: old token dead, fresh one works, no unrevoke needed
  const old=await mint(alice,org.id);await wait()
  assert.equal((await request('/api/gateway/revoke',alice.cookie)).status,200)
  assert.equal(await dead(old,alice,org.id),true);await wait()
  const fresh=await mint(alice,org.id);assert.equal(await dead(fresh,alice,org.id),false)
  // admin block is scoped to one org
  const carol=await signup('carol@example.test')
  await pool.query('INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())',['m-carol',org.id,carol.id,'member'])
  const orgC=await(await request('/api/auth/organization/create',carol.cookie,{name:'Carol team',slug:'carol-team'})).json() as {id:string}
  const bobTeam=await(await request('/api/auth/organization/create',bob.cookie,{name:'Bob team',slug:'bob-team'})).json() as {id:string}
  const carolOld=await mint(carol,org.id);await wait()
  assert.equal((await request('/api/gateway/revoke',alice.cookie,{userId:carol.id})).status,400,'organizationId is required')
  assert.equal((await request('/api/gateway/revoke',bob.cookie,{userId:carol.id,organizationId:bobTeam.id})).status,403,'target not in that org')
  assert.equal((await request('/api/gateway/revoke',bob.cookie,{userId:carol.id,organizationId:org.id})).status,403,'viewer is not admin')
  assert.equal((await request('/api/gateway/revoke',alice.cookie,{userId:'nobody',organizationId:org.id})).status,403)
  assert.equal((await request('/api/gateway/revoke',alice.cookie,{userId:carol.id,organizationId:org.id})).status,200)
  assert.equal(await dead(carolOld,carol,org.id),true)
  assert.equal(await mint(carol,org.id),403)
  const carolC=await mint(carol,orgC.id);assert.equal(await dead(carolC,carol,orgC.id),false)
  // collusion: carol (blocked in A) makes accomplice bob admin of her own org; neither can unblock in A
  await pool.query('INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())',['m-bob-c',orgC.id,bob.id,'admin'])
  assert.equal((await request('/api/gateway/unrevoke',bob.cookie,{userId:carol.id,organizationId:org.id})).status,403)
  assert.equal((await request('/api/gateway/unrevoke',bob.cookie,{userId:carol.id,organizationId:orgC.id})).status,200,'bob may lift only the org-C row')
  assert.equal(await mint(carol,org.id),403)
  assert.equal((await request('/api/gateway/unrevoke',carol.cookie,{userId:carol.id,organizationId:org.id})).status,403,'self cannot unblock')
  assert.equal((await request('/api/gateway/unrevoke','',{userId:carol.id,organizationId:org.id})).status,401)
  // unblock keeps valid_after: the pre-block token stays dead, a new one works
  assert.equal((await request('/api/gateway/unrevoke',alice.cookie,{userId:carol.id,organizationId:org.id})).status,200)
  assert.equal(await dead(carolOld,carol,org.id),true);await wait()
  const carolNew=await mint(carol,org.id);assert.equal(await dead(carolNew,carol,org.id),false)
 }finally{await server.close()}
})
