import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const dashboardPage = readFileSync(
  new URL('../apps/www/src/pages/dashboard.astro', import.meta.url),
  'utf8',
);
const localizedDashboardPage = readFileSync(
  new URL('../apps/www/src/pages/[locale]/dashboard.astro', import.meta.url),
  'utf8',
);
const dashboardContent = readFileSync(
  new URL('../apps/www/src/lib/dashboard-content.ts', import.meta.url),
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
    expect(dashboardPage).toContain("getDefaultLocaleRedirect('dashboard')");
    expect(localizedDashboardPage).toContain('data-dashboard-app');
    expect(localizedDashboardPage).toContain('data-state="auth-missing"');
    expect(localizedDashboardPage).toContain('data-state="loading"');
    expect(localizedDashboardPage).toContain('data-state="empty"');
    expect(localizedDashboardPage).toContain('data-state="error"');
    expect(localizedDashboardPage).toContain('data-stale-indicator');
    expect(localizedDashboardPage).toContain('data-action-permission="operator"');
    expect(dashboardContent).toContain('Rainrail Operations');
    expect(dashboardContent).toContain('Rainrail 運用');
  });

  it('renders dashboard language switcher links to equivalent dashboard locale pages', () => {
    const dashboardLayout = readFileSync(
      new URL('../apps/www/src/layouts/DashboardLayout.astro', import.meta.url),
      'utf8',
    );

    expect(dashboardLayout).toContain('language-switcher');
    expect(dashboardLayout).toContain('getDashboardHref(targetLocale)');
    expect(dashboardLayout).toContain('data-locale-choice={targetLocale}');
    expect(dashboardLayout).toContain('languagePreferenceKey');
    expect(dashboardLayout).toContain('window.localStorage?.setItem(languagePreferenceKey, locale)');
  });

  it('adds Sources, Queue, and Settings views for operator context', () => {
    for (const tab of ['sources', 'queue', 'settings']) {
      expect(localizedDashboardPage).toContain(`data-dashboard-tab="${tab}"`);
    }

    for (const method of ['sources()', 'queue()', 'settings()']) {
      expect(dashboardClient).toContain(method);
    }

    expect(dashboardApp).toContain("type DashboardTab = 'overview' | 'events' | 'workflow-runs' | 'agent-tasks' | 'sources' | 'queue' | 'settings'");
    expect(dashboardApp).toContain('sources: (await activeClient.sources()).data');
    expect(dashboardApp).toContain('queue: (await activeClient.queue()).data');
    expect(dashboardApp).toContain('settings: (await activeClient.settings()).data');
    expect(dashboardApp).toContain("const sourceBundleLabels = ['EEP Bridge', 'GitHub webhook', 'Cloudflare tail', 'manual/chat']");
    expect(dashboardApp).toContain("const queueLabels = ['upcoming issue', 'blocked reason', 'in-progress count', 'claim lock', 'Project status']");
    expect(dashboardApp).toContain("const settingsLabels = ['max concurrency', 'auto-start', 'retry policy', 'operational snapshot limit', 'dashboard auth']");
  });

  it('keeps UI code behind an operational API client instead of hard-coded fetch URLs', () => {
    for (const endpoint of [
      '/api/v1/overview',
      '/api/v1/events',
      '/api/v1/workflow-runs',
      '/api/v1/agent-tasks',
      '/api/v1/sources',
      '/api/v1/queue',
      '/api/v1/settings',
    ]) {
      expect(dashboardClient).toContain(endpoint);
      expect(dashboardApp).not.toContain(endpoint);
      expect(localizedDashboardPage).not.toContain(endpoint);
    }

    expect(dashboardClient).toContain('class RainrailDashboardApiClient');
    expect(dashboardClient).toContain('authorization: `Bearer ${this.token}`');
    expect(dashboardApp).toContain('new RainrailDashboardApiClient');
    expect(localizedDashboardPage).toContain('data-api-base-url-input');
    expect(localizedDashboardPage).toContain('data-api-base-url');
    expect(dashboardApp).toContain('API_BASE_URL_STORAGE_KEY');
    expect(dashboardApp).toContain('apiBaseUrlInput');
    expect(dashboardApp).toContain('baseUrl: apiBaseUrl');
    expect(localizedDashboardPage).toContain('PUBLIC_RAINRAIL_OPERATIONAL_API_URL');
    expect(cloudflarePagesDocs).toContain('PUBLIC_RAINRAIL_OPERATIONAL_API_URL');
    expect(cloudflarePagesDocs).toContain('operational store');
    expect(cloudflarePagesDocs).not.toContain('operational API の Worker base URL');
  });

  it('documents polling as the MVP live update strategy in code and UI affordances', () => {
    expect(dashboardClient).toContain('pollIntervalMs');
    expect(dashboardClient).toContain('30000');
    expect(dashboardApp).toContain('setInterval');
    expect(localizedDashboardPage).toContain('data-live-strategy="polling"');
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
    expect(dashboardApp).toContain('events: (await activeClient.events(currentEventFilters())).data');
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

  it('renders dashboard stat counts without trusting runtime API values as HTML', () => {
    expect(dashboardApp).toContain('valueElement.textContent = String(value)');
    expect(dashboardApp).not.toContain('item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${value}</strong>`');
  });

  it('adds responsive two-pane dashboard layout styles', () => {
    for (const selector of [
      '.dashboard-shell',
      '.dashboard-sidebar',
      '.dashboard-topbar',
      '.dashboard-two-pane',
      '.dashboard-list',
      '.dashboard-detail',
      '.dashboard-meta-grid',
      '.dashboard-meta-item',
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
