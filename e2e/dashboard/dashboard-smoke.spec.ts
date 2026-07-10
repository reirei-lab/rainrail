import { expect, test, type Locator } from '@playwright/test';

import { startDashboardDemoServerHarness } from '../../scripts/dashboard-demo-server-harness.mjs';
import { dashboardDemoVrtScenarios } from '../../scripts/dashboard-demo-vrt-scenarios.mjs';

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

type ScenarioExpectation = {
  rows: readonly string[];
  excludedRows?: readonly string[];
  detail: readonly string[];
  controls?: readonly { selector: string; value: string }[];
};

const scenarioExpectations: Record<string, ScenarioExpectation> = {
  'overview-demo-summary': {
    rows: [
      'Started dashboard demo seed task for issue #272',
      'Seed dashboard demo SQLite DB',
    ],
    detail: ['Codex activity timeline recorded implementation, tests, and PR creation phases'],
  },
  'events-handler-retry-detail': {
    rows: [
      'github.issue reirei-lab/rainrail#272',
      'gh-delivery-demo-001',
    ],
    excludedRows: ['Synthetic timeout while posting a webhook preview'],
    detail: [
      'agent-assignment-dispatch',
      'Demo dispatcher is waiting for capacity',
    ],
    controls: [
      { selector: '[data-event-source-filter]', value: 'github' },
    ],
  },
  'workflow-runs-failed-retry': {
    rows: [
      'Cloudflare tail issue report failed and scheduled retry',
      'failed',
    ],
    excludedRows: [
      'Started dashboard demo seed task for issue #272',
      'Ignored a non-command chat message after classification',
    ],
    detail: [
      'act_demo_workflow_failed_retry',
      'evt_demo_cloudflare_tail_001',
      'cloudflare_tail_issue_report',
      'failed',
    ],
  },
  'agent-tasks-running-actions': {
    rows: [
      'Seed dashboard demo SQLite DB',
      'running',
    ],
    detail: [
      'agent_task_demo_running',
      'resume-demo-001',
      'agent:demo:dashboard-running',
      '4242',
    ],
  },
  'sources-last-deliveries': {
    rows: [
      'github-webhook',
      'cloudflare-tail',
      'manual-chat',
      'gh-delivery-demo-001',
      'cf-tail-demo-001',
      'chat-delivery-demo-001',
    ],
    detail: ['github-webhook'],
  },
  'queue-blocked-stale-claim': {
    rows: [
      'Investigate flaky Cloudflare tail reporter',
      'blocked',
      'stale demo project claim',
    ],
    excludedRows: ['Seed dashboard demo SQLite DB'],
    detail: [
      'agent_task_demo_failed_stale_claim',
      'stale demo project claim',
      'item-demo-125',
    ],
  },
  'settings-retry-auth': {
    rows: [
      'Retry policy',
      'Dashboard auth',
      '2 retries pending',
      'not configured',
    ],
    detail: [
      'Max concurrency',
      '1 task',
    ],
  },
};

const seededTabScenarios = dashboardDemoVrtScenarios.filter(
  (scenario) => scenario.id in scenarioExpectations,
);

for (const scenario of seededTabScenarios) {
  test(`renders seeded dashboard scenario: ${scenario.id}`, async ({ page }) => {
    const url = new URL(scenario.url, dashboardBaseUrl);
    await page.goto(url.href);

    await expect(page.locator('[data-demo-indicator]')).toBeVisible();
    await expect(page.locator(`[data-dashboard-tab="${scenario.tab}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-status-text]')).toContainText(/Live operational state|運用状態/i);

    const expectations = scenarioExpectations[scenario.id]!;
    const list = page.locator('[data-dashboard-list]');
    await expect(list.locator('button').first()).toBeVisible();
    for (const rowText of expectations.rows) {
      await expect(list).toContainText(rowText);
    }
    for (const rowText of expectations.excludedRows ?? []) {
      await expect(list).not.toContainText(rowText);
    }
    for (const control of expectations.controls ?? []) {
      await expect(page.locator(control.selector)).toHaveValue(control.value);
    }

    const detail = page.locator('[data-dashboard-detail]');
    for (const detailText of expectations.detail) {
      await expect(detail).toContainText(detailText);
    }
  });
}

test('keeps sidebar tabs clickable before operational data is loaded', async ({ page }) => {
  let apiRequests = 0;
  await page.route('**/api/v1/**', async (route) => {
    apiRequests += 1;
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
      const apiRequestsBeforeNavigation = apiRequests;
      await page.goto(`${dashboardBaseUrl}/en/dashboard?demo=1`);

      await expect(page.getByRole('heading', { level: 1, name: /Rainrail Operations/i })).toBeVisible();
      await expect(page.locator('[data-token-input]')).toHaveValue('');
      expect(await page.evaluate(() => sessionStorage.getItem('rainrail-dashboard-token'))).toBeNull();
      await expect(page.locator('[data-status-text]')).toContainText(/Operational API unavailable/i);
      expect(apiRequests).toBeGreaterThan(apiRequestsBeforeNavigation);
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
