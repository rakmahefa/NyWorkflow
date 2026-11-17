/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nyworkflowServerPlugin } from './src/server/plugin.ts'

// Port 3080 — same as deepseek-harness web UI.
// The gateway is now EMBEDDED in the dev/preview server (M8, server/embed.ts):
// whatever NYW_WEBAPI_HOST/PORT says, the /api proxy follows. W2A_URL still
// wins to target any other OpenAI-compatible server (e.g. the e2e mock).
const gatewayPort = process.env.NYW_WEBAPI_PORT ?? '8081'
const gatewayHost = process.env.NYW_WEBAPI_HOST === '0.0.0.0' ? '127.0.0.1' : (process.env.NYW_WEBAPI_HOST ?? '127.0.0.1')
const proxy = {
  '/api': {
    target: process.env.W2A_URL ?? `http://${gatewayHost}:${gatewayPort}`,
    changeOrigin: true,
    rewrite: (p: string) => p.replace(/^\/api/, ''),
  },
}

export default defineConfig({
  plugins: [react(), nyworkflowServerPlugin()],
  server: { host: '127.0.0.1', port: 3080, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
