import {
  RainrailDashboardApiClient,
  RainrailDashboardApiError,
  type DashboardAgentTask,
  type DashboardDetail,
  type DashboardEvent,
  type DashboardOverview,
  type DashboardQueueItem,
  type DashboardSetting,
  type DashboardSource,
  type DashboardWorkflowRun,
} from './dashboard-client';

type DashboardTab = 'overview' | 'events' | 'workflow-runs' | 'sources' | 'queue' | 'settings';
type DashboardRow = DashboardEvent | DashboardWorkflowRun | DashboardAgentTask | DashboardSource | DashboardQueueItem | DashboardSetting;

interface DashboardData {
  overview: DashboardOverview;
  events: DashboardEvent[];
  workflowRuns: DashboardWorkflowRun[];
  agentTasks: DashboardAgentTask[];
  sources: DashboardSource[];
  queue: DashboardQueueItem[];
  settings: DashboardSetting[];
}

const TOKEN_STORAGE_KEY = 'rainrail-dashboard-token';
const API_BASE_URL_STORAGE_KEY = 'rainrail-dashboard-api-base-url';
const OPERATOR_STORAGE_KEY = 'rainrail-dashboard-operator';
const STALE_AFTER_MS = 45000;
const sourceBundleLabels = ['EEP Bridge', 'GitHub webhook', 'Cloudflare tail', 'manual/chat'];
const queueLabels = ['upcoming issue', 'blocked reason', 'in-progress count', 'claim lock', 'Project status'];
const settingsLabels = ['max concurrency', 'auto-start', 'retry policy', 'replay retention', 'dashboard auth'];

