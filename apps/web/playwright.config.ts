import { defineConfig } from '@playwright/test'

// E2E always talks to the mock gateway (SSE) on 9801: the web server
// inherits this variable before it starts and proxies /api there.
// Note: a dev server already running on 3080 is reused as-is.
process.env.W2A_URL ??= 'http://127.0.0.1:9801'

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  reporter: [['list'], ['html', { open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:3080' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:3080',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
