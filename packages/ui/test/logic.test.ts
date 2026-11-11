import { test } from 'node:test'
import assert from 'node:assert/strict'
import { crumbs, joinPath, lineCount, parseListing } from '../src/files.js'
import { diffLines, parseGit } from '../src/git.js'
import { navGroups } from '../src/nav.js'

test('listing puts folders first and reports truncation', () => {
  const listing = parseListing('b.ts\nsrc/\na.ts\n...[12 more]')
  assert.deepEqual(listing.entries.map(e => e.name), ['src', 'a.ts', 'b.ts'])
  assert.equal(listing.entries[0]!.dir, true)
  assert.equal(listing.more, 12)
  assert.deepEqual(parseListing('').entries, [])
})

test('paths and breadcrumbs', () => {
  assert.equal(joinPath('.', 'a'), 'a')
  assert.equal(joinPath('src', 'a'), 'src/a')
  assert.deepEqual(crumbs('src/ui/a.ts').map(c => c.path), ['src', 'src/ui', 'src/ui/a.ts'])
  assert.equal(lineCount('a\nb\n'), 2)
  assert.equal(lineCount(''), 0)
})

test('git status parsing covers branch, upstream, files, diff and failures', () => {
  const git = parseGit('## main...origin/main [ahead 2, behind 1]\n M a.ts\n?? b.ts\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-x\n+y\n')
  assert.equal(git.branch, 'main'); assert.equal(git.upstream, 'origin/main')
  assert.equal(git.ahead, 2); assert.equal(git.behind, 1)
  assert.deepEqual(git.files, [{ code: 'M', path: 'a.ts' }, { code: '??', path: 'b.ts' }])
  assert.deepEqual(diffLines(git.diff).map(l => l.kind), ['meta', 'meta', 'meta', 'hunk', 'del', 'add'])
  assert.equal(parseGit('fatal: not a git repository (or any of the parent directories): .git').state, 'not-a-repo')
  assert.equal(parseGit('## No commits yet on main\n').branch, 'main')
  assert.equal(parseGit('## main\n').files.length, 0)
  assert.equal(parseGit('boom').state, 'error')
})

test('navigation groups differ between local and server mode', () => {
  assert.ok(!navGroups(false).primary.includes('Projects'))
  assert.deepEqual(navGroups(true).primary, ['Chat', 'Projects', 'Explorer', 'Git'])
})
