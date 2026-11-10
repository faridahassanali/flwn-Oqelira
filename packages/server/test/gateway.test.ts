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
  assert.equal((await request('/api/gateway/revoke',alice.cookie)).status,200)
  assert.equal(await isRevoked(gwDb,alice.id),true);assert.equal(await isRevoked(gwDb,bob.id),false)
  assert.equal((await request('/api/gateway/token',alice.cookie,{organizationId:org.id,deviceId:'d1'})).status,403)
 
  // admin revoke / un-revoke
  const carol=await signup('carol@example.test')
  // bob is only a viewer in org, but owns an unrelated org
  await request('/api/auth/organization/create',bob.cookie,{name:'Bob team',slug:'bob-team'})
  await pool.query('INSERT INTO member (id,"organizationId","userId",role,"createdAt") VALUES ($1,$2,$3,$4,now())',['m-carol',org.id,carol.id,'member'])
  const mint=async(u:{cookie:string})=>(await request('/api/gateway/token',u.cookie,{organizationId:org.id,deviceId:'d1'})).status
  assert.equal(await mint(carol),200)
  // self-revoke, self un-revoke refused, then admin restores
  assert.equal((await request('/api/gateway/revoke',carol.cookie)).status,200)
  assert.equal(await mint(carol),403)
  assert.equal((await request('/api/gateway/unrevoke',carol.cookie,{userId:carol.id})).status,403)
  assert.equal(await isRevoked(gwDb,carol.id),true)
  // non-admin and unrelated-org admin cannot act; same 403 for unknown targets
  assert.equal((await request('/api/gateway/unrevoke',bob.cookie,{userId:carol.id})).status,403)
  assert.equal((await request('/api/gateway/revoke',bob.cookie,{userId:carol.id})).status,403)
  assert.equal((await request('/api/gateway/revoke',carol.cookie,{userId:alice.id})).status,403)
  assert.equal((await request('/api/gateway/unrevoke',carol.cookie,{userId:alice.id})).status,403)
  assert.equal((await request('/api/gateway/revoke',bob.cookie,{userId:'nobody'})).status,403)
  assert.equal((await request('/api/gateway/unrevoke',alice.cookie,{userId:'nobody'})).status,403)
  assert.equal((await request('/api/gateway/unrevoke','',{userId:carol.id})).status,401)
  assert.equal(await isRevoked(gwDb,alice.id),true)
  assert.equal((await request('/api/gateway/unrevoke',alice.cookie,{userId:carol.id})).status,200)
  assert.equal(await mint(carol),200)
  // admin cannot un-revoke self (alice is still revoked from above)
  assert.equal((await request('/api/gateway/unrevoke',alice.cookie,{userId:alice.id})).status,403)
  assert.equal(await isRevoked(gwDb,alice.id),true)
  // admin revoke of a member blocks that member's next token
  assert.equal((await request('/api/gateway/unrevoke',alice.cookie,{userId:carol.id})).status,200)
  assert.equal((await request('/api/gateway/revoke',alice.cookie,{userId:carol.id})).status,200)
  assert.equal(await mint(carol),403)
 }finally{await server.close()}
})
