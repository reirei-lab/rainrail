import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { createRainrailHttpApp } from '../src/http-app.js';
import { SqliteOperationalStore } from '../src/operational-store.js';
import type { RainrailIntakeAdapter } from '../src/intake-adapter.js';
import type { ProjectIssue } from '../src/project-issues.js';

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
