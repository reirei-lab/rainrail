import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { createEventEnvelope } from './events.js';
import { RainrailOperationalStore } from './operational-store.js';

describe('RainrailOperationalStore', () => {
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
        pid: 12345,
      });
      first.recordEventHandlerRetry({
        eventId: latest.id,
        handlerName: 'review-request',
        nextRetryAt: '2026-07-02T01:00:00.000Z',
        lastError: 'GitHub GraphQL request failed with HTTP 503',
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
          eventHandlerRetries: 1,
        },
        events: [{ id: latest.id, name: 'github.pull_request' }],
        activityEvents: [{ summary: 'plugin execution completed' }],
        agentTasks: [{ id: 'agent_task_rainrail_25', runtime: { status: 'running', pid: 12345 } }],
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
