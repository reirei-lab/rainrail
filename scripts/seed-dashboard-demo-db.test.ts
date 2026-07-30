import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createDashboardCardRegistry, defineDashboardCard } from '../src/dashboard-card-registry.js';
import { createDashboardCardSandboxHost } from '../src/dashboard-card-sandbox.js';
import { createRainrailHttpApp } from '../src/http-app.js';
import { SqliteOperationalStore } from '../src/operational-store.js';
import type { RainrailIntakeAdapter } from '../src/intake-adapter.js';
import type { ProjectIssue } from '../src/project-issues.js';
import { dashboardDemoVrtScenarios } from './dashboard-demo-vrt-scenarios.mjs';

const seedScript = new URL('./seed-dashboard-demo-db.mjs', import.meta.url);

describe('dashboard demo SQLite seed script', () => {
  it('rebuilds a deterministic representative operational DB without raw provider data', async () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      writeFileSync(databasePath, 'stale demo database contents');

      const firstRun = runSeed(databasePath);
      expect(firstRun.status).toBe(0);
      expect(JSON.parse(firstRun.stdout)).toMatchObject({
        databasePath,
        counts: {
          events: 3,
          activityEvents: 4,
          agentTasks: 3,
          commandResults: 3,
          eventHandlerRetries: 2,
        },
      });

      const firstRows = await readDashboardResources(databasePath);
      const secondRun = runSeed(databasePath);
      expect(secondRun.status).toBe(0);
      const secondRows = await readDashboardResources(databasePath);

      expect(secondRows).toEqual(firstRows);
      expect(existsSync(databasePath)).toBe(true);

      const databaseText = readFileSync(databasePath).toString('utf8')
        + (existsSync(`${databasePath}-wal`) ? readFileSync(`${databasePath}-wal`).toString('utf8') : '');
      expect(databaseText).not.toContain('stale demo database contents');
      expect(databaseText).not.toContain('raw-provider-secret-token');
      expect(databaseText).not.toContain('ghp_');
      expect(databaseText).not.toContain('xoxb-');
      expect(databaseText).toContain('github://deliveries/gh-delivery-demo-001');
      expect(databaseText).toContain('cloudflare://tails/cf-tail-demo-001');
      expect(databaseText).toContain('chat://deliveries/chat-delivery-demo-001');
    } finally {
      cleanup();
    }
  });

  it('serves non-empty dashboard v1 resources from the seeded SQLite DB', async () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      expect(runSeed(databasePath).status).toBe(0);
      const store = new SqliteOperationalStore({ databasePath, eventLimit: 25 });
      try {
        const app = createRainrailHttpApp({
          room: { fetch: () => Response.json({ ok: true }) },
          publishToken: 'publish-token',
          runtime: 'node',
          dashboardAuth: {
            readOnlyToken: 'read-token',
            operatorToken: 'operator-token',
            adminToken: 'admin-token',
          },
          operationalStore: store,
          intakeAdapters: demoIntakeAdapters(),
          taskQueue: demoTaskQueue(),
        });
        const headers = { authorization: 'Bearer read-token' };

        await expect(getJson(app, '/api/v1/overview', headers))
          .resolves.toMatchObject({
            data: {
              counts: {
                events: 3,
                activityEvents: 4,
                agentTasks: 3,
                commandResults: 3,
                eventHandlerRetries: 2,
              },
              recentActivity: expect.arrayContaining([
                expect.objectContaining({ id: 'act_demo_workflow_success', status: 'success' }),
                expect.objectContaining({ id: 'act_demo_workflow_failed_retry', status: 'failed' }),
              ]),
            },
          });
        await expect(getJson(app, '/api/v1/events', headers))
          .resolves.toMatchObject({
            data: expect.arrayContaining([
              expect.objectContaining({ id: 'evt_demo_github_issue_272', handlerRetryCount: 1 }),
              expect.objectContaining({ id: 'evt_demo_cloudflare_tail_001', handlerRetryCount: 1 }),
              expect.objectContaining({ id: 'evt_demo_manual_chat_001' }),
            ]),
          });
        await expect(getJson(app, '/api/v1/workflow-runs', headers))
          .resolves.toMatchObject({
            data: expect.arrayContaining([
              expect.objectContaining({ id: 'act_demo_workflow_success', status: 'success' }),
              expect.objectContaining({ id: 'act_demo_workflow_failed_retry', status: 'failed' }),
              expect.objectContaining({ id: 'act_demo_workflow_skipped_non_command', status: 'skipped' }),
            ]),
          });
        await expect(getJson(app, '/api/v1/agent-tasks', headers))
          .resolves.toMatchObject({
            data: expect.arrayContaining([
              expect.objectContaining({ id: 'agent_task_demo_running', status: 'running' }),
              expect.objectContaining({ id: 'agent_task_demo_succeeded', status: 'succeeded' }),
              expect.objectContaining({
                id: 'agent_task_demo_failed_stale_claim',
                status: 'stopped',
                warnings: { staleProjectClaim: true },
              }),
            ]),
          });
        await expect(getJson(app, '/api/v1/sources', headers))
          .resolves.toMatchObject({
            data: expect.arrayContaining([
              expect.objectContaining({
                id: 'github-webhook',
                sourceType: 'github',
                endpoint: '/webhooks/github',
                auth: { status: 'configured' },
                lastDelivery: expect.objectContaining({ id: 'gh-delivery-demo-001' }),
              }),
              expect.objectContaining({
                id: 'cloudflare-tail',
                sourceType: 'cloudflare',
                transport: 'tail',
                lastDelivery: expect.objectContaining({ id: 'cf-tail-demo-001' }),
              }),
              expect.objectContaining({
                id: 'manual-chat',
                sourceType: 'chat',
                endpoint: '/manual/chat',
                lastDelivery: expect.objectContaining({ id: 'chat-delivery-demo-001' }),
              }),
            ]),
          });
        await expect(getJson(app, '/api/v1/queue', headers))
          .resolves.toMatchObject({
            data: expect.arrayContaining([
              expect.objectContaining({ id: 'agent_task_demo_running', status: 'in-progress' }),
              expect.objectContaining({ id: 'agent_task_demo_failed_stale_claim', status: 'blocked' }),
            ]),
            summary: expect.objectContaining({
              blockedCount: 1,
              claimedCount: 2,
              staleClaimCount: 1,
              upcomingIssues: 1,
            }),
          });
        await expect(getJson(app, '/api/v1/settings', headers))
          .resolves.toMatchObject({
            data: expect.arrayContaining([
              expect.objectContaining({ id: 'max-concurrency', value: '2 agent tasks' }),
              expect.objectContaining({ id: 'retry-policy', value: '2 retries pending' }),
              expect.objectContaining({ id: 'dashboard-auth', value: 'bearer token configured' }),
              expect.objectContaining({ id: 'runtime', value: 'node' }),
            ]),
          });

        await expect(getJson(app, '/api/v1/events/evt_demo_github_issue_272', headers))
          .resolves.toMatchObject({
            data: {
              id: 'evt_demo_github_issue_272',
              record: {
                envelope: {
                  rawPayload: {
                    reference: 'github://deliveries/gh-delivery-demo-001',
                    sha256: 'a4c778f8a28149d589f1121118720b3b08b2fbe03df801e6290e4fedc27357b7',
                  },
                },
                activityEvents: expect.arrayContaining([
                  expect.objectContaining({ id: 'act_demo_workflow_success' }),
                ]),
              },
            },
          });
        await expect(getJson(app, '/api/v1/agent-tasks/agent_task_demo_running', headers))
          .resolves.toMatchObject({
            data: {
              record: {
                pid: 4242,
                resumeAttempts: [expect.objectContaining({ id: 'resume-demo-001', status: 'running' })],
                runtime: expect.objectContaining({ status: 'running', pid: 4242 }),
              },
            },
          });
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });

  it('backs every dashboard demo VRT scenario with representative SQLite API data', async () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      expect(runSeed(databasePath).status).toBe(0);
      const store = new SqliteOperationalStore({ databasePath, eventLimit: 25 });
      try {
        const app = createRainrailHttpApp({
          room: { fetch: () => Response.json({ ok: true }) },
          publishToken: 'publish-token',
          runtime: 'node',
          dashboardAuth: {
            readOnlyToken: 'read-token',
            operatorToken: 'operator-token',
            adminToken: 'admin-token',
          },
          operationalStore: store,
          intakeAdapters: demoIntakeAdapters(),
          taskQueue: demoTaskQueue(),
        });
        const headers = { authorization: 'Bearer read-token' };

        expect(dashboardDemoVrtScenarios).toEqual([
          expect.objectContaining({ id: 'overview-demo-summary', tab: 'overview' }),
          expect.objectContaining({ id: 'events-handler-retry-detail', tab: 'events' }),
          expect.objectContaining({ id: 'workflow-runs-failed-retry', tab: 'workflow-runs' }),
          expect.objectContaining({ id: 'agent-tasks-running-actions', tab: 'agent-tasks' }),
          expect.objectContaining({ id: 'sources-last-deliveries', tab: 'sources' }),
          expect.objectContaining({ id: 'queue-blocked-stale-claim', tab: 'queue' }),
          expect.objectContaining({ id: 'settings-retry-auth', tab: 'settings' }),
          expect.objectContaining({ id: 'dashboard-cards-default-layout', tab: 'overview' }),
          expect.objectContaining({ id: 'dashboard-cards-mobile-layout', tab: 'overview', viewport: 'mobile' }),
        ]);
        for (const scenario of dashboardDemoVrtScenarios) {
          expect(scenario.url).toMatch(/^\/(?:ja|en)\/dashboard(?:\/[a-z-]+)?\?demo=1\b/);
          expect(scenario.captureHints.length).toBeGreaterThan(0);
        }

        const overview = await getJson(app, '/api/v1/overview', headers);
        expect(overview.data).toMatchObject({
          counts: {
            events: 3,
            activityEvents: 4,
            agentTasks: 3,
            commandResults: 3,
            eventHandlerRetries: 2,
          },
          warnings: {
            staleProjectClaims: [
              expect.objectContaining({ taskId: 'agent_task_demo_failed_stale_claim' }),
            ],
          },
        });

        const retryEvents = await getJson(app, '/api/v1/events?filter[source]=github', headers);
        expect(retryEvents.data).toEqual(expect.arrayContaining([
          expect.objectContaining({
            id: 'evt_demo_github_issue_272',
            handlerRetryCount: 1,
            latestOutcome: 'success',
          }),
        ]));
        const retryEventDetail = await getJson(app, '/api/v1/events/evt_demo_github_issue_272', headers);
        expect(retryEventDetail.data.record.handlerRetries).toEqual([
          expect.objectContaining({
            handlerName: 'agent-assignment-dispatch',
            attempts: 1,
            lastError: expect.stringContaining('waiting for capacity'),
          }),
        ]);

        const failedWorkflowRuns = await getJson(app, '/api/v1/workflow-runs?filter[status]=failed', headers);
        expect(failedWorkflowRuns.data).toEqual([
          expect.objectContaining({
            id: 'act_demo_workflow_failed_retry',
            status: 'failed',
            sourceEventId: 'evt_demo_cloudflare_tail_001',
          }),
        ]);

        const runningTasks = await getJson(app, '/api/v1/agent-tasks?filter[status]=running', headers);
        expect(runningTasks.data).toEqual([
          expect.objectContaining({ id: 'agent_task_demo_running', status: 'running' }),
        ]);
        const runningTaskDetail = await getJson(app, '/api/v1/agent-tasks/agent_task_demo_running', headers);
        expect(runningTaskDetail.data.record.resumeAttempts).toEqual([
          expect.objectContaining({ id: 'resume-demo-001', status: 'running' }),
        ]);
        expect(store.snapshot().commandResults).toEqual([
          expect.objectContaining({ actionType: 'queue_assign_next', status: 'failed', dryRun: false }),
          expect.objectContaining({ actionType: 'settings_update', status: 'preview', dryRun: true }),
          expect.objectContaining({ actionType: 'agent_task_resume', status: 'accepted', dryRun: false }),
        ]);

        const sources = await getJson(app, '/api/v1/sources', headers);
        expect(sources.data).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'github-webhook', lastDelivery: expect.objectContaining({ id: 'gh-delivery-demo-001' }) }),
          expect.objectContaining({ id: 'cloudflare-tail', lastDelivery: expect.objectContaining({ id: 'cf-tail-demo-001' }) }),
          expect.objectContaining({ id: 'manual-chat', lastDelivery: expect.objectContaining({ id: 'chat-delivery-demo-001' }) }),
        ]));

        const blockedQueue = await getJson(app, '/api/v1/queue?filter[status]=blocked', headers);
        expect(blockedQueue).toMatchObject({
          data: [
            expect.objectContaining({
              id: 'agent_task_demo_failed_stale_claim',
              status: 'blocked',
              blockedReason: expect.stringContaining('stale'),
            }),
          ],
          summary: {
            blockedCount: 1,
            staleClaimCount: 1,
          },
        });

        const settings = await getJson(app, '/api/v1/settings', headers);
        expect(settings.data).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: 'retry-policy', value: '2 retries pending' }),
          expect.objectContaining({ id: 'dashboard-auth', value: 'bearer token configured' }),
        ]));
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });

  it('backs dashboard card smoke and VRT states with layout, plugin failure, and mobile capture contracts', async () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      expect(runSeed(databasePath).status).toBe(0);
      const store = new SqliteOperationalStore({ databasePath, eventLimit: 25 });
      try {
        const registry = createDashboardCardRegistry();
        registry.register(defineDashboardCard({
          id: 'plugin:github.queue',
          title: 'GitHub queue',
          description: 'Open issue and pull request queue',
          entry: { type: 'plugin', pluginName: 'github', cardName: 'queue' },
          category: 'operations',
          requiredCapabilities: ['dashboard:read', 'github:read'],
          size: {
            default: { columns: 3, rows: 2 },
            min: { columns: 2, rows: 1 },
            max: { columns: 6, rows: 4 },
          },
          settingsSchema: {
            type: 'object',
            properties: {
              repository: { type: 'string' },
            },
            additionalProperties: false,
          },
        }));
        const app = createRainrailHttpApp({
          room: { fetch: () => Response.json({ ok: true }) },
          publishToken: 'publish-token',
          runtime: 'node',
          dashboardAuth: {
            readOnlyToken: 'read-token',
            operatorToken: 'operator-token',
            adminToken: 'admin-token',
          },
          operationalStore: store,
          intakeAdapters: demoIntakeAdapters(),
          taskQueue: demoTaskQueue(),
          dashboardCardRegistry: registry,
          dashboardCardCatalog: {
            availableCapabilities: ['dashboard:read', 'github:read'],
            enabledPlugins: ['github'],
          },
          dashboardDefaultLayout: [
            { id: 'operational-totals', cardId: 'core.operationalTotals', x: 0, y: 0, columns: 8, rows: 2 },
          ],
        });
        const readHeaders = { authorization: 'Bearer read-token' };

        const defaultLayout = await getJson(app, '/api/v1/dashboard/layout', readHeaders);
        expect(defaultLayout.data).toMatchObject({
          id: 'core.defaultLayout',
          source: 'default',
          filteredItemCount: 0,
          items: [
            expect.objectContaining({ id: 'operational-totals', cardId: 'core.operationalTotals' }),
          ],
        });

        const cards = await getJson(app, '/api/v1/dashboard/cards', readHeaders);
        expect(cards.data).toEqual(expect.arrayContaining([
          expect.objectContaining({
            definition: expect.objectContaining({
              id: 'plugin:github.queue',
              entry: { type: 'plugin', pluginName: 'github', cardName: 'queue' },
              settingsSchema: expect.objectContaining({
                properties: { repository: { type: 'string' } },
              }),
            }),
            availability: { status: 'available' },
          }),
        ]));

        const savedLayoutResponse = await app.fetch(new Request('https://rainrail.local/api/v1/dashboard/layout', {
          method: 'PUT',
          headers: {
            authorization: 'Bearer operator-token',
            'content-type': 'application/json',
            'x-rainrail-client': 'dashboard-vrt-smoke',
            'x-request-id': 'request-dashboard-cards-vrt',
          },
          body: JSON.stringify({
            items: [
              { id: 'operational-totals', cardId: 'core.operationalTotals', x: 0, y: 0, columns: 8, rows: 2 },
              {
                id: 'github-queue',
                cardId: 'plugin:github.queue',
                x: 8,
                y: 0,
                columns: 3,
                rows: 2,
                config: { repository: 'reirei-lab/rainrail' },
              },
            ],
          }),
        }));
        expect(savedLayoutResponse.status).toBe(200);
        await expect(savedLayoutResponse.json()).resolves.toMatchObject({
          data: {
            id: 'user.dashboardLayout',
            source: 'user',
            items: [
              expect.objectContaining({ id: 'operational-totals', cardId: 'core.operationalTotals' }),
              expect.objectContaining({
                id: 'github-queue',
                cardId: 'plugin:github.queue',
                config: { repository: 'reirei-lab/rainrail' },
              }),
            ],
          },
        });

        const sandboxHost = createDashboardCardSandboxHost({
          cardBaseUrl: '/dashboard/plugin-cards/',
          allowedCapabilities: ['dashboard:read'],
        });
        await expect(sandboxHost.load({
          id: 'plugin:github.queue',
          title: 'GitHub queue',
          entry: { type: 'plugin', pluginName: 'github', cardName: 'queue' },
          category: 'operations',
          requiredCapabilities: ['dashboard:read'],
          size: { default: { columns: 3, rows: 2 } },
        }, async () => {
          throw new Error('simulated plugin card bundle failure');
        })).resolves.toEqual({
          status: 'error',
          cardId: 'plugin:github.queue',
          error: 'Plugin card failed to load',
        });

        expect(dashboardDemoVrtScenarios.filter((scenario) => scenario.id.startsWith('dashboard-cards-')))
          .toEqual([
            expect.objectContaining({
              id: 'dashboard-cards-default-layout',
              captureHints: expect.arrayContaining(['collapsed dashboard layout customize control']),
            }),
            expect.objectContaining({
              id: 'dashboard-cards-mobile-layout',
              viewport: 'mobile',
              captureHints: expect.arrayContaining(['expanded mobile single-column layout tools']),
            }),
          ]);
      } finally {
        store.close();
      }
    } finally {
      cleanup();
    }
  });
});

