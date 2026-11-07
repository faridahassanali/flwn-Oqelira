import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const packages = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string) => fs.readFileSync(p, 'utf8')
function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sources(path.join(dir, e.name)) : /\.(ts|mjs|cjs)$/.test(e.name) ? [path.join(dir, e.name)] : []))
}

test('interfaces and the engine never depend on the terminal CLI (installing them must not install it)', () => {
  for (const name of ['engine', 'host', 'extension', 'desktop', 'web', 'ui']) {
    const manifest = JSON.parse(read(path.join(packages, name, 'package.json')))
    const deps = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies, ...manifest.optionalDependencies }
    assert.ok(!('@oqelira/cli' in deps), `${name} must not depend on @oqelira/cli`)
    for (const dir of ['src', 'test']) {
      const full = path.join(packages, name, dir)
      if (!fs.existsSync(full)) continue
      for (const file of sources(full)) assert.ok(!/@oqelira\/cli|packages\/cli\//.test(read(file)) || file.endsWith('isolation.test.ts'), `${file} must not reference the CLI`)
    }
  }
})

test('the CLI depends on the engine, and the engine has no terminal UI code', () => {
  const cli = JSON.parse(read(path.join(packages, 'cli', 'package.json')))
  assert.ok('@oqelira/engine' in cli.dependencies)
  for (const file of sources(path.join(packages, 'engine', 'src'))) assert.ok(!/readline\.createInterface\(\{\s*input:\s*process\.stdin[^)]*output/.test(read(file)) && !/\\x1b\[|ansi/i.test(read(file)), `${file} looks like terminal UI`)
})
