import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './app'
import { startTelemetry } from './telemetry'

// Standalone entry: the web deployment, and local development.
const here = dirname(fileURLToPath(import.meta.url))
const stopTelemetry = await startTelemetry()
const mode = process.env.AIW_MODE === 'local' ? 'local' : 'web'
const server = await startServer({
  mode,
  dataDir: resolve(process.env.AIW_DATA_DIR ?? join(here, '../../../.data')),
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  staticDir: resolve(process.env.AIW_STATIC_DIR ?? join(here, '../../../apps/web/dist')),
  token: process.env.AIW_TOKEN,
  databaseUrl: process.env.DATABASE_URL,
  dailyTokenLimit: Number(process.env.AIW_DAILY_TOKEN_LIMIT ?? 0),
  mcpCommand: { command: join(here, '../node_modules/.bin/tsx'), args: [join(here, 'mcp.ts')] },
})
console.log(`stetpad server (${mode}) on http://127.0.0.1:${server.port}`)
if (mode === 'local' && !process.env.AIW_TOKEN) console.log(`token: ${server.token}`)
const stop = (): void => void server.close().then(() => stopTelemetry?.()).then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
