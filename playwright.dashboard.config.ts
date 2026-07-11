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
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  expect: {
    toHaveScreenshot: {
      pathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}{-projectName}{ext}',
    },
  },
  projects: [
    {
      name: 'dashboard-chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
