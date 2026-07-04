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
const cloudflarePagesDocs = readFileSync(
  new URL('../docs/cloudflare-pages.md', import.meta.url),
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
    expect(dashboardPage).toContain('data-api-base-url-input');
    expect(dashboardPage).toContain('data-api-base-url');
    expect(dashboardApp).toContain('API_BASE_URL_STORAGE_KEY');
    expect(dashboardApp).toContain('apiBaseUrlInput');
    expect(dashboardApp).toContain('baseUrl: apiBaseUrl');
    expect(cloudflarePagesDocs).toContain('PUBLIC_RAINRAIL_WORKER_URL');
  });

  it('documents polling as the MVP live update strategy in code and UI affordances', () => {
    expect(dashboardClient).toContain('pollIntervalMs');
    expect(dashboardClient).toContain('30000');
    expect(dashboardApp).toContain('setInterval');
    expect(dashboardPage).toContain('data-live-strategy="polling"');
  });

  it('clears rendered operational data when auth is cleared', () => {
    expect(dashboardApp).toContain('resetDashboardData()');
    expect(dashboardApp).toContain('latestData = undefined');
    expect(dashboardApp).toContain('renderEmptyStats()');
    expect(dashboardApp).toContain('renderPlaceholderDetail');
    expect(dashboardApp).toContain('list.replaceChildren()');
  });

  it('clears rendered operational data before switching connection targets', () => {
    expect(dashboardApp).toContain('resetDashboardData();');
    expect(dashboardApp).toMatch(/client = createDashboardClient\(token, apiBaseUrl\);[\s\S]*?resetDashboardData\(\);[\s\S]*?void refresh\(\);/);
  });

  it('keeps pending refreshes tied to the client that started them', () => {
    expect(dashboardApp).toContain('const activeClient = client');
    expect(dashboardApp).toContain('const activeRefreshId = ++refreshSequence;');
    expect(dashboardApp).toContain('refreshInFlightClient');
    expect(dashboardApp).toContain('if (options.quiet && refreshInFlightClient === client) return;');
    expect(dashboardApp).toContain('clearRefreshInFlight(activeClient, activeRefreshId)');
    expect(dashboardApp).toContain('isCurrentRefresh(activeClient, activeRefreshId)');
    expect(dashboardApp).toContain('if (client !== activeClient) return false;');
    expect(dashboardApp).toContain('overview: await activeClient.overview()');
    expect(dashboardApp).toContain('events: (await activeClient.events()).data');
  });

  it('models event repository under source like the v1 API compact row', () => {
    expect(dashboardClient).toContain('source?: { type?: string; name?: string; repository?: string }');
    expect(dashboardClient).not.toContain('source?: string');
    expect(dashboardApp).toContain('row.source?.repository');
    expect(dashboardApp).toContain('`${row.source.repository}#${row.subject.id}`');
  });

  it('keeps dashboard initialization usable when browser storage is blocked', () => {
    expect(dashboardApp).toContain('createSafeStorage');
    expect(dashboardApp).toContain('memoryStorage');
    expect(dashboardApp).toContain('try {');
    expect(dashboardApp).toContain('catch {');
    expect(dashboardApp).toContain('const sessionStore = createSafeStorage');
    expect(dashboardApp).toContain('const localStore = createSafeStorage');
    expect(dashboardApp).not.toContain('sessionStorage.getItem');
    expect(dashboardApp).not.toContain('localStorage.getItem');
  });

  it('treats missing and invalid bearer tokens as auth errors', () => {
    expect(dashboardApp).toContain('isDashboardAuthError');
    expect(dashboardApp).toContain('error.status === 401');
    expect(dashboardApp).toContain('error.status === 403');
    expect(dashboardApp).toContain("error.code === 'invalid_bearer_token'");
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
