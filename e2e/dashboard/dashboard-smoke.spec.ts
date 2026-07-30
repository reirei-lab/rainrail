import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

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

test('drops legacy tab query when navigating to a routed dashboard view', async ({ page }) => {
  await page.goto(`${dashboardBaseUrl}/en/dashboard?demo=1&tab=events`);

  await page.locator('[data-dashboard-tab="workflow-runs"]').click();

  await expect(page).toHaveURL(/\/en\/dashboard\/runs\?demo=1$/);
  await expect(page.locator('[data-dashboard-tab="workflow-runs"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-dashboard-tab="workflow-runs"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-dashboard-tab="events"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-dashboard-list]')).toContainText('Cloudflare tail issue report failed and scheduled retry');
});

test('keeps legacy Event Inbox filter deep links working without overview filter controls', async ({ page }) => {
  await page.goto(`${dashboardBaseUrl}/en/dashboard?demo=1&tab=events&source=github&name=github.issue&event=evt_demo_github_issue_272`);

  await expect(page.locator('[data-dashboard-tab="events"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-event-source-filter]')).toHaveCount(0);
  await expect(page.locator('[data-dashboard-list]')).toContainText('github.issue reirei-lab/rainrail#272');
  await expect(page.locator('[data-dashboard-list]')).not.toContainText('Synthetic timeout while posting a webhook preview');
  await expect(page.locator('[data-dashboard-detail]')).toContainText('evt_demo_github_issue_272');
});

test('prefers routed dashboard view over legacy tab query on initial load', async ({ page }) => {
  await page.goto(`${dashboardBaseUrl}/en/dashboard/runs?demo=1&tab=events`);

  await expect(page).toHaveURL(/\/en\/dashboard\/runs\?demo=1&tab=events$/);
  await expect(page.locator('[data-dashboard-tab="workflow-runs"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-dashboard-tab="workflow-runs"]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-dashboard-tab="events"]')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('[data-dashboard-list]')).toContainText('Cloudflare tail issue report failed and scheduled retry');
  await expect(page.locator('[data-dashboard-list]')).not.toContainText('github.issue reirei-lab/rainrail#272');
});

