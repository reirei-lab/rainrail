import type { RainrailEventEnvelope } from './events.js';
import type { RainrailOperationalStore, StoredAgentTask, StoredEventHandlerRetry } from './operational-store.js';
import type { ProjectIssue } from './project-issues.js';
import type { RuntimeRunStatus } from './runtime-provider.js';
import type { ProjectIssueClaim, TaskQueueProvider } from './task-queue.js';

const RETRY_BASE_DELAY_MS = 60_000;
const RETRY_MAX_DELAY_MS = 15 * 60_000;
const TERMINAL_STATUSES = new Set<RuntimeRunStatus>([
  'succeeded',
  'failed',
  'canceled',
  'stopped',
  'timed_out',
  'compaction_failed',
  'needs_human',
  'split_recommended',
]);
const RELEASE_STALE_PROJECT_CLAIM_STATUSES = new Set<RuntimeRunStatus>([
  'failed',
  'canceled',
  'stopped',
  'timed_out',
  'compaction_failed',
]);

export type EventHandlerRetryHandler = (event: RainrailEventEnvelope, retry: StoredEventHandlerRetry) => unknown | Promise<unknown>;

export interface ProcessDueEventHandlerRetriesOptions {
  store: RainrailOperationalStore;
  now: string;
  handlers: Record<string, EventHandlerRetryHandler | undefined>;
  limit?: number;
}

export type ProcessDueEventHandlerRetryResult =
  | { eventId: string; handlerName: string; status: 'fulfilled' }
  | { eventId: string; handlerName: string; status: 'scheduled' }
  | { eventId: string; handlerName: string; status: 'cleared'; reason: 'missing_event' | 'missing_handler' }
  | { eventId: string; handlerName: string; status: 'failed'; error: string };

export interface ReconcileOperationalAgentTasksOptions {
  store: RainrailOperationalStore;
  readRuntimeStatus(task: StoredAgentTask): Promise<OperationalRuntimeStatus | undefined> | OperationalRuntimeStatus | undefined;
  queue?: Pick<TaskQueueProvider, 'releaseProjectIssue'>;
}

export interface OperationalRuntimeStatus {
  status: RuntimeRunStatus;
  completedAt?: string;
  summary?: string;
}

export function isRetryableOperationalError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /rate limit/i.test(message)
    || /HTTP (?:429|5\d\d)/i.test(message)
    || /fetch failed/i.test(message)
    || /mergeability is still being calculated/i.test(message)
    || /pull request (?:checks|reviews) are still being reflected/i.test(message)
    || /pull request draft state is still being reflected/i.test(message)
    || /pull request review decision is still being reflected/i.test(message);
}

export function retryDelayMs(previousAttempts: number): number {
  return Math.min(RETRY_BASE_DELAY_MS * (2 ** previousAttempts), RETRY_MAX_DELAY_MS);
}

export function prioritizeEventHandlerRetriesForProcessing<T extends Pick<StoredEventHandlerRetry, 'handlerName' | 'nextRetryAt'>>(
  retries: T[],
): T[] {
  return [...retries].sort((left, right) => {
    const priorityDelta = retryHandlerPriority(left.handlerName) - retryHandlerPriority(right.handlerName);
    if (priorityDelta !== 0) return priorityDelta;

    return left.nextRetryAt.localeCompare(right.nextRetryAt);
  });
}

