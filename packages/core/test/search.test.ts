import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { searchWorkspace } from '../src/tools/search-engine.mjs'

test('search returns literal line matches and skips credentials, dependencies, generated, binary and oversized files', async () => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'oq-search-'))
  try {
    await fs.mkdir(path.join(root,'src')); await fs.mkdir(path.join(root,'node_modules')); await fs.mkdir(path.join(root,'dist'))
    await fs.writeFile(path.join(root,'src','main.ts'),'first\nNeedle .* here\nneedle later')
    for(const name of ['.env','.env.example','private.pem','node_modules/dep.ts','dist/bundle.js']) await fs.writeFile(path.join(root,name),'needle excluded')
    await fs.writeFile(path.join(root,'binary.dat'),Buffer.from('needle\0binary'))
    await fs.writeFile(path.join(root,'large.txt'),'needle'.repeat(50_000))
    const result=JSON.parse(await searchWorkspace(root,{query:'needle'}))
    assert.deepEqual(result.matches.map((m:{path:string;line:number})=>[m.path,m.line]),[['src/main.ts',2],['src/main.ts',3]])
    assert.equal(result.limit_reached,false)
    assert.equal(JSON.parse(await searchWorkspace(root,{query:'.*',case_sensitive:true})).matches.length,1)
    assert.equal(JSON.parse(await searchWorkspace(root,{query:'Needle',case_sensitive:true})).matches.length,1)
    assert.equal(JSON.parse(await searchWorkspace(root,{query:'absent'})).matches.length,0)
    const limited=JSON.parse(await searchWorkspace(root,{query:'needle',max_results:1}))
    assert.equal(limited.matches.length,1);assert.equal(limited.limit_reached,true)
    for(const input of [{query:''},{query:'x\ny'},{query:'x',max_results:201},{query:'x',case_sensitive:'yes'},{query:'x',path:'../'},{query:'x',path:'.env'}]) await assert.rejects(searchWorkspace(root,input))
    const controller=new AbortController();controller.abort()
    await assert.rejects(searchWorkspace(root,{query:'needle'},controller.signal),{name:'AbortError'})
    // Junctions need no Windows developer-mode symlink permission.
    await fs.symlink(path.join(root,'src'),path.join(root,'alias'),process.platform==='win32'?'junction':'dir')
    await assert.rejects(searchWorkspace(root,{query:'needle',path:'alias'}),/Symlink/)
    assert.equal(JSON.parse(await searchWorkspace(root,{query:'needle'})).matches.length,2)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})

test('search keeps large result sets valid and bounded instead of cutting JSON',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'oq-search-limit-'))
  try {
    await fs.writeFile(path.join(root,'matches.txt'),('needle '+ 'x'.repeat(490)+'\n').repeat(200))
    const output=await searchWorkspace(root,{query:'needle',max_results:200})
    assert.ok(output.length<30_000)
    const result=JSON.parse(output);assert.equal(result.limit_reached,true);assert.ok(result.matches.length>0 && result.matches.length<200)
  } finally { await fs.rm(root,{recursive:true,force:true}) }
})