function runSeed(databasePath: string) {
  return spawnSync(process.execPath, [seedScript.pathname, '--database', databasePath], {
    encoding: 'utf8',
  });
}

async function readDashboardResources(databasePath: string) {
  const store = new SqliteOperationalStore({ databasePath, eventLimit: 25 });
  try {
    return {
      events: store.listEvents(),
      activityEvents: store.listActivityEvents(),
      agentTasks: store.listAgentTasks(),
      commandResults: store.snapshot().commandResults,
      eventHandlerRetries: store.listEventHandlerRetries(),
    };
  } finally {
    store.close();
  }
}

async function getJson(app: ReturnType<typeof createRainrailHttpApp>, path: string, headers: Record<string, string>) {
  const response = await app.fetch(new Request(`https://rainrail.local${path}`, { headers }));
  expect(response.status).toBe(200);
  return response.json();
}

function demoIntakeAdapters(): RainrailIntakeAdapter[] {
  return [
    {
      name: 'github-webhook',
      source: { type: 'github', authStatus: 'configured' },
      routes: [{ path: '/webhooks/github', methods: ['POST'], handle: () => Response.json({ ok: true }) }],
    },
    {
      name: 'cloudflare-tail',
      source: { type: 'cloudflare', authStatus: 'configured' },
      tail: () => undefined,
    },
    {
      name: 'manual-chat',
      source: { type: 'chat', authStatus: 'not_required' },
      routes: [{ path: '/manual/chat', methods: ['POST'], handle: () => Response.json({ ok: true }) }],
    },
  ];
}

