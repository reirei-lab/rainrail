/**
 * Stable capture targets for SQLite-backed dashboard demo review.
 *
 * Keep this manifest deterministic so Playwright can capture the same
 * dashboard states without rediscovering which records exercise retries, stale
 * claims, command audit rows, and each dashboard tab.
 *
 * @typedef {'overview' | 'events' | 'workflow-runs' | 'agent-tasks' | 'sources' | 'queue' | 'settings'} DashboardDemoTab
 * @typedef DashboardDemoVrtScenario
 * @property {string} id
 * @property {DashboardDemoTab} tab
 * @property {string} url
 * @property {'desktop' | 'mobile'} [viewport]
 * @property {string[]} captureHints
 */

/** @satisfies {readonly DashboardDemoVrtScenario[]} */
export const dashboardDemoVrtScenarios = Object.freeze([
  {
    id: 'overview-demo-summary',
    tab: 'overview',
    url: '/ja/dashboard?demo=1',
    captureHints: [
      'default landing state',
      'demo badge',
      'counts for events, workflow runs, agent tasks, retries, and command audit rows',
    ],
  },
  {
    id: 'events-handler-retry-detail',
    tab: 'events',
    url: '/ja/dashboard?demo=1&tab=events&source=github&event=evt_demo_github_issue_272',
    captureHints: [
      'GitHub issue event',
      'handler retry count',
      'detail pane retry metadata',
    ],
  },
  {
    id: 'workflow-runs-failed-retry',
    tab: 'workflow-runs',
    url: '/ja/dashboard/runs?demo=1&status=failed&run=act_demo_workflow_failed_retry',
    captureHints: [
      'failed workflow row',
      'retry-oriented summary',
      'source event link',
    ],
  },
  {
    id: 'agent-tasks-running-actions',
    tab: 'agent-tasks',
    url: '/ja/dashboard/tasks?demo=1&task=agent_task_demo_running',
    captureHints: [
      'running task detail',
      'resume attempt timeline',
      'demo-only operator action buttons and audit coverage',
    ],
  },
  {
    id: 'sources-last-deliveries',
    tab: 'sources',
    url: '/ja/dashboard?demo=1&tab=sources',
    captureHints: [
      'GitHub webhook source',
      'Cloudflare tail source',
      'manual chat source',
      'last delivery chips',
    ],
  },
  {
    id: 'queue-blocked-stale-claim',
    tab: 'queue',
    url: '/ja/dashboard?demo=1&tab=queue&status=blocked',
    captureHints: [
      'blocked queue filter',
      'stale project claim warning',
      'queue summary counts',
    ],
  },
  {
    id: 'settings-retry-auth',
    tab: 'settings',
    url: '/ja/dashboard?demo=1&tab=settings',
    captureHints: [
      'retry policy setting',
      'dashboard auth setting',
      'runtime and snapshot settings',
    ],
  },
  {
    id: 'dashboard-cards-default-layout',
    tab: 'overview',
    url: '/ja/dashboard?demo=1&tab=overview',
    captureHints: [
      'default core card layout',
      'card picker with core cards',
      'layout save controls idle state',
    ],
  },
  {
    id: 'dashboard-cards-mobile-layout',
    tab: 'overview',
    url: '/ja/dashboard?demo=1&tab=overview',
    viewport: 'mobile',
    captureHints: [
      'mobile single-column layout tools',
      'card picker does not overlap controls',
      'dashboard cards remain readable on narrow screens',
    ],
  },
]);
