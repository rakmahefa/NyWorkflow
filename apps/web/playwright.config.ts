import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
  ],
  use: { baseURL: 'http://127.0.0.1:3080' },
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:3080',
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
})
