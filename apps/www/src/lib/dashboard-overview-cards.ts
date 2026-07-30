import type { DashboardApiStatus, DashboardOverview, DashboardStatus } from './dashboard-client';

export const OVERVIEW_CARD_STORAGE_KEY = 'rainrail-dashboard-overview-card-layout';

export type OverviewCardId = 'apiStatus' | 'health' | 'counts' | 'recentActivity' | 'warnings';

export interface OverviewCardDefinition {
  id: OverviewCardId;
  title: string;
  description: string;
}

export interface OverviewCardLayoutItem {
  id: OverviewCardId;
  visible: boolean;
}

export interface OverviewHealthStatusLabels {
  ready: string;
  empty: string;
  error: string;
  authMissing: string;
  loading: string;
  connected: string;
}

export interface OverviewCountLabels {
  events: string;
  activeRuns: string;
  retryingHandlers: string;
  commandResults: string;
  providerStatus: string;
  agentTasks: string;
  sources: string;
  queue: string;
}

export interface OverviewWarningLabels {
  staleProjectClaim: string;
  warningCount: string;
}

export interface OverviewWarningSummary {
  label: string;
  value: string;
  detail: string;
}

export interface OverviewApiStatusLabels {
  connected: string;
  degraded: string;
  error: string;
  authMissing: string;
  authRejected: string;
  unavailable: string;
  overview: string;
  duration: string;
  lastSuccess: string;
  authScope: string;
  store: string;
}

export interface OverviewApiStatusSummary {
  status: string;
  tone: DashboardApiStatus | 'auth-missing' | 'auth-rejected' | 'unavailable';
  metrics: {
    overview: string;
    duration: string;
    lastSuccess: string;
    authScope: string;
    store: string;
  };
  note: string;
}

export const overviewCardRegistry: readonly OverviewCardDefinition[] = [
  {
    id: 'apiStatus',
    title: 'API status',
    description: 'Independent operational API, auth, and overview health signals.',
  },
  {
    id: 'health',
    title: 'Health',
    description: 'API response freshness and dashboard connection state.',
  },
  {
    id: 'counts',
    title: 'Counts',
    description: 'Operational totals from the overview API.',
  },
  {
    id: 'recentActivity',
    title: 'Recent activity',
    description: 'Latest workflow activity from the overview API.',
  },
  {
    id: 'warnings',
    title: 'Warnings',
    description: 'Overview warning signals that need operator attention.',
  },
] as const;

export function createDefaultOverviewCardLayout(
  registry: readonly OverviewCardDefinition[] = overviewCardRegistry,
): OverviewCardLayoutItem[] {
  return registry.map((card) => ({ id: card.id, visible: true }));
}

export function parseOverviewCardLayout(
  value: string | undefined,
  registry: readonly OverviewCardDefinition[] = overviewCardRegistry,
): OverviewCardLayoutItem[] {
  if (value === undefined) return createDefaultOverviewCardLayout(registry);

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return createDefaultOverviewCardLayout(registry);
  }
  if (!Array.isArray(parsed)) return createDefaultOverviewCardLayout(registry);

  const registryIds = new Set(registry.map((card) => card.id));
  const seen = new Set<OverviewCardId>();
  const layout: OverviewCardLayoutItem[] = [];
  for (const item of parsed) {
    if (!isRecord(item)) continue;
    const id = item.id;
    if (!isOverviewCardId(id, registryIds) || seen.has(id)) continue;
    seen.add(id);
    layout.push({ id, visible: item.visible !== false });
  }

  for (const item of createDefaultOverviewCardLayout(registry)) {
    if (!seen.has(item.id)) layout.push(item);
  }

  return layout.length === 0 ? createDefaultOverviewCardLayout(registry) : layout;
}

export function serializeOverviewCardLayout(layout: readonly OverviewCardLayoutItem[]): string {
  return JSON.stringify(layout.map((item) => ({ id: item.id, visible: item.visible })));
}

export function setOverviewCardVisibility(
  layout: readonly OverviewCardLayoutItem[],
  id: OverviewCardId,
  visible: boolean,
): OverviewCardLayoutItem[] {
  return layout.map((item) => item.id === id ? { ...item, visible } : item);
}

