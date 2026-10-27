import { app, BrowserWindow } from 'electron'
import { fileURLToPath } from 'node:url'

function createWindow() {
  const window = new BrowserWindow({
    width: 1480, height: 980, minWidth: 800, minHeight: 600,
    backgroundColor: '#fcfbf8', title: 'Oqelira · by Flwn',
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', event => event.preventDefault())
  void window.loadFile(fileURLToPath(new URL('../web/dist/index.html', import.meta.url)))
}
await app.whenReady()
createWindow()
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