const root = document.querySelector<HTMLElement>('[data-dashboard-app]');
const sessionStore = createSafeStorage(() => window.sessionStorage);
const localStore = createSafeStorage(() => window.localStorage);

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
  const eventSourceFilter = root.querySelector<HTMLSelectElement>('[data-event-source-filter]');
  const eventNameFilter = root.querySelector<HTMLInputElement>('[data-event-name-filter]');
  const filterApplyButton = root.querySelector<HTMLButtonElement>('[data-filter-apply]');
  const permissionToggle = root.querySelector<HTMLInputElement>('[data-permission-toggle]');
  const operatorActions = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-action-permission="operator"]'));
  const tabButtons = Array.from(root.querySelectorAll<HTMLButtonElement>('[data-dashboard-tab]'));

  let client: RainrailDashboardApiClient | undefined;
  let selectedTab: DashboardTab = 'overview';
  let latestData: DashboardData | undefined;
  let lastUpdatedAt = 0;
  let staleTimer: number | undefined;
  let pollTimer: number | undefined;
  let refreshInFlightClient: RainrailDashboardApiClient | undefined;
  let refreshSequence = 0;
  let detailRequestSequence = 0;
  let selectedDetailRowId: string | undefined;

  const storedToken = sessionStore.get(TOKEN_STORAGE_KEY) ?? '';
  const storedApiBaseUrl = sessionStore.get(API_BASE_URL_STORAGE_KEY) ?? appRoot.dataset.apiBaseUrl ?? '';
  const operatorEnabled = localStore.get(OPERATOR_STORAGE_KEY) === '1';
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
      sessionStore.remove(TOKEN_STORAGE_KEY);
      client = undefined;
      stopPolling();
      resetDashboardData();
      setState('auth-missing', 'Bearer token required');
      return;
    }

    const apiBaseUrl = normalizeApiBaseUrl(apiBaseUrlInput?.value ?? appRoot.dataset.apiBaseUrl ?? '');
    sessionStore.set(TOKEN_STORAGE_KEY, token);
    if (apiBaseUrl === '') {
      sessionStore.remove(API_BASE_URL_STORAGE_KEY);
    } else {
      sessionStore.set(API_BASE_URL_STORAGE_KEY, apiBaseUrl);
    }
    if (apiBaseUrlInput !== null) apiBaseUrlInput.value = apiBaseUrl;
    client = createDashboardClient(token, apiBaseUrl);
    resetDashboardData();
    void refresh();
    startPolling(client);
  });

  clearTokenButton?.addEventListener('click', () => {
    sessionStore.remove(TOKEN_STORAGE_KEY);
    client = undefined;
    stopPolling();
    if (tokenInput !== null) tokenInput.value = '';
    resetDashboardData();
    setState('auth-missing', 'Bearer token required');
  });

  refreshButton?.addEventListener('click', () => {
    void refresh();
  });

  filterApplyButton?.addEventListener('click', () => {
    selectedTab = 'events';
    void refresh();
  });

  permissionToggle?.addEventListener('change', () => {
    const enabled = permissionToggle.checked;
    localStore.set(OPERATOR_STORAGE_KEY, enabled ? '1' : '0');
    setOperatorActionsEnabled(enabled);
  });

  for (const button of tabButtons) {
    button.addEventListener('click', () => {
      const tab = button.dataset.dashboardTab;
      if (isDashboardTab(tab)) {
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
    if (options.quiet && refreshInFlightClient === client) return;

    const activeClient = client;
    const activeRefreshId = ++refreshSequence;
    refreshInFlightClient = activeClient;

    if (!options.quiet) setState('loading', 'Loading operational state');

    try {
      const nextData = {
        overview: await activeClient.overview(),
        events: (await activeClient.events(currentEventFilters())).data,
        workflowRuns: (await activeClient.workflowRuns()).data,
        agentTasks: (await activeClient.agentTasks()).data,
        sources: (await activeClient.sources()).data,
        queue: (await activeClient.queue()).data,
        settings: (await activeClient.settings()).data,
      };
      if (!isCurrentRefresh(activeClient, activeRefreshId)) return;

      latestData = nextData;
      lastUpdatedAt = Date.now();
      scheduleStaleCheck();
      renderStats(latestData.overview);
      renderCurrentList();
      const hasOperationalData = hasDashboardRecords(latestData);
      setState(hasOperationalData ? 'ready' : 'empty', hasOperationalData ? 'Live operational state' : 'No operational records yet');
    } catch (error) {
      if (!isCurrentRefresh(activeClient, activeRefreshId)) return;
      const authError = isDashboardAuthError(error);
      if (authError) resetDashboardData();
      const message = authError
        ? 'Token rejected by operational API'
        : 'Operational API unavailable';
      setState('error', message);
    } finally {
      clearRefreshInFlight(activeClient, activeRefreshId);
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
      clearSelectedDetail();
      detail.textContent = emptyDetailMessage(selectedTab);
      return;
    }

    void renderDetail(rows[0]!);
  }

  function rowButton(row: DashboardRow): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dashboard-row';
    button.innerHTML = `
      <span>${escapeHtml(row.status)}${'latestOutcome' in row && row.latestOutcome !== undefined ? ` / ${escapeHtml(row.latestOutcome)}` : ''}</span>
      <strong>${escapeHtml(rowTitle(row))}</strong>
      <small>${escapeHtml(rowMeta(row))}</small>
    `;
    button.addEventListener('click', () => {
      void renderDetail(row);
    });
    return button;
  }

  async function renderDetail(row: DashboardRow): Promise<void> {
    if (detail === null) return;

    const detailRequestId = ++detailRequestSequence;
    selectedDetailRowId = row.id;
    renderBasicDetail(row, 'Loading detail');
    const activeClient = client;
    if (activeClient === undefined) {
      if (isCurrentDetailRequest(activeClient, detailRequestId, row.id)) {
        renderBasicDetail(row, 'Detail unavailable');
      }
      return;
    }

    try {
      if (row.type === 'event') {
        const loaded = await activeClient.eventDetail(row.id);
        if (!isCurrentDetailRequest(activeClient, detailRequestId, row.id)) return;
        renderEventDetail(row, loaded);
        return;
      }
      if (row.type === 'workflow-run') {
        const loaded = await activeClient.workflowRunDetail(row.id);
        if (!isCurrentDetailRequest(activeClient, detailRequestId, row.id)) return;
        renderWorkflowRunDetail(row, loaded);
        return;
      }
      if (row.type === 'agent-task') {
        const loaded = await activeClient.agentTaskDetail(row.id);
        if (!isCurrentDetailRequest(activeClient, detailRequestId, row.id)) return;
        renderAgentTaskDetail(row, loaded);
        return;
      }
      if (!isCurrentDetailRequest(activeClient, detailRequestId, row.id)) return;
      renderBasicDetail(row, `${row.type} summary`);
    } catch {
      if (isCurrentDetailRequest(activeClient, detailRequestId, row.id)) {
        renderBasicDetail(row, 'Detail request failed');
      }
    }
  }

  function renderStats(overview: DashboardOverview): void {
    if (stats === null) return;

    const counts = overview.data.counts;
    stats.replaceChildren(...[
      statItem('Health', 1),
      statItem('Events', counts.events ?? 0),
      statItem('Active runs', counts.activityEvents ?? 0),
      statItem('Retrying handlers', counts.eventHandlerRetries ?? 0),
      statItem('Provider status', providerCount(latestData?.events ?? [])),
      statItem('Agent tasks', counts.agentTasks ?? 0),
    ]);
  }

  function renderEmptyStats(): void {
    if (stats === null) return;

    stats.replaceChildren(
      statItem('Health', 0),
      statItem('Events', 0),
      statItem('Active runs', 0),
      statItem('Retrying handlers', 0),
      statItem('Provider status', 0),
      statItem('Agent tasks', 0),
    );
  }

  function statItem(label: string, value: number): HTMLElement {
    const item = document.createElement('div');
    item.className = 'dashboard-stat';

    const labelElement = document.createElement('span');
    labelElement.textContent = label;

    const valueElement = document.createElement('strong');
    valueElement.textContent = String(value);

    item.append(labelElement, valueElement);
    return item;
  }

  function selectedRows(data: DashboardData): DashboardRow[] {
    if (selectedTab === 'workflow-runs') return data.workflowRuns;
    if (selectedTab === 'sources') return data.sources;
    if (selectedTab === 'queue') return data.queue;
    if (selectedTab === 'settings') return data.settings;
    if (selectedTab === 'overview') return [...data.overview.data.recentActivity, ...data.agentTasks];
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
    refreshInFlightClient = undefined;
    clearSelectedDetail();
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

  function isCurrentRefresh(activeClient: RainrailDashboardApiClient, activeRefreshId: number): boolean {
    if (client !== activeClient) return false;
    return refreshSequence === activeRefreshId;
  }

  function clearRefreshInFlight(activeClient: RainrailDashboardApiClient, activeRefreshId: number): void {
    if (refreshInFlightClient === activeClient && refreshSequence === activeRefreshId) {
      refreshInFlightClient = undefined;
    }
  }

  function isCurrentDetailRequest(activeClient: RainrailDashboardApiClient | undefined, detailRequestId: number, rowId: string): boolean {
    return client === activeClient
      && detailRequestSequence === detailRequestId
      && selectedDetailRowId === rowId;
  }

  function clearSelectedDetail(): void {
    selectedDetailRowId = undefined;
    detailRequestSequence += 1;
  }

  function emptyDetailMessage(tab: DashboardTab): string {
    if (tab === 'sources') return `Waiting for configured source adapters: ${sourceBundleLabels.join(', ')}.`;
    if (tab === 'queue') return `Waiting for queue records covering ${queueLabels.join(', ')}.`;
    if (tab === 'settings') return `Waiting for settings metadata covering ${settingsLabels.join(', ')}.`;
    return 'Select another stream or wait for the next poll.';
  }

  function currentEventFilters(): { sourceType?: string; name?: string } {
    return {
      sourceType: eventSourceFilter?.value.trim() ?? '',
      name: eventNameFilter?.value.trim() ?? '',
    };
  }

  function renderBasicDetail(row: DashboardRow, label: string): void {
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
        <div><dt>Action audit</dt><dd>${escapeHtml(label)}</dd></div>
      </dl>
    `;
  }

  function renderEventDetail(row: DashboardEvent, loaded: DashboardDetail): void {
    if (detail === null) return;

    const record = objectRecord(loaded.data.record);
    const envelope = objectRecord(record.envelope);
    const rawPayload = objectRecord(envelope.rawPayload);
    const activityEvents = arrayRecord(record.activityEvents);
    const handlerRetries = arrayRecord(record.handlerRetries);

    detail.innerHTML = `
      <div class="dashboard-detail-heading">
        <span>event</span>
        <strong>${escapeHtml(row.status)}</strong>
      </div>
      <h2>${escapeHtml(stringRecordValue(record.humanSummary) ?? rowTitle(row))}</h2>
      <dl>
        <div><dt>Human summary</dt><dd>${escapeHtml(stringRecordValue(record.humanSummary) ?? rowTitle(row))}</dd></div>
        <div><dt>Delivery</dt><dd>${escapeHtml(row.deliveryId ?? stringRecordValue(objectRecord(record.delivery).id) ?? 'n/a')}</dd></div>
        <div><dt>Raw payload reference</dt><dd>${escapeHtml(stringRecordValue(rawPayload.reference) ?? row.rawPayloadReference ?? 'n/a')}</dd></div>
        <div><dt>Matched workflows</dt><dd>${escapeHtml(formatActivityList(activityEvents))}</dd></div>
        <div><dt>Retry schedule</dt><dd>${escapeHtml(formatRetryList(handlerRetries))}</dd></div>
        <div><dt>Action audit</dt><dd>${escapeHtml(formatActivityList(activityEvents))}</dd></div>
      </dl>
      <section class="dashboard-audit-list" aria-label="Sanitized envelope">
        <h3>Sanitized envelope</h3>
        <pre>${escapeHtml(JSON.stringify(envelope, null, 2))}</pre>
      </section>
    `;
  }

  function renderWorkflowRunDetail(row: DashboardWorkflowRun, loaded: DashboardDetail): void {
    if (detail === null) return;

    const record = objectRecord(loaded.data.record);
    detail.innerHTML = `
      <div class="dashboard-detail-heading">
        <span>workflow-run</span>
        <strong>${escapeHtml(row.status)}</strong>
      </div>
      <h2>${escapeHtml(rowTitle(row))}</h2>
      <dl>
        <div><dt>Human summary</dt><dd>${escapeHtml(stringRecordValue(record.summary) ?? rowTitle(row))}</dd></div>
        <div><dt>Source event</dt><dd>${escapeHtml(stringRecordValue(record.sourceEventId) ?? row.sourceEventId ?? 'n/a')}</dd></div>
        <div><dt>Action audit</dt><dd>${escapeHtml(`${stringRecordValue(record.actionType) ?? 'n/a'} / ${stringRecordValue(record.outcome) ?? row.status}`)}</dd></div>
        <div><dt>Retry schedule</dt><dd>${escapeHtml(row.status === 'failed' ? 'Check handler retry rows for this source event.' : 'n/a')}</dd></div>
      </dl>
      <section class="dashboard-audit-list" aria-label="Workflow run record">
        <h3>Action audit</h3>
        <pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
      </section>
    `;
  }

  function renderAgentTaskDetail(row: DashboardAgentTask, loaded: DashboardDetail): void {
    if (detail === null) return;

    const record = objectRecord(loaded.data.record);
    const runtime = objectRecord(record.runtime);
    detail.innerHTML = `
      <div class="dashboard-detail-heading">
        <span>agent-task</span>
        <strong>${escapeHtml(row.status)}</strong>
      </div>
      <h2>${escapeHtml(rowTitle(row))}</h2>
      <dl>
        <div><dt>Branch</dt><dd>${escapeHtml(row.branchName ?? 'n/a')}</dd></div>
        <div><dt>Issue</dt><dd>${escapeHtml(formatIssue(row))}</dd></div>
        <div><dt>Runtime</dt><dd>${escapeHtml(stringRecordValue(runtime.status) ?? row.status)}</dd></div>
        <div><dt>Action audit</dt><dd>${escapeHtml(stringRecordValue(record.logPath) ?? 'Agent task summary')}</dd></div>
      </dl>
      <section class="dashboard-audit-list" aria-label="Agent task record">
        <h3>Action audit</h3>
        <pre>${escapeHtml(JSON.stringify(record, null, 2))}</pre>
      </section>
    `;
  }
}

interface SafeStorage {
  get(key: string): string | undefined;
  set(key: string, value: string): void;
  remove(key: string): void;
}

function createSafeStorage(getStorage: () => Storage): SafeStorage {
  const memoryStorage = new Map<string, string>();

  function storage(): Storage | undefined {
    try {
      const candidate = getStorage();
      const probeKey = 'rainrail-dashboard-storage-probe';
      candidate.setItem(probeKey, '1');
      candidate.removeItem(probeKey);
      return candidate;
    } catch {
      return undefined;
    }
  }

  return {
    get(key) {
      const target = storage();
      if (target === undefined) return memoryStorage.get(key);

      try {
        return target.getItem(key) ?? undefined;
      } catch {
        return memoryStorage.get(key);
      }
    },
    set(key, value) {
      const target = storage();
      if (target === undefined) {
        memoryStorage.set(key, value);
        return;
      }

      try {
        target.setItem(key, value);
      } catch {
        memoryStorage.set(key, value);
      }
    },
    remove(key) {
      memoryStorage.delete(key);
      const target = storage();
      if (target === undefined) return;

      try {
        target.removeItem(key);
      } catch {
        // The fallback is already cleared.
      }
    },
  };
}

function normalizeApiBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

function isDashboardAuthError(error: unknown): boolean {
  return error instanceof RainrailDashboardApiError
    && (error.status === 401 || error.status === 403 || error.code === 'invalid_bearer_token');
}

function isDashboardTab(value: string | undefined): value is DashboardTab {
  return value === 'overview'
    || value === 'events'
    || value === 'workflow-runs'
    || value === 'sources'
    || value === 'queue'
    || value === 'settings';
}

function hasOperationalRecords(overview: DashboardOverview): boolean {
  const counts = overview.data.counts;
  return Object.values(counts).some((value) => value > 0);
}

function hasDashboardRecords(data: DashboardData): boolean {
  return hasOperationalRecords(data.overview)
    || data.sources.length > 0
    || data.queue.length > 0
    || data.settings.length > 0;
}

function formatIssue(row: DashboardRow): string {
  if ('issue' in row && row.issue?.repository !== undefined && row.issue.number !== undefined) {
    return `${row.issue.repository}#${row.issue.number}`;
  }
  if ('source' in row && row.source?.repository !== undefined && 'subject' in row && row.subject?.id !== undefined) {
    return `${row.source.repository}#${row.subject.id}`;
  }
  if ('subject' in row && row.subject?.type !== undefined && row.subject.id !== undefined) {
    return `${row.subject.type}#${row.subject.id}`;
  }
  return 'n/a';
}

function rowTitle(row: DashboardRow): string {
  if ('label' in row && typeof row.label === 'string') return row.label;
  if ('name' in row && typeof row.name === 'string') return row.name;
  if ('summary' in row && typeof row.summary === 'string') return row.summary;
  if ('title' in row && typeof row.title === 'string') return row.title;
  return row.id;
}

function rowMeta(row: DashboardRow): string {
  if (row.type === 'event') {
    return [
      row.deliveryId === undefined ? undefined : `Delivery ${row.deliveryId}`,
      row.latestOutcome === undefined ? undefined : `Publish result ${row.latestOutcome}`,
      row.workflowRunCount === undefined ? undefined : `Workflow matches ${row.workflowRunCount}`,
      row.handlerRetryCount === undefined ? undefined : `Retries ${row.handlerRetryCount}`,
    ].filter((value): value is string => value !== undefined).join(' | ') || row.id;
  }
  if (row.type === 'workflow-run') {
    return row.sourceEventId === undefined ? row.id : `Source event ${row.sourceEventId}`;
  }
  if (row.type === 'source') {
    return [
      row.sourceType,
      row.transport,
      row.lastDelivery?.id === undefined ? undefined : `Last delivery ${row.lastDelivery.id}`,
    ].filter((value): value is string => value !== undefined).join(' | ') || row.id;
  }
  if (row.type === 'queue-item') {
    return [
      row.projectStatus === undefined ? undefined : `Project ${row.projectStatus}`,
      row.blockedReason === undefined ? undefined : `Blocked ${row.blockedReason}`,
      row.claimLock?.heldBy === undefined ? undefined : `Claim ${row.claimLock.heldBy}`,
    ].filter((value): value is string => value !== undefined).join(' | ') || row.id;
  }
  if (row.type === 'setting') {
    return row.value;
  }
  return row.id;
}

function providerCount(events: DashboardEvent[]): number {
  return new Set(events.map((event) => event.source?.type).filter((value): value is string => value !== undefined)).size;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function arrayRecord(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(objectRecord) : [];
}

function stringRecordValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function formatActivityList(activityEvents: Array<Record<string, unknown>>): string {
  if (activityEvents.length === 0) return 'n/a';
  return activityEvents
    .map((activity) => [
      stringRecordValue(activity.summary) ?? stringRecordValue(activity.actionType) ?? 'workflow',
      stringRecordValue(activity.outcome) ?? 'unknown',
    ].join(' / '))
    .join('; ');
}

function formatRetryList(handlerRetries: Array<Record<string, unknown>>): string {
  if (handlerRetries.length === 0) return 'n/a';
  return handlerRetries
    .map((retry) => [
      stringRecordValue(retry.handlerName) ?? 'handler',
      stringRecordValue(retry.nextRetryAt) ?? 'unscheduled',
      stringRecordValue(retry.lastError) ?? 'retry pending',
    ].join(' / '))
    .join('; ');
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
