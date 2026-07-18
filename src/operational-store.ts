import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';

import type { DashboardLayoutItem } from './dashboard-card-registry.js';
import type { RainrailEventEnvelope } from './events.js';
import type { RuntimeAgentResumeAttempt, RuntimeRunStatus } from './runtime-provider.js';

const nodeRequire = createRequire(import.meta.url);
interface SqliteRunResult {
  changes: number;
}

interface SqliteStatement {
  run(...values: Array<string | number | null>): SqliteRunResult;
  get(...values: Array<string | number | null>): unknown;
  all(...values: Array<string | number | null>): unknown[];
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

type DatabaseSyncConstructor = new (
  databasePath: string,
  options?: { readOnly?: boolean },
) => SqliteDatabase;

export interface RainrailOperationalStoreOptions {
  databasePath: string;
  eventLimit: number;
  now?: () => Date;
}

export type JsonFileOperationalStoreOptions = RainrailOperationalStoreOptions;

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

export interface StoredDashboardLayout {
  id: 'user.dashboardLayout';
  items: DashboardLayoutItem[];
  updatedAt: string;
}

export interface SnapshotOptions {
  hideSkippedActivityEvents?: boolean;
}

export interface ListOperationalStoreEventsOptions {
  limit?: number;
}

export interface ListOperationalStoreActivityEventsOptions {
  hideSkippedActivityEvents?: boolean;
  limit?: number;
}

export interface UpdateAgentTaskStatusInput {
  id: string;
  status: RuntimeRunStatus;
  completedAt?: string;
  result?: string;
}

export interface UpdateAgentTaskProjectClaimInput {
  id: string;
  status: StoredAgentTaskProjectClaimState['status'];
  reason: string;
  error?: string;
  updatedAt?: string;
}

export interface OperationalStore {
  recordEvent<TPayload>(event: RainrailEventEnvelope<TPayload>): StoredOperationalEvent<TPayload>;
  getEvent(id: string): StoredOperationalEvent | undefined;
  eventLimit(): number;
  countEventSourceTypes(): number;
  listEvents(options?: ListOperationalStoreEventsOptions): StoredOperationalEvent[];
  recordActivityEvent(input: RecordActivityEventInput): StoredActivityEvent;
  getActivityEvent(id: string): StoredActivityEvent | undefined;
  listActivityEvents(options?: ListOperationalStoreActivityEventsOptions): StoredActivityEvent[];
  recordCommandResult(input: RecordCommandResultInput): StoredCommandResult;
  recordAgentTask(input: RecordAgentTaskInput): StoredAgentTask;
  getAgentTask(id: string): StoredAgentTask | undefined;
  getAgentTaskByBranchName(branchName: string): StoredAgentTask | undefined;
  listAgentTasks(): StoredAgentTask[];
  updateAgentTaskStatus(input: UpdateAgentTaskStatusInput): StoredAgentTask | undefined;
  updateAgentTaskProjectClaim(input: UpdateAgentTaskProjectClaimInput): StoredAgentTask | undefined;
  recordEventHandlerRetry(input: RecordEventHandlerRetryInput): StoredEventHandlerRetry;
  getEventHandlerRetry(eventId: string, handlerName: string): StoredEventHandlerRetry | undefined;
  claimEventHandlerRetry(retry: StoredEventHandlerRetry, claimedUntilAt: string, now: string): boolean;
  listDueEventHandlerRetries(now: string, limit?: number): StoredEventHandlerRetry[];
  listEventHandlerRetries(): StoredEventHandlerRetry[];
  clearEventHandlerRetry(eventId: string, handlerName: string): void;
  clearClaimedEventHandlerRetry(retry: StoredEventHandlerRetry): boolean;
  rescheduleClaimedEventHandlerRetry(
    retry: StoredEventHandlerRetry,
    input: RecordEventHandlerRetryInput,
  ): StoredEventHandlerRetry | undefined;
  getDashboardLayout(): StoredDashboardLayout | undefined;
  saveDashboardLayout(items: DashboardLayoutItem[]): StoredDashboardLayout;
  snapshot(options?: SnapshotOptions): OperationalStoreSnapshot;
}

interface OperationalStoreData {
  events: Record<string, StoredOperationalEvent>;
  activityEvents: Record<string, StoredActivityEvent>;
  agentTasks: Record<string, StoredAgentTask>;
  commandResults: Record<string, StoredCommandResult>;
  eventHandlerRetries: Record<string, StoredEventHandlerRetry>;
  dashboardLayout?: StoredDashboardLayout;
  sequences: Record<string, number>;
}

const sharedFileStores = new Map<string, OperationalStoreData>();

export class JsonFileOperationalStore implements OperationalStore {
  readonly #databasePath: string;
  readonly #data: OperationalStoreData;
  readonly #eventLimit: number;
  readonly #now: () => Date;
  #closed = false;

