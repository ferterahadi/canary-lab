import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import path from 'path'

// Vite project for the canary-lab web UI. Build output lands in `dist/` and is
// served by the Fastify server in production. Dev mode proxies /api and /ws to
// the Fastify backend on :7421 (override with CANARY_DEV_API to point the dev
// UI at another running instance, e.g. an installed workspace server).
const apiTarget = process.env.CANARY_DEV_API ?? 'http://127.0.0.1:7421'
const wsTarget = apiTarget.replace(/^http/, 'ws')

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  css: {
    postcss: {
      plugins: [tailwindcss()],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: apiTarget, changeOrigin: true },
      '/mcp': { target: apiTarget, changeOrigin: true },
      '/ws': { target: wsTarget, ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../../dist/apps/web/dist'),
    emptyOutDir: true,
  },
})
