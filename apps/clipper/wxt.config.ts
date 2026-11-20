import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'wxt'

export default defineConfig({
  manifestVersion: 3,
  vite: () => ({
    plugins: [react(), tailwindcss()],
  }),
  manifest: ({ browser }) => ({
    name: 'Stetpad Web Clipper',
    description: '剪藏网页正文与选区到 Stetpad，保留清洁排版、转存图片，并由 AI 生成待确认的修订建议。',
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus'],
    host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      96: 'icon/96.png',
      128: 'icon/128.png',
    },
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Alt+Shift+S',
          mac: 'Alt+Shift+S',
        },
        description: '打开 Stetpad 剪藏器',
      },
    },
    ...(browser === 'firefox'
      ? {
          browser_specific_settings: {
            gecko: {
              id: 'clipper@stetpad.app',
              strict_min_version: '128.0',
              data_collection_permissions: {
                required: ['none'],
              },
            } as Record<string, unknown>,
          },
        }
      : {}),
  }),
})
