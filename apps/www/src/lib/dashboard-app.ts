import {
  RainrailDashboardApiClient,
  RainrailDashboardApiError,
  type DashboardAgentTask,
  type DashboardEvent,
  type DashboardOverview,
  type DashboardWorkflowRun,
} from './dashboard-client';

type DashboardTab = 'events' | 'workflow-runs' | 'agent-tasks';

interface DashboardData {
  overview: DashboardOverview;
  events: DashboardEvent[];
  workflowRuns: DashboardWorkflowRun[];
  agentTasks: DashboardAgentTask[];
}

const TOKEN_STORAGE_KEY = 'rainrail-dashboard-token';
const API_BASE_URL_STORAGE_KEY = 'rainrail-dashboard-api-base-url';
const OPERATOR_STORAGE_KEY = 'rainrail-dashboard-operator';
const STALE_AFTER_MS = 45000;

const root = document.querySelector<HTMLElement>('[data-dashboard-app]');

if (root !== null) {
  const appRoot = root;
  const tokenInput = root.querySelector<HTMLInputElement>('[data-token-input]');
  const apiBaseUrlInput = root.querySelector<HTMLInputElement>('[data-api-base-url-input]');
  const saveTokenButton = root.querySelector<HTMLButtonElement>('[data-token-save]');
  const clearTokenButton = root.querySelector<HTMLButtonElement>('[data-token-clear]');
  const refreshButton = root.querySelector<HTMLButtonElement>('[data-refresh]');
  const statusText = root.querySelector<HTMLElement>('[data-status-text]');
  const staleIndicator = root.querySelector<HTMLElement>('[data-stale-indicator]');
  const list = root.querySelector<HTMLElement>('[data-dashboard-list]');
  const detail = root.querySelector<HTMLElement>('[data-dashboard-detail]');
  const stats = root.querySelector<HTMLElement>('[data-dashboard-stats]');
  const permissionToggle = root.querySelector<HTMLInputElement>('[data-permission-toggle]');
  const operatorActions = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-action-permission="operator"]'));
  const tabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-dashboard-tab]'));

  let client: RainrailDashboardApiClient | undefined;
  let selectedTab: DashboardTab = 'events';
  let latestData: DashboardData | undefined;
  let lastUpdatedAt = 0;
  let staleTimer: number | undefined;
  let pollTimer: number | undefined;

  const storedToken = sessionStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
  const storedApiBaseUrl = sessionStorage.getItem(API_BASE_URL_STORAGE_KEY) ?? appRoot.dataset.apiBaseUrl ?? '';
  const operatorEnabled = localStorage.getItem(OPERATOR_STORAGE_KEY) === '1';
  if (tokenInput !== null) tokenInput.value = storedToken;
  if (apiBaseUrlInput !== null) apiBaseUrlInput.value = storedApiBaseUrl;
  if (permissionToggle !== null) permissionToggle.checked = operatorEnabled;
  setOperatorActionsEnabled(operatorEnabled);
  resetDashboardData();

  if (storedToken === '') {
    setState('auth-missing', 'Bearer token required');
  } else {
    client = createDashboardClient(storedToken);
    void refresh();
    startPolling(client);
  }

  saveTokenButton?.addEventListener('click', () => {
    const token = tokenInput?.value.trim() ?? '';
    if (token === '') {
      sessionStorage.removeItem(TOKEN_STORAGE_KEY);
      client = undefined;
      stopPolling();
      resetDashboardData();
      setState('auth-missing', 'Bearer token required');
      return;
    }

    const apiBaseUrl = normalizeApiBaseUrl(apiBaseUrlInput?.value ?? appRoot.dataset.apiBaseUrl ?? '');
    sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    if (apiBaseUrl === '') {
      sessionStorage.removeItem(API_BASE_URL_STORAGE_KEY);
    } else {
      sessionStorage.setItem(API_BASE_URL_STORAGE_KEY, apiBaseUrl);
    }
    if (apiBaseUrlInput !== null) apiBaseUrlInput.value = apiBaseUrl;
    client = createDashboardClient(token, apiBaseUrl);
    void refresh();
    startPolling(client);
  });

  clearTokenButton?.addEventListener('click', () => {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    client = undefined;
    stopPolling();
    if (tokenInput !== null) tokenInput.value = '';
    resetDashboardData();
    setState('auth-missing', 'Bearer token required');
  });

  refreshButton?.addEventListener('click', () => {
    void refresh();
  });

  permissionToggle?.addEventListener('change', () => {
    const enabled = permissionToggle.checked;
    localStorage.setItem(OPERATOR_STORAGE_KEY, enabled ? '1' : '0');
    setOperatorActionsEnabled(enabled);
  });

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      const tab = button.dataset.dashboardTab;
      if (tab === 'events' || tab === 'workflow-runs' || tab === 'agent-tasks') {
        selectedTab = tab;
        renderCurrentList();
      }
    });
  }

  async function refresh(options: { quiet?: boolean } = {}): Promise<void> {
    if (client === undefined) {
      setState('auth-missing', 'Bearer token required');
      return;
    }
    const activeClient = client;

    if (!options.quiet) setState('loading', 'Loading operational state');

    try {
      const nextData = {
        overview: await activeClient.overview(),
        events: (await activeClient.events()).data,
        workflowRuns: (await activeClient.workflowRuns()).data,
        agentTasks: (await activeClient.agentTasks()).data,
      };
      if (client !== activeClient) return;

      latestData = nextData;
      lastUpdatedAt = Date.now();
      scheduleStaleCheck();
      renderStats(latestData.overview);
      renderCurrentList();
      setState(hasRows(latestData) ? 'ready' : 'empty', hasRows(latestData) ? 'Live operational state' : 'No operational records yet');
    } catch (error) {
      if (client !== activeClient) return;
      const authError = isDashboardAuthError(error);
      if (authError) resetDashboardData();
      const message = authError
        ? 'Token rejected by operational API'
        : 'Operational API unavailable';
      setState('error', message);
    }
  }

  function renderCurrentList(): void {
    if (latestData === undefined || list === null || detail === null) return;

    for (const button of tabButtons) {
      button.ariaPressed = String(button.dataset.dashboardTab === selectedTab);
    }

    const rows = selectedRows(latestData);
    list.replaceChildren(...rows.map((row) => rowButton(row)));
    if (rows.length === 0) {
      detail.textContent = 'Select another stream or wait for the next poll.';
      return;
    }

    renderDetail(rows[0]!);
  }

  function rowButton(row: DashboardEvent | DashboardWorkflowRun | DashboardAgentTask): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dashboard-row';
    button.innerHTML = `
      <span>${escapeHtml(row.status)}</span>
      <strong>${escapeHtml(rowTitle(row))}</strong>
      <small>${escapeHtml(row.id)}</small>
    `;
    button.addEventListener('click', () => renderDetail(row));
    return button;
  }

  function renderDetail(row: DashboardEvent | DashboardWorkflowRun | DashboardAgentTask): void {
    if (detail === null) return;

    detail.innerHTML = `
      <div class="dashboard-detail-heading">
        <span>${escapeHtml(row.type)}</span>
        <strong>${escapeHtml(row.status)}</strong>
      </div>
      <h2>${escapeHtml(rowTitle(row))}</h2>
      <dl>
        <div><dt>ID</dt><dd>${escapeHtml(row.id)}</dd></div>
        <div><dt>Branch</dt><dd>${escapeHtml('branchName' in row ? row.branchName ?? 'n/a' : 'n/a')}</dd></div>
        <div><dt>Issue</dt><dd>${escapeHtml(formatIssue(row))}</dd></div>
      </dl>
    `;
  }

  function renderStats(overview: DashboardOverview): void {
    if (stats === null) return;

    const counts = overview.data.counts;
    stats.replaceChildren(...[
      statItem('Events', counts.events ?? 0),
      statItem('Workflow runs', counts.activityEvents ?? 0),
      statItem('Agent tasks', counts.agentTasks ?? 0),
      statItem('Retries', counts.eventHandlerRetries ?? 0),
    ]);
  }

  function renderEmptyStats(): void {
    if (stats === null) return;

    stats.replaceChildren(
      statItem('Events', 0),
      statItem('Workflow runs', 0),
      statItem('Agent tasks', 0),
      statItem('Retries', 0),
    );
  }

  function statItem(label: string, value: number): HTMLElement {
    const item = document.createElement('div');
    item.className = 'dashboard-stat';
    item.innerHTML = `<span>${escapeHtml(label)}</span><strong>${value}</strong>`;
    return item;
  }

  function selectedRows(data: DashboardData): Array<DashboardEvent | DashboardWorkflowRun | DashboardAgentTask> {
    if (selectedTab === 'workflow-runs') return data.workflowRuns;
    if (selectedTab === 'agent-tasks') return data.agentTasks;
    return data.events;
  }

  function setState(state: string, message: string): void {
    appRoot.dataset.state = state;
    if (statusText !== null) statusText.textContent = message;
  }

  function scheduleStaleCheck(): void {
    if (staleTimer !== undefined) window.clearTimeout(staleTimer);
    staleTimer = window.setTimeout(() => {
      const stale = Date.now() - lastUpdatedAt > STALE_AFTER_MS;
      if (staleIndicator !== null) staleIndicator.hidden = !stale;
    }, STALE_AFTER_MS + 100);
    if (staleIndicator !== null) staleIndicator.hidden = true;
  }

  function resetDashboardData(): void {
    latestData = undefined;
    lastUpdatedAt = 0;
    if (staleTimer !== undefined) {
      window.clearTimeout(staleTimer);
      staleTimer = undefined;
    }
    if (staleIndicator !== null) staleIndicator.hidden = true;
    renderEmptyStats();
    if (list !== null) list.replaceChildren();
    renderPlaceholderDetail('Select a stream after connecting.');
  }

  function renderPlaceholderDetail(message: string): void {
    if (detail === null) return;

    detail.innerHTML = `
      <div class="dashboard-detail-heading">
        <span>ready</span>
        <strong>waiting</strong>
      </div>
      <h2>${escapeHtml(message)}</h2>
      <dl>
        <div><dt>ID</dt><dd>n/a</dd></div>
        <div><dt>Branch</dt><dd>n/a</dd></div>
        <div><dt>Issue</dt><dd>n/a</dd></div>
      </dl>
    `;
  }

  function createDashboardClient(token: string, configuredApiBaseUrl?: string): RainrailDashboardApiClient {
    const apiBaseUrl = normalizeApiBaseUrl(configuredApiBaseUrl ?? apiBaseUrlInput?.value ?? appRoot.dataset.apiBaseUrl ?? '');
    return new RainrailDashboardApiClient({ token, baseUrl: apiBaseUrl });
  }

  function startPolling(nextClient: RainrailDashboardApiClient): void {
    stopPolling();
    pollTimer = window.setInterval(() => {
      void refresh({ quiet: true });
    }, nextClient.pollIntervalMs);
  }

  function stopPolling(): void {
    if (pollTimer !== undefined) {
      window.clearInterval(pollTimer);
      pollTimer = undefined;
    }
  }

  function setOperatorActionsEnabled(enabled: boolean): void {
    for (const action of operatorActions) action.disabled = !enabled;
  }
}

function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isDashboardAuthError(error: unknown): boolean {
  return error instanceof RainrailDashboardApiError
    && (error.status === 401 || error.status === 403 || error.code === 'invalid_bearer_token');
}

function hasRows(data: DashboardData): boolean {
  return data.events.length + data.workflowRuns.length + data.agentTasks.length > 0;
}

function formatIssue(row: DashboardEvent | DashboardWorkflowRun | DashboardAgentTask): string {
  if ('issue' in row && row.issue?.repository !== undefined && row.issue.number !== undefined) {
    return `${row.issue.repository}#${row.issue.number}`;
  }
  if ('subject' in row && row.subject?.type !== undefined && row.subject.id !== undefined) {
    return `${row.subject.type}#${row.subject.id}`;
  }
  return 'n/a';
}

function rowTitle(row: DashboardEvent | DashboardWorkflowRun | DashboardAgentTask): string {
  if ('summary' in row && typeof row.summary === 'string') return row.summary;
  if ('title' in row && typeof row.title === 'string') return row.title;
  return row.id;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
