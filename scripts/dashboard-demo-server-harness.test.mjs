import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { startDashboardDemoServerHarness } from './dashboard-demo-server-harness.mjs';

const cliBinPath = new URL('../packages/cli/dist/bin/rainrail.js', import.meta.url);

describe('dashboard demo server harness', () => {
  it('starts a disposable SQLite-backed dashboard server and cleans it up', async () => {
    ensureCliBuild();
    const harness = await startDashboardDemoServerHarness({
      cliBinPath: cliBinPath.pathname,
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
      await expect(dashboardResponse.text()).resolves.toContain('Rainrail Dashboard Demo');
    } finally {
      await harness.cleanup();
    }

    expect(existsSync(harness.root)).toBe(false);
  });
});

function ensureCliBuild() {
  if (existsSync(cliBinPath)) return;
  const result = spawnSync('pnpm', [
    '--filter',
    '@rainrail/cli',
    'exec',
    'tsc',
    '-p',
    'tsconfig.build.json',
  ], {
    cwd: new URL('..', import.meta.url),
    env: process.env,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}
