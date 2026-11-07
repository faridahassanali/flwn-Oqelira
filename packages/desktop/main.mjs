import { app, BrowserWindow, dialog, session } from 'electron'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

const canvasColor = readFileSync(new URL('../ui/src/tokens.css', import.meta.url), 'utf8').match(/--cream:\s*(#[a-f\d]{6})/i)?.[1]

let host
let origin
// Fresh secret per launch: the host refuses any request that lacks it, so only this app can use it.
const launchToken = randomBytes(32).toString('hex')
async function startHost() {
  host = spawn(process.execPath, ['--import', 'tsx', 'packages/host/src/main.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OQELIRA_PORT: '0', OQELIRA_LAUNCH_TOKEN: launchToken },
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
  const window = new BrowserWindow({
    width: 1480, height: 980, minWidth: 800, minHeight: 600,
    backgroundColor: canvasColor, title: 'Oqelira · by Flwn',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.once('did-finish-load', () => process.stdout.write('Oqelira desktop renderer loaded\n'))
  void window.loadURL(origin)
}
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
