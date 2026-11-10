import path from 'node:path'

/** Same rule as the engine: https, or http only for localhost; no credentials, query or fragment. */
export function gatewayUrl(value) {
  let url
  try { url = new URL(String(value).trim()) } catch { throw new Error('Enter a valid gateway URL') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTPS gateway URL without credentials')
  return (url.origin + url.pathname).replace(/\/+$/, '')
}

/**
 * Gateway URL (plain) and token (encrypted with the OS keychain via Electron safeStorage) in one file under
 * the app's user-data directory, never the project. `safeStorage` and `fs` are injected so this runs without Electron.
 */
export function createGatewayStore({ dir, safeStorage, fs }) {
  const file = path.join(dir, 'gateway.json')
  // On Linux without a keyring Electron falls back to a hard-coded key ('basic_text'): that is not protection.
  const canEncrypt = () => safeStorage.isEncryptionAvailable() && safeStorage.getSelectedStorageBackend?.() !== 'basic_text'
  const read = () => {
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf8'))
      return typeof value?.url === 'string' && typeof value?.token === 'string' ? value : undefined
    } catch { return undefined }
  }
  return {
    /** All the renderer may learn: whether it is set and the non-secret URL. */
    status() { const v = read(); return v ? { configured: true, url: v.url } : { configured: false } },
    save(url, token) {
      if (!canEncrypt()) throw new Error('Secure storage is not available on this computer, so the token was not saved')
      const clean = gatewayUrl(url)
      if (typeof token !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(token.trim())) throw new Error('Enter your gateway token')
      fs.mkdirSync(dir, { recursive: true })
      const encrypted = safeStorage.encryptString(token.trim()).toString('base64')
      fs.writeFileSync(file, JSON.stringify({ url: clean, token: encrypted }), { mode: 0o600 })
    },
    clear() { fs.rmSync(file, { force: true }) },
    /** Main process only: environment variables for the host/engine, or undefined when not configured. */
    env() {
      const v = read()
      if (!v) return undefined
      try { return { OQELIRA_GATEWAY_URL: v.url, OQELIRA_GATEWAY_TOKEN: safeStorage.decryptString(Buffer.from(v.token, 'base64')) } } catch { return undefined }
    },
  }
}
