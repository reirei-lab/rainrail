import { expect, test, type Locator } from '@playwright/test';

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

test('keeps sidebar tabs clickable before operational data is loaded', async ({ page }) => {
  await page.route('**/api/v1/**', async (route) => {
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'operational_store_unavailable' }),
    });
  });

  const viewports = [
    { name: 'desktop', width: 1280, height: 900 },
    { name: 'narrow', width: 390, height: 844 },
  ];
  const tabNames = [
    'overview',
    'events',
    'workflow-runs',
    'agent-tasks',
    'sources',
    'queue',
    'settings',
  ];

  for (const viewport of viewports) {
    await test.step(viewport.name, async () => {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto(`${dashboardBaseUrl}/en/dashboard`);

      await expect(page.getByRole('heading', { level: 1, name: /Rainrail Operations/i })).toBeVisible();
      await expect(page.locator('[data-token-input]')).toHaveValue('');
      expect(await page.evaluate(() => sessionStorage.getItem('rainrail-dashboard-token'))).toBeNull();
      await expect(page.locator('[data-status-text]')).toContainText(/Operational API unavailable/i);
      await expect(page.locator('[data-dashboard-list]')).toBeEmpty();

      for (const tabName of tabNames) {
        const tab = page.locator(`[data-dashboard-tab="${tabName}"]`);
        await expect(tab).toBeVisible();
        await expect(tab).toBeEnabled();
        await expectActiveHitTarget(tab);

        await tab.click();
        await expect(tab).toHaveAttribute('aria-pressed', 'true');

        for (const otherTabName of tabNames.filter((candidate) => candidate !== tabName)) {
          await expect(page.locator(`[data-dashboard-tab="${otherTabName}"]`)).toHaveAttribute('aria-pressed', 'false');
        }
      }
    });
  }
});

async function expectActiveHitTarget(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const isActiveHitTarget = await locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const target = document.elementFromPoint(centerX, centerY);
    return target === element || element.contains(target);
  });
  expect(isActiveHitTarget).toBe(true);
}
