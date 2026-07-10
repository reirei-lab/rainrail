import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  formatDashboardDemoBaseUrl,
  startDashboardDemoServerHarness,
} from './dashboard-demo-server-harness.mjs';

const cliBinPath = new URL('../packages/cli/dist/bin/rainrail.js', import.meta.url);
const dashboardIndexPath = new URL('../apps/www/dist/en/dashboard/index.html', import.meta.url);

describe('dashboard demo server harness', () => {
  it('starts a disposable SQLite-backed dashboard server and cleans it up', async () => {
    ensureDashboardHarnessBuild();
    const harness = await startDashboardDemoServerHarness({
      cliBinPath: cliBinPath.pathname,
      env: {
        ...process.env,
        RAINRAIL_OPERATIONAL_STORE: 'json',
        RAINRAIL_OPERATIONAL_DB: '/tmp/rainrail-wrong-store.json',
        RAINRAIL_OPERATIONAL_EVENT_LIMIT: '1',
        SSE_BEARER_TOKEN: 'external-token-that-must-not-affect-demo',
      },
    });
    try {
      expect(harness.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(existsSync(harness.databasePath)).toBe(true);

      const overviewResponse = await fetch(`${harness.baseUrl}/api/v1/overview`);
      expect(overviewResponse.status).toBe(200);
      await expect(overviewResponse.json()).resolves.toMatchObject({
        data: {
          runtime: 'node',
          counts: {
            events: 3,
            activityEvents: 4,
            agentTasks: 3,
            commandResults: 3,
            eventHandlerRetries: 2,
          },
        },
      });

      const dashboardResponse = await fetch(`${harness.baseUrl}/en/dashboard?demo=1`);
      expect(dashboardResponse.status).toBe(200);
      await expect(dashboardResponse.text()).resolves.toContain('data-dashboard-app');

      const sourcesResponse = await fetch(`${harness.baseUrl}/api/v1/sources`);
      expect(sourcesResponse.status).toBe(200);
      await expect(sourcesResponse.json()).resolves.toMatchObject({
        data: expect.arrayContaining([
          expect.objectContaining({
            id: 'github-webhook',
            sourceType: 'github',
            lastDelivery: expect.objectContaining({ id: 'evt_demo_github_issue_272' }),
          }),
          expect.objectContaining({
            id: 'manual-chat',
            sourceType: 'chat',
            lastDelivery: expect.objectContaining({ id: 'evt_demo_manual_chat_001' }),
          }),
          expect.objectContaining({
            id: 'cloudflare-tail',
            sourceType: 'cloudflare',
            lastDelivery: expect.objectContaining({ id: 'evt_demo_cloudflare_tail_001' }),
          }),
        ]),
      });
    } finally {
      await harness.cleanup();
    }

    expect(existsSync(harness.root)).toBe(false);
  }, 30_000);

  it('formats IPv6 localhost base URLs with brackets', () => {
    expect(formatDashboardDemoBaseUrl('::1', 43210)).toBe('http://[::1]:43210');
    expect(formatDashboardDemoBaseUrl('[::1]', 43210)).toBe('http://[::1]:43210');
    expect(formatDashboardDemoBaseUrl('127.0.0.1', 43210)).toBe('http://127.0.0.1:43210');
  });
});

function ensureDashboardHarnessBuild() {
  if (!existsSync(dashboardIndexPath)) {
    runRequiredPnpm([
      '--filter',
      'www',
      'build',
    ]);
  }
  if (existsSync(cliBinPath)) return;
  runRequiredPnpm([
    '--filter',
    '@rainrail/cli',
    'exec',
    'tsc',
    '-p',
    'tsconfig.build.json',
  ]);
}

/**
 * @param {string[]} args
 */
function runRequiredPnpm(args) {
  const result = spawnSync('pnpm', args, {
    cwd: new URL('..', import.meta.url),
    env: process.env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}
