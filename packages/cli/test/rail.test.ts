import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StepRail } from '../src/rail.js'

test('step rail links consecutive items and closes at the end', () => {
  const rail = new StepRail()
  assert.equal(rail.begin(), '┌─ ')
  assert.equal(rail.item(), '│  ')
  assert.equal(rail.begin(), '│  ')
  assert.equal(rail.end(), '└─ ')
  assert.equal(rail.end(), '')
  assert.equal(rail.active, false)
})
