import { describe, expect, it } from 'vitest';

import type { RainrailEventEnvelope } from './events.js';
import { createRainrailHttpApp } from './http-app.js';
import { processDueEventHandlerRetries, reconcileOperationalAgentTasks } from './operational-runner.js';
import type { DashboardLayoutItem } from './dashboard-card-registry.js';
import type {
  OperationalStore,
  OperationalStoreSnapshot,
  RecordActivityEventInput,
  RecordAgentTaskInput,
  RecordCommandResultInput,
  RecordEventHandlerRetryInput,
  StoredActivityEvent,
  StoredAgentTask,
  StoredCommandResult,
  StoredDashboardLayout,
  StoredEventHandlerRetry,
  StoredOperationalEvent,
} from './operational-store.js';

describe('operational store contract', () => {
  it('allows dashboard and runner consumers to depend on a store interface instead of JSON persistence', async () => {
    const store = new InMemoryContractStore();

    createRainrailHttpApp({
      room: { fetch: () => Response.json({ ok: true }) },
      publishToken: 'publish-token',
      operationalStore: store,
    });

    await processDueEventHandlerRetries({
      store,
      now: '2026-07-09T00:00:00.000Z',
      handlers: {},
    });

    await reconcileOperationalAgentTasks({
      store,
      readRuntimeStatus: () => undefined,
    });

    expect(store.snapshot().counts).toMatchObject({
      events: 0,
      activityEvents: 0,
      agentTasks: 0,
      commandResults: 0,
      eventHandlerRetries: 0,
    });
  });
});

class InMemoryContractStore implements OperationalStore {
  readonly #events = new Map<string, StoredOperationalEvent>();
  readonly #activityEvents = new Map<string, StoredActivityEvent>();
  readonly #agentTasks = new Map<string, StoredAgentTask>();
  readonly #commandResults = new Map<string, StoredCommandResult>();
  readonly #eventHandlerRetries = new Map<string, StoredEventHandlerRetry>();
  #dashboardLayout: StoredDashboardLayout | undefined;

  recordEvent<TPayload>(event: RainrailEventEnvelope<TPayload>): StoredOperationalEvent<TPayload> {
    const stored: StoredOperationalEvent<TPayload> = {
      id: event.id,
      name: event.name,
      source: event.source,
      delivery: event.delivery,
      subject: event.subject,
      occurredAt: event.occurredAt,
      receivedAt: event.delivery.receivedAt,
      envelope: event,
    };
    this.#events.set(stored.id, stored);
    return stored;
  }

  getEvent(id: string): StoredOperationalEvent | undefined {
    return this.#events.get(id);
  }

  eventLimit(): number {
    return 100;
  }

