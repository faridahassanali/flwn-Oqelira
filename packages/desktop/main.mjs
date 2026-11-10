import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import fs, { readFileSync } from 'node:fs'
import { createGatewayStore } from './gateway-store.mjs'

const canvasColor = readFileSync(new URL('../ui/src/tokens.css', import.meta.url), 'utf8').match(/--cream:\s*(#[a-f\d]{6})/i)?.[1]

let host
let window
// Token is encrypted at rest and only ever decrypted here, to put it in the host's environment (never a file, never the renderer).
const gateway = createGatewayStore({ dir: app.getPath('userData'), safeStorage, fs })
let origin
// The gateway settings bridge exists only for the local host this app starts itself. A remote server URL gets no preload.
const localHost = !process.env.OQELIRA_DESKTOP_SERVER_URL
// Fresh secret per launch: the host refuses any request that lacks it, so only this app can use it.
const launchToken = randomBytes(32).toString('hex')
async function startHost() {
  host = spawn(process.execPath, ['--import', 'tsx', 'packages/host/src/main.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, ...gateway.env(), ELECTRON_RUN_AS_NODE: '1', OQELIRA_PORT: '0', OQELIRA_LAUNCH_TOKEN: launchToken },
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true,
  })
  // Do not display provider diagnostics or environment values in the renderer.
  host.stderr?.resume()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { host.kill(); reject(new Error('Local host did not start in time')) }, 20000)
    host.once('error', error => { clearTimeout(timer); reject(error) })
    host.once('exit', () => { clearTimeout(timer); reject(new Error('Local host stopped')) })
    host.on('message', message => {
      if (message?.type !== 'ready' || typeof message.origin !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(message.origin)) return
      clearTimeout(timer)
      session.defaultSession.webRequest.onBeforeSendHeaders({ urls: [`${message.origin}/*`] }, (details, callback) => callback({ requestHeaders: { ...details.requestHeaders, 'X-Oqelira-Launch': launchToken } }))
      resolve(message.origin)
    })
  })
}

function createWindow() {
  window = new BrowserWindow({
    width: 1480, height: 980, minWidth: 800, minHeight: 600,
    backgroundColor: canvasColor, title: 'Oqelira · by Flwn',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, ...(localHost ? { preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)) } : {}) },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.once('did-finish-load', () => process.stdout.write('Oqelira desktop renderer loaded\n'))
  void window.loadURL(origin)
}
// Settings calls are accepted only from our own window, and answer "configured: yes/no" plus the non-secret URL.
// Accept settings calls only when the local host is shown, and only from the window's top frame at exactly that origin
// (no subframes, no other origin that merely starts with the same text).
const trusted = event => {
  if (!localHost || !origin || !window || event.senderFrame !== window.webContents.mainFrame) return false
  try { return new URL(event.senderFrame.url).origin === origin } catch { return false }
}
async function restartHost() {
  if (process.env.OQELIRA_DESKTOP_SERVER_URL) return
  host?.removeAllListeners('exit'); host?.disconnect?.(); host?.kill()
  origin = await startHost()
  void window?.loadURL(origin)
}
ipcMain.handle('gateway:status', event => { if (!trusted(event)) throw new Error('Not allowed'); return gateway.status() })
ipcMain.handle('gateway:save', async (event, url, token) => {
  if (!trusted(event)) throw new Error('Not allowed')
  gateway.save(url, token)
  await restartHost()
  return gateway.status()
})
ipcMain.handle('gateway:clear', async event => {
  if (!trusted(event)) throw new Error('Not allowed')
  gateway.clear()
  await restartHost()
  return gateway.status()
})
// Register lifecycle handlers immediately instead of suspending module evaluation.
void app.whenReady().then(async () => {
  try {
    const cloud = process.env.OQELIRA_DESKTOP_SERVER_URL
    if (cloud) {
      const target = new URL(cloud)
      if ((target.protocol !== 'https:' && !(target.protocol === 'http:' && ['127.0.0.1','localhost'].includes(target.hostname))) || target.username || target.password || target.pathname !== '/' || target.search || target.hash) throw new Error('Use an HTTPS server origin')
      origin = target.origin
    } else origin = await startHost()
    createWindow()
  }
  catch { dialog.showErrorBox('Oqelira could not start', 'The local host could not start. Check your installation and try again.'); app.quit() }
})
app.on('before-quit', () => { if (host?.connected) host.disconnect(); host?.kill() })
app.on('activate', () => { if (origin && BrowserWindow.getAllWindows().length === 0) createWindow() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
