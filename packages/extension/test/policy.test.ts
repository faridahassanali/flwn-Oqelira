import {test} from 'node:test'
import assert from 'node:assert/strict'
import {foundryEndpoint,secretName} from '../src/policy.js'
test('credentials are bound to a validated Foundry origin; arbitrary workspace endpoints are rejected',()=>{
  assert.equal(foundryEndpoint('https://fixture.openai.azure.com/'),'https://fixture.openai.azure.com/openai/v1')
  assert.equal(secretName('https://fixture.openai.azure.com/openai/v1'),'oqelira.foundry:https://fixture.openai.azure.com')
  for(const url of ['http://fixture.openai.azure.com','https://attacker.test','https://fixture.openai.azure.com.attacker.test','https://key@fixture.openai.azure.com','https://fixture.openai.azure.com/?key=value'])assert.throws(()=>foundryEndpoint(url))
})
import {engineEnv,proposedContent} from '../src/policy.js'
const setup={endpoint:'https://fixture.openai.azure.com/',model:{id:'dep',deployment:'dep',api:'chat' as const,speed:'fast'}}
test('engine environment: key and model come from setup, stray FOUNDRY_/OQELIRA_ variables from the host process are dropped',()=>{
  const env=engineEnv({PATH:'/bin',FOUNDRY_KEY:'old',FOUNDRY_BASE_URL:'https://attacker.test',OQELIRA_MODEL:'x',OQELIRA_NO_ENV_FILES:'0',OQELIRA_EMBEDDING_DEPLOYMENT:'emb',TAVILY_API_KEY:'t'},setup,'secret')
  assert.equal(env.FOUNDRY_KEY,'secret')
  assert.equal(env.FOUNDRY_BASE_URL,'https://fixture.openai.azure.com/openai/v1')
  assert.equal(env.OQELIRA_MODEL,'dep')
  assert.deepEqual(JSON.parse(env.OQELIRA_MODELS_JSON!),[setup.model])
  assert.equal(env.ELECTRON_RUN_AS_NODE,'1')
  assert.equal(env.PATH,'/bin')
  assert.equal(env.OQELIRA_EMBEDDING_DEPLOYMENT,'emb')
  assert.equal(env.TAVILY_API_KEY,'t')
  assert.equal(env.OQELIRA_NO_ENV_FILES,undefined)
  assert.throws(()=>engineEnv({},{...setup,endpoint:'https://attacker.test'},'k'))
})
test('proposed content for the native diff matches what the tool would write',()=>{
  assert.equal(proposedContent('write_file',{path:'a',content:'new'},'old'),'new')
  assert.equal(proposedContent('apply_file_change',{path:'a',content:null},'old'),null)
  assert.equal(proposedContent('edit_file',{path:'a',old_string:'b',new_string:'X'},'abc'),'aXc')
  assert.equal(proposedContent('edit_file',{path:'a',old_string:'b',new_string:'X'},'abcb'),undefined,'ambiguous edit: the tool refuses it, so no preview')
  assert.equal(proposedContent('edit_file',{path:'a',old_string:'z',new_string:'X'},'abc'),undefined)
  assert.equal(proposedContent('run_command',{command:'ls'},null),undefined)
})