test('keeps the legacy workflow-runs route as a routed Runs alias', async ({ page }) => {
  await page.goto(`${dashboardBaseUrl}/en/dashboard/workflow-runs?demo=1&status=failed&run=act_demo_workflow_failed_retry`);

  await expect(page.locator('[data-dashboard-tab="workflow-runs"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('[data-dashboard-list]')).toContainText('Cloudflare tail issue report failed and scheduled retry');
  await expect(page.locator('[data-dashboard-detail]')).toContainText('evt_demo_cloudflare_tail_001');
});

type ScenarioExpectation = {
  rows: readonly string[];
  excludedRows?: readonly string[];
  detail: readonly string[];
  controls?: readonly { selector: string; value: string }[];
};

type ScenarioCapture = {
  id: string;
  tab: string;
  url: string;
  viewport: 'desktop' | 'mobile';
  captureHints: readonly string[];
  screenshot: string;
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
      'evt_demo_github_issue_272',
      'evt_demo_cloudflare_tail_001',
      'evt_demo_manual_chat_001',
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

test('captures dashboard demo screenshots from the scenario manifest', async ({ page }) => {
  const screenshotDir = join(process.cwd(), 'test-results', 'dashboard', 'screenshots');
  await mkdir(screenshotDir, { recursive: true });

  const captures: ScenarioCapture[] = [];

  for (const scenario of dashboardDemoVrtScenarios) {
    const viewport = scenario.viewport ?? 'desktop';
    await test.step(`${scenario.id} (${viewport})`, async () => {
      await page.setViewportSize(viewport === 'mobile'
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 });

      const url = new URL(scenario.url, dashboardBaseUrl);
      await page.goto(url.href);

      await expect(page.getByRole('heading', { level: 1, name: /Rainrail (Operations|運用)/i })).toBeVisible();
      await expect(page.locator('[data-demo-indicator]')).toBeVisible();
      await expect(page.locator(`[data-dashboard-tab="${scenario.tab}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-status-text]')).toContainText(/Live operational state|運用状態/i);

      const expectations = scenarioExpectations[scenario.id];
      if (expectations !== undefined) {
        const list = page.locator('[data-dashboard-list]');
        await expect(list.locator('button').first()).toBeVisible();
        for (const rowText of expectations.rows) {
          await expect(list).toContainText(rowText);
        }
        for (const detailText of expectations.detail) {
          await expect(page.locator('[data-dashboard-detail]')).toContainText(detailText);
        }
      } else {
        await expect(page.locator('[data-dashboard-layout-grid]')).toBeVisible();
        await expect(page.locator('[data-card-picker-list]')).not.toBeEmpty();
      }

      const screenshotFileName = `${scenario.id}-${viewport}.png`;
      const screenshotPath = join(screenshotDir, screenshotFileName);
      await page.screenshot({ path: screenshotPath, fullPage: true });
      await expect.poll(async () => (await stat(screenshotPath)).size).toBeGreaterThan(1024);

      captures.push({
        id: scenario.id,
        tab: scenario.tab,
        url: scenario.url,
        viewport,
        captureHints: scenario.captureHints,
        screenshot: screenshotFileName,
      });
    });
  }

  await writeFile(
    join(screenshotDir, 'dashboard-demo-screenshot-manifest.json'),
    `${JSON.stringify({ captures }, null, 2)}\n`,
  );
  expect(captures).toHaveLength(dashboardDemoVrtScenarios.length);
});

test('matches dashboard route visual baselines from the scenario manifest', async ({ page }) => {
  for (const scenario of dashboardDemoVrtScenarios) {
    const viewport = scenario.viewport ?? 'desktop';
    await test.step(`${scenario.id} (${viewport})`, async () => {
      await page.setViewportSize(viewport === 'mobile'
        ? { width: 390, height: 844 }
        : { width: 1440, height: 1000 });

      const url = new URL(scenario.url, dashboardBaseUrl);
      await page.goto(url.href);

      await expect(page.getByRole('heading', { level: 1, name: /Rainrail (Operations|運用)/i })).toBeVisible();
      await expect(page.locator('[data-demo-indicator]')).toBeVisible();
      await expect(page.locator(`[data-dashboard-tab="${scenario.tab}"]`)).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('[data-status-text]')).toContainText(/Live operational state|運用状態/i);

      await expect(page).toHaveScreenshot(`${scenario.id}-${viewport}.png`, {
        maxDiffPixelRatio: 0.04,
        mask: [
          page.locator('[data-status-text]'),
          page.locator('[data-overview-card-id="apiStatus"]'),
          page.locator('[data-overview-card-id="health"]'),
        ],
      });
    });
  }
});

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

test('persists Overview custom card visibility and ordering across reloads', async ({ page }) => {
  await page.goto(`${dashboardBaseUrl}/en/dashboard?demo=1`);

  const board = page.locator('[data-overview-card-board]');
  const controls = page.locator('[data-overview-card-controls]');
  await expect(board.locator('[data-overview-card-id="apiStatus"]')).toBeVisible();
  await expect(board.locator('[data-overview-card-id="health"]')).toBeVisible();
  await expect(board.locator('[data-overview-card-id="counts"]')).toBeVisible();

  await overviewCardControl(controls, 'Counts').getByRole('checkbox').uncheck();
  await overviewCardControl(controls, 'Warnings').getByRole('button', { name: 'Move up' }).click();

  await expect(board.locator('[data-overview-card-id="counts"]')).toHaveCount(0);
  await expect(board.locator('[data-overview-card-id]').first()).toHaveAttribute('data-overview-card-id', 'apiStatus');
  await expect(board.locator('[data-overview-card-id]').nth(1)).toHaveAttribute('data-overview-card-id', 'health');
  await expect(board.locator('[data-overview-card-id]').nth(2)).toHaveAttribute('data-overview-card-id', 'warnings');

  await page.reload();

  await expect(page.locator('[data-demo-indicator]')).toBeVisible();
  await expect(board.locator('[data-overview-card-id="counts"]')).toHaveCount(0);
  await expect(board.locator('[data-overview-card-id]').first()).toHaveAttribute('data-overview-card-id', 'apiStatus');
  await expect(board.locator('[data-overview-card-id]').nth(1)).toHaveAttribute('data-overview-card-id', 'health');
  await expect(board.locator('[data-overview-card-id]').nth(2)).toHaveAttribute('data-overview-card-id', 'warnings');
  await expect.poll(async () => page.evaluate(() => window.localStorage.getItem('rainrail-dashboard-overview-card-layout')))
    .toContain('"id":"warnings"');
});

test('updates the API Status Tile while overview is slow and unavailable', async ({ page }) => {
  const lastSuccessAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  let overviewCompleted = false;
  let overviewRequests = 0;
  let statusRequests = 0;

  await page.route('**/api/v1/dashboard/status**', async (route) => {
    statusRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          status: overviewCompleted ? 'degraded' : 'ok',
          runtime: 'node',
          store: { status: 'configured' },
          overview: overviewCompleted ? {
            status: 'error',
            lastAttemptAt: new Date().toISOString(),
            lastSuccessAt,
            lastDurationMs: 1200,
            lastHttpStatus: 503,
            lastError: {
              code: 'operational_store_unavailable',
              summary: 'Operational store unavailable',
            },
            links: { self: '/api/v1/overview' },
          } : {
            status: 'unknown',
            lastAttemptAt: null,
            lastSuccessAt: null,
            lastDurationMs: null,
            lastHttpStatus: null,
            lastError: null,
            links: { self: '/api/v1/overview' },
          },
          auth: { scope: 'read-only' },
          links: { overview: '/api/v1/overview' },
        },
      }),
    });
  });
  await page.route('**/api/v1/overview**', async (route) => {
    overviewRequests += 1;
    await new Promise((resolve) => setTimeout(resolve, 750));
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'operational_store_unavailable' }),
    });
    overviewCompleted = true;
  });

  await page.goto(`${dashboardBaseUrl}/en/dashboard?demo=1`);

  const apiStatusTile = page.locator('[data-overview-card-id="apiStatus"]');
  await expect(apiStatusTile).toBeVisible();
  await expect(apiStatusTile).toContainText('Degraded');
  await expect(apiStatusTile).toContainText('error');
  await expect(apiStatusTile).toContainText('1200 ms');
  await expect(apiStatusTile).toContainText('5m ago');
  await expect(apiStatusTile).toContainText('read-only');
  await expect(apiStatusTile).toContainText('operational_store_unavailable');
  await expect(page.locator('[data-status-text]')).toContainText(/Operational API unavailable/i);
  expect(statusRequests).toBeGreaterThanOrEqual(2);
  expect(overviewRequests).toBeGreaterThan(0);
});

test('redraws the API Status Tile after clearing an auth-required dashboard token', async ({ page }) => {
  await page.route('**/api/v1/dashboard/status**', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          status: 'ok',
          runtime: 'node',
          store: { status: 'configured' },
          overview: {
            status: 'ok',
            lastAttemptAt: new Date().toISOString(),
            lastSuccessAt: new Date().toISOString(),
            lastDurationMs: 8,
            lastHttpStatus: 200,
            lastError: null,
            links: { self: '/api/v1/overview' },
          },
          auth: { scope: 'operator' },
          links: { overview: '/api/v1/overview' },
        },
      }),
    });
  });

  await page.goto(`${dashboardBaseUrl}/en/dashboard`);
  await page.locator('[data-token-input]').fill('operator-token');
  await page.locator('[data-token-save]').click();

  const apiStatusTile = page.locator('[data-overview-card-id="apiStatus"]');
  await expect(apiStatusTile).toContainText('operator');

  await page.locator('[data-token-clear]').click();

  await expect(page.locator('[data-status-text]')).toContainText('Bearer token required');
  await expect(apiStatusTile).toContainText('Bearer token required');
});

test('sends scoped task operator commands with confirmation and error feedback', async ({ page }) => {
  const commandRequests: Array<{ pathname: string; body: unknown }> = [];

  await page.route('**/api/v1/agent-tasks/**/actions/resume**', async (route) => {
    commandRequests.push({ pathname: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          action: 'agent_task_resume',
          targetType: 'agent-task',
          targetId: 'agent_task_demo_running',
          status: 'accepted',
          dryRun: false,
          auditId: 'audit-resume-e2e',
        },
      }),
    });
  });

  // destructive command は fixture API で confirmation-required と confirmed の2段階を固定する。
  await page.route('**/api/v1/agent-tasks/**/actions/reset**', async (route) => {
    const body = route.request().postDataJSON();
    commandRequests.push({ pathname: new URL(route.request().url()).pathname, body });
    if (body.confirmationToken !== 'confirm-reset-e2e') {
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'action_confirmation_required',
          data: { confirmationToken: 'confirm-reset-e2e' },
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        data: {
          action: 'agent_task_reset',
          targetType: 'agent-task',
          targetId: 'agent_task_demo_running',
          status: 'accepted',
          dryRun: false,
          auditId: 'audit-reset-e2e',
        },
      }),
    });
  });

  await page.route('**/api/v1/agent-tasks/**/actions/terminate**', async (route) => {
    commandRequests.push({ pathname: new URL(route.request().url()).pathname, body: route.request().postDataJSON() });
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'operator_scope_rejected' }),
    });
  });

  await page.goto(`${dashboardBaseUrl}/en/dashboard/tasks?demo=1&task=agent_task_demo_running`);
  await expect(page.locator('[data-dashboard-detail]')).toContainText('agent_task_demo_running');

  await page.locator('[data-agent-action="resume"]').click();
  await expect(page.locator('[data-command-status]')).toContainText('accepted');
  await expect(page.locator('[data-command-status]')).toContainText('audit-resume-e2e');

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('reset');
    await dialog.accept();
  });
  await page.locator('[data-agent-action="reset"]').click();
  await expect(page.locator('[data-command-status]')).toContainText('audit-reset-e2e');

  await page.locator('[data-agent-action="terminate"]').click();
  await expect(page.locator('[data-command-status]')).toContainText('operator_scope_rejected');

  expect(commandRequests).toEqual([
    { pathname: '/api/v1/agent-tasks/agent_task_demo_running/actions/resume', body: {} },
    { pathname: '/api/v1/agent-tasks/agent_task_demo_running/actions/reset', body: {} },
    { pathname: '/api/v1/agent-tasks/agent_task_demo_running/actions/reset', body: { confirmationToken: 'confirm-reset-e2e' } },
    { pathname: '/api/v1/agent-tasks/agent_task_demo_running/actions/terminate', body: {} },
  ]);
});

test('sends terminate-all as a collection command and surfaces confirmation cancellation', async ({ page }) => {
  const terminateAllRequests: unknown[] = [];

  await page.route('**/api/v1/agent-tasks/actions/terminate-all**', async (route) => {
    terminateAllRequests.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        error: 'action_confirmation_required',
        data: { confirmationToken: 'confirm-terminate-all-e2e' },
      }),
    });
  });

  await page.goto(`${dashboardBaseUrl}/en/dashboard/tasks?demo=1`);
  await expect(page.locator('[data-dashboard-list] button').first()).toBeVisible();

  page.once('dialog', async (dialog) => {
    expect(dialog.message()).toContain('terminate all');
    await dialog.dismiss();
  });
  await page.locator('[data-agent-action="terminate-all"]').click();

  await expect(page.locator('[data-command-status]')).toContainText('action_confirmation_required');
  expect(terminateAllRequests).toEqual([{}]);
});

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

test('keeps dashboard connection controls inside the narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 844 });
  await page.goto(`${dashboardBaseUrl}/en/dashboard?demo=1`);

  await expect(page.getByRole('heading', { level: 1, name: /Rainrail Operations/i })).toBeVisible();
  await expect(page.locator('[data-token-save]')).toBeVisible();
  await expect(page.locator('[data-token-clear]')).toBeVisible();

  const connectionControlBoxes = await page.locator([
    '[data-api-base-url-input]',
    '[data-token-input]',
    '[data-token-save]',
    '[data-token-clear]',
  ].join(',')).evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      left: rect.left,
      right: rect.right,
      width: rect.width,
    };
  }));

  expect(connectionControlBoxes).toHaveLength(4);
  for (const box of connectionControlBoxes) {
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(1000);
    expect(box.width).toBeGreaterThanOrEqual(44);
  }
});

test('keeps dashboard connection controls stacked on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${dashboardBaseUrl}/en/dashboard?demo=1`);

  await expect(page.getByRole('heading', { level: 1, name: /Rainrail Operations/i })).toBeVisible();

  const connectionControlBoxes = await page.locator([
    '[data-api-base-url-input]',
    '[data-token-input]',
    '[data-token-save]',
    '[data-token-clear]',
  ].join(',')).evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top,
      bottom: rect.bottom,
      left: rect.left,
      right: rect.right,
    };
  }));
  expect(connectionControlBoxes).toHaveLength(4);
  const apiBaseUrlBox = connectionControlBoxes[0]!;
  const tokenBox = connectionControlBoxes[1]!;
  const connectBox = connectionControlBoxes[2]!;
  const clearBox = connectionControlBoxes[3]!;

  expect(apiBaseUrlBox.right).toBeLessThanOrEqual(390);
  expect(tokenBox.top).toBeGreaterThanOrEqual(apiBaseUrlBox.bottom);
  expect(connectBox.top).toBeGreaterThanOrEqual(tokenBox.bottom);
  expect(clearBox.top).toBeGreaterThanOrEqual(connectBox.bottom);
});

function overviewCardControl(controls: Locator, name: string): Locator {
  return controls.locator('.dashboard-overview-card-control').filter({ hasText: name });
}

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
