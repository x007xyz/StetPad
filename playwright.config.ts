import { defineConfig, devices } from '@playwright/test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export default defineConfig({
  testDir: './e2e',
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:8797',
    locale: 'zh-CN',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm --dir apps/web build && pnpm --dir packages/server start',
    url: 'http://127.0.0.1:8797/?token=dev',
    timeout: 120_000,
    reuseExistingServer: false,
    env: { PORT: '8797', AIW_TOKEN: 'dev', AIW_DATA_DIR: mkdtempSync(join(tmpdir(), 'stetpad-e2e-')) },
  },
})