function demoTaskQueue() {
  const issues: ProjectIssue[] = [
    {
      id: 'project-demo-upcoming-300',
      contentType: 'Issue',
      title: 'Upcoming dashboard polish task',
      state: 'open',
      status: 'Todo',
      assigneeLogins: ['reirei-agent'],
      repository: 'reirei-lab/rainrail',
      number: 300,
      url: 'https://github.com/reirei-lab/rainrail/issues/300',
    },
    {
      id: 'project-demo-in-progress-301',
      contentType: 'Issue',
      title: 'Project status integration already in progress',
      state: 'open',
      status: 'In Progress',
      assigneeLogins: ['reirei-agent'],
      repository: 'reirei-lab/rainrail',
      number: 301,
      url: 'https://github.com/reirei-lab/rainrail/issues/301',
    },
  ];
  return {
    selection: {
      assigneeLogin: 'reirei-agent',
      todoStatus: 'Todo',
      inProgressStatus: 'In Progress',
      maxConcurrentAgentTasks: 2,
    },
    listProjectIssues: () => issues,
  };
}

function temporaryDatabasePath() {
  const directory = mkdtempSync(join(tmpdir(), 'rainrail-dashboard-demo-seed-'));
  const databasePath = join(directory, 'dashboard-demo.sqlite');
  return {
    databasePath,
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}
