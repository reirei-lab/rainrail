import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardPage = readFileSync(
  new URL('../apps/www/src/pages/dashboard.astro', import.meta.url),
  'utf8',
);
const dashboardClient = readFileSync(
  new URL('../apps/www/src/lib/dashboard-client.ts', import.meta.url),
  'utf8',
);
const dashboardApp = readFileSync(
  new URL('../apps/www/src/lib/dashboard-app.ts', import.meta.url),
  'utf8',
);
const globalStyles = readFileSync(
  new URL('../apps/www/src/styles/global.css', import.meta.url),
  'utf8',
);

describe('dashboard app shell', () => {
  it('places the operational dashboard under a dedicated app shell route', () => {
    expect(dashboardPage).toContain('Rainrail Operations');
    expect(dashboardPage).toContain('data-dashboard-app');
    expect(dashboardPage).toContain('data-state="auth-missing"');
    expect(dashboardPage).toContain('data-state="loading"');
    expect(dashboardPage).toContain('data-state="empty"');
    expect(dashboardPage).toContain('data-state="error"');
    expect(dashboardPage).toContain('data-stale-indicator');
    expect(dashboardPage).toContain('data-action-permission="operator"');
  });

  it('keeps UI code behind an operational API client instead of hard-coded fetch URLs', () => {
    for (const endpoint of [
      '/api/v1/overview',
      '/api/v1/events',
      '/api/v1/workflow-runs',
      '/api/v1/agent-tasks',
    ]) {
      expect(dashboardClient).toContain(endpoint);
      expect(dashboardApp).not.toContain(endpoint);
      expect(dashboardPage).not.toContain(endpoint);
    }

    expect(dashboardClient).toContain('class RainrailDashboardApiClient');
    expect(dashboardClient).toContain('authorization: `Bearer ${this.token}`');
    expect(dashboardApp).toContain('new RainrailDashboardApiClient');
  });

  it('documents polling as the MVP live update strategy in code and UI affordances', () => {
    expect(dashboardClient).toContain('pollIntervalMs');
    expect(dashboardClient).toContain('30000');
    expect(dashboardApp).toContain('setInterval');
    expect(dashboardPage).toContain('data-live-strategy="polling"');
  });

  it('adds responsive two-pane dashboard layout styles', () => {
    for (const selector of [
      '.dashboard-shell',
      '.dashboard-sidebar',
      '.dashboard-topbar',
      '.dashboard-two-pane',
      '.dashboard-list',
      '.dashboard-detail',
      '.dashboard-state',
      '.dashboard-stale',
      '.dashboard-action',
    ]) {
      expect(globalStyles).toContain(selector);
    }

    expect(globalStyles).toContain('@media (max-width: 900px)');
    expect(globalStyles).toContain('.dashboard-two-pane');
    expect(globalStyles).toContain('grid-template-columns: 1fr');
  });
});
