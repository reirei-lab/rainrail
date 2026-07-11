import {
  RainrailDashboardApiError,
  type DashboardAgentTask,
  type DashboardCardCatalogEntry,
  type DashboardCollection,
  type DashboardDetail,
  type DashboardEvent,
  type DashboardLayout,
  type DashboardOverview,
  type DashboardQueueItem,
  type DashboardSetting,
  type DashboardSource,
  type DashboardWorkflowRun,
} from './dashboard-client';

export type DashboardTab = 'overview' | 'events' | 'workflow-runs' | 'agent-tasks' | 'sources' | 'queue' | 'settings';

export interface DashboardData {
  overview: DashboardOverview;
  events: DashboardEvent[];
  workflowRuns: DashboardWorkflowRun[];
  agentTasks: DashboardAgentTask[];
  sources: DashboardSource[];
  queue: DashboardQueueItem[];
  settings: DashboardSetting[];
  cards: DashboardCardCatalogEntry[];
  layout: DashboardLayout['data'];
}

export interface DashboardPageControllerRequest {
  tab: DashboardTab;
  eventFilters: { sourceType?: string; name?: string };
  eventDetailId?: string;
  workflowRunFilters: { status?: string };
  agentTaskFilters: { status?: string };
  queueFilters: { status?: string };
}

export interface DashboardDataClient {
  overview(): Promise<DashboardOverview>;
  events(filters: { sourceType?: string; name?: string }): Promise<DashboardCollection<DashboardEvent>>;
  eventDetail(id: string): Promise<DashboardDetail<unknown, DashboardEvent>>;
  workflowRuns(filters: { status?: string }): Promise<DashboardCollection<DashboardWorkflowRun>>;
  agentTasks(filters: { status?: string }): Promise<DashboardCollection<DashboardAgentTask>>;
  sources(): Promise<DashboardCollection<DashboardSource>>;
  queue(filters: { status?: string }): Promise<DashboardCollection<DashboardQueueItem>>;
  settings(): Promise<DashboardCollection<DashboardSetting>>;
  dashboardCards(): Promise<{ data: DashboardCardCatalogEntry[] }>;
  dashboardLayout(): Promise<DashboardLayout>;
}

export async function fetchDashboardDataForTab(
  client: DashboardDataClient,
  request: DashboardPageControllerRequest,
): Promise<DashboardData> {
  const overview = await client.overview();
  const cards = (await client.dashboardCards()).data;
  const layout = (await client.dashboardLayout()).data;
  const data: DashboardData = {
    overview,
    events: [],
    workflowRuns: [],
    agentTasks: [],
    sources: [],
    queue: [],
    settings: [],
    cards,
    layout,
  };

  if (request.tab === 'events') {
    data.events = (await client.events(request.eventFilters)).data;
    const eventDetailId = request.eventDetailId?.trim();
    if (eventDetailId !== undefined && eventDetailId !== '' && !data.events.some((event) => event.id === eventDetailId)) {
      try {
        const detail = await client.eventDetail(eventDetailId);
        if (detail.data.compact !== undefined && eventMatchesFilters(detail.data.compact, request.eventFilters)) {
          data.events = [detail.data.compact, ...data.events];
        }
      } catch (error) {
        if (!isEventDetailNotFound(error)) throw error;
      }
    }
  } else if (request.tab === 'workflow-runs') {
    data.workflowRuns = (await client.workflowRuns(request.workflowRunFilters)).data;
  } else if (request.tab === 'agent-tasks') {
    data.agentTasks = (await client.agentTasks(request.agentTaskFilters)).data;
  } else if (request.tab === 'sources') {
    data.sources = (await client.sources()).data;
  } else if (request.tab === 'queue') {
    data.queue = (await client.queue(request.queueFilters)).data;
  } else if (request.tab === 'settings') {
    data.settings = (await client.settings()).data;
  } else {
    data.agentTasks = (await client.agentTasks(request.agentTaskFilters)).data;
  }

  return data;
}

function eventMatchesFilters(event: DashboardEvent, filters: { sourceType?: string; name?: string }): boolean {
  const sourceType = filters.sourceType?.trim();
  if (sourceType !== undefined && sourceType !== '' && event.source?.type !== sourceType) return false;

  const name = filters.name?.trim();
  if (name !== undefined && name !== '' && event.name !== name) return false;

  return true;
}

function isEventDetailNotFound(error: unknown): boolean {
  return error instanceof RainrailDashboardApiError
    && error.status === 404
    && error.code === 'event_not_found';
}
