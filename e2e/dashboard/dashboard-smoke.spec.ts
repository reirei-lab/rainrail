import { expect, test } from '@playwright/test';

import { startDashboardDemoServerHarness } from '../../scripts/dashboard-demo-server-harness.mjs';

let dashboardBaseUrl = '';
let cleanupDashboardDemoServer: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
  const harness = await startDashboardDemoServerHarness();
  dashboardBaseUrl = harness.baseUrl;
  cleanupDashboardDemoServer = harness.cleanup;
});

test.afterAll(async () => {
  await cleanupDashboardDemoServer?.();
});

test('loads the seeded dashboard demo and navigates core records', async ({ page }) => {
  await page.goto(`${dashboardBaseUrl}/en/dashboard?demo=1`);

  await expect(page.getByRole('heading', { level: 1, name: /Rainrail Operations/i })).toBeVisible();
  await expect(page.locator('[data-demo-indicator]')).toBeVisible();
  await expect(page.locator('[data-status-text]')).toContainText(/Live operational state/i);
  await expect(page.locator('[data-dashboard-stats] strong').first()).not.toHaveText('0');

  await page.locator('[data-dashboard-tab="events"]').click();
  await expect(page.locator('[data-dashboard-list] button').first()).toBeVisible();
  await page.locator('[data-dashboard-list] button').first().click();
  await expect(page.locator('[data-dashboard-detail]')).toContainText(/github|manual|cloudflare|system/i);
});
