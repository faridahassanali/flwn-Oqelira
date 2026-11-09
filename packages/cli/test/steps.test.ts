import assert from 'node:assert/strict'
import { test } from 'node:test'
import { StepLog, stepDetails, stepSummary } from '../src/steps.js'

test('step log collapses completed output but keeps details for expansion', () => {
  const log = new StepLog()
  log.start('a', 'read_file', 'read package.json')
  const step = log.finish('a', 'line one\nline two', false)!
  assert.equal(step.index, 1)
  assert.match(stepSummary(step), /^ok read package\.json · line one · \d+ms$/)
  assert.equal(stepDetails(step), `Step 1: read package.json\n  line one\n  line two\n  [completed in ${step.durationMs}ms]`)
  assert.equal(log.get(1)?.id, 'a')
})

test('step log keeps failed steps and can be cleared', () => {
  const log = new StepLog()
  log.start('a', 'run_command', 'run tests')
  const step = log.finish('a', 'failed output', true)!
  assert.match(stepSummary(step), /^x run tests/)
  log.clear()
  assert.equal(log.all().length, 0)
})