  listEvents(): StoredOperationalEvent[] {
    return [...this.#events.values()];
  }

  recordActivityEvent(input: RecordActivityEventInput): StoredActivityEvent {
    const stored: StoredActivityEvent = {
      id: input.id ?? `activity-${this.#activityEvents.size + 1}`,
      category: input.category,
      targetType: input.targetType,
      actionType: input.actionType,
      outcome: input.outcome,
      summary: input.summary,
      createdAt: '2026-07-09T00:00:00.000Z',
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      ...(input.sourceEventName === undefined ? {} : { sourceEventName: input.sourceEventName }),
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.targetUrl === undefined ? {} : { targetUrl: input.targetUrl }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    this.#activityEvents.set(stored.id, stored);
    return stored;
  }

  getActivityEvent(id: string): StoredActivityEvent | undefined {
    return this.#activityEvents.get(id);
  }

  listActivityEvents(): StoredActivityEvent[] {
    return [...this.#activityEvents.values()];
  }

  recordCommandResult(input: RecordCommandResultInput): StoredCommandResult {
    const stored: StoredCommandResult = {
      id: input.id ?? `command-${this.#commandResults.size + 1}`,
      actionType: input.actionType,
      targetType: input.targetType,
      targetId: input.targetId,
      status: input.status,
      actor: input.actor,
      requestId: input.requestId,
      dryRun: input.dryRun,
      createdAt: '2026-07-09T00:00:00.000Z',
      ...(input.client === undefined ? {} : { client: input.client }),
      ...(input.result === undefined ? {} : { result: input.result }),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    this.#commandResults.set(stored.id, stored);
    return stored;
  }

  recordAgentTask(input: RecordAgentTaskInput): StoredAgentTask {
    const startedAt = input.startedAt ?? '2026-07-09T00:00:00.000Z';
    const status = input.status ?? 'running';
    const stored: StoredAgentTask = {
      ...input,
      status,
      startedAt,
      updatedAt: '2026-07-09T00:00:00.000Z',
      runtime: {
        status,
        ...(input.pid === undefined ? {} : { pid: input.pid }),
        startedAt,
        ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      },
    };
    this.#agentTasks.set(stored.id, stored);
    return stored;
  }

  getAgentTask(id: string): StoredAgentTask | undefined {
    return this.#agentTasks.get(id);
  }

  getAgentTaskByBranchName(branchName: string): StoredAgentTask | undefined {
    return this.listAgentTasks().find((task) => task.branchName === branchName);
  }

  listAgentTasks(): StoredAgentTask[] {
    return [...this.#agentTasks.values()];
  }

  updateAgentTaskStatus(input: { id: string; status: StoredAgentTask['status']; completedAt?: string; result?: string }): StoredAgentTask | undefined {
    const existing = this.getAgentTask(input.id);
    if (existing === undefined) return undefined;
    return this.recordAgentTask({
      ...existing,
      status: input.status,
      ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }),
      ...(input.result === undefined ? {} : { result: input.result }),
    });
  }

  updateAgentTaskProjectClaim(input: {
    id: string;
    status: StoredAgentTask['projectClaim'] extends { status: infer TStatus } ? TStatus : never;
    reason: string;
    error?: string;
    updatedAt?: string;
  }): StoredAgentTask | undefined {
    const existing = this.getAgentTask(input.id);
    if (existing === undefined) return undefined;
    return this.recordAgentTask({
      ...existing,
      projectClaim: {
        status: input.status,
        reason: input.reason,
        updatedAt: input.updatedAt ?? '2026-07-09T00:00:00.000Z',
        ...(input.error === undefined ? {} : { error: input.error }),
      },
    });
  }

  recordEventHandlerRetry(input: RecordEventHandlerRetryInput): StoredEventHandlerRetry {
    const stored = {
      ...input,
      attempts: input.attempts ?? 1,
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    this.#eventHandlerRetries.set(`${input.eventId}:${input.handlerName}`, stored);
    return stored;
  }

  getEventHandlerRetry(eventId: string, handlerName: string): StoredEventHandlerRetry | undefined {
    return this.#eventHandlerRetries.get(`${eventId}:${handlerName}`);
  }

  claimEventHandlerRetry(retry: StoredEventHandlerRetry, claimedUntilAt: string, now: string): boolean {
    this.#eventHandlerRetries.set(`${retry.eventId}:${retry.handlerName}`, {
      ...retry,
      claimedUntilAt,
      updatedAt: now,
    });
    return true;
  }

  listDueEventHandlerRetries(): StoredEventHandlerRetry[] {
    return [...this.#eventHandlerRetries.values()];
  }

  listEventHandlerRetries(): StoredEventHandlerRetry[] {
    return [...this.#eventHandlerRetries.values()];
  }

  clearEventHandlerRetry(eventId: string, handlerName: string): void {
    this.#eventHandlerRetries.delete(`${eventId}:${handlerName}`);
  }

  clearClaimedEventHandlerRetry(retry: StoredEventHandlerRetry): boolean {
    return this.#eventHandlerRetries.delete(`${retry.eventId}:${retry.handlerName}`);
  }

  rescheduleClaimedEventHandlerRetry(
    retry: StoredEventHandlerRetry,
    input: RecordEventHandlerRetryInput,
  ): StoredEventHandlerRetry | undefined {
    return this.recordEventHandlerRetry({
      ...input,
      attempts: input.attempts ?? retry.attempts + 1,
    });
  }

  getDashboardLayout(): StoredDashboardLayout | undefined {
    return this.#dashboardLayout;
  }

  saveDashboardLayout(items: DashboardLayoutItem[]): StoredDashboardLayout {
    this.#dashboardLayout = {
      id: 'user.dashboardLayout',
      items,
      updatedAt: '2026-07-09T00:00:00.000Z',
    };
    return this.#dashboardLayout;
  }

  snapshot(): OperationalStoreSnapshot {
    return {
      events: this.listEvents(),
      activityEvents: this.listActivityEvents(),
      agentTasks: this.listAgentTasks(),
      commandResults: [...this.#commandResults.values()],
      eventHandlerRetries: this.listEventHandlerRetries(),
      warnings: { staleProjectClaims: [] },
      counts: {
        events: this.#events.size,
        activityEvents: this.#activityEvents.size,
        agentTasks: this.#agentTasks.size,
        commandResults: this.#commandResults.size,
        eventHandlerRetries: this.#eventHandlerRetries.size,
      },
    };
  }
}
