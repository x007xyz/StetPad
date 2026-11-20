import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startServer } from './app'
import { startTelemetry } from './telemetry'

// Standalone entry, for development. The desktop app embeds the server through startServer instead.
const here = dirname(fileURLToPath(import.meta.url))
const stopTelemetry = await startTelemetry()
const server = await startServer({
  dataDir: resolve(process.env.AIW_DATA_DIR ?? join(here, '../../../.data')),
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',
  staticDir: resolve(process.env.AIW_STATIC_DIR ?? join(here, '../../../apps/web/dist')),
  token: process.env.AIW_TOKEN,
  assetDir: process.env.AIW_ASSET_DIR,
  drawioUrl: process.env.AIW_DRAWIO_URL,
  drawioDir: process.env.AIW_DRAWIO_DIR ? resolve(process.env.AIW_DRAWIO_DIR) : undefined,
  assetGraceDays: process.env.AIW_ASSET_GRACE_DAYS ? Number(process.env.AIW_ASSET_GRACE_DAYS) : undefined,
  mcpCommand: { command: join(here, '../node_modules/.bin/tsx'), args: [join(here, 'mcp.ts')] },
})
console.log(`stetpad server on http://127.0.0.1:${server.port}`)
if (!process.env.AIW_TOKEN) console.log(`token: ${server.token}`)
const stop = (): void => void server.close().then(() => stopTelemetry?.()).then(() => process.exit(0))
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
