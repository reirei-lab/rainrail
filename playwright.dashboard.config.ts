import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/dashboard',
  outputDir: 'test-results/dashboard',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report/dashboard', open: 'never' }],
  ],
  use: {
    baseURL: 'http://127.0.0.1:8787',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'pnpm demo:dashboard',
    url: 'http://127.0.0.1:8787/en/dashboard?demo=1',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: 'dashboard-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
