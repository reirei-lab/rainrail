import { describe, expect, it } from 'vitest';
import { RainrailDashboardApiError } from '../apps/www/src/lib/dashboard-client';
import { fetchDashboardDataForTab, type DashboardTab } from '../apps/www/src/lib/dashboard-controllers';

describe('dashboard page controllers', () => {
  it('fetches only Events collection data for the Events page', async () => {
    const client = fakeDashboardClient();

    await fetchDashboardDataForTab(client, {
      tab: 'events',
      eventFilters: { sourceType: 'github', name: 'issues.opened' },
      workflowRunFilters: {},
      agentTaskFilters: {},
      queueFilters: {},
    });

    expect(client.calls).toEqual([
      'overview',
      'dashboardCards',
      'dashboardLayout',
      'events:github:issues.opened',
    ]);
  });

  it('includes a deep-linked event detail row when it is outside the Events page collection', async () => {
    const client = fakeDashboardClient({
      events: [{ id: 'evt_recent', type: 'event', status: 'received', summary: 'recent event' }],
      eventDetails: {
        evt_older_source: {
          id: 'evt_older_source',
          type: 'event',
          status: 'received',
          summary: 'older source event',
        },
      },
    });

    const data = await fetchDashboardDataForTab(client, {
      tab: 'events',
      eventFilters: {},
      workflowRunFilters: {},
      agentTaskFilters: {},
      queueFilters: {},
      eventDetailId: 'evt_older_source',
    });

    expect(client.calls).toEqual([
      'overview',
      'dashboardCards',
      'dashboardLayout',
      'events::',
      'eventDetail:evt_older_source',
    ]);
    expect(data.events.map((event) => event.id)).toEqual(['evt_older_source', 'evt_recent']);
  });

  it('does not refetch a deep-linked event that is already in the Events page collection', async () => {
    const client = fakeDashboardClient({
      events: [{ id: 'evt_recent', type: 'event', status: 'received', summary: 'recent event' }],
    });

    const data = await fetchDashboardDataForTab(client, {
      tab: 'events',
      eventFilters: {},
      workflowRunFilters: {},
      agentTaskFilters: {},
      queueFilters: {},
      eventDetailId: 'evt_recent',
    });

    expect(client.calls).toEqual([
      'overview',
      'dashboardCards',
      'dashboardLayout',
      'events::',
    ]);
    expect(data.events.map((event) => event.id)).toEqual(['evt_recent']);
  });

  it('keeps the Events collection usable when a deep-linked event no longer exists', async () => {
    const client = fakeDashboardClient({
      events: [{ id: 'evt_recent', type: 'event', status: 'received', summary: 'recent event' }],
      eventDetailErrors: {
        evt_missing: new RainrailDashboardApiError(404, 'event_not_found'),
      },
    });

    const data = await fetchDashboardDataForTab(client, {
      tab: 'events',
      eventFilters: {},
      workflowRunFilters: {},
      agentTaskFilters: {},
      queueFilters: {},
      eventDetailId: 'evt_missing',
    });

    expect(client.calls).toEqual([
      'overview',
      'dashboardCards',
      'dashboardLayout',
      'events::',
      'eventDetail:evt_missing',
    ]);
    expect(data.events.map((event) => event.id)).toEqual(['evt_recent']);
  });

  it('still surfaces non-not-found event detail failures', async () => {
    const client = fakeDashboardClient({
      events: [{ id: 'evt_recent', type: 'event', status: 'received', summary: 'recent event' }],
      eventDetailErrors: {
        evt_forbidden: new RainrailDashboardApiError(403, 'dashboard_forbidden'),
      },
    });

    await expect(fetchDashboardDataForTab(client, {
      tab: 'events',
      eventFilters: {},
      workflowRunFilters: {},
      agentTaskFilters: {},
      queueFilters: {},
      eventDetailId: 'evt_forbidden',
    })).rejects.toMatchObject({ status: 403, code: 'dashboard_forbidden' });
  });

  it.each<[
    DashboardTab,
    string[],
  ]>([
    ['workflow-runs', ['overview', 'dashboardCards', 'dashboardLayout', 'workflowRuns:failed']],
    ['agent-tasks', ['overview', 'dashboardCards', 'dashboardLayout', 'agentTasks:running']],
    ['sources', ['overview', 'dashboardCards', 'dashboardLayout', 'sources']],
    ['queue', ['overview', 'dashboardCards', 'dashboardLayout', 'queue:blocked']],
    ['settings', ['overview', 'dashboardCards', 'dashboardLayout', 'settings']],
  ])('fetches only the active %s page collection', async (tab, expectedCalls) => {
    const client = fakeDashboardClient();

    await fetchDashboardDataForTab(client, {
      tab,
      eventFilters: {},
      workflowRunFilters: { status: 'failed' },
      agentTaskFilters: { status: 'running' },
      queueFilters: { status: 'blocked' },
    });

    expect(client.calls).toEqual(expectedCalls);
  });
});

type FakeDashboardClientOptions = {
  events?: Array<{ id: string; type: 'event'; status: string; summary: string }>;
  eventDetails?: Record<string, { id: string; type: 'event'; status: string; summary: string }>;
  eventDetailErrors?: Record<string, Error>;
};

function fakeDashboardClient(options: FakeDashboardClientOptions = {}) {
  const calls: string[] = [];
  return {
    calls,
    async overview() {
      calls.push('overview');
      return { data: { counts: {}, warnings: {}, recentActivity: [], links: emptyLinks() } };
    },
    async dashboardCards() {
      calls.push('dashboardCards');
      return { data: [] };
    },
    async dashboardLayout() {
      calls.push('dashboardLayout');
      return { data: { id: 'default', source: 'default', updatedAt: null, items: [] } };
    },
    async events(filters: { sourceType?: string; name?: string }) {
      calls.push(`events:${filters.sourceType ?? ''}:${filters.name ?? ''}`);
      return { data: options.events ?? [], page: { limit: 25, nextCursor: null } };
    },
    async eventDetail(id: string) {
      calls.push(`eventDetail:${id}`);
      const error = options.eventDetailErrors?.[id];
      if (error !== undefined) throw error;
      return {
        data: {
          id,
          type: 'event',
          compact: options.eventDetails?.[id],
          record: {},
        },
      };
    },
    async workflowRuns(filters: { status?: string }) {
      calls.push(`workflowRuns:${filters.status ?? ''}`);
      return { data: [], page: { limit: 25, nextCursor: null } };
    },
    async agentTasks(filters: { status?: string }) {
      calls.push(`agentTasks:${filters.status ?? ''}`);
      return { data: [], page: { limit: 25, nextCursor: null } };
    },
    async sources() {
      calls.push('sources');
      return { data: [], page: { limit: 25, nextCursor: null } };
    },
    async queue(filters: { status?: string }) {
      calls.push(`queue:${filters.status ?? ''}`);
      return { data: [], page: { limit: 25, nextCursor: null } };
    },
    async settings() {
      calls.push('settings');
      return { data: [], page: { limit: 25, nextCursor: null } };
    },
  };
}

function emptyLinks() {
  return {
    events: '',
    workflowRuns: '',
    agentTasks: '',
    sources: '',
    queue: '',
    settings: '',
  };
}
