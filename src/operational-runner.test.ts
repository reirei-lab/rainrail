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
    expect(isRetryableOperationalError(new Error('GitHub GraphQL request failed with HTTP 429'))).toBe(true);
    expect(isRetryableOperationalError(new Error('fetch failed'))).toBe(true);
    expect(isRetryableOperationalError(new Error('pull request mergeability is still being calculated'))).toBe(true);
    expect(isRetryableOperationalError(new Error('pull request checks are still being reflected'))).toBe(true);
    expect(isRetryableOperationalError(new Error('pull request draft state is still being reflected'))).toBe(true);
    expect(isRetryableOperationalError(new Error('pull request reviews are still being reflected'))).toBe(true);
    expect(isRetryableOperationalError(new Error('pull request review decision is still being reflected'))).toBe(true);
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

  it('applies the processing limit after handler priority under retry backlog', async () => {
    const store = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = store.recordEvent(fixtureEvent());
    for (let index = 0; index < 120; index += 1) {
      store.recordEventHandlerRetry({
        eventId: event.id,
        handlerName: `__auto_assign_next_issue_${index}`,
        nextRetryAt: `2026-07-02T00:00:${String(index % 60).padStart(2, '0')}.000Z`,
        lastError: 'fetch failed',
      });
    }
    store.recordEventHandlerRetry({
      eventId: event.id,
      handlerName: 'conflict-check',
      nextRetryAt: '2026-07-02T01:00:00.000Z',
      lastError: 'fetch failed',
    });
    const handled: string[] = [];

    const result = await processDueEventHandlerRetries({
      store,
      now: '2026-07-02T01:00:00.000Z',
      limit: 1,
      handlers: new Proxy({}, {
        get: (_target, property) => async () => {
          handled.push(String(property));
        },
      }) as Record<string, () => Promise<void>>,
    });

    expect(result).toEqual([{ eventId: event.id, handlerName: 'conflict-check', status: 'fulfilled' }]);
    expect(handled).toEqual(['conflict-check']);
    store.close();
  });

  it('claims a retry row before running a handler so concurrent processors do not duplicate side effects', async () => {
    const store = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = store.recordEvent(fixtureEvent());
    store.recordEventHandlerRetry({
      eventId: event.id,
      handlerName: 'review-request',
      nextRetryAt: '2026-07-02T00:00:00.000Z',
      lastError: 'fetch failed',
    });
    let handlerCalls = 0;
    const handler = async () => {
      handlerCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    };

    const [first, second] = await Promise.all([
      processDueEventHandlerRetries({
        store,
        now: '2026-07-02T00:00:00.000Z',
        handlers: { 'review-request': handler },
      }),
      processDueEventHandlerRetries({
        store,
        now: '2026-07-02T00:00:00.000Z',
        handlers: { 'review-request': handler },
      }),
    ]);

    expect([...first, ...second].filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(handlerCalls).toBe(1);
    expect(store.getEventHandlerRetry(event.id, 'review-request')).toBeUndefined();
    store.close();
  });

  it('keeps claimed retries recoverable after their lease expires', () => {
    const store = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = store.recordEvent(fixtureEvent());
    const retry = store.recordEventHandlerRetry({
      eventId: event.id,
      handlerName: 'review-request',
      nextRetryAt: '2026-07-02T00:00:00.000Z',
      lastError: 'fetch failed',
    });

    expect(store.claimEventHandlerRetry(retry, '2026-07-02T00:05:00.000Z', '2026-07-02T00:00:00.000Z')).toBe(true);

    expect(store.listDueEventHandlerRetries('2026-07-02T00:04:59.000Z')).toEqual([]);
    expect(store.listDueEventHandlerRetries('2026-07-02T00:05:00.000Z')).toEqual([
      expect.objectContaining({
        eventId: event.id,
        handlerName: 'review-request',
        claimedUntilAt: '2026-07-02T00:05:00.000Z',
      }),
    ]);
    store.close();
  });

  it('does not let stale claimed success clear a newly scheduled retry', async () => {
    const store = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = store.recordEvent(fixtureEvent());
    store.recordEventHandlerRetry({
      eventId: event.id,
      handlerName: 'review-request',
      nextRetryAt: '2026-07-02T00:00:00.000Z',
      lastError: 'fetch failed',
    });
    let markFirstHandlerStarted!: () => void;
    let releaseFirstHandler!: () => void;
    const firstHandlerDone = new Promise<void>((resolve) => {
      releaseFirstHandler = resolve;
    });
    const firstHandlerStarted = new Promise<void>((resolve) => {
      markFirstHandlerStarted = resolve;
    });
    let firstHandlerCalls = 0;

    const firstRun = processDueEventHandlerRetries({
      store,
      now: '2026-07-02T00:00:00.000Z',
      handlers: {
        'review-request': async () => {
          firstHandlerCalls += 1;
          markFirstHandlerStarted();
          await firstHandlerDone;
        },
      },
    });
    await firstHandlerStarted;

    const secondRun = await processDueEventHandlerRetries({
      store,
      now: '2026-07-02T00:05:00.000Z',
      handlers: {
        'review-request': async () => {
          throw new Error('GitHub GraphQL request failed with HTTP 503');
        },
      },
    });
    releaseFirstHandler();
    await firstRun;

    expect(firstHandlerCalls).toBe(1);
    expect(secondRun).toEqual([{ eventId: event.id, handlerName: 'review-request', status: 'scheduled' }]);
    expect(store.getEventHandlerRetry(event.id, 'review-request')).toMatchObject({
      attempts: 2,
      nextRetryAt: '2026-07-02T00:07:00.000Z',
    });
    store.close();
  });

  it('does not clear a retry for a missing handler unless it can claim the row', async () => {
    const store = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = store.recordEvent(fixtureEvent());
    const staleRetry = store.recordEventHandlerRetry({
      eventId: event.id,
      handlerName: 'new-handler',
      nextRetryAt: '2026-07-02T00:00:00.000Z',
      lastError: 'fetch failed',
    });
    expect(store.claimEventHandlerRetry(
      staleRetry,
      '2026-07-02T00:05:00.000Z',
      '2026-07-02T00:00:00.000Z',
    )).toBe(true);
    const originalListDue = store.listDueEventHandlerRetries.bind(store);
    store.listDueEventHandlerRetries = () => [staleRetry];

    const result = await processDueEventHandlerRetries({
      store,
      now: '2026-07-02T00:00:00.000Z',
      handlers: {},
    });

    expect(result).toEqual([]);
    expect(store.getEventHandlerRetry(event.id, 'new-handler')).toMatchObject({
      claimedUntilAt: '2026-07-02T00:05:00.000Z',
    });
    store.listDueEventHandlerRetries = originalListDue;
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
