/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { nyworkflowServerPlugin } from './src/server/plugin.ts'

// Port 3080 — same as deepseek-harness web UI.
// The gateway (@nyworkflow/webapi — pnpm webapi, default 127.0.0.1:8081) is
// reached same-origin through /api: no CORS, whatever the target (our
// gateway, or any OpenAI-compatible server via W2A_URL).
const proxy = {
  '/api': {
    target: process.env.W2A_URL ?? 'http://127.0.0.1:8081',
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
