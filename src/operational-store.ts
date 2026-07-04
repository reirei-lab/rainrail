import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import type { RainrailEventEnvelope } from './events.js';
import type { RuntimeAgentResumeAttempt, RuntimeRunStatus } from './runtime-provider.js';

export interface RainrailOperationalStoreOptions {
  databasePath: string;
  eventLimit: number;
  now?: () => Date;
}

export interface StoredOperationalEvent<TPayload = unknown> {
  id: string;
  name: string;
  source: RainrailEventEnvelope<TPayload>['source'];
  delivery: RainrailEventEnvelope<TPayload>['delivery'];
  subject: RainrailEventEnvelope<TPayload>['subject'];
  occurredAt: string;
  receivedAt: string;
  envelope: RainrailEventEnvelope<TPayload>;
}

export interface RecordActivityEventInput {
  id?: string;
  sourceEventId?: string;
  sourceEventName?: string;
  category: string;
  targetType: string;
  targetId?: string;
  targetUrl?: string;
  actionType: string;
  outcome: 'success' | 'failed' | 'skipped' | (string & {});
  summary: string;
  metadata?: Record<string, unknown>;
}

export interface StoredActivityEvent extends Required<Omit<RecordActivityEventInput, 'id' | 'targetId' | 'targetUrl' | 'metadata' | 'sourceEventId' | 'sourceEventName'>> {
  id: string;
  sourceEventId?: string;
  sourceEventName?: string;
  targetId?: string;
  targetUrl?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RecordCommandResultInput {
  id?: string;
  actionType: string;
  targetType: string;
  targetId: string;
  status: 'preview' | 'accepted' | 'failed' | (string & {});
  actor: string;
  client?: string;
  requestId: string;
  dryRun: boolean;
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface StoredCommandResult extends Omit<RecordCommandResultInput, 'id' | 'client' | 'result' | 'error' | 'metadata'> {
  id: string;
  client?: string;
  result?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export interface RecordAgentTaskInput {
  id: string;
  title: string;
  agentSessionId?: string;
  branchName: string;
  status?: RuntimeRunStatus;
  issue?: unknown;
  claim?: unknown;
  logPath?: string;
  stderrLogPath?: string;
  pid?: number;
  resumeAttempts?: RuntimeAgentResumeAttempt[];
  projectClaim?: StoredAgentTaskProjectClaimState;
  result?: string;
  startedAt?: string;
  completedAt?: string;
}

export interface StoredAgentTaskProjectClaimState {
  status: 'released' | 'release_failed';
  reason: string;
  updatedAt: string;
  error?: string;
}

export interface StoredAgentTask extends RecordAgentTaskInput {
  status: RuntimeRunStatus;
  startedAt: string;
  updatedAt: string;
  runtime: {
    status: RuntimeRunStatus;
    pid?: number;
    startedAt: string;
    completedAt?: string;
  };
}

export interface RecordEventHandlerRetryInput {
  eventId: string;
  handlerName: string;
  attempts?: number;
  nextRetryAt: string;
  lastError: string;
}

export interface StoredEventHandlerRetry extends RecordEventHandlerRetryInput {
  attempts: number;
  updatedAt: string;
  claimedUntilAt?: string;
}

export interface OperationalStoreSnapshot {
  events: StoredOperationalEvent[];
  activityEvents: StoredActivityEvent[];
  agentTasks: StoredAgentTask[];
  commandResults: StoredCommandResult[];
  eventHandlerRetries: StoredEventHandlerRetry[];
  warnings: OperationalStoreWarnings;
  counts: {
    events: number;
    activityEvents: number;
    agentTasks: number;
    commandResults: number;
    eventHandlerRetries: number;
  };
}

export interface OperationalStoreWarnings {
  staleProjectClaims: StoredStaleProjectClaimWarning[];
}

export interface StoredStaleProjectClaimWarning {
  taskId: string;
  title: string;
  status: RuntimeRunStatus;
  agentSessionId?: string;
  branchName: string;
  issue?: unknown;
  claim?: unknown;
  releaseError?: string;
}

interface SnapshotOptions {
  hideSkippedActivityEvents?: boolean;
}

export interface ListOperationalStoreEventsOptions {
  limit?: number;
}

export interface ListOperationalStoreActivityEventsOptions {
  hideSkippedActivityEvents?: boolean;
  limit?: number;
}

interface OperationalStoreData {
  events: Record<string, StoredOperationalEvent>;
  activityEvents: Record<string, StoredActivityEvent>;
  agentTasks: Record<string, StoredAgentTask>;
  commandResults: Record<string, StoredCommandResult>;
  eventHandlerRetries: Record<string, StoredEventHandlerRetry>;
  sequences: Record<string, number>;
}

const sharedFileStores = new Map<string, OperationalStoreData>();

export class RainrailOperationalStore {
  readonly #databasePath: string;
  readonly #data: OperationalStoreData;
  readonly #eventLimit: number;
  readonly #now: () => Date;
  #closed = false;

  constructor(options: RainrailOperationalStoreOptions) {
    this.#databasePath = options.databasePath;
    this.#eventLimit = expectPositiveInteger(options.eventLimit, 'eventLimit');
    this.#now = options.now ?? (() => new Date());
    this.#data = loadStoreData(options.databasePath);
  }

  close(): void {
    if (this.#closed) return;
    this.#persist();
    this.#closed = true;
  }

  recordEvent<TPayload>(event: RainrailEventEnvelope<TPayload>): StoredOperationalEvent<TPayload> {
    this.#assertOpen();
    const stored = eventToStoredOperationalEvent(event);
    this.#data.events[event.id] = jsonClone(stored);
    this.#persist();

    return this.getEvent(event.id) as StoredOperationalEvent<TPayload>;
  }

  getEvent(id: string): StoredOperationalEvent | undefined {
    this.#assertOpen();
    const event = this.#data.events[id];
    return event === undefined ? undefined : jsonClone(event);
  }

  listEvents(options: ListOperationalStoreEventsOptions = {}): StoredOperationalEvent[] {
    this.#assertOpen();
    return limitRows(Object.values(this.#data.events)
      .sort((left, right) => compareDesc(left.receivedAt, right.receivedAt) || compareDesc(left.id, right.id))
      .map((event) => jsonClone(event)), options.limit);
  }

  recordActivityEvent(input: RecordActivityEventInput): StoredActivityEvent {
    this.#assertOpen();
    const id = input.id ?? nextId(this.#data, 'activity', 'act');
    const activity: StoredActivityEvent = {
      id,
      ...(input.sourceEventId === undefined ? {} : { sourceEventId: input.sourceEventId }),
      ...(input.sourceEventName === undefined ? {} : { sourceEventName: input.sourceEventName }),
      category: input.category,
      targetType: input.targetType,
      ...(input.targetId === undefined ? {} : { targetId: input.targetId }),
      ...(input.targetUrl === undefined ? {} : { targetUrl: input.targetUrl }),
      actionType: input.actionType,
      outcome: input.outcome,
      summary: input.summary,
      ...(input.metadata === undefined ? {} : { metadata: jsonClone(input.metadata) }),
      createdAt: this.#now().toISOString(),
    };
    this.#data.activityEvents[id] = activity;
    this.#persist();

    return jsonClone(activity);
  }

  getActivityEvent(id: string): StoredActivityEvent | undefined {
    this.#assertOpen();
    const activity = this.#data.activityEvents[id];
    return activity === undefined ? undefined : jsonClone(activity);
  }

  listActivityEvents(options: ListOperationalStoreActivityEventsOptions = {}): StoredActivityEvent[] {
    this.#assertOpen();
    return limitRows(Object.values(this.#data.activityEvents)
      .filter((activity) => !(options.hideSkippedActivityEvents === true && activity.outcome === 'skipped'))
      .sort((left, right) => compareDesc(left.createdAt, right.createdAt) || compareDesc(left.id, right.id))
      .map((activity) => jsonClone(activity)), options.limit);
  }

  recordCommandResult(input: RecordCommandResultInput): StoredCommandResult {
    this.#assertOpen();
    const id = input.id ?? nextId(this.#data, 'command', 'cmd');
    const commandResult: StoredCommandResult = {
      id,
      actionType: input.actionType,
      targetType: input.targetType,
      targetId: input.targetId,
      status: input.status,
      actor: input.actor,
      ...(input.client === undefined ? {} : { client: input.client }),
      requestId: input.requestId,
      dryRun: input.dryRun,
      ...(input.result === undefined ? {} : { result: jsonClone(input.result) }),
      ...(input.error === undefined ? {} : { error: input.error }),
      ...(input.metadata === undefined ? {} : { metadata: jsonClone(input.metadata) }),
      createdAt: this.#now().toISOString(),
    };
    this.#data.commandResults[id] = commandResult;
    this.#persist();

    return jsonClone(commandResult);
  }

  recordAgentTask(input: RecordAgentTaskInput): StoredAgentTask {
    this.#assertOpen();
    const now = this.#now().toISOString();
    const existing = this.#data.agentTasks[input.id];
    const startedAt = input.startedAt ?? existing?.startedAt ?? now;
    const status = input.status ?? existing?.status ?? 'running';
    const agentSessionId = input.agentSessionId ?? existing?.agentSessionId;
    const issue = input.issue ?? existing?.issue;
    const claim = input.claim ?? existing?.claim;
    const logPath = input.logPath ?? existing?.logPath;
    const stderrLogPath = input.stderrLogPath ?? existing?.stderrLogPath;
    const pid = input.pid ?? existing?.pid;
    const resumeAttempts = input.resumeAttempts ?? existing?.resumeAttempts;
    const result = input.result ?? existing?.result;
    const completedAt = input.completedAt ?? existing?.completedAt;
    const projectClaim = input.projectClaim ?? carryForwardProjectClaim(existing, {
      agentSessionId,
      branchName: input.branchName,
      claim,
      status,
    });
    const task = agentTaskWithRuntime({
      id: input.id,
      title: input.title,
      ...(agentSessionId === undefined ? {} : { agentSessionId }),
      branchName: input.branchName,
      status,
      ...(issue === undefined ? {} : { issue: jsonClone(issue) }),
      ...(claim === undefined ? {} : { claim: jsonClone(claim) }),
      ...(logPath === undefined ? {} : { logPath }),
      ...(stderrLogPath === undefined ? {} : { stderrLogPath }),
      ...(pid === undefined ? {} : { pid }),
      ...(resumeAttempts === undefined ? {} : { resumeAttempts: jsonClone(resumeAttempts) }),
      ...(projectClaim === undefined ? {} : { projectClaim: jsonClone(projectClaim) }),
      ...(result === undefined ? {} : { result }),
      startedAt,
      ...(completedAt === undefined ? {} : { completedAt }),
      updatedAt: now,
    });
    this.#data.agentTasks[input.id] = task;
    this.#persist();

    return jsonClone(task);
  }

  getAgentTask(id: string): StoredAgentTask | undefined {
    this.#assertOpen();
    const task = this.#data.agentTasks[id];
    return task === undefined ? undefined : jsonClone(task);
  }

  getAgentTaskByBranchName(branchName: string): StoredAgentTask | undefined {
    this.#assertOpen();
    return this.listAgentTasks().find((task) => task.branchName === branchName);
  }

  listAgentTasks(): StoredAgentTask[] {
    this.#assertOpen();
    return Object.values(this.#data.agentTasks)
      .map((task) => jsonClone(task))
      .sort((left, right) => compareDesc(left.updatedAt, right.updatedAt) || compareDesc(left.id, right.id));
  }

  updateAgentTaskStatus(input: {
    id: string;
    status: RuntimeRunStatus;
    completedAt?: string;
    result?: string;
  }): StoredAgentTask | undefined {
    const existing = this.getAgentTask(input.id);
    if (existing === undefined) return undefined;

    return this.recordAgentTask({
      id: existing.id,
      title: existing.title,
      ...(existing.agentSessionId === undefined ? {} : { agentSessionId: existing.agentSessionId }),
      branchName: existing.branchName,
      status: input.status,
      ...(existing.issue === undefined ? {} : { issue: existing.issue }),
      ...(existing.claim === undefined ? {} : { claim: existing.claim }),
      ...(existing.logPath === undefined ? {} : { logPath: existing.logPath }),
      ...(existing.stderrLogPath === undefined ? {} : { stderrLogPath: existing.stderrLogPath }),
      ...(existing.pid === undefined ? {} : { pid: existing.pid }),
      ...(existing.resumeAttempts === undefined ? {} : { resumeAttempts: existing.resumeAttempts }),
      ...(existing.projectClaim === undefined ? {} : { projectClaim: existing.projectClaim }),
      ...((input.result ?? existing.result) === undefined ? {} : { result: input.result ?? existing.result }),
      startedAt: existing.startedAt,
      ...((input.completedAt ?? existing.completedAt) === undefined
        ? {}
        : { completedAt: input.completedAt ?? existing.completedAt }),
    });
  }

  updateAgentTaskProjectClaim(input: {
    id: string;
    status: StoredAgentTaskProjectClaimState['status'];
    reason: string;
    error?: string;
    updatedAt?: string;
  }): StoredAgentTask | undefined {
    const existing = this.getAgentTask(input.id);
    if (existing === undefined) return undefined;

    return this.recordAgentTask({
      id: existing.id,
      title: existing.title,
      ...(existing.agentSessionId === undefined ? {} : { agentSessionId: existing.agentSessionId }),
      branchName: existing.branchName,
      status: existing.status,
      ...(existing.issue === undefined ? {} : { issue: existing.issue }),
      ...(existing.claim === undefined ? {} : { claim: existing.claim }),
      ...(existing.logPath === undefined ? {} : { logPath: existing.logPath }),
      ...(existing.stderrLogPath === undefined ? {} : { stderrLogPath: existing.stderrLogPath }),
      ...(existing.pid === undefined ? {} : { pid: existing.pid }),
      ...(existing.resumeAttempts === undefined ? {} : { resumeAttempts: existing.resumeAttempts }),
      projectClaim: {
        status: input.status,
        reason: input.reason,
        updatedAt: input.updatedAt ?? this.#now().toISOString(),
        ...(input.error === undefined ? {} : { error: input.error }),
      },
      ...(existing.result === undefined ? {} : { result: existing.result }),
      startedAt: existing.startedAt,
      ...(existing.completedAt === undefined ? {} : { completedAt: existing.completedAt }),
    });
  }

  recordEventHandlerRetry(input: RecordEventHandlerRetryInput): StoredEventHandlerRetry {
    this.#assertOpen();
    const key = retryKey(input.eventId, input.handlerName);
    const existing = this.#data.eventHandlerRetries[key];
    const retry: StoredEventHandlerRetry = {
      eventId: input.eventId,
      handlerName: input.handlerName,
      attempts: input.attempts ?? (existing?.attempts ?? 0) + 1,
      nextRetryAt: input.nextRetryAt,
      lastError: input.lastError,
      updatedAt: this.#now().toISOString(),
    };
    this.#data.eventHandlerRetries[key] = retry;
    this.#persist();

    return jsonClone(retry);
  }

  getEventHandlerRetry(eventId: string, handlerName: string): StoredEventHandlerRetry | undefined {
    this.#assertOpen();
    const retry = this.#data.eventHandlerRetries[retryKey(eventId, handlerName)];
    return retry === undefined ? undefined : jsonClone(retry);
  }

  claimEventHandlerRetry(retry: StoredEventHandlerRetry, claimedUntilAt: string, now: string): boolean {
    this.#assertOpen();
    const current = this.#data.eventHandlerRetries[retryKey(retry.eventId, retry.handlerName)];
    if (current === undefined
      || !sameRetryVersion(current, retry)
      || (current.claimedUntilAt !== undefined && current.claimedUntilAt > now)) {
      return false;
    }

    this.#data.eventHandlerRetries[retryKey(retry.eventId, retry.handlerName)] = {
      ...current,
      updatedAt: now,
      claimedUntilAt,
    };
    this.#persist();
    return true;
  }

  listDueEventHandlerRetries(now: string, limit?: number): StoredEventHandlerRetry[] {
    this.#assertOpen();
    const retries = Object.values(this.#data.eventHandlerRetries)
      .filter((retry) => retry.nextRetryAt <= now && (retry.claimedUntilAt === undefined || retry.claimedUntilAt <= now))
      .sort((left, right) => left.nextRetryAt.localeCompare(right.nextRetryAt) || left.handlerName.localeCompare(right.handlerName))
      .map((retry) => jsonClone(retry));

    return limit === undefined ? retries : retries.slice(0, limit);
  }

  listEventHandlerRetries(): StoredEventHandlerRetry[] {
    this.#assertOpen();
    return Object.values(this.#data.eventHandlerRetries)
      .sort((left, right) => left.nextRetryAt.localeCompare(right.nextRetryAt) || left.handlerName.localeCompare(right.handlerName))
      .map((retry) => jsonClone(retry));
  }

  clearEventHandlerRetry(eventId: string, handlerName: string): void {
    this.#assertOpen();
    delete this.#data.eventHandlerRetries[retryKey(eventId, handlerName)];
    this.#persist();
  }

  clearClaimedEventHandlerRetry(retry: StoredEventHandlerRetry): boolean {
    this.#assertOpen();
    const key = retryKey(retry.eventId, retry.handlerName);
    const current = this.#data.eventHandlerRetries[key];
    if (current === undefined || !sameRetryVersion(current, retry)) return false;

    delete this.#data.eventHandlerRetries[key];
    this.#persist();
    return true;
  }

  rescheduleClaimedEventHandlerRetry(
    retry: StoredEventHandlerRetry,
    input: RecordEventHandlerRetryInput,
  ): StoredEventHandlerRetry | undefined {
    this.#assertOpen();
    const key = retryKey(retry.eventId, retry.handlerName);
    const current = this.#data.eventHandlerRetries[key];
    if (current === undefined || !sameRetryVersion(current, retry)) return undefined;

    const next: StoredEventHandlerRetry = {
      eventId: input.eventId,
      handlerName: input.handlerName,
      attempts: input.attempts ?? retry.attempts + 1,
      nextRetryAt: input.nextRetryAt,
      lastError: input.lastError,
      updatedAt: this.#now().toISOString(),
    };
    this.#data.eventHandlerRetries[key] = next;
    this.#persist();
    return jsonClone(next);
  }

  snapshot(options: SnapshotOptions = {}): OperationalStoreSnapshot {
    this.#assertOpen();
    const activityEvents = this.listActivityEvents({
      ...(options.hideSkippedActivityEvents === undefined ? {} : { hideSkippedActivityEvents: options.hideSkippedActivityEvents }),
      limit: this.#eventLimit,
    });
    const events = this.listEvents({ limit: this.#eventLimit });

    return {
      events,
      activityEvents,
      agentTasks: this.listAgentTasks(),
      commandResults: Object.values(this.#data.commandResults)
        .sort((left, right) => compareDesc(left.createdAt, right.createdAt) || compareDesc(left.id, right.id))
        .slice(0, this.#eventLimit)
        .map((result) => jsonClone(result)),
      eventHandlerRetries: this.listEventHandlerRetries(),
      warnings: {
        staleProjectClaims: staleProjectClaimWarnings(this.listAgentTasks()),
      },
      counts: {
        events: Object.keys(this.#data.events).length,
        activityEvents: Object.keys(this.#data.activityEvents).length,
        agentTasks: Object.keys(this.#data.agentTasks).length,
        commandResults: Object.keys(this.#data.commandResults).length,
        eventHandlerRetries: Object.keys(this.#data.eventHandlerRetries).length,
      },
    };
  }

  #persist(): void {
    if (this.#databasePath === ':memory:') return;

    mkdirSync(dirname(this.#databasePath), { recursive: true });
    writeFileSync(this.#databasePath, JSON.stringify(this.#data), { mode: 0o600 });
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('operational store is closed');
    }
  }
}

function loadStoreData(databasePath: string): OperationalStoreData {
  if (databasePath === ':memory:') return emptyStoreData();

  const shared = sharedFileStores.get(databasePath);
  if (shared !== undefined) return shared;

  const data = existsSync(databasePath)
    ? parseStoreData(readFileSync(databasePath, 'utf8'))
    : emptyStoreData();
  sharedFileStores.set(databasePath, data);
  return data;
}

function parseStoreData(raw: string): OperationalStoreData {
  try {
    const value = JSON.parse(raw) as Partial<OperationalStoreData>;
    return {
      events: value.events ?? {},
      activityEvents: value.activityEvents ?? {},
      agentTasks: value.agentTasks ?? {},
      commandResults: value.commandResults ?? {},
      eventHandlerRetries: value.eventHandlerRetries ?? {},
      sequences: value.sequences ?? {},
    };
  } catch {
    return emptyStoreData();
  }
}

function emptyStoreData(): OperationalStoreData {
  return {
    events: {},
    activityEvents: {},
    agentTasks: {},
    commandResults: {},
    eventHandlerRetries: {},
    sequences: {},
  };
}

function eventToStoredOperationalEvent<TPayload>(event: RainrailEventEnvelope<TPayload>): StoredOperationalEvent<TPayload> {
  return {
    id: event.id,
    name: event.name,
    source: jsonClone(event.source),
    delivery: jsonClone(event.delivery),
    subject: jsonClone(event.subject),
    occurredAt: event.occurredAt,
    receivedAt: event.delivery.receivedAt,
    envelope: jsonClone(event),
  };
}

function agentTaskWithRuntime(task: Omit<StoredAgentTask, 'runtime'>): StoredAgentTask {
  return {
    ...task,
    runtime: {
      status: task.status,
      ...('pid' in task ? { pid: task.pid } : {}),
      startedAt: task.startedAt,
      ...('completedAt' in task ? { completedAt: task.completedAt } : {}),
    },
  };
}

function carryForwardProjectClaim(
  existing: StoredAgentTask | undefined,
  next: {
    agentSessionId: string | undefined;
    branchName: string;
    claim: unknown;
    status: RuntimeRunStatus;
  },
): StoredAgentTaskProjectClaimState | undefined {
  if (existing?.projectClaim === undefined || next.status === 'running') {
    return undefined;
  }
  if (
    existing.agentSessionId !== next.agentSessionId
    || existing.branchName !== next.branchName
    || !sameJsonValue(existing.claim, next.claim)
  ) {
    return undefined;
  }

  return existing.projectClaim;
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const staleProjectClaimRuntimeStatuses = new Set<RuntimeRunStatus>([
  'failed',
  'canceled',
  'stopped',
  'timed_out',
  'compaction_failed',
]);

function staleProjectClaimWarnings(tasks: StoredAgentTask[]): StoredStaleProjectClaimWarning[] {
  return tasks
    .filter((task) =>
      staleProjectClaimRuntimeStatuses.has(task.status)
      && task.claim !== undefined
      && task.projectClaim?.status !== 'released'
    )
    .map((task) => ({
      taskId: task.id,
      title: task.title,
      status: task.status,
      ...(task.agentSessionId === undefined ? {} : { agentSessionId: task.agentSessionId }),
      branchName: task.branchName,
      ...(task.issue === undefined ? {} : { issue: jsonClone(task.issue) }),
      ...(task.claim === undefined ? {} : { claim: jsonClone(task.claim) }),
      ...(task.projectClaim?.error === undefined ? {} : { releaseError: task.projectClaim.error }),
    }));
}

function sameRetryVersion(left: StoredEventHandlerRetry, right: StoredEventHandlerRetry): boolean {
  return left.eventId === right.eventId
    && left.handlerName === right.handlerName
    && left.attempts === right.attempts
    && left.nextRetryAt === right.nextRetryAt
    && left.lastError === right.lastError
    && left.updatedAt === right.updatedAt
    && left.claimedUntilAt === right.claimedUntilAt;
}

function retryKey(eventId: string, handlerName: string): string {
  return `${JSON.stringify(eventId)}:${JSON.stringify(handlerName)}`;
}

function nextId(data: OperationalStoreData, name: string, prefix: string): string {
  const value = (data.sequences[name] ?? 0) + 1;
  data.sequences[name] = value;
  return `${prefix}_${String(value).padStart(6, '0')}`;
}

function compareDesc(left: string, right: string): number {
  return right.localeCompare(left);
}

function limitRows<T>(rows: T[], limit: number | undefined): T[] {
  return limit === undefined ? rows : rows.slice(0, limit);
}

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}
