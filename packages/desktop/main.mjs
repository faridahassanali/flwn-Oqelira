import { app, BrowserWindow, dialog } from 'electron'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

let host
let origin
async function startHost() {
  host = spawn(process.execPath, ['--import', 'tsx', 'packages/host/src/main.ts'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', OQELIRA_PORT: '0' },
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
      clearTimeout(timer); resolve(message.origin)
    })
  })
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1480, height: 980, minWidth: 800, minHeight: 600,
    backgroundColor: '#fcfbf8', title: 'Oqelira · by Flwn',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  window.webContents.once('did-finish-load', () => process.stdout.write('Oqelira desktop renderer loaded\n'))
  void window.loadURL(origin)
}
// Register lifecycle handlers immediately instead of suspending module evaluation.
void app.whenReady().then(async () => {
  try { origin = await startHost(); createWindow() }
  catch { dialog.showErrorBox('Oqelira could not start', 'The local host could not start. Check your installation and try again.'); app.quit() }
})
app.on('before-quit', () => { if (host?.connected) host.disconnect(); host?.kill() })
app.on('activate', () => { if (origin && BrowserWindow.getAllWindows().length === 0) createWindow() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
