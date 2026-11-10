import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGatewayStore, gatewayUrl } from '../gateway-store.mjs'

const fake = (available = true, backend = 'gnome_libsecret') => ({
  isEncryptionAvailable: () => available,
  getSelectedStorageBackend: () => backend,
  encryptString: s => Buffer.from('ENC:' + [...s].reverse().join('')),
  decryptString: b => [...b.toString().slice(4)].reverse().join(''),
})
const setup = (safe = fake()) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-')); return { dir, store: createGatewayStore({ dir, safeStorage: safe, fs }) } }

test('saves encrypted, never plain text, and round-trips for the main process', () => {
  const { dir, store } = setup()
  store.save('https://gw.example.com/', '  secret-token-123 ')
  const raw = fs.readFileSync(path.join(dir, 'gateway.json'), 'utf8')
  assert.ok(!raw.includes('secret-token-123'))
  assert.deepEqual(store.status(), { configured: true, url: 'https://gw.example.com' })
  assert.deepEqual(store.env(), { OQELIRA_GATEWAY_URL: 'https://gw.example.com', OQELIRA_GATEWAY_TOKEN: 'secret-token-123' })
})

test('refuses to save when encryption is unavailable or weak', () => {
  for (const safe of [fake(false), fake(true, 'basic_text')]) {
    const { dir, store } = setup(safe)
    assert.throws(() => store.save('https://gw.example.com', 'tok'), /Secure storage is not available/)
    assert.equal(fs.existsSync(path.join(dir, 'gateway.json')), false)
  }
})

test('url validation matches the engine', () => {
  assert.equal(gatewayUrl('http://localhost:8080'), 'http://localhost:8080')
  for (const bad of ['http://gw.example.com', 'https://u:p@gw.example.com', 'https://gw.example.com/?a=1', 'ftp://x', 'nope']) assert.throws(() => gatewayUrl(bad), undefined, bad)
  const { store } = setup()
  assert.throws(() => store.save('http://gw.example.com', 'tok'))
  assert.throws(() => store.save('https://gw.example.com', '  '))
  assert.equal(store.status().configured, false)
})

test('clear removes the file and the configuration', () => {
  const { dir, store } = setup()
  store.save('https://gw.example.com', 'tok')
  store.clear(); store.clear()
  assert.equal(fs.existsSync(path.join(dir, 'gateway.json')), false)
  assert.deepEqual(store.status(), { configured: false })
  assert.equal(store.env(), undefined)
})
