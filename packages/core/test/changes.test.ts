import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {snapshotFile,applyFileChange,readFileChange} from '../src/tools/changes.mjs'
import {runAgent} from '../src/agent/loop.js'
import {builtinTools} from '../src/tools/index.js'

test('versioned edits survive restart, reject stale hashes, and revert only the recorded content',async()=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'oq-changes-'))
  try{
    await fs.writeFile(path.join(cwd,'code.ts'),'original\n')
    const before=await snapshotFile(cwd,'code.ts')
    const changed=JSON.parse(await applyFileChange(cwd,{path:'code.ts',expected_sha256:before.sha256,content:'updated\n'}))
    assert.equal(await fs.readFile(path.join(cwd,'code.ts'),'utf8'),'updated\n')
    await assert.rejects(applyFileChange(cwd,{path:'code.ts',expected_sha256:before.sha256,content:'stale'}),/changed since preview/)
    const undo=await readFileChange(cwd,changed.change_id)
    await assert.rejects(applyFileChange(cwd,{...undo,content:'tampered'},true),/does not match/)
    await fs.writeFile(path.join(cwd,'code.ts'),'human edit')
    await assert.rejects(applyFileChange(cwd,undo,true),/changed since preview/)
    await fs.writeFile(path.join(cwd,'code.ts'),'updated\n')
    await applyFileChange(cwd,undo,true)
    assert.equal(await fs.readFile(path.join(cwd,'code.ts'),'utf8'),'original\n')
    for(const bad of ['../outside','.env','.git/config','.oqelira/changes/anything.json'])await assert.rejects(snapshotFile(cwd,bad),/excluded/)
    await fs.mkdir(path.join(cwd,'real'))
    try{
      await fs.symlink(path.join(cwd,'real'),path.join(cwd,'alias'),process.platform==='win32'?'junction':'dir')
      await assert.rejects(snapshotFile(cwd,'alias/file'),/Symlink/)
    }catch(error){if((error as NodeJS.ErrnoException).code!=='EPERM')throw error}
  }finally{await fs.rm(cwd,{recursive:true,force:true})}
})

test('new files and deletions can be reverted; denying approval does not modify the workspace',async()=>{
  const cwd=await fs.mkdtemp(path.join(os.tmpdir(),'oq-changes-create-'))
  try{
    const created=JSON.parse(await applyFileChange(cwd,{path:'new.txt',expected_sha256:null,content:'new'}))
    await applyFileChange(cwd,await readFileChange(cwd,created.change_id),true)
    assert.equal((await snapshotFile(cwd,'new.txt')).exists,false)
    await fs.writeFile(path.join(cwd,'kept.txt'),'kept')
    const snap=await snapshotFile(cwd,'kept.txt')
    const removed=JSON.parse(await applyFileChange(cwd,{path:'kept.txt',expected_sha256:snap.sha256,content:null}))
    await applyFileChange(cwd,await readFileChange(cwd,removed.change_id),true)
    assert.equal(await fs.readFile(path.join(cwd,'kept.txt'),'utf8'),'kept')
    const result=await runAgent({cwd,prompt:'fixture',maxSteps:1,tools:builtinTools,permissions:{autoAllow:['read'],approve:async()=>false},provider:{id:'fixture',async *stream(){yield{type:'tool-call',call:{id:'denied',name:'apply_file_change',input:{path:'denied.txt',expected_sha256:null,content:'must not exist'}}};yield{type:'finish',reason:'tool-calls'}}}})
    assert.equal((await snapshotFile(cwd,'denied.txt')).exists,false)
    const final=result.messages.at(-1);if(final?.role==='tool')assert.equal(final.results[0]?.isError,true)
  }finally{await fs.rm(cwd,{recursive:true,force:true})}
})
