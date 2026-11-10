const { contextBridge, ipcRenderer } = require('electron')
// The renderer can set or clear the gateway and ask whether it is configured. It can never read the token.
contextBridge.exposeInMainWorld('oqeliraDesktop', {
  gateway: {
    status: () => ipcRenderer.invoke('gateway:status'),
    save: (url, token) => ipcRenderer.invoke('gateway:save', url, token),
    clear: () => ipcRenderer.invoke('gateway:clear'),
  },
})
