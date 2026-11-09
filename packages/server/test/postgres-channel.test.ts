import {test} from 'node:test'
import assert from 'node:assert/strict'
import {Pool} from 'pg'
import {PostgresRunChannel,pgListen} from '../src/channel.js'
import type {Listen} from '../src/channel.js'

// Integration test against a real PostgreSQL server (LISTEN/NOTIFY over pg). Skipped unless
// OQELIRA_TEST_DATABASE_URL is set, e.g. a throwaway local container:
//   docker run --rm -p 55433:5432 -e POSTGRES_PASSWORD=test pgvector/pgvector:pg17
//   OQELIRA_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55433/postgres npm test -w @oqelira/server
const url=process.env.OQELIRA_TEST_DATABASE_URL

test('LISTEN/NOTIFY on real PostgreSQL wakes watchers on another replica',{timeout:30000,skip:!url&&'set OQELIRA_TEST_DATABASE_URL to run against PostgreSQL'},async()=>{
 const pool=new Pool({connectionString:url,max:2})
 // Each replica holds its own LISTEN connection, as in production.
 const stops:(()=>Promise<void>)[]=[]
 const listen:Listen=async(channel,onPayload)=>{stops.push(await pgListen(url!)(channel,onPayload) as ()=>Promise<void>)}
 const replicaA=await PostgresRunChannel.open(pool,listen),replicaB=await PostgresRunChannel.open(pool,listen)
 try{
  const run='44444444-4444-4444-8444-444444444444'
  let fired=0
  const unwatch=replicaA.watch(run,()=>fired++)
  await replicaB.wake(run)
  for(let i=0;i<200&&!fired;i++)await new Promise(resolve=>setTimeout(resolve,10))
  assert.equal(fired,1)
  unwatch()
 }finally{await Promise.all(stops.map(stop=>stop()));await pool.end()}
})
