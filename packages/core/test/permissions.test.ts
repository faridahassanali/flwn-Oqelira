import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPermission } from '../src/permissions.js'
import type { ApprovalRequest } from '../src/permissions.js'

const req: ApprovalRequest = { tool: 'run_command', risk: 'exec', summary: 'run: ls', input: { command: 'ls' } }

test('decide runs before the approver: allow skips it, deny blocks without asking, undefined falls through', async () => {
  let asked = 0
  const approve = async () => (asked++, true)
  assert.deepEqual(await checkPermission({ autoAllow: ['read'], decide: () => 'allow', approve }, req), { allowed: true })
  const denied = await checkPermission({ autoAllow: ['read'], decide: async () => 'deny', approve }, req)
  assert.equal(denied.allowed, false)
  assert.equal(asked, 0)
  assert.equal((await checkPermission({ autoAllow: ['read'], decide: () => undefined, approve }, req)).allowed, true)
  assert.equal(asked, 1)
})

test('decide never overrides fail-closed: no approver and no decision means denied', async () => {
  assert.equal((await checkPermission({ autoAllow: ['read'], decide: () => undefined }, req)).allowed, false)
})