export function moveOverviewCard(
  layout: readonly OverviewCardLayoutItem[],
  id: OverviewCardId,
  direction: 'up' | 'down',
): OverviewCardLayoutItem[] {
  const next = [...layout];
  const index = next.findIndex((item) => item.id === id);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= next.length) return [...layout];
  [next[index], next[targetIndex]] = [next[targetIndex]!, next[index]!];
  return next;
}

export function overviewWarningCount(overview: DashboardOverview): number {
  return overview.data.warnings.staleProjectClaims?.length ?? 0;
}

export function overviewHealthStatusLabel(
  dashboardState: string | undefined,
  labels: OverviewHealthStatusLabels,
  currentStatusMessage?: string,
): string {
  if (dashboardState === 'ready') return labels.ready;
  if (dashboardState === 'empty') return labels.empty;
  if (dashboardState === 'error') return currentStatusMessage ?? labels.error;
  if (dashboardState === 'auth-missing') return labels.authMissing;
  if (dashboardState === 'loading') return labels.loading;
  return labels.connected;
}

export function overviewCountLabel(key: string, labels: OverviewCountLabels): string {
  if (key === 'events') return labels.events;
  if (key === 'activityEvents') return labels.activeRuns;
  if (key === 'eventHandlerRetries') return labels.retryingHandlers;
  if (key === 'commandResults') return labels.commandResults;
  if (key === 'providers') return labels.providerStatus;
  if (key === 'agentTasks') return labels.agentTasks;
  if (key === 'sources') return labels.sources;
  if (key === 'queue') return labels.queue;
  return key;
}

export function overviewWarningSummary(
  staleProjectClaims: readonly unknown[],
  labels: OverviewWarningLabels,
): OverviewWarningSummary {
  const count = staleProjectClaims.length;
  return {
    label: labels.staleProjectClaim,
    value: String(count),
    detail: `${labels.warningCount} ${count}`,
  };
}

export function overviewApiStatusSummary(
  status: DashboardStatus | undefined,
  labels: OverviewApiStatusLabels,
  options: {
    nowMs?: number;
    dashboardState?: string;
    currentStatusMessage?: string;
  } = {},
): OverviewApiStatusSummary {
  if (status === undefined) {
    const dashboardState = options.dashboardState;
    const isAuthMissing = dashboardState === 'auth-missing';
    const isAuthRejected = dashboardState === 'error' && options.currentStatusMessage === labels.authRejected;
    return {
      status: isAuthMissing ? labels.authMissing : isAuthRejected ? labels.authRejected : labels.unavailable,
      tone: isAuthMissing ? 'auth-missing' : isAuthRejected ? 'auth-rejected' : 'unavailable',
      metrics: {
        overview: labels.unavailable,
        duration: 'n/a',
        lastSuccess: 'n/a',
        authScope: isAuthMissing ? labels.authMissing : 'n/a',
        store: 'n/a',
      },
      note: isAuthMissing ? labels.authMissing : options.currentStatusMessage ?? labels.unavailable,
    };
  }

  const data = status.data;
  const lastError = data.overview.lastError;
  return {
    status: apiStatusLabel(data.status, labels),
    tone: data.status,
    metrics: {
      overview: data.overview.status,
      duration: formatDuration(data.overview.lastDurationMs),
      lastSuccess: formatRelativeTime(data.overview.lastSuccessAt, options.nowMs ?? Date.now()),
      authScope: data.auth?.scope ?? 'read-only',
      store: data.store.status,
    },
    note: lastError === null ? `${labels.overview}: ${data.overview.status}` : `${lastError.code}: ${lastError.summary}`,
  };
}

function apiStatusLabel(status: DashboardApiStatus, labels: OverviewApiStatusLabels): string {
  if (status === 'ok') return labels.connected;
  if (status === 'degraded') return labels.degraded;
  return labels.error;
}

function formatDuration(value: number | null): string {
  if (value === null) return 'n/a';
  return `${Math.max(0, Math.round(value))} ms`;
}

function formatRelativeTime(value: string | null, nowMs: number): string {
  if (value === null) return 'n/a';
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return 'n/a';
  const diffMs = Math.max(0, nowMs - timestamp);
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function isOverviewCardId(value: unknown, registryIds: Set<OverviewCardId>): value is OverviewCardId {
  return typeof value === 'string' && registryIds.has(value as OverviewCardId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
