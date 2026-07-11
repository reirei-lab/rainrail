import type { DashboardOverview } from './dashboard-client';

export const OVERVIEW_CARD_STORAGE_KEY = 'rainrail-dashboard-overview-card-layout';

export type OverviewCardId = 'health' | 'counts' | 'recentActivity' | 'warnings';

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
  providerStatus: string;
  agentTasks: string;
  sources: string;
  queue: string;
}

export const overviewCardRegistry: readonly OverviewCardDefinition[] = [
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
  if (key === 'providers') return labels.providerStatus;
  if (key === 'agentTasks') return labels.agentTasks;
  if (key === 'sources') return labels.sources;
  if (key === 'queue') return labels.queue;
  return key;
}

function isOverviewCardId(value: unknown, registryIds: Set<OverviewCardId>): value is OverviewCardId {
  return typeof value === 'string' && registryIds.has(value as OverviewCardId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
