/// <reference types="vitest/config" />
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Port 3080 — same as deepseek-harness web UI.
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 3080 },
  test: { environment: 'node' },
})
