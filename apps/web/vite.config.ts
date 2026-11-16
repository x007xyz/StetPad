import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

// In development the API and the collaboration socket are proxied to the server.
// AIW_API lets a test run point at a server on another port.
const api = process.env.AIW_API ?? '127.0.0.1:8787'
export default defineConfig({
  plugins: [tailwindcss()],
  esbuild: { jsx: 'automatic' },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  server: {
    proxy: {
      '/api': `http://${api}`,
      '/collab': { target: `ws://${api}`, ws: true },
    },
  },
})
