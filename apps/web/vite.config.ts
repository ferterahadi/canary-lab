import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/postcss'
import path from 'path'

// Vite project for the canary-lab web UI. Build output lands in `dist/` and is
// served by the Fastify server in production. Dev mode proxies /api and /ws to
// the Fastify backend on :7421.
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
      '/api': { target: 'http://127.0.0.1:7421', changeOrigin: true },
      '/ws': { target: 'ws://127.0.0.1:7421', ws: true, changeOrigin: true },
    },
  },
  build: {
    outDir: path.resolve(__dirname, '../../dist/apps/web/dist'),
    emptyOutDir: true,
  },
})
