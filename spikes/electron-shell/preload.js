const { contextBridge } = require('electron')
const arg = process.argv.find((a) => a.startsWith('--svc='))
contextBridge.exposeInMainWorld('svc', arg ? JSON.parse(arg.slice('--svc='.length)) : null)
