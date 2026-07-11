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
const localizedDashboardRoutePage = readFileSync(
  new URL('../apps/www/src/pages/[locale]/dashboard/[view].astro', import.meta.url),
  'utf8',
);
const dashboardLayout = readFileSync(
  new URL('../apps/www/src/layouts/DashboardLayout.astro', import.meta.url),
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
const dashboardControllers = readFileSync(
  new URL('../apps/www/src/lib/dashboard-controllers.ts', import.meta.url),
  'utf8',
);
const dashboardSession = readFileSync(
  new URL('../apps/www/src/lib/dashboard-session.ts', import.meta.url),
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
const sitemapRoute = readFileSync(
  new URL('../apps/www/src/pages/sitemap.xml.ts', import.meta.url),
  'utf8',
);
const dashboardShellSource = localizedDashboardPage + localizedDashboardRoutePage + dashboardLayout;
const cloudflarePagesDocs = readFileSync(
  new URL('../docs/cloudflare-pages.md', import.meta.url),
  'utf8',
);
const dashboardDemoVrtScenarios = readFileSync(
  new URL('./dashboard-demo-vrt-scenarios.mjs', import.meta.url),
  'utf8',
);
/** @type {{ contracts: Array<{ id: string, sources: string[], tests: string[] }> }} */
const contractsManifest = JSON.parse(
  readFileSync(new URL('../docs/contracts.manifest.json', import.meta.url), 'utf8'),
);

describe('dashboard app shell', () => {
  it('places the operational dashboard under a dedicated app shell route', () => {
    expect(dashboardPage).toContain("getDefaultLocaleRedirect('dashboard')");
    expect(dashboardShellSource).toContain('data-dashboard-app');
    expect(dashboardShellSource).toContain('data-state="auth-missing"');
    expect(dashboardShellSource).toContain('data-state="loading"');
    expect(dashboardShellSource).toContain('data-state="empty"');
    expect(dashboardShellSource).toContain('data-state="error"');
    expect(dashboardShellSource).toContain('data-stale-indicator');
    expect(dashboardContent).toContain('Rainrail Operations');
    expect(dashboardContent).toContain('Rainrail 運用');
  });

  it('renders dashboard language switcher links to equivalent dashboard locale pages', () => {
    expect(dashboardLayout).toContain('language-switcher');
    expect(dashboardLayout).toContain('getDashboardHref(targetLocale, activeRoute)');
    expect(dashboardLayout).toContain('data-locale-choice={targetLocale}');
    expect(dashboardLayout).toContain('languagePreferenceKey');
    expect(dashboardLayout).toContain('window.localStorage?.setItem(languagePreferenceKey, locale)');
  });

  it('uses DashboardLayout as the shared route shell with link-based navigation', () => {
    expect(localizedDashboardPage).toContain("activeRoute=\"overview\"");
    expect(localizedDashboardRoutePage).toContain('getDashboardRoutes()');
    expect(localizedDashboardRoutePage).toContain('getDashboardRouteBySlug(view)');
    expect(localizedDashboardRoutePage).toContain('activeRoute={route.id}');
    expect(dashboardLayout).toContain('data-dashboard-app');
    expect(dashboardLayout).toContain('dashboardRoutes.map');
    expect(dashboardLayout).toContain('href={getDashboardHref(locale, route.id)}');
    expect(dashboardLayout).toContain('aria-current={route.id === activeRoute ? \'page\' : undefined}');
    expect(dashboardLayout).toContain("aria-pressed={route.id === activeRoute ? 'true' : 'false'}");
    expect(dashboardApp).toContain('preserveDashboardRouteQuery(button)');
    expect(dashboardApp).toContain('target.search = window.location.search');
    expect(dashboardApp).toContain("target.searchParams.delete('tab')");
    expect(dashboardLayout).not.toContain('<button type="button" data-dashboard-tab="overview"');
    expect(localizedDashboardPage).not.toContain('<aside class="dashboard-sidebar"');
    expect(localizedDashboardRoutePage).not.toContain('<aside class="dashboard-sidebar"');
  });

  it('defines dashboard route URLs for each primary dashboard view', () => {
    expect(dashboardContent).toContain("export type DashboardRouteId = 'overview' | 'events' | 'workflow-runs' | 'agent-tasks' | 'sources' | 'queue' | 'settings'");
    expect(dashboardContent).toContain("slug: 'events'");
    expect(dashboardContent).toContain("slug: 'runs'");
    expect(dashboardContent).toContain("aliases: ['workflow-runs']");
    expect(dashboardContent).toContain("slug: 'tasks'");
    expect(dashboardContent).toContain("aliases: ['agent-tasks']");
    expect(dashboardContent).not.toContain("slug: 'workflow-runs'");
    expect(dashboardContent).not.toContain("slug: 'agent-tasks'");
    expect(localizedDashboardRoutePage).toContain('const routeViews = getDashboardRouteSlugs(route);');
    expect(localizedDashboardRoutePage).toContain('params: { locale, view }');
    expect(localizedDashboardRoutePage).toContain('props: { locale, view }');
    expect(dashboardContent).toContain('getDashboardRouteSlugs(route)');
    expect(sitemapRoute).toContain("getDashboardHref(locale, route.id)");
    expect(dashboardContent).toContain("return `/${locale}/dashboard/${route.slug}`;");
  });

  it('adds Sources, Queue, and Settings views for operator context', () => {
    for (const tab of ['sources', 'queue', 'settings']) {
      expect(dashboardLayout).toContain('data-dashboard-tab={route.id}');
      expect(dashboardContent).toContain(`${tab}:`);
    }

    for (const method of ['sources()', 'queue(', 'settings()']) {
      expect(dashboardClient).toContain(method);
    }

    expect(dashboardControllers).toContain("export type DashboardTab = 'overview' | 'events' | 'workflow-runs' | 'agent-tasks' | 'sources' | 'queue' | 'settings'");
    expect(dashboardControllers).toContain('data.sources = (await client.sources()).data');
    expect(dashboardControllers).toContain('data.queue = (await client.queue(request.queueFilters)).data');
    expect(dashboardControllers).toContain('data.settings = (await client.settings()).data');
    expect(dashboardContent).toContain("sourceBundles: ['EEP Bridge', 'GitHub webhook', 'Cloudflare tail'");
    expect(dashboardContent).toContain("queueSignals: ['upcoming issue', 'blocked reason', 'in-progress count'");
    expect(dashboardContent).toContain("settingsSignals: ['max concurrency', 'auto-start', 'retry policy'");
    expect(dashboardApp).not.toContain('const sourceBundleLabels');
    expect(dashboardApp).not.toContain('const queueLabels');
    expect(dashboardApp).not.toContain('const settingsLabels');
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

  it('defaults the dashboard API client to same-origin unless Pages injects an explicit API URL', () => {
    expect(localizedDashboardPage).toContain("const apiBaseUrl = import.meta.env.PUBLIC_RAINRAIL_OPERATIONAL_API_URL ?? '';");
    expect(dashboardShellSource).toContain('data-api-base-url={apiBaseUrl}');
    expect(dashboardShellSource).toContain('data-auth-required="true"');
    expect(dashboardClient).toContain("this.baseUrl = options.baseUrl ?? '';");
    expect(dashboardClient).toContain('fetch(`${this.baseUrl}${this.pathWithDemoMode(path)}`');
    expect(dashboardApp).toContain("const authRequired = !demoAuthBypass && appRoot.dataset.authRequired !== 'false';");
    expect(dashboardApp).toContain("if (storedToken === '' && authRequired)");
    expect(dashboardApp).toContain('client = createDashboardClient(storedToken, storedApiBaseUrl);');
    expect(dashboardClient).not.toContain('http://127.0.0.1:8787');
    expect(dashboardClient).not.toContain('localhost:8787');
  });

  it('supports explicit local dashboard demo mode without a bearer token', () => {
    expect(localizedDashboardPage).toContain('data-demo-indicator');
    expect(localizedDashboardPage).toContain('content.shell.demoModeBadge');
    expect(dashboardContent).toContain("demoModeBadge: 'Demo mode'");
    expect(dashboardContent).toContain("demoModeBadge: 'デモモード'");
    expect(dashboardApp).toContain("new URLSearchParams(window.location.search).get('demo') === '1'");
    expect(dashboardApp).toContain('const demoAuthBypass = demoMode && isLoopbackDashboardHost(window.location.hostname);');
    expect(dashboardApp).toContain("const authRequired = !demoAuthBypass && appRoot.dataset.authRequired !== 'false';");
    expect(dashboardSession).toContain('function isLoopbackDashboardHost');
    expect(dashboardApp).toContain('demoIndicator.hidden = !demoMode');
    expect(dashboardApp).toContain('isOperatorModeEnabled');
    expect(dashboardClient).toContain('demoMode?: boolean');
    expect(dashboardClient).toContain('pathWithDemoMode(path)');
    expect(dashboardClient).toContain('demo=1');
  });

  it('hydrates dashboard demo VRT state from URL parameters', () => {
    expect(dashboardDemoVrtScenarios).toContain('tab=events&source=github&event=evt_demo_github_issue_272');
    expect(dashboardDemoVrtScenarios).toContain('/ja/dashboard/runs?demo=1&status=failed&run=act_demo_workflow_failed_retry');
    expect(dashboardDemoVrtScenarios).toContain('/ja/dashboard/tasks?demo=1&task=agent_task_demo_running');
    expect(dashboardDemoVrtScenarios).toContain('tab=queue&status=blocked');
    expect(dashboardApp).toContain('initialDashboardStateFromUrl');
    expect(dashboardApp).toContain('let selectedTab: DashboardTab = initialDashboardState.tab;');
    expect(dashboardApp).toContain('fetchDashboardDataForTab(activeClient');
    expect(dashboardControllers).toContain('data.workflowRuns = (await client.workflowRuns(request.workflowRunFilters)).data');
    expect(dashboardControllers).toContain('data.agentTasks = (await client.agentTasks(request.agentTaskFilters)).data');
    expect(dashboardControllers).toContain('data.queue = (await client.queue(request.queueFilters)).data');
    expect(dashboardApp).toContain('preferredDetailRowId()');
    expect(dashboardClient).toContain("params.set('filter[status]', filters.status)");
  });

  it('keeps dashboard demo smoke and VRT files attached to the local dashboard contract', () => {
    const contract = contractsManifest.contracts.find((entry) => entry.id === 'local-dashboard-start');
    expect(contract).toBeDefined();
    if (contract === undefined) throw new Error('local-dashboard-start contract missing');
    expect(contract.sources).toContain('scripts/dashboard-demo-vrt-scenarios.mjs');
    expect(contract.sources).toContain('apps/www/src/lib/dashboard-controllers.ts');
    expect(contract.sources).toContain('apps/www/src/lib/dashboard-session.ts');
    expect(contract.tests).toContain('scripts/seed-dashboard-demo-db.test.ts');
    expect(contract.tests).toContain('e2e/dashboard/dashboard-smoke.spec.ts');
  });

  it('documents polling as the MVP live update strategy in code and UI affordances', () => {
    expect(dashboardClient).toContain('pollIntervalMs');
    expect(dashboardClient).toContain('30000');
    expect(dashboardSession).toContain('setInterval');
    expect(dashboardApp).toContain('createDashboardPollingController');
    expect(dashboardShellSource).toContain('data-live-strategy="polling"');
  });

  it('clears rendered operational data when auth is cleared', () => {
    expect(dashboardApp).toContain('resetDashboardData()');
    expect(dashboardApp).toContain('latestData = undefined');
    expect(dashboardApp).toContain('renderEmptyStats()');
    expect(dashboardApp).toContain('renderPlaceholderDetail');
    expect(dashboardApp).toContain('list.replaceChildren()');
  });

  it('keeps sidebar tab selection responsive before operational data loads', () => {
    expect(dashboardApp).toContain('function updateTabButtons()');
    expect(dashboardApp).toMatch(/function renderCurrentList\(\): void \{\s+ensureVisibleDashboardTab\(\);\s+updateTabButtons\(\);\s+if \(list === null \|\| detail === null\) return;/);
    expect(dashboardApp).toMatch(/if \(latestData === undefined\) \{[\s\S]*?renderPlaceholderDetail\(emptyDetailMessage\(selectedTab\)\);/);
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
    expect(dashboardApp).toContain('fetchDashboardDataForTab(activeClient');
    expect(dashboardControllers).toContain('const overview = await client.overview()');
    expect(dashboardControllers).toContain('data.events = (await client.events(request.eventFilters)).data');
    expect(dashboardControllers).toContain("if (request.tab === 'events')");
  });

  it('keeps shell stats backed by overview counts while page controllers skip inactive collections', () => {
    expect(dashboardApp).toContain('statItem(copy.stats.providerStatus, counts.providers ?? providerCount(latestData?.events ?? []))');
    expect(dashboardApp).toContain('statItem(copy.stats.sources, counts.sources ?? latestData?.sources.length ?? 0)');
    expect(dashboardApp).toContain('statItem(copy.stats.queue, counts.queue ?? latestData?.queue.length ?? 0)');
    expect(dashboardApp).not.toContain('statItem(copy.stats.providerStatus, providerCount(latestData?.events ?? [])),');
    expect(dashboardControllers).toContain('sources: []');
    expect(dashboardControllers).toContain('queue: []');
  });

  it('refreshes active-page collections after client-side dashboard tab changes', () => {
    expect(dashboardApp).toContain('let tabChangedDuringLayoutVisibility = false;');
    expect(dashboardApp).toContain('let refreshAfterSave = false;');
    expect(dashboardApp).toContain('if (tabChangedDuringLayoutVisibility) {');
    expect(dashboardApp).toContain('refreshAfterSave = applyDashboardLayoutVisibility();');
    expect(dashboardApp).toContain('void refresh({ quiet: true });');
    expect(dashboardApp).toContain('selectedTab = tab;');
    expect(dashboardApp).toContain('void refresh();');
  });

  it('models event repository under source like the v1 API compact row', () => {
    expect(dashboardClient).toContain('source?: { type?: string; name?: string; repository?: string }');
    expect(dashboardClient).not.toContain('source?: string');
    expect(dashboardApp).toContain('row.source?.repository');
    expect(dashboardApp).toContain('`${row.source.repository}#${row.subject.id}`');
  });

  it('keeps dashboard initialization usable when browser storage is blocked', () => {
    expect(dashboardApp).toContain('createSafeStorage');
    expect(dashboardSession).toContain('memoryStorage');
    expect(dashboardSession).toContain('try {');
    expect(dashboardSession).toContain('catch {');
    expect(dashboardApp).toContain('const sessionStore = createSafeStorage');
    expect(dashboardApp).toContain('const localStore = createSafeStorage');
    expect(dashboardApp).not.toContain('sessionStorage.getItem');
    expect(dashboardApp).not.toContain('localStorage.getItem');
  });

  it('treats missing and invalid bearer tokens as auth errors', () => {
    expect(dashboardApp).toContain('isDashboardAuthError');
    expect(dashboardSession).toContain('error.status === 401');
    expect(dashboardSession).toContain('error.status === 403');
    expect(dashboardSession).toContain("error.code === 'invalid_bearer_token'");
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
    expect(globalStyles).toContain('.dashboard-sidebar nav a:not([hidden])');
  });
});
