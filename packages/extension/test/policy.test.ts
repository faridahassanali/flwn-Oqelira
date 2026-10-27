import {test} from 'node:test'
import assert from 'node:assert/strict'
import {foundryEndpoint,secretName} from '../src/policy.js'
test('credentials are bound to a validated Foundry origin; arbitrary workspace endpoints are rejected',()=>{
  assert.equal(foundryEndpoint('https://fixture.openai.azure.com/'),'https://fixture.openai.azure.com/openai/v1')
  assert.equal(secretName('https://fixture.openai.azure.com/openai/v1'),'oqelira.foundry:https://fixture.openai.azure.com')
  for(const url of ['http://fixture.openai.azure.com','https://attacker.test','https://fixture.openai.azure.com.attacker.test','https://key@fixture.openai.azure.com','https://fixture.openai.azure.com/?key=value'])assert.throws(()=>foundryEndpoint(url))
})
