import { contextBridge } from 'electron'

// The page gets exactly two things: the token for the local service and the platform name.
const arg = process.argv.find((a) => a.startsWith('--aiw='))
contextBridge.exposeInMainWorld('aiw', arg ? JSON.parse(arg.slice('--aiw='.length)) : null)
