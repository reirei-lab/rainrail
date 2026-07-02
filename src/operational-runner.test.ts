import { describe, expect, it } from 'vitest';

import { createEventEnvelope } from './events.js';
import { RainrailOperationalStore } from './operational-store.js';
import {
  isRetryableOperationalError,
  prioritizeEventHandlerRetriesForProcessing,
  processDueEventHandlerRetries,
  reconcileOperationalAgentTasks,
  retryDelayMs,
} from './operational-runner.js';

describe('operational retry helpers', () => {
  it('recognizes transient failures and uses bounded exponential backoff', () => {
    expect(isRetryableOperationalError(new Error('API rate limit already exceeded'))).toBe(true);
    expect(isRetryableOperationalError(new Error('GitHub GraphQL request failed with HTTP 503'))).toBe(true);
    expect(isRetryableOperationalError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableOperationalError(new Error('pull request mergeability is still being calculated'))).toBe(true);
    expect(isRetryableOperationalError(new Error('pull request is not mergeable'))).toBe(false);

    expect(retryDelayMs(0)).toBe(60_000);
    expect(retryDelayMs(2)).toBe(240_000);
    expect(retryDelayMs(8)).toBe(15 * 60_000);
  });

  it('prioritizes conflict checks before older automatic assignment retries', () => {
    expect(prioritizeEventHandlerRetriesForProcessing([
      retry('__auto_assign_next_issue', 'evt_1', '2026-07-02T00:00:00.000Z'),
      retry('review-request', 'evt_2', '2026-07-02T00:01:00.000Z'),
      retry('conflict-check', 'evt_3', '2026-07-03T00:00:00.000Z'),
      retry('__auto_assign_next_issue', 'evt_4', '2026-07-01T00:00:00.000Z'),
    ]).map((item) => item.handlerName)).toEqual([
      'conflict-check',
      'review-request',
      '__auto_assign_next_issue',
      '__auto_assign_next_issue',
    ]);
  });

  it('replays due handler retries and updates retry state from handler outcomes', async () => {
    const store = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = store.recordEvent(fixtureEvent());
    store.recordEventHandlerRetry({
      eventId: event.id,
      handlerName: 'flaky-handler',
      nextRetryAt: '2026-07-02T00:00:00.000Z',
      lastError: 'fetch failed',
    });

    const first = await processDueEventHandlerRetries({
      store,
      now: '2026-07-02T00:00:00.000Z',
      handlers: {
        'flaky-handler': async () => {
          throw new Error('GitHub GraphQL request failed with HTTP 503');
        },
      },
    });

    expect(first).toEqual([{ eventId: event.id, handlerName: 'flaky-handler', status: 'scheduled' }]);
    expect(store.getEventHandlerRetry(event.id, 'flaky-handler')).toMatchObject({
      attempts: 2,
      nextRetryAt: '2026-07-02T00:02:00.000Z',
    });

    const second = await processDueEventHandlerRetries({
      store,
      now: '2026-07-02T00:02:00.000Z',
      handlers: { 'flaky-handler': async () => undefined },
    });

    expect(second).toEqual([{ eventId: event.id, handlerName: 'flaky-handler', status: 'fulfilled' }]);
    expect(store.getEventHandlerRetry(event.id, 'flaky-handler')).toBeUndefined();
    store.close();
  });
});

describe('operational reconcile helpers', () => {
  it('records terminal runtime state for previously running agent tasks', async () => {
    const store = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    store.recordAgentTask({
      id: 'agent_task_rainrail_25',
      title: 'issue 25',
      agentSessionId: 'agent:main:rainrail-25',
      branchName: 'agent/reirei-lab-rainrail-25-store-retry-reconcile-dashboard-api',
      status: 'running',
      logPath: 'var/log/rainrail-25.log',
      pid: 123,
    });

    await reconcileOperationalAgentTasks({
      store,
      readRuntimeStatus: async (task) => task.id === 'agent_task_rainrail_25' ? {
        status: 'succeeded',
        completedAt: '2026-07-02T00:05:00.000Z',
        summary: 'Outcome: implemented',
      } : undefined,
    });

    expect(store.getAgentTask('agent_task_rainrail_25')).toMatchObject({
      status: 'succeeded',
      completedAt: '2026-07-02T00:05:00.000Z',
      result: 'Outcome: implemented',
    });
    store.close();
  });
});

function retry(handlerName: string, eventId: string, nextRetryAt: string) {
  return {
    eventId,
    handlerName,
    attempts: 1,
    nextRetryAt,
    lastError: 'retryable',
    updatedAt: nextRetryAt,
  };
}

function fixtureEvent() {
  return createEventEnvelope({
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    name: 'github.issue',
    delivery: { id: 'delivery-25', receivedAt: '2026-07-02T00:00:00.000Z' },
    occurredAt: '2026-07-02T00:00:00.000Z',
    subject: { type: 'issue', id: '25' },
    payload: { action: 'opened' },
    rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-25' },
  });
}
