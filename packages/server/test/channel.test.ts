import {test} from 'node:test'
import assert from 'node:assert/strict'
import {PGlite} from '@electric-sql/pglite'
import {pglitePool} from './database.js'
import {PostgresRunChannel} from '../src/channel.js'

test('a wake from one replica reaches watchers on another replica without polling; unwatched runs stay quiet',{timeout:20000},async()=>{
 const db=new PGlite(),pool=pglitePool(db)
 const listen=(channel:string,callback:(payload:string)=>void)=>db.listen(channel,callback)
 const replicaA=await PostgresRunChannel.open(pool,listen),replicaB=await PostgresRunChannel.open(pool,listen)
 try{
  const run='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222'
  let fired=0,otherFired=0
  const unwatch=replicaA.watch(run,()=>fired++)
  replicaA.watch(other,()=>otherFired++)
  const started=Date.now()
  await replicaB.wake(run)
  for(let i=0;i<100&&!fired;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(fired,1)
  assert.ok(Date.now()-started<1000)
  unwatch()
  await replicaB.wake(run)
  await new Promise(resolve=>setTimeout(resolve,100))
  assert.equal(fired,1)
  assert.equal(otherFired,0)
 }finally{await db.close()}
})
