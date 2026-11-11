import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

// The worker image copies files by name. A relative import that the Dockerfile does not copy only fails once the
// container starts (every tool call then returns 503), and unit tests running from source cannot see that.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const entry = 'packages/worker/runner.mjs'

function relativeImports(file) {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  const specs = [...text.matchAll(/(?:from\s+|import\s*\()\s*['"](\.[^'"]+)['"]/g)].map(m => m[1])
  return specs.map(spec => path.posix.normalize(path.posix.join(path.posix.dirname(file), spec)))
}

test('every file the worker imports (transitively) is copied into the worker image', () => {
  const dockerfile = fs.readFileSync(path.join(root, 'packages/worker/Dockerfile'), 'utf8')
  const copied = new Set([...dockerfile.matchAll(/^COPY\s+(\S+)\s+\/app\/(\S+)\s*$/gm)].filter(m => m[1] === m[2]).map(m => m[1]))
  const seen = new Set(), queue = [entry]
  while (queue.length) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const dep of relativeImports(file)) queue.push(dep)
  }
  assert.ok(seen.size > 1, 'expected the worker to import shared tool code')
  const missing = [...seen].filter(file => !copied.has(file))
  assert.deepEqual(missing, [], `Dockerfile does not COPY: ${missing.join(', ')}`)
})