  constructor(options: JsonFileOperationalStoreOptions) {
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

  eventLimit(): number {
    this.#assertOpen();
    return this.#eventLimit;
  }

  countEventSourceTypes(): number {
    this.#assertOpen();
    return new Set(Object.values(this.#data.events).map((event) => event.source.type)).size;
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

  updateAgentTaskStatus(input: UpdateAgentTaskStatusInput): StoredAgentTask | undefined {
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

  updateAgentTaskProjectClaim(input: UpdateAgentTaskProjectClaimInput): StoredAgentTask | undefined {
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

  getDashboardLayout(): StoredDashboardLayout | undefined {
    this.#assertOpen();
    return this.#data.dashboardLayout === undefined ? undefined : jsonClone(this.#data.dashboardLayout);
  }

  saveDashboardLayout(items: DashboardLayoutItem[]): StoredDashboardLayout {
    this.#assertOpen();
    const layout: StoredDashboardLayout = {
      id: 'user.dashboardLayout',
      items: jsonClone(items),
      updatedAt: this.#now().toISOString(),
    };
    this.#data.dashboardLayout = layout;
    this.#persist();
    return jsonClone(layout);
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

export class SqliteOperationalStore implements OperationalStore {
  readonly #databasePath: string;
  readonly #database: SqliteDatabase;
  readonly #eventLimit: number;
  readonly #now: () => Date;
  #closed = false;

  constructor(options: RainrailOperationalStoreOptions) {
    const DatabaseSync = loadDatabaseSync();
    const legacyData = readLegacyJsonStoreData(options.databasePath);
    this.#databasePath = options.databasePath;
    this.#eventLimit = expectPositiveInteger(options.eventLimit, 'eventLimit');
    this.#now = options.now ?? (() => new Date());
    if (options.databasePath !== ':memory:') {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }
    const legacyBackupPath = legacyData === undefined ? undefined : moveLegacyJsonStore(options.databasePath);
    let database: SqliteDatabase | undefined;
    try {
      database = new DatabaseSync(options.databasePath);
      this.#database = database;
      this.#protectDatabaseFiles();
      this.#database.exec('PRAGMA busy_timeout = 5000');
      this.#database.exec('PRAGMA foreign_keys = ON');
      this.#database.exec('PRAGMA journal_mode = WAL');
      this.#migrate();
      if (legacyData !== undefined) {
        this.#importLegacyData(legacyData);
      }
    } catch (error) {
      if (legacyBackupPath !== undefined) {
        database?.close();
        restoreLegacyJsonStore(options.databasePath, legacyBackupPath);
      }
      throw error;
    }
    this.#protectDatabaseFiles();
  }

  close(): void {
    if (this.#closed) return;
    this.#database.close();
    this.#closed = true;
  }

  recordEvent<TPayload>(event: RainrailEventEnvelope<TPayload>): StoredOperationalEvent<TPayload> {
    this.#assertOpen();
    const stored = eventToStoredOperationalEvent(event);
    const sanitizedEnvelope = eventEnvelopeWithoutRawPayload(stored.envelope);
    this.#database.prepare(`
      INSERT INTO operational_events (
        id, name, source_type, source_json, delivery_json, subject_json, occurred_at, received_at,
        payload_json, raw_payload_reference_json, links_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        source_type = excluded.source_type,
        source_json = excluded.source_json,
        delivery_json = excluded.delivery_json,
        subject_json = excluded.subject_json,
        occurred_at = excluded.occurred_at,
        received_at = excluded.received_at,
        payload_json = excluded.payload_json,
        raw_payload_reference_json = excluded.raw_payload_reference_json,
        links_json = excluded.links_json
    `).run(
      stored.id,
      stored.name,
      stored.source.type,
      toJsonText(stored.source),
      toJsonText(stored.delivery),
      toJsonText(stored.subject),
      stored.occurredAt,
      stored.receivedAt,
      toJsonText(sanitizedEnvelope.payload),
      toJsonText(sanitizedEnvelope.rawPayload),
      toNullableJsonText(sanitizedEnvelope.links),
    );
    this.#protectDatabaseFiles();

    return this.getEvent(stored.id) as StoredOperationalEvent<TPayload>;
  }

  getEvent(id: string): StoredOperationalEvent | undefined {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT * FROM operational_events WHERE id = ?').get(id);
    return row === undefined ? undefined : operationalEventFromRow(row);
  }

  eventLimit(): number {
    this.#assertOpen();
    return this.#eventLimit;
  }

  countEventSourceTypes(): number {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT COUNT(DISTINCT source_type) AS count FROM operational_events').get();
    return requiredNumber(row, 'count');
  }

  listEvents(options: ListOperationalStoreEventsOptions = {}): StoredOperationalEvent[] {
    this.#assertOpen();
    const limit = options.limit;
    const rows = limit === undefined
      ? this.#database.prepare('SELECT * FROM operational_events ORDER BY received_at DESC, id DESC').all()
      : this.#database.prepare('SELECT * FROM operational_events ORDER BY received_at DESC, id DESC LIMIT ?').all(limit);
    return rows.map(operationalEventFromRow);
  }

  recordActivityEvent(input: RecordActivityEventInput): StoredActivityEvent {
    this.#assertOpen();
    const id = input.id ?? this.#nextId('activity', 'act');
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
    this.#database.prepare(`
      INSERT INTO activity_events (
        id, source_event_id, source_event_name, category, target_type, target_id, target_url,
        action_type, outcome, summary, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_event_id = excluded.source_event_id,
        source_event_name = excluded.source_event_name,
        category = excluded.category,
        target_type = excluded.target_type,
        target_id = excluded.target_id,
        target_url = excluded.target_url,
        action_type = excluded.action_type,
        outcome = excluded.outcome,
        summary = excluded.summary,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at
    `).run(
      activity.id,
      activity.sourceEventId ?? null,
      activity.sourceEventName ?? null,
      activity.category,
      activity.targetType,
      activity.targetId ?? null,
      activity.targetUrl ?? null,
      activity.actionType,
      activity.outcome,
      activity.summary,
      toNullableJsonText(activity.metadata),
      activity.createdAt,
    );
    this.#protectDatabaseFiles();
    return jsonClone(activity);
  }

  getActivityEvent(id: string): StoredActivityEvent | undefined {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT * FROM activity_events WHERE id = ?').get(id);
    return row === undefined ? undefined : activityEventFromRow(row);
  }

  listActivityEvents(options: ListOperationalStoreActivityEventsOptions = {}): StoredActivityEvent[] {
    this.#assertOpen();
    const where = options.hideSkippedActivityEvents === true ? 'WHERE outcome <> ?' : '';
    const limit = options.limit;
    const query = `SELECT * FROM activity_events ${where} ORDER BY created_at DESC, id DESC${limit === undefined ? '' : ' LIMIT ?'}`;
    const values: Array<string | number | null> = [
      ...(options.hideSkippedActivityEvents === true ? ['skipped'] : []),
      ...(limit === undefined ? [] : [limit]),
    ];
    return this.#database.prepare(query).all(...values).map(activityEventFromRow);
  }

  recordCommandResult(input: RecordCommandResultInput): StoredCommandResult {
    this.#assertOpen();
    const id = input.id ?? this.#nextId('command', 'cmd');
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
    this.#database.prepare(`
      INSERT INTO command_results (
        id, action_type, target_type, target_id, status, actor, client, request_id,
        dry_run, result_json, error, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        action_type = excluded.action_type,
        target_type = excluded.target_type,
        target_id = excluded.target_id,
        status = excluded.status,
        actor = excluded.actor,
        client = excluded.client,
        request_id = excluded.request_id,
        dry_run = excluded.dry_run,
        result_json = excluded.result_json,
        error = excluded.error,
        metadata_json = excluded.metadata_json,
        created_at = excluded.created_at
    `).run(
      commandResult.id,
      commandResult.actionType,
      commandResult.targetType,
      commandResult.targetId,
      commandResult.status,
      commandResult.actor,
      commandResult.client ?? null,
      commandResult.requestId,
      commandResult.dryRun ? 1 : 0,
      toNullableJsonText(commandResult.result),
      commandResult.error ?? null,
      toNullableJsonText(commandResult.metadata),
      commandResult.createdAt,
    );
    this.#protectDatabaseFiles();
    return jsonClone(commandResult);
  }

  recordAgentTask(input: RecordAgentTaskInput): StoredAgentTask {
    this.#assertOpen();
    const now = this.#now().toISOString();
    const existing = this.getAgentTask(input.id);
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
    this.#database.prepare(`
      INSERT INTO agent_tasks (
        id, title, agent_session_id, branch_name, status, issue_json, claim_json, log_path,
        stderr_log_path, pid, resume_attempts_json, project_claim_json, result, started_at,
        completed_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        agent_session_id = excluded.agent_session_id,
        branch_name = excluded.branch_name,
        status = excluded.status,
        issue_json = excluded.issue_json,
        claim_json = excluded.claim_json,
        log_path = excluded.log_path,
        stderr_log_path = excluded.stderr_log_path,
        pid = excluded.pid,
        resume_attempts_json = excluded.resume_attempts_json,
        project_claim_json = excluded.project_claim_json,
        result = excluded.result,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run(
      task.id,
      task.title,
      task.agentSessionId ?? null,
      task.branchName,
      task.status,
      toNullableJsonText(task.issue),
      toNullableJsonText(task.claim),
      task.logPath ?? null,
      task.stderrLogPath ?? null,
      task.pid ?? null,
      toNullableJsonText(task.resumeAttempts),
      toNullableJsonText(task.projectClaim),
      task.result ?? null,
      task.startedAt,
      task.completedAt ?? null,
      task.updatedAt,
    );
    this.#protectDatabaseFiles();
    return jsonClone(task);
  }

  getAgentTask(id: string): StoredAgentTask | undefined {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id);
    return row === undefined ? undefined : agentTaskFromRow(row);
  }

  getAgentTaskByBranchName(branchName: string): StoredAgentTask | undefined {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT * FROM agent_tasks WHERE branch_name = ? ORDER BY updated_at DESC, id DESC LIMIT 1').get(branchName);
    return row === undefined ? undefined : agentTaskFromRow(row);
  }

  listAgentTasks(): StoredAgentTask[] {
    this.#assertOpen();
    return this.#database.prepare('SELECT * FROM agent_tasks ORDER BY updated_at DESC, id DESC').all().map(agentTaskFromRow);
  }

  updateAgentTaskStatus(input: UpdateAgentTaskStatusInput): StoredAgentTask | undefined {
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

  updateAgentTaskProjectClaim(input: UpdateAgentTaskProjectClaimInput): StoredAgentTask | undefined {
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
    const existing = this.getEventHandlerRetry(input.eventId, input.handlerName);
    const retry: StoredEventHandlerRetry = {
      eventId: input.eventId,
      handlerName: input.handlerName,
      attempts: input.attempts ?? (existing?.attempts ?? 0) + 1,
      nextRetryAt: input.nextRetryAt,
      lastError: input.lastError,
      updatedAt: this.#now().toISOString(),
    };
    this.#database.prepare(`
      INSERT INTO event_handler_retries (
        event_id, handler_name, attempts, next_retry_at, last_error, updated_at, claimed_until_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL)
      ON CONFLICT(event_id, handler_name) DO UPDATE SET
        attempts = excluded.attempts,
        next_retry_at = excluded.next_retry_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at,
        claimed_until_at = NULL
    `).run(retry.eventId, retry.handlerName, retry.attempts, retry.nextRetryAt, retry.lastError, retry.updatedAt);
    this.#protectDatabaseFiles();
    return jsonClone(retry);
  }

  getEventHandlerRetry(eventId: string, handlerName: string): StoredEventHandlerRetry | undefined {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT * FROM event_handler_retries WHERE event_id = ? AND handler_name = ?').get(eventId, handlerName);
    return row === undefined ? undefined : eventHandlerRetryFromRow(row);
  }

  claimEventHandlerRetry(retry: StoredEventHandlerRetry, claimedUntilAt: string, now: string): boolean {
    this.#assertOpen();
    const result = this.#database.prepare(`
      UPDATE event_handler_retries
      SET updated_at = ?, claimed_until_at = ?
      WHERE event_id = ?
        AND handler_name = ?
        AND attempts = ?
        AND next_retry_at = ?
        AND last_error = ?
        AND updated_at = ?
        AND (claimed_until_at = ? OR (claimed_until_at IS NULL AND ? IS NULL))
        AND (claimed_until_at IS NULL OR claimed_until_at <= ?)
    `).run(
      now,
      claimedUntilAt,
      retry.eventId,
      retry.handlerName,
      retry.attempts,
      retry.nextRetryAt,
      retry.lastError,
      retry.updatedAt,
      retry.claimedUntilAt ?? null,
      retry.claimedUntilAt ?? null,
      now,
    );
    this.#protectDatabaseFiles();
    return result.changes === 1;
  }

  listDueEventHandlerRetries(now: string, limit?: number): StoredEventHandlerRetry[] {
    this.#assertOpen();
    const rows = limit === undefined
      ? this.#database.prepare(`
        SELECT * FROM event_handler_retries
        WHERE next_retry_at <= ? AND (claimed_until_at IS NULL OR claimed_until_at <= ?)
        ORDER BY next_retry_at ASC, handler_name ASC
      `).all(now, now)
      : this.#database.prepare(`
        SELECT * FROM event_handler_retries
        WHERE next_retry_at <= ? AND (claimed_until_at IS NULL OR claimed_until_at <= ?)
        ORDER BY next_retry_at ASC, handler_name ASC
        LIMIT ?
      `).all(now, now, limit);
    return rows.map(eventHandlerRetryFromRow);
  }

  listEventHandlerRetries(): StoredEventHandlerRetry[] {
    this.#assertOpen();
    return this.#database.prepare('SELECT * FROM event_handler_retries ORDER BY next_retry_at ASC, handler_name ASC')
      .all()
      .map(eventHandlerRetryFromRow);
  }

  clearEventHandlerRetry(eventId: string, handlerName: string): void {
    this.#assertOpen();
    this.#database.prepare('DELETE FROM event_handler_retries WHERE event_id = ? AND handler_name = ?').run(eventId, handlerName);
    this.#protectDatabaseFiles();
  }

  clearClaimedEventHandlerRetry(retry: StoredEventHandlerRetry): boolean {
    this.#assertOpen();
    const result = this.#database.prepare(`
      DELETE FROM event_handler_retries
      WHERE event_id = ?
        AND handler_name = ?
        AND attempts = ?
        AND next_retry_at = ?
        AND last_error = ?
        AND updated_at = ?
        AND (claimed_until_at = ? OR (claimed_until_at IS NULL AND ? IS NULL))
    `).run(
      retry.eventId,
      retry.handlerName,
      retry.attempts,
      retry.nextRetryAt,
      retry.lastError,
      retry.updatedAt,
      retry.claimedUntilAt ?? null,
      retry.claimedUntilAt ?? null,
    );
    this.#protectDatabaseFiles();
    return result.changes === 1;
  }

  rescheduleClaimedEventHandlerRetry(
    retry: StoredEventHandlerRetry,
    input: RecordEventHandlerRetryInput,
  ): StoredEventHandlerRetry | undefined {
    this.#assertOpen();
    const updatedAt = this.#now().toISOString();
    const attempts = input.attempts ?? retry.attempts + 1;
    const result = this.#database.prepare(`
      UPDATE event_handler_retries
      SET event_id = ?, handler_name = ?, attempts = ?, next_retry_at = ?, last_error = ?, updated_at = ?, claimed_until_at = NULL
      WHERE event_id = ?
        AND handler_name = ?
        AND attempts = ?
        AND next_retry_at = ?
        AND last_error = ?
        AND updated_at = ?
        AND (claimed_until_at = ? OR (claimed_until_at IS NULL AND ? IS NULL))
    `).run(
      input.eventId,
      input.handlerName,
      attempts,
      input.nextRetryAt,
      input.lastError,
      updatedAt,
      retry.eventId,
      retry.handlerName,
      retry.attempts,
      retry.nextRetryAt,
      retry.lastError,
      retry.updatedAt,
      retry.claimedUntilAt ?? null,
      retry.claimedUntilAt ?? null,
    );
    if (result.changes !== 1) return undefined;
    this.#protectDatabaseFiles();
    return this.getEventHandlerRetry(input.eventId, input.handlerName);
  }

  getDashboardLayout(): StoredDashboardLayout | undefined {
    this.#assertOpen();
    const row = this.#database.prepare('SELECT * FROM dashboard_layout WHERE id = ?').get('user.dashboardLayout');
    return row === undefined ? undefined : dashboardLayoutFromRow(row);
  }

  saveDashboardLayout(items: DashboardLayoutItem[]): StoredDashboardLayout {
    this.#assertOpen();
    const layout: StoredDashboardLayout = {
      id: 'user.dashboardLayout',
      items: jsonClone(items),
      updatedAt: this.#now().toISOString(),
    };
    this.#database.prepare(`
      INSERT INTO dashboard_layout (id, items_json, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        items_json = excluded.items_json,
        updated_at = excluded.updated_at
    `).run(layout.id, toJsonText(layout.items), layout.updatedAt);
    this.#protectDatabaseFiles();
    return jsonClone(layout);
  }

  snapshot(options: SnapshotOptions = {}): OperationalStoreSnapshot {
    this.#assertOpen();
    const activityEvents = this.listActivityEvents({
      ...(options.hideSkippedActivityEvents === undefined ? {} : { hideSkippedActivityEvents: options.hideSkippedActivityEvents }),
      limit: this.#eventLimit,
    });
    const events = this.listEvents({ limit: this.#eventLimit });
    const commandResults = this.#database.prepare('SELECT * FROM command_results ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(this.#eventLimit)
      .map(commandResultFromRow);

    return {
      events,
      activityEvents,
      agentTasks: this.listAgentTasks(),
      commandResults,
      eventHandlerRetries: this.listEventHandlerRetries(),
      warnings: {
        staleProjectClaims: staleProjectClaimWarnings(this.listAgentTasks()),
      },
      counts: {
        events: this.#count('operational_events'),
        activityEvents: this.#count('activity_events'),
        agentTasks: this.#count('agent_tasks'),
        commandResults: this.#count('command_results'),
        eventHandlerRetries: this.#count('event_handler_retries'),
      },
    };
  }

  #nextId(name: string, prefix: string): string {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database.prepare('SELECT value FROM operational_sequences WHERE name = ?').get(name);
      const value = (row === undefined ? 0 : requiredNumber(row, 'value')) + 1;
      this.#database.prepare(`
        INSERT INTO operational_sequences (name, value) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET value = excluded.value
      `).run(name, value);
      this.#database.exec('COMMIT');
      this.#protectDatabaseFiles();
      return `${prefix}_${String(value).padStart(6, '0')}`;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #count(tableName: string): number {
    const row = this.#database.prepare(`SELECT count(*) AS count FROM ${tableName}`).get();
    const value = rowValue(row, 'count');
    return typeof value === 'number' ? value : Number(value);
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS operational_events (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_json TEXT NOT NULL,
        delivery_json TEXT NOT NULL,
        subject_json TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        received_at TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        raw_payload_reference_json TEXT NOT NULL,
        links_json TEXT
      );
      CREATE INDEX IF NOT EXISTS operational_events_received_at_idx
        ON operational_events (received_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        source_event_id TEXT,
        source_event_name TEXT,
        category TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        target_url TEXT,
        action_type TEXT NOT NULL,
        outcome TEXT NOT NULL,
        summary TEXT NOT NULL,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS activity_events_created_at_idx
        ON activity_events (created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS command_results (
        id TEXT PRIMARY KEY,
        action_type TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,
        status TEXT NOT NULL,
        actor TEXT NOT NULL,
        client TEXT,
        request_id TEXT NOT NULL,
        dry_run INTEGER NOT NULL,
        result_json TEXT,
        error TEXT,
        metadata_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS command_results_created_at_idx
        ON command_results (created_at DESC, id DESC);

      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        agent_session_id TEXT,
        branch_name TEXT NOT NULL,
        status TEXT NOT NULL,
        issue_json TEXT,
        claim_json TEXT,
        log_path TEXT,
        stderr_log_path TEXT,
        pid INTEGER,
        resume_attempts_json TEXT,
        project_claim_json TEXT,
        result TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_tasks_updated_at_idx
        ON agent_tasks (updated_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS agent_tasks_branch_name_idx
        ON agent_tasks (branch_name);

      CREATE TABLE IF NOT EXISTS event_handler_retries (
        event_id TEXT NOT NULL,
        handler_name TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        next_retry_at TEXT NOT NULL,
        last_error TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        claimed_until_at TEXT,
        PRIMARY KEY (event_id, handler_name)
      );
      CREATE INDEX IF NOT EXISTS event_handler_retries_schedule_idx
        ON event_handler_retries (next_retry_at ASC, handler_name ASC);

      CREATE TABLE IF NOT EXISTS dashboard_layout (
        id TEXT PRIMARY KEY,
        items_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS operational_sequences (
        name TEXT PRIMARY KEY,
        value INTEGER NOT NULL
      );
    `);
    this.#addColumnIfMissing(
      'operational_events',
      'raw_payload_reference_json',
      `TEXT NOT NULL DEFAULT '${toJsonText(redactedRawPayloadReference()).replaceAll("'", "''")}'`,
    );
    this.#addColumnIfMissing('operational_events', 'source_type', `TEXT NOT NULL DEFAULT 'unknown'`);
    this.#backfillOperationalEventSourceTypes();
    this.#protectDatabaseFiles();
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error('operational store is closed');
    }
  }

  #addColumnIfMissing(tableName: string, columnName: string, definition: string): void {
    const rows = this.#database.prepare(`PRAGMA table_info(${tableName})`).all();
    if (rows.some((row) => rowValue(row, 'name') === columnName)) return;
    this.#database.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
    this.#protectDatabaseFiles();
  }

  #backfillOperationalEventSourceTypes(): void {
    const rows = this.#database.prepare('SELECT id, source_json FROM operational_events WHERE source_type = ?').all('unknown');
    if (rows.length === 0) return;

    const update = this.#database.prepare('UPDATE operational_events SET source_type = ? WHERE id = ?');
    for (const row of rows) {
      const source = fromJsonText<RainrailEventEnvelope['source']>(requiredString(row, 'source_json'));
      update.run(source.type, requiredString(row, 'id'));
    }
    this.#protectDatabaseFiles();
  }

  #importLegacyData(data: OperationalStoreData): void {
    for (const event of Object.values(data.events)) {
      this.recordEvent(event.envelope);
    }
    for (const activity of Object.values(data.activityEvents)) {
      this.#database.prepare(`
        INSERT INTO activity_events (
          id, source_event_id, source_event_name, category, target_type, target_id, target_url,
          action_type, outcome, summary, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_event_id = excluded.source_event_id,
          source_event_name = excluded.source_event_name,
          category = excluded.category,
          target_type = excluded.target_type,
          target_id = excluded.target_id,
          target_url = excluded.target_url,
          action_type = excluded.action_type,
          outcome = excluded.outcome,
          summary = excluded.summary,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at
      `).run(
        activity.id,
        activity.sourceEventId ?? null,
        activity.sourceEventName ?? null,
        activity.category,
        activity.targetType,
        activity.targetId ?? null,
        activity.targetUrl ?? null,
        activity.actionType,
        activity.outcome,
        activity.summary,
        toNullableJsonText(activity.metadata),
        activity.createdAt,
      );
    }
    for (const task of Object.values(data.agentTasks)) {
      this.#database.prepare(`
        INSERT INTO agent_tasks (
          id, title, agent_session_id, branch_name, status, issue_json, claim_json, log_path,
          stderr_log_path, pid, resume_attempts_json, project_claim_json, result, started_at,
          completed_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          agent_session_id = excluded.agent_session_id,
          branch_name = excluded.branch_name,
          status = excluded.status,
          issue_json = excluded.issue_json,
          claim_json = excluded.claim_json,
          log_path = excluded.log_path,
          stderr_log_path = excluded.stderr_log_path,
          pid = excluded.pid,
          resume_attempts_json = excluded.resume_attempts_json,
          project_claim_json = excluded.project_claim_json,
          result = excluded.result,
          started_at = excluded.started_at,
          completed_at = excluded.completed_at,
          updated_at = excluded.updated_at
      `).run(
        task.id,
        task.title,
        task.agentSessionId ?? null,
        task.branchName,
        task.status,
        toNullableJsonText(task.issue),
        toNullableJsonText(task.claim),
        task.logPath ?? null,
        task.stderrLogPath ?? null,
        task.pid ?? null,
        toNullableJsonText(task.resumeAttempts),
        toNullableJsonText(task.projectClaim),
        task.result ?? null,
        task.startedAt,
        task.completedAt ?? null,
        task.updatedAt,
      );
    }
    for (const result of Object.values(data.commandResults)) {
      this.#database.prepare(`
        INSERT INTO command_results (
          id, action_type, target_type, target_id, status, actor, client, request_id,
          dry_run, result_json, error, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          action_type = excluded.action_type,
          target_type = excluded.target_type,
          target_id = excluded.target_id,
          status = excluded.status,
          actor = excluded.actor,
          client = excluded.client,
          request_id = excluded.request_id,
          dry_run = excluded.dry_run,
          result_json = excluded.result_json,
          error = excluded.error,
          metadata_json = excluded.metadata_json,
          created_at = excluded.created_at
      `).run(
        result.id,
        result.actionType,
        result.targetType,
        result.targetId,
        result.status,
        result.actor,
        result.client ?? null,
        result.requestId,
        result.dryRun ? 1 : 0,
        toNullableJsonText(result.result),
        result.error ?? null,
        toNullableJsonText(result.metadata),
        result.createdAt,
      );
    }
    for (const retry of Object.values(data.eventHandlerRetries)) {
      this.#database.prepare(`
        INSERT INTO event_handler_retries (
          event_id, handler_name, attempts, next_retry_at, last_error, updated_at, claimed_until_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id, handler_name) DO UPDATE SET
          attempts = excluded.attempts,
          next_retry_at = excluded.next_retry_at,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at,
          claimed_until_at = excluded.claimed_until_at
      `).run(
        retry.eventId,
        retry.handlerName,
        retry.attempts,
        retry.nextRetryAt,
        retry.lastError,
        retry.updatedAt,
        retry.claimedUntilAt ?? null,
      );
    }
    if (data.dashboardLayout !== undefined) {
      this.#database.prepare(`
        INSERT INTO dashboard_layout (id, items_json, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          items_json = excluded.items_json,
          updated_at = excluded.updated_at
      `).run(data.dashboardLayout.id, toJsonText(data.dashboardLayout.items), data.dashboardLayout.updatedAt);
    }
    for (const [name, value] of Object.entries(data.sequences)) {
      this.#database.prepare(`
        INSERT INTO operational_sequences (name, value) VALUES (?, ?)
        ON CONFLICT(name) DO UPDATE SET value = max(value, excluded.value)
      `).run(name, value);
    }
    this.#protectDatabaseFiles();
  }

  #protectDatabaseFiles(): void {
    if (this.#databasePath === ':memory:') return;
    for (const path of [this.#databasePath, `${this.#databasePath}-wal`, `${this.#databasePath}-shm`]) {
      if (!existsSync(path)) continue;
      chmodSync(path, 0o600);
    }
  }
}

export { SqliteOperationalStore as RainrailOperationalStore };

function loadDatabaseSync(): DatabaseSyncConstructor {
  try {
    return (nodeRequire('node:sqlite') as { DatabaseSync: DatabaseSyncConstructor }).DatabaseSync;
  } catch (error) {
    throw new Error(
      'SQLite operational store requires a Node.js runtime with node:sqlite support. '
        + 'Use JsonFileOperationalStore on older Node.js versions or upgrade Node.js.',
      { cause: error },
    );
  }
}

function readLegacyJsonStoreData(databasePath: string): OperationalStoreData | undefined {
  if (databasePath === ':memory:' || !existsSync(databasePath) || isSqliteDatabaseFile(databasePath)) {
    return undefined;
  }

  const raw = readFileSync(databasePath, 'utf8');
  const firstNonWhitespace = raw.match(/\S/u)?.[0];
  if (firstNonWhitespace !== '{') {
    return undefined;
  }

  return parseStoreData(raw);
}

function moveLegacyJsonStore(databasePath: string): string {
  const backupPath = `${databasePath}.json-backup`;
  renameSync(databasePath, backupPath);
  chmodSync(backupPath, 0o600);
  sharedFileStores.delete(databasePath);
  return backupPath;
}

function restoreLegacyJsonStore(databasePath: string, backupPath: string): void {
  removeSqliteDatabaseFiles(databasePath);
  renameSync(backupPath, databasePath);
  chmodSync(databasePath, 0o600);
}

function isSqliteDatabaseFile(databasePath: string): boolean {
  const fd = openSync(databasePath, 'r');
  try {
    const header = Buffer.alloc(16);
    const bytesRead = readSync(fd, header, 0, header.length, 0);
    return bytesRead === header.length && header.toString('utf8') === 'SQLite format 3\u0000';
  } finally {
    closeSync(fd);
  }
}

function removeSqliteDatabaseFiles(databasePath: string): void {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    rmSync(path, { force: true });
  }
}

function operationalEventFromRow(row: unknown): StoredOperationalEvent {
  const source = fromJsonText<RainrailEventEnvelope['source']>(requiredString(row, 'source_json'));
  const delivery = fromJsonText<RainrailEventEnvelope['delivery']>(requiredString(row, 'delivery_json'));
  const subject = fromJsonText<RainrailEventEnvelope['subject']>(requiredString(row, 'subject_json'));
  const payload = fromJsonText<unknown>(requiredString(row, 'payload_json'));
  const rawPayload = fromJsonText<RainrailEventEnvelope['rawPayload']>(requiredString(row, 'raw_payload_reference_json'));
  const links = fromNullableJsonText<Record<string, string>>(nullableString(row, 'links_json'));
  const envelope = {
    id: requiredString(row, 'id'),
    schemaVersion: 'rainrail.event.v1',
    source,
    name: requiredString(row, 'name'),
    delivery,
    occurredAt: requiredString(row, 'occurred_at'),
    subject,
    payload,
    rawPayload,
    ...(links === undefined ? {} : { links }),
  } satisfies RainrailEventEnvelope;
  return {
    id: envelope.id,
    name: envelope.name,
    source,
    delivery,
    subject,
    occurredAt: envelope.occurredAt,
    receivedAt: requiredString(row, 'received_at'),
    envelope,
  };
}

function activityEventFromRow(row: unknown): StoredActivityEvent {
  const sourceEventId = nullableString(row, 'source_event_id');
  const sourceEventName = nullableString(row, 'source_event_name');
  const targetId = nullableString(row, 'target_id');
  const targetUrl = nullableString(row, 'target_url');
  const metadataJson = nullableString(row, 'metadata_json');
  return {
    id: requiredString(row, 'id'),
    ...(sourceEventId === undefined ? {} : { sourceEventId }),
    ...(sourceEventName === undefined ? {} : { sourceEventName }),
    category: requiredString(row, 'category'),
    targetType: requiredString(row, 'target_type'),
    ...(targetId === undefined ? {} : { targetId }),
    ...(targetUrl === undefined ? {} : { targetUrl }),
    actionType: requiredString(row, 'action_type'),
    outcome: requiredString(row, 'outcome') as StoredActivityEvent['outcome'],
    summary: requiredString(row, 'summary'),
    ...(metadataJson === undefined
      ? {}
      : { metadata: fromJsonText<Record<string, unknown>>(metadataJson) }),
    createdAt: requiredString(row, 'created_at'),
  };
}

function commandResultFromRow(row: unknown): StoredCommandResult {
  const client = nullableString(row, 'client');
  const resultJson = nullableString(row, 'result_json');
  const error = nullableString(row, 'error');
  const metadataJson = nullableString(row, 'metadata_json');
  return {
    id: requiredString(row, 'id'),
    actionType: requiredString(row, 'action_type'),
    targetType: requiredString(row, 'target_type'),
    targetId: requiredString(row, 'target_id'),
    status: requiredString(row, 'status') as StoredCommandResult['status'],
    actor: requiredString(row, 'actor'),
    ...(client === undefined ? {} : { client }),
    requestId: requiredString(row, 'request_id'),
    dryRun: Boolean(requiredNumber(row, 'dry_run')),
    ...(resultJson === undefined ? {} : { result: fromJsonText<unknown>(resultJson) }),
    ...(error === undefined ? {} : { error }),
    ...(metadataJson === undefined
      ? {}
      : { metadata: fromJsonText<Record<string, unknown>>(metadataJson) }),
    createdAt: requiredString(row, 'created_at'),
  };
}

function agentTaskFromRow(row: unknown): StoredAgentTask {
  const agentSessionId = nullableString(row, 'agent_session_id');
  const issueJson = nullableString(row, 'issue_json');
  const claimJson = nullableString(row, 'claim_json');
  const logPath = nullableString(row, 'log_path');
  const stderrLogPath = nullableString(row, 'stderr_log_path');
  const pid = nullableNumber(row, 'pid');
  const resumeAttemptsJson = nullableString(row, 'resume_attempts_json');
  const projectClaimJson = nullableString(row, 'project_claim_json');
  const result = nullableString(row, 'result');
  const completedAt = nullableString(row, 'completed_at');
  return agentTaskWithRuntime({
    id: requiredString(row, 'id'),
    title: requiredString(row, 'title'),
    ...(agentSessionId === undefined ? {} : { agentSessionId }),
    branchName: requiredString(row, 'branch_name'),
    status: requiredString(row, 'status') as StoredAgentTask['status'],
    ...(issueJson === undefined ? {} : { issue: fromJsonText<unknown>(issueJson) }),
    ...(claimJson === undefined ? {} : { claim: fromJsonText<unknown>(claimJson) }),
    ...(logPath === undefined ? {} : { logPath }),
    ...(stderrLogPath === undefined ? {} : { stderrLogPath }),
    ...(pid === undefined ? {} : { pid }),
    ...(resumeAttemptsJson === undefined
      ? {}
      : { resumeAttempts: fromJsonText<RuntimeAgentResumeAttempt[]>(resumeAttemptsJson) }),
    ...(projectClaimJson === undefined
      ? {}
      : { projectClaim: fromJsonText<StoredAgentTaskProjectClaimState>(projectClaimJson) }),
    ...(result === undefined ? {} : { result }),
    startedAt: requiredString(row, 'started_at'),
    ...(completedAt === undefined ? {} : { completedAt }),
    updatedAt: requiredString(row, 'updated_at'),
  });
}

function eventHandlerRetryFromRow(row: unknown): StoredEventHandlerRetry {
  const claimedUntilAt = nullableString(row, 'claimed_until_at');
  return {
    eventId: requiredString(row, 'event_id'),
    handlerName: requiredString(row, 'handler_name'),
    attempts: requiredNumber(row, 'attempts'),
    nextRetryAt: requiredString(row, 'next_retry_at'),
    lastError: requiredString(row, 'last_error'),
    updatedAt: requiredString(row, 'updated_at'),
    ...(claimedUntilAt === undefined ? {} : { claimedUntilAt }),
  };
}

function dashboardLayoutFromRow(row: unknown): StoredDashboardLayout {
  return {
    id: 'user.dashboardLayout',
    items: fromJsonText<DashboardLayoutItem[]>(requiredString(row, 'items_json')),
    updatedAt: requiredString(row, 'updated_at'),
  };
}

function eventEnvelopeWithoutRawPayload<TPayload>(event: RainrailEventEnvelope<TPayload>): RainrailEventEnvelope<TPayload> {
  const rawPayload = isSafeRawPayloadReference(event.rawPayload)
    ? jsonClone(event.rawPayload)
    : redactedRawPayloadReference();
  return {
    ...jsonClone(event),
    rawPayload,
  };
}

function isSafeRawPayloadReference(rawPayload: RainrailEventEnvelope['rawPayload']): boolean {
  if (rawPayload.kind === 'external-reference') return true;
  if (rawPayload.kind !== 'inline-redacted') return false;
  return /^(github|cloudflare|rainrail|manual|chat):\/\//u.test(rawPayload.reference);
}

function redactedRawPayloadReference(): RainrailEventEnvelope['rawPayload'] {
  return {
    kind: 'inline-redacted',
    reference: 'rainrail://redacted/raw-payload',
  };
}

function toJsonText(value: unknown): string {
  return JSON.stringify(value);
}

function toNullableJsonText(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function fromJsonText<T>(value: string): T {
  return JSON.parse(value) as T;
}

function fromNullableJsonText<T>(value: string | undefined): T | undefined {
  return value === undefined ? undefined : fromJsonText<T>(value);
}

function rowValue(row: unknown, key: string): unknown {
  if (typeof row !== 'object' || row === null || !(key in row)) {
    throw new Error(`SQLite row is missing ${key}`);
  }
  return (row as Record<string, unknown>)[key];
}

function requiredString(row: unknown, key: string): string {
  const value = rowValue(row, key);
  if (typeof value !== 'string') throw new Error(`SQLite row ${key} must be a string`);
  return value;
}

function nullableString(row: unknown, key: string): string | undefined {
  const value = rowValue(row, key);
  if (value === null) return undefined;
  if (typeof value !== 'string') throw new Error(`SQLite row ${key} must be a string or null`);
  return value;
}

function requiredNumber(row: unknown, key: string): number {
  const value = rowValue(row, key);
  if (typeof value !== 'number') throw new Error(`SQLite row ${key} must be a number`);
  return value;
}

function nullableNumber(row: unknown, key: string): number | undefined {
  const value = rowValue(row, key);
  if (value === null) return undefined;
  if (typeof value !== 'number') throw new Error(`SQLite row ${key} must be a number or null`);
  return value;
}

function loadStoreData(databasePath: string): OperationalStoreData {
  if (databasePath === ':memory:') return emptyStoreData();

  const shared = sharedFileStores.get(databasePath);
  if (shared !== undefined) return shared;

  if (existsSync(databasePath) && isSqliteDatabaseFile(databasePath)) {
    throw new Error(
      'SQLite operational store file cannot be opened with JsonFileOperationalStore. '
        + 'Use RainrailOperationalStore/SqliteOperationalStore or choose a separate JSON databasePath.',
    );
  }

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
      ...(value.dashboardLayout === undefined ? {} : { dashboardLayout: value.dashboardLayout }),
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
