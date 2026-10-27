import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
const runner = fileURLToPath(new URL('../runner.mjs', import.meta.url))
async function call(root, name, input) {
  return new Promise((resolve, reject) => {
    const processHandle = spawn(process.execPath, ['--import','tsx',runner], { env: { ...process.env, OQELIRA_WORKER_ROOT: root }, stdio: ['pipe','pipe','pipe'], windowsHide: true })
    let output = '', errors = ''
    processHandle.stdout.on('data', bytes => { output += bytes })
    processHandle.stderr.on('data', bytes => { errors += bytes })
    processHandle.on('error', reject)
    processHandle.on('close', code => { try { assert.equal(code, 0, errors); resolve(JSON.parse(output)) } catch (e) { reject(e) } })
    processHandle.stdin.end(JSON.stringify({ name, input }))
  })
}
test('worker file operations persist, reject ambiguous edits, and hide credential paths', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-worker-'))
  try {
    assert.equal((await call(dir, 'write_file', {path:'src/main.ts',content:'hello world'})).error, undefined)
    assert.equal((await call(dir, 'read_file', {path:'src/main.ts'})).output, 'hello world')
    assert.equal((await call(dir, 'edit_file', {path:'src/main.ts',old_string:'world',new_string:'code'})).error, undefined)
    assert.equal((await call(dir, 'read_file', {path:'src/main.ts'})).output, 'hello code')
    assert.match((await call(dir, 'write_file', {path:'../escape.txt',content:'outside'})).error, /outside/)
    assert.match((await call(dir, 'read_file', {path:'.env'})).error, /excluded/)
    await fs.writeFile(path.join(dir, '.env'), 'LOCAL_FIXTURE_ONLY=not-a-key')
    await fs.writeFile(path.join(dir, 'duplicate.txt'), 'repeat repeat')
    assert.match((await call(dir, 'edit_file', {path:'duplicate.txt',old_string:'repeat',new_string:'x'})).error, /exactly once/)
    assert.ok(!(await call(dir, 'list_dir', {path:'.'})).output.includes('.env'))
  } finally { await fs.rm(dir, {recursive:true,force:true}) }
})

test('worker runs the same bounded project search without shell access', async () => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'oq-worker-search-'))
  try {
    await fs.writeFile(path.join(dir,'code.ts'),'first\nneedle code')
    await fs.writeFile(path.join(dir,'.env'),'needle excluded')
    const response=await call(dir,'search_text',{query:'needle'})
    assert.equal(response.error,undefined)
    assert.deepEqual(JSON.parse(response.output).matches,[{path:'code.ts',line:2,text:'needle code'}])
    assert.match((await call(dir,'search_text',{query:'needle',path:'../'})).error,/outside/)
  } finally { await fs.rm(dir,{recursive:true,force:true}) }
})

test('isolated worker applies and reverts versioned file changes with stale-write protection',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'oq-worker-changes-'))
 try{
   const snap=JSON.parse((await call(root,'file_snapshot',{path:'new.ts'})).output)
   assert.equal(snap.exists,false)
   const written=await call(root,'apply_file_change',{path:'new.ts',expected_sha256:null,content:'version one'})
   assert.equal(written.error,undefined)
   const id=JSON.parse(written.output).change_id
   assert.match((await call(root,'apply_file_change',{path:'new.ts',expected_sha256:null,content:'stale'})).error,/changed since preview/)
   const input=JSON.parse((await call(root,'read_file_change',{change_id:id})).output)
   assert.equal((await call(root,'revert_file_change',input)).error,undefined)
   assert.equal(JSON.parse((await call(root,'file_snapshot',{path:'new.ts'})).output).exists,false)
   assert.match((await call(root,'read_file',{path:'.oqelira/changes/'+id+'.json'})).error,/excluded/)
 }finally{await fs.rm(root,{recursive:true,force:true})}
})
