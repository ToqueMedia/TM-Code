// MONOREPO layout: vite.config.ts is one level deeper than .env, so envDir
// MUST point at the project root or import.meta.env.VITE_* will all be undefined.
// (See `auth-proxy` skill for the FLAT vs MONOREPO classification rule.)
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  envDir: path.resolve(__dirname, '..'),
  plugins: [react()],
  server: {
    // The Vite dev proxy is the ONLY way /api/* leaves port 5173 to reach the
    // backend. Without this, every fetch('/api/...') hits Vite and returns
    // 404 HTML — CORS headers on the backend are NOT a substitute.
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
})
