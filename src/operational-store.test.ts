import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';

import { createEventEnvelope } from './events.js';
import { createRainrailHttpApp } from './http-app.js';
import { JsonFileOperationalStore, RainrailOperationalStore, SqliteOperationalStore } from './operational-store.js';

describe('RainrailOperationalStore', () => {
  it('keeps the module importable on Node versions without a static node:sqlite import', () => {
    const source = readFileSync(new URL('./operational-store.ts', import.meta.url), 'utf8');
    expect(source).not.toContain("from 'node:sqlite'");
  });

  it('migrates an existing JSON-backed RainrailOperationalStore file into SQLite', () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      const jsonStore = new JsonFileOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });
      const event = jsonStore.recordEvent(fixtureEvent('delivery-json-migration', 'github.issue'));
      const activity = jsonStore.recordActivityEvent({
        category: 'plugin',
        targetType: 'event',
        targetId: event.id,
        actionType: 'plugin_executed',
        outcome: 'success',
        summary: 'legacy activity',
      });
      const command = jsonStore.recordCommandResult({
        actionType: 'agent_task_resume',
        targetType: 'agent_task',
        targetId: 'agent_task_legacy',
        status: 'accepted',
        actor: 'operator',
        requestId: 'request-legacy',
        dryRun: false,
      });
      const task = jsonStore.recordAgentTask({
        id: 'agent_task_legacy',
        title: 'legacy task',
        branchName: 'agent/reirei-lab-rainrail-legacy',
        status: 'running',
      });
      jsonStore.recordEventHandlerRetry({
        eventId: event.id,
        handlerName: 'legacy-handler',
        nextRetryAt: '2026-07-02T01:00:00.000Z',
        lastError: 'legacy retry',
      });
      const retry = jsonStore.getEventHandlerRetry(event.id, 'legacy-handler')!;
      expect(jsonStore.claimEventHandlerRetry(
        retry,
        '2026-07-02T02:00:00.000Z',
        '2026-07-02T01:00:00.000Z',
      )).toBe(true);
      jsonStore.close();

      const migrated = new RainrailOperationalStore({
        databasePath,
        eventLimit: 10,
        now: () => new Date('2026-07-03T01:23:45.000Z'),
      });
      expect(migrated.snapshot()).toMatchObject({
        counts: { events: 1, activityEvents: 1, agentTasks: 1, commandResults: 1, eventHandlerRetries: 1 },
        events: [{ id: event.id }],
        activityEvents: [{ id: 'act_000001', summary: 'legacy activity', createdAt: activity.createdAt }],
        agentTasks: [{ id: task.id, updatedAt: task.updatedAt }],
        commandResults: [{ id: 'cmd_000001', requestId: 'request-legacy', createdAt: command.createdAt }],
        eventHandlerRetries: [{
          eventId: event.id,
          handlerName: 'legacy-handler',
          updatedAt: '2026-07-02T01:00:00.000Z',
          claimedUntilAt: '2026-07-02T02:00:00.000Z',
        }],
      });
      expect(migrated.listDueEventHandlerRetries('2026-07-02T01:30:00.000Z')).toEqual([]);
      migrated.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare('select count(*) as count from operational_events').get()).toEqual({ count: 1 });
      } finally {
        database.close();
      }
      expect(existsSync(`${databasePath}.json-backup`)).toBe(true);
    } finally {
      cleanup();
    }
  });

  it('checks SQLite availability before moving a legacy JSON store aside', () => {
    const source = readFileSync(new URL('./operational-store.ts', import.meta.url), 'utf8');
    expect(source.indexOf('const DatabaseSync = loadDatabaseSync()')).toBeLessThan(
      source.indexOf('moveLegacyJsonStore'),
    );
  });

  it('restricts SQLite database and sidecar file permissions', () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      const store = new RainrailOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });
      store.recordEvent(fixtureEvent('delivery-permissions', 'github.issue'));
      store.recordActivityEvent({
        category: 'plugin',
        targetType: 'event',
        actionType: 'plugin_executed',
        outcome: 'success',
        summary: 'permission check',
      });

      for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        if (!existsSync(path)) continue;
        expect(statMode(path)).toBe(0o600);
      }
      store.close();
    } finally {
      cleanup();
    }
  });

  it('configures SQLite connections to wait briefly for write locks during sequence allocation', () => {
    const source = readFileSync(new URL('./operational-store.ts', import.meta.url), 'utf8');
    expect(source).toContain('PRAGMA busy_timeout = 5000');
  });

  it('uses SQLite-backed tables for local file persistence without storing raw provider payloads', () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      const store = new SqliteOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });
      const event = store.recordEvent(createEventEnvelope({
        source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
        name: 'github.issue',
        delivery: { id: 'delivery-raw-secret', receivedAt: '2026-07-02T00:00:00.000Z' },
        occurredAt: '2026-07-02T00:00:00.000Z',
        subject: { type: 'issue', id: '270' },
        payload: { action: 'opened', safe: true },
        rawPayload: {
          kind: 'inline-redacted',
          reference: 'raw-provider-secret-token',
          contentType: 'application/json',
        },
      }));
      store.recordActivityEvent({
        sourceEventId: event.id,
        sourceEventName: event.name,
        category: 'plugin',
        targetType: 'event',
        actionType: 'plugin_executed',
        outcome: 'success',
        summary: 'plugin execution completed',
        metadata: { provider: { installationId: 12345 } },
      });
      store.recordAgentTask({
        id: 'agent_task_rainrail_270',
        title: 'sqlite operational store',
        branchName: 'agent/reirei-lab-rainrail-270-operational-store-sqlite-backed',
        status: 'running',
        issue: { repository: 'reirei-lab/rainrail', number: 270 },
        claim: { projectItemId: 'PVTI_270' },
      });
      store.recordCommandResult({
        actionType: 'agent_task_resume',
        targetType: 'agent_task',
        targetId: 'agent_task_rainrail_270',
        status: 'accepted',
        actor: 'operator',
        requestId: 'request-270',
        dryRun: false,
        metadata: { runtime: { provider: 'local-node' } },
      });
      store.recordEventHandlerRetry({
        eventId: event.id,
        handlerName: 'review-request',
        nextRetryAt: '2026-07-02T01:00:00.000Z',
        lastError: 'GitHub GraphQL request failed with HTTP 503',
      });
      store.close();

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(database.prepare('select count(*) as count from operational_events').get()).toEqual({ count: 1 });
        expect(database.prepare('select json_extract(metadata_json, ?) as providerId from activity_events').get('$.provider.installationId'))
          .toEqual({ providerId: 12345 });
        expect(JSON.stringify(database.prepare('select * from operational_events').all())).not.toContain('raw-provider-secret-token');
      } finally {
        database.close();
      }

      const reopened = new SqliteOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });
      expect(reopened.snapshot()).toMatchObject({
        counts: {
          events: 1,
          activityEvents: 1,
          agentTasks: 1,
          commandResults: 1,
          eventHandlerRetries: 1,
        },
        events: [{
          id: event.id,
          envelope: {
            payload: { action: 'opened', safe: true },
            rawPayload: { kind: 'inline-redacted', reference: 'rainrail://redacted/raw-payload' },
          },
        }],
      });
      reopened.close();
    } finally {
      cleanup();
    }
  });

  it('preserves safe inline-redacted raw payload references for dashboard tracing', () => {
    const store = new RainrailOperationalStore({ databasePath: ':memory:', eventLimit: 10, now: fixedClock() });
    const event = store.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-inline-safe', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '270' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'inline-redacted',
        reference: 'github://deliveries/delivery-inline-safe',
        sha256: '0'.repeat(64),
      },
    }));

    expect(store.getEvent(event.id)?.envelope.rawPayload).toEqual({
      kind: 'inline-redacted',
      reference: 'github://deliveries/delivery-inline-safe',
      sha256: '0'.repeat(64),
    });
    store.close();
  });

  it('serves the dashboard v1 resource surface from a SQLite-backed store', async () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      const operationalStore = new SqliteOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });
      const event = operationalStore.recordEvent(fixtureEvent('delivery-dashboard-sqlite', 'github.issue'));
      const workflow = operationalStore.recordActivityEvent({
        sourceEventId: event.id,
        sourceEventName: event.name,
        category: 'workflow',
        targetType: 'event',
        targetId: event.id,
        actionType: 'workflow_dispatched',
        outcome: 'success',
        summary: 'workflow dispatched',
      });
      operationalStore.recordAgentTask({
        id: 'agent_task_dashboard_sqlite',
        title: 'dashboard sqlite task',
        branchName: 'agent/reirei-lab-rainrail-270-dashboard-sqlite',
      });
      operationalStore.recordEventHandlerRetry({
        eventId: event.id,
        handlerName: 'dashboard-handler',
        nextRetryAt: '2026-07-02T01:00:00.000Z',
        lastError: 'fetch failed',
      });

      const app = createRainrailHttpApp({
        room: { fetch: () => Response.json({ ok: true }) },
        publishToken: 'publish-token',
        dashboardAuth: { readOnlyToken: 'dashboard-token' },
        operationalStore,
      });
      const headers = { authorization: 'Bearer dashboard-token' };

      await expect((await app.fetch(new Request('https://rainrail.local/api/v1/overview', { headers }))).json())
        .resolves.toMatchObject({ data: { counts: { events: 1, activityEvents: 1, agentTasks: 1, eventHandlerRetries: 1 } } });
      await expect((await app.fetch(new Request('https://rainrail.local/api/v1/events', { headers }))).json())
        .resolves.toMatchObject({ data: [{ id: event.id, handlerRetryCount: 1 }] });
      await expect((await app.fetch(new Request(`https://rainrail.local/api/v1/workflow-runs/${workflow.id}`, { headers }))).json())
        .resolves.toMatchObject({ data: { id: workflow.id, record: { summary: 'workflow dispatched' } } });
      await expect((await app.fetch(new Request('https://rainrail.local/api/v1/agent-tasks/agent_task_dashboard_sqlite', { headers }))).json())
        .resolves.toMatchObject({ data: { id: 'agent_task_dashboard_sqlite', record: { status: 'running' } } });

      operationalStore.close();
    } finally {
      cleanup();
    }
  });

  it('persists events, activity, tasks, and retry records for dashboard snapshots', () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      const first = new RainrailOperationalStore({ databasePath, eventLimit: 1, now: fixedClock() });
      const older = fixtureEvent('delivery-1', 'github.issue');
      const latest = fixtureEvent('delivery-2', 'github.pull_request');

      first.recordEvent(older);
      first.recordEvent(latest);
      first.recordActivityEvent({
        category: 'plugin',
        targetType: 'event',
        targetId: latest.id,
        actionType: 'plugin_executed',
        outcome: 'success',
        summary: 'plugin execution completed',
        metadata: { pluginName: 'review-request' },
      });
      first.recordAgentTask({
        id: 'agent_task_rainrail_25',
        title: 'store、retry/reconcile、dashboard/API を移植する',
        agentSessionId: 'agent:main:rainrail-25',
        branchName: 'agent/reirei-lab-rainrail-25-store-retry-reconcile-dashboard-api',
        status: 'running',
        issue: { repository: 'reirei-lab/rainrail', number: 25 },
        logPath: 'var/agent-task-logs/rainrail-25.log',
        resumeAttempts: [{
          id: 'resume-01',
          status: 'running',
          logPath: 'var/agent-task-logs/rainrail-25-resume.log',
          stderrLogPath: 'var/agent-task-logs/rainrail-25-resume.stderr.log',
        }],
        pid: 12345,
      });
      first.recordEventHandlerRetry({
        eventId: latest.id,
        handlerName: 'review-request',
        nextRetryAt: '2026-07-02T01:00:00.000Z',
        lastError: 'GitHub GraphQL request failed with HTTP 503',
      });
      first.recordCommandResult({
        actionType: 'agent_task_resume',
        targetType: 'agent_task',
        targetId: 'agent_task_rainrail_25',
        status: 'accepted',
        actor: 'operator',
        client: 'dashboard',
        requestId: 'request-resume',
        dryRun: false,
        result: { resumed: true },
      });
      first.close();

      const second = new RainrailOperationalStore({ databasePath, eventLimit: 1, now: fixedClock() });
      expect(second.getEvent(older.id)?.name).toBe('github.issue');
      expect(second.getEvent(latest.id)?.delivery.id).toBe('delivery-2');
      expect(second.getAgentTaskByBranchName('agent/reirei-lab-rainrail-25-store-retry-reconcile-dashboard-api')?.id)
        .toBe('agent_task_rainrail_25');
      expect(second.getEventHandlerRetry(latest.id, 'review-request')).toMatchObject({
        attempts: 1,
        lastError: 'GitHub GraphQL request failed with HTTP 503',
      });
      expect(second.snapshot()).toMatchObject({
        counts: {
          events: 2,
          activityEvents: 1,
          agentTasks: 1,
          commandResults: 1,
          eventHandlerRetries: 1,
        },
        events: [{ id: latest.id, name: 'github.pull_request' }],
        activityEvents: [{ summary: 'plugin execution completed' }],
        agentTasks: [{
          id: 'agent_task_rainrail_25',
          runtime: { status: 'running', pid: 12345 },
          resumeAttempts: [{
            id: 'resume-01',
            logPath: 'var/agent-task-logs/rainrail-25-resume.log',
            stderrLogPath: 'var/agent-task-logs/rainrail-25-resume.stderr.log',
          }],
        }],
        commandResults: [{
          id: 'cmd_000001',
          actionType: 'agent_task_resume',
          targetId: 'agent_task_rainrail_25',
          status: 'accepted',
          actor: 'operator',
          requestId: 'request-resume',
          result: { resumed: true },
        }],
      });
      second.close();
    } finally {
      cleanup();
    }
  });

  it('lists due handler retries in schedule order and clears them after success', () => {
    const store = new RainrailOperationalStore({ databasePath: ':memory:', eventLimit: 10, now: fixedClock() });
    const event = store.recordEvent(fixtureEvent('delivery-1', 'github.issue'));

    store.recordEventHandlerRetry({
      eventId: event.id,
      handlerName: 'slow-handler',
      nextRetryAt: '2026-07-02T01:05:00.000Z',
      lastError: 'fetch failed',
    });
    store.recordEventHandlerRetry({
      eventId: event.id,
      handlerName: 'fast-handler',
      nextRetryAt: '2026-07-02T01:00:00.000Z',
      lastError: 'rate limited',
    });

    expect(store.listDueEventHandlerRetries('2026-07-02T01:01:00.000Z').map((retry) => retry.handlerName))
      .toEqual(['fast-handler']);

    store.clearEventHandlerRetry(event.id, 'fast-handler');

    expect(store.getEventHandlerRetry(event.id, 'fast-handler')).toBeUndefined();
    expect(store.snapshot().counts.eventHandlerRetries).toBe(1);
    store.close();
  });

  it('claims retry rows atomically across store connections', () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      const first = new RainrailOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });
      const second = new RainrailOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });
      const event = first.recordEvent(fixtureEvent('delivery-1', 'github.issue'));
      first.recordEventHandlerRetry({
        eventId: event.id,
        handlerName: 'review-request',
        nextRetryAt: '2026-07-02T01:00:00.000Z',
        lastError: 'fetch failed',
      });
      const firstRetry = first.getEventHandlerRetry(event.id, 'review-request')!;
      const staleSecondRetry = second.getEventHandlerRetry(event.id, 'review-request')!;

      expect(first.claimEventHandlerRetry(
        firstRetry,
        '2026-07-02T01:05:00.000Z',
        '2026-07-02T01:00:00.000Z',
      )).toBe(true);
      expect(second.claimEventHandlerRetry(
        staleSecondRetry,
        '2026-07-02T01:05:00.000Z',
        '2026-07-02T01:00:00.000Z',
      )).toBe(false);
      expect(first.getEventHandlerRetry(event.id, 'review-request')).toMatchObject({
        claimedUntilAt: '2026-07-02T01:05:00.000Z',
      });

      first.close();
      second.close();
    } finally {
      cleanup();
    }
  });

  it('generates unique sequence ids across store connections', () => {
    const { databasePath, cleanup } = temporaryDatabasePath();
    try {
      const first = new RainrailOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });
      const second = new RainrailOperationalStore({ databasePath, eventLimit: 10, now: fixedClock() });

      const firstActivity = first.recordActivityEvent({
        category: 'plugin',
        targetType: 'event',
        actionType: 'plugin_executed',
        outcome: 'success',
        summary: 'first activity',
      });
      const secondActivity = second.recordActivityEvent({
        category: 'plugin',
        targetType: 'event',
        actionType: 'plugin_executed',
        outcome: 'success',
        summary: 'second activity',
      });

      expect(firstActivity.id).toBe('act_000001');
      expect(secondActivity.id).toBe('act_000002');

      const firstCommand = first.recordCommandResult({
        actionType: 'agent_task_resume',
        targetType: 'agent_task',
        targetId: 'agent_task_first',
        status: 'accepted',
        actor: 'operator',
        requestId: 'request-first',
        dryRun: false,
      });
      const secondCommand = second.recordCommandResult({
        actionType: 'agent_task_resume',
        targetType: 'agent_task',
        targetId: 'agent_task_second',
        status: 'accepted',
        actor: 'operator',
        requestId: 'request-second',
        dryRun: false,
      });

      expect(firstCommand.id).toBe('cmd_000001');
      expect(secondCommand.id).toBe('cmd_000002');
      first.close();
      second.close();
    } finally {
      cleanup();
    }
  });

  it('preserves existing runtime metadata when re-recording a task with partial updates', () => {
    const store = new RainrailOperationalStore({ databasePath: ':memory:', eventLimit: 10, now: fixedClock() });
    store.recordAgentTask({
      id: 'agent_task_rainrail_25',
      title: 'initial run',
      agentSessionId: 'agent:main:rainrail-25',
      branchName: 'agent/reirei-lab-rainrail-25-store-retry-reconcile-dashboard-api',
      status: 'running',
      issue: { repository: 'reirei-lab/rainrail', number: 25 },
      claim: { projectItemId: 'PVTI_item' },
      logPath: 'var/log/rainrail-25.log',
      stderrLogPath: 'var/log/rainrail-25.stderr.log',
      pid: 123,
      resumeAttempts: [{
        id: 'resume-01',
        status: 'running',
        logPath: 'var/log/rainrail-25-resume.log',
      }],
    });

    store.recordAgentTask({
      id: 'agent_task_rainrail_25',
      title: 'completed run',
      branchName: 'agent/reirei-lab-rainrail-25-store-retry-reconcile-dashboard-api',
      status: 'succeeded',
      result: 'Outcome: implemented',
      completedAt: '2026-07-02T01:30:00.000Z',
    });

    expect(store.getAgentTask('agent_task_rainrail_25')).toMatchObject({
      title: 'completed run',
      agentSessionId: 'agent:main:rainrail-25',
      branchName: 'agent/reirei-lab-rainrail-25-store-retry-reconcile-dashboard-api',
      status: 'succeeded',
      issue: { repository: 'reirei-lab/rainrail', number: 25 },
      claim: { projectItemId: 'PVTI_item' },
      logPath: 'var/log/rainrail-25.log',
      stderrLogPath: 'var/log/rainrail-25.stderr.log',
      pid: 123,
      resumeAttempts: [{
        id: 'resume-01',
        status: 'running',
        logPath: 'var/log/rainrail-25-resume.log',
      }],
      result: 'Outcome: implemented',
      completedAt: '2026-07-02T01:30:00.000Z',
    });
    store.close();
  });

  it('clears a previous project claim release state when re-recording a task for a new claim', () => {
    const store = new RainrailOperationalStore({ databasePath: ':memory:', eventLimit: 10, now: fixedClock() });
    store.recordAgentTask({
      id: 'agent_task_rainrail_47',
      title: 'stale claim recovery',
      agentSessionId: 'agent:main:rainrail-47-first',
      branchName: 'agent/reirei-lab-rainrail-47-first',
      status: 'stopped',
      issue: { id: 'item_47', repository: 'reirei-lab/rainrail', number: 47 },
      claim: { projectItemId: 'item_47', lockRefId: 'REF_first' },
      projectClaim: {
        status: 'released',
        reason: 'runtime stopped',
        updatedAt: '2026-07-02T00:05:00.000Z',
      },
    });

    store.recordAgentTask({
      id: 'agent_task_rainrail_47',
      title: 'stale claim recovery',
      agentSessionId: 'agent:main:rainrail-47-second',
      branchName: 'agent/reirei-lab-rainrail-47-second',
      status: 'running',
      issue: { id: 'item_47', repository: 'reirei-lab/rainrail', number: 47 },
      claim: { projectItemId: 'item_47', lockRefId: 'REF_second' },
    });

    expect(store.getAgentTask('agent_task_rainrail_47')).toMatchObject({
      status: 'running',
      agentSessionId: 'agent:main:rainrail-47-second',
      branchName: 'agent/reirei-lab-rainrail-47-second',
      claim: { lockRefId: 'REF_second' },
    });
    expect(store.getAgentTask('agent_task_rainrail_47')?.projectClaim).toBeUndefined();
    store.close();
  });
});

function fixtureEvent(deliveryId: string, name: 'github.issue' | 'github.pull_request') {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name,
    delivery: { id: deliveryId, receivedAt: '2026-07-02T00:00:00.000Z' },
    occurredAt: '2026-07-02T00:00:00.000Z',
    subject: { type: name === 'github.issue' ? 'issue' : 'pull_request', id: '25' },
    payload: { action: 'opened' },
    rawPayload: { kind: 'external-reference', reference: `github://deliveries/${deliveryId}` },
  });
}

function temporaryDatabasePath(): { databasePath: string; cleanup: () => void } {
  const directory = mkdtempSync(join(tmpdir(), 'rainrail-operational-store-'));
  return {
    databasePath: join(directory, 'state.sqlite'),
    cleanup: () => rmSync(directory, { force: true, recursive: true }),
  };
}

function fixedClock(): () => Date {
  return () => new Date('2026-07-02T01:23:45.000Z');
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
