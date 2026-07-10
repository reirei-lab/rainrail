/**
 * Stable capture targets for SQLite-backed dashboard demo review.
 *
 * The repository does not ship a browser/VRT runner yet. Keep this manifest
 * deterministic so a future Playwright job can capture the same dashboard
 * states without rediscovering which records exercise retries, stale claims,
 * command audit rows, and each dashboard tab.
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
    url: '/ja/dashboard?demo=1&tab=events&event=evt_demo_github_issue_272',
    captureHints: [
      'GitHub issue event',
      'handler retry count',
      'detail pane retry metadata',
    ],
  },
  {
    id: 'workflow-runs-failed-retry',
    tab: 'workflow-runs',
    url: '/ja/dashboard?demo=1&tab=workflow-runs&status=failed&run=act_demo_workflow_failed_retry',
    captureHints: [
      'failed workflow row',
      'retry-oriented summary',
      'source event link',
    ],
  },
  {
    id: 'agent-tasks-running-actions',
    tab: 'agent-tasks',
    url: '/ja/dashboard?demo=1&tab=agent-tasks&task=agent_task_demo_running',
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
    url: '/ja/dashboard?demo=1&tab=overview&panel=cards',
    captureHints: [
      'default core card layout',
      'card picker with core cards',
      'layout save controls idle state',
    ],
  },
  {
    id: 'dashboard-cards-custom-plugin-layout',
    tab: 'overview',
    url: '/ja/dashboard?demo=1&tab=overview&panel=cards&layout=custom',
    captureHints: [
      'saved user layout',
      'plugin card catalog entry',
      'per-card settings affordance',
    ],
  },
  {
    id: 'dashboard-cards-plugin-failure-shell',
    tab: 'overview',
    url: '/ja/dashboard?demo=1&tab=overview&panel=cards&pluginCardFailure=1',
    captureHints: [
      'unavailable plugin card warning',
      'dashboard shell remains interactive',
      'core cards still render beside failed plugin card',
    ],
  },
  {
    id: 'dashboard-cards-mobile-layout',
    tab: 'overview',
    url: '/ja/dashboard?demo=1&tab=overview&panel=cards',
    viewport: 'mobile',
    captureHints: [
      'mobile single-column layout tools',
      'card picker does not overlap controls',
      'dashboard cards remain readable on narrow screens',
    ],
  },
]);
