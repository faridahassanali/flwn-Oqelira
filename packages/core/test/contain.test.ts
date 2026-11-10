import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { resolveInside, writeNoFollow } from '../src/tools/contain.mjs'
import { writeFile } from '../src/tools/fs.js'
import { snapshotFile } from '../src/tools/changes.mjs'

const blocked = /(^|\/)\.git(\/|$)/
async function setup() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'oq-contain-'))
  const root = path.join(base, 'ws'), out = path.join(base, 'out')
  await fs.mkdir(root); await fs.mkdir(out)
  return { base, root, out }
}
const link = (target: string, p: string) => fs.symlink(target, p)

test('containment: every escape shape is refused, inside symlinks allowed', async () => {
  const { base, root, out } = await setup()
  try {
    await fs.writeFile(path.join(out, 'secret'), 'x')
    await fs.writeFile(path.join(root, 'in.txt'), 'y')
    await link(path.join(out, 'missing'), path.join(root, 'dangling'))
    await link(path.join(out, 'secret'), path.join(root, 'toout'))
    await link('in.txt', path.join(root, 'toin'))
    await link('loop2', path.join(root, 'loop1')); await link('loop1', path.join(root, 'loop2'))
    await link(out, path.join(root, 'dirlink'))
    await link(path.join(out, 'nodir'), path.join(root, 'danglingdir'))
    for (const p of ['dangling', 'toout', 'loop1', 'dirlink/new.txt', 'dirlink/secret', 'danglingdir/f', '../out/x', path.join(out, 'x'), '/etc/passwd', 'a/../../out/x'])
      await assert.rejects(resolveInside(root, p, blocked), /./, p)
    assert.equal(await resolveInside(root, 'toin', blocked), path.join(await fs.realpath(root), 'in.txt'))
    assert.equal(await resolveInside(root, 'new/dir/f.txt', blocked), path.join(await fs.realpath(root), 'new/dir/f.txt'))
    // the real tool: dangling link must not create the outside file
    await assert.rejects(writeFile.run({ path: 'dangling', content: 'pwn' }, { cwd: root } as any))
    await assert.rejects(fs.stat(path.join(out, 'missing')))
    await assert.rejects(snapshotFile(root, 'dangling'))
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('check-then-swap: a symlink swapped in after the check is not followed', async () => {
  const { base, root, out } = await setup()
  try {
    const file = await resolveInside(root, 'late.txt', blocked)
    await link(path.join(out, 'victim'), file) // attacker swaps after the check
    await assert.rejects(writeNoFollow(file, 'pwn'), (e: any) => e.code === 'ELOOP')
    await assert.rejects(fs.stat(path.join(out, 'victim')))
    await fs.rm(file); await fs.writeFile(path.join(out, 'victim'), 'keep'); await link(path.join(out, 'victim'), file)
    await assert.rejects(writeNoFollow(file, 'pwn'), (e: any) => e.code === 'ELOOP')
    assert.equal(await fs.readFile(path.join(out, 'victim'), 'utf8'), 'keep')
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})