export async function processDueEventHandlerRetries(
  options: ProcessDueEventHandlerRetriesOptions,
): Promise<ProcessDueEventHandlerRetryResult[]> {
  const results: ProcessDueEventHandlerRetryResult[] = [];
  const nowMs = new Date(options.now).getTime();
  const claimLeaseMs = 5 * 60_000;
  const claimLeaseUntil = new Date(nowMs + claimLeaseMs).toISOString();
  const dueRetries = prioritizeEventHandlerRetriesForProcessing(
    options.store.listDueEventHandlerRetries(options.now),
  ).slice(0, options.limit ?? 100);

  for (const retry of dueRetries) {
    const event = options.store.getEvent(retry.eventId);
    if (event === undefined) {
      options.store.clearEventHandlerRetry(retry.eventId, retry.handlerName);
      results.push({ eventId: retry.eventId, handlerName: retry.handlerName, status: 'cleared', reason: 'missing_event' });
      continue;
    }

    const handler = options.handlers[retry.handlerName];
    if (handler === undefined) {
      if (options.store.claimEventHandlerRetry(
        retry,
        claimLeaseUntil,
        options.now,
      )) {
        const claimedRetry = { ...retry, updatedAt: options.now, claimedUntilAt: claimLeaseUntil };
        options.store.clearClaimedEventHandlerRetry(claimedRetry);
        results.push({ eventId: retry.eventId, handlerName: retry.handlerName, status: 'cleared', reason: 'missing_handler' });
      }
      continue;
    }

    if (!options.store.claimEventHandlerRetry(
      retry,
      claimLeaseUntil,
      options.now,
    )) {
      continue;
    }
    const claimedRetry = { ...retry, updatedAt: options.now, claimedUntilAt: claimLeaseUntil };

    try {
      await handler(event.envelope, retry);
      options.store.clearClaimedEventHandlerRetry(claimedRetry);
      results.push({ eventId: retry.eventId, handlerName: retry.handlerName, status: 'fulfilled' });
    } catch (error) {
      if (!isRetryableOperationalError(error)) {
        options.store.clearClaimedEventHandlerRetry(claimedRetry);
        results.push({
          eventId: retry.eventId,
          handlerName: retry.handlerName,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      options.store.rescheduleClaimedEventHandlerRetry(claimedRetry, {
        eventId: retry.eventId,
        handlerName: retry.handlerName,
        attempts: retry.attempts + 1,
        nextRetryAt: new Date(new Date(options.now).getTime() + retryDelayMs(retry.attempts)).toISOString(),
        lastError: error instanceof Error ? error.message : String(error),
      });
      results.push({ eventId: retry.eventId, handlerName: retry.handlerName, status: 'scheduled' });
    }
  }

  return results;
}

export async function reconcileOperationalAgentTasks(options: ReconcileOperationalAgentTasksOptions): Promise<StoredAgentTask[]> {
  const updated: StoredAgentTask[] = [];

  for (const task of options.store.listAgentTasks()) {
    if (TERMINAL_STATUSES.has(task.status)) {
      if (shouldReleaseStaleProjectClaim(task) && options.queue?.releaseProjectIssue !== undefined) {
        await releaseStaleProjectClaim(options, task);
      }
      continue;
    }

    const runtimeStatus = await options.readRuntimeStatus(task);
    if (runtimeStatus === undefined || !TERMINAL_STATUSES.has(runtimeStatus.status)) continue;

    const update = {
      id: task.id,
      status: runtimeStatus.status,
      ...(runtimeStatus.completedAt === undefined ? {} : { completedAt: runtimeStatus.completedAt }),
      ...(runtimeStatus.summary === undefined ? {} : { result: runtimeStatus.summary }),
    };
    const next = options.store.updateAgentTaskStatus(update);
    if (next !== undefined) updated.push(next);
    if (next !== undefined && shouldReleaseStaleProjectClaim(next) && options.queue?.releaseProjectIssue !== undefined) {
      await releaseStaleProjectClaim(options, next);
    }
  }

  return updated;
}

async function releaseStaleProjectClaim(
  options: ReconcileOperationalAgentTasksOptions,
  task: StoredAgentTask,
): Promise<void> {
  const claim = task.claim as ProjectIssueClaim | undefined;
  const issue = releaseProjectIssueForTask(task.issue, claim);
  if (options.queue?.releaseProjectIssue === undefined || issue === undefined || claim === undefined || task.agentSessionId === undefined) {
    return;
  }

  const reason = `runtime ${task.status}`;
  try {
    await options.queue.releaseProjectIssue({
      issue,
      claim,
      agentSessionId: task.agentSessionId,
      branchName: task.branchName,
      reason,
    });
    options.store.updateAgentTaskProjectClaim({
      id: task.id,
      status: 'released',
      reason,
      ...(task.completedAt === undefined ? {} : { updatedAt: task.completedAt }),
    });
    options.store.recordActivityEvent({
      category: 'agent_task',
      targetType: 'project_claim',
      targetId: task.id,
      actionType: 'project_claim_released',
      outcome: 'success',
      summary: `Released stale Project claim for ${task.title} after ${reason}`,
      metadata: {
        status: task.status,
        agentSessionId: task.agentSessionId,
        branchName: task.branchName,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    options.store.updateAgentTaskProjectClaim({
      id: task.id,
      status: 'release_failed',
      reason,
      error: message,
      ...(task.completedAt === undefined ? {} : { updatedAt: task.completedAt }),
    });
    options.store.recordActivityEvent({
      category: 'agent_task',
      targetType: 'project_claim',
      targetId: task.id,
      actionType: 'project_claim_release_failed',
      outcome: 'failed',
      summary: `Failed to release stale Project claim for ${task.title}: ${message}`,
      metadata: {
        status: task.status,
        agentSessionId: task.agentSessionId,
        branchName: task.branchName,
      },
    });
  }
}

function shouldReleaseStaleProjectClaim(task: StoredAgentTask): boolean {
  return RELEASE_STALE_PROJECT_CLAIM_STATUSES.has(task.status)
    && task.projectClaim?.status !== 'released'
    && task.issue !== undefined
    && task.claim !== undefined
    && task.agentSessionId !== undefined;
}

function releaseProjectIssueForTask(issue: unknown, claim: ProjectIssueClaim | undefined): ProjectIssue | undefined {
  if (!isRecord(issue)) return undefined;
  if (typeof issue.id === 'string' && issue.id.length > 0) {
    return issue as unknown as ProjectIssue;
  }
  if (typeof claim?.projectItemId !== 'string' || claim.projectItemId.length === 0) {
    return undefined;
  }

  return { ...issue, id: claim.projectItemId } as unknown as ProjectIssue;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function retryHandlerPriority(handlerName: string): number {
  if (handlerName === 'conflict-check') return 0;
  if (handlerName === '__auto_assign_next_issue') return 2;
  return 1;
}
