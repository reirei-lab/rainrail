import { describe, expect, it } from 'vitest';
import { fetchDashboardDataForTab, type DashboardTab } from '../apps/www/src/lib/dashboard-controllers';

describe('dashboard page controllers', () => {
  it('fetches overview data plus agent task context for the Overview page', async () => {
    const client = fakeDashboardClient();

    await fetchDashboardDataForTab(client, {
      tab: 'overview',
      eventFilters: {},
      workflowRunFilters: { status: 'failed' },
      agentTaskFilters: { status: 'running' },
      queueFilters: { status: 'blocked' },
    });

    expect(client.calls).toEqual([
      'overview',
      'dashboardCards',
      'dashboardLayout',
      'agentTasks:running',
    ]);
  });

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

function fakeDashboardClient() {
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
      return { data: [], page: { limit: 25, nextCursor: null } };
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
