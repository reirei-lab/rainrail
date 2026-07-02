import { DatabaseSync } from 'node:sqlite';

import type { RainrailEventEnvelope } from './events.js';
import type { RuntimeRunStatus } from './runtime-provider.js';

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
  result?: string;
  startedAt?: string;
  completedAt?: string;
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
  nextRetryAt: string;
  lastError: string;
}

export interface StoredEventHandlerRetry extends RecordEventHandlerRetryInput {
  attempts: number;
  updatedAt: string;
}

export interface OperationalStoreSnapshot {
  events: StoredOperationalEvent[];
  activityEvents: StoredActivityEvent[];
  agentTasks: StoredAgentTask[];
  eventHandlerRetries: StoredEventHandlerRetry[];
  counts: {
    events: number;
    activityEvents: number;
    agentTasks: number;
    eventHandlerRetries: number;
  };
}

interface SnapshotOptions {
  hideSkippedActivityEvents?: boolean;
}

interface EventRow {
  id: string;
  name: string;
  source_json: string;
  delivery_json: string;
  subject_json: string;
  occurred_at: string;
  received_at: string;
  envelope_json: string;
}

interface ActivityRow {
  id: string;
  source_event_id: string | null;
  source_event_name: string | null;
  category: string;
  target_type: string;
  target_id: string | null;
  target_url: string | null;
  action_type: string;
  outcome: string;
  summary: string;
  metadata_json: string | null;
  created_at: string;
}

interface AgentTaskRow {
  id: string;
  title: string;
  agent_session_id: string | null;
  branch_name: string;
  status: string;
  issue_json: string | null;
  claim_json: string | null;
  log_path: string | null;
  stderr_log_path: string | null;
  pid: number | null;
  result: string | null;
  started_at: string;
  completed_at: string | null;
  updated_at: string;
}

interface RetryRow {
  event_id: string;
  handler_name: string;
  attempts: number;
  next_retry_at: string;
  last_error: string;
  updated_at: string;
}

export class RainrailOperationalStore {
  readonly #db: DatabaseSync;
  readonly #eventLimit: number;
  readonly #now: () => Date;

  constructor(options: RainrailOperationalStoreOptions) {
    this.#eventLimit = expectPositiveInteger(options.eventLimit, 'eventLimit');
    this.#now = options.now ?? (() => new Date());
    this.#db = new DatabaseSync(options.databasePath);
    this.#migrate();
  }

  close(): void {
    this.#db.close();
  }

  recordEvent<TPayload>(event: RainrailEventEnvelope<TPayload>): StoredOperationalEvent<TPayload> {
    const receivedAt = event.delivery.receivedAt;
    this.#db.prepare(`
      insert into events (
        id, name, source_json, delivery_json, subject_json, occurred_at, received_at, envelope_json
      ) values (?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        name = excluded.name,
        source_json = excluded.source_json,
        delivery_json = excluded.delivery_json,
        subject_json = excluded.subject_json,
        occurred_at = excluded.occurred_at,
        received_at = excluded.received_at,
        envelope_json = excluded.envelope_json
    `).run(
      event.id,
      event.name,
      JSON.stringify(event.source),
      JSON.stringify(event.delivery),
      JSON.stringify(event.subject),
      event.occurredAt,
      receivedAt,
      JSON.stringify(event),
    );

    return this.getEvent(event.id) as StoredOperationalEvent<TPayload>;
  }

  getEvent(id: string): StoredOperationalEvent | undefined {
    const row = this.#db.prepare(`
      select id, name, source_json, delivery_json, subject_json, occurred_at, received_at, envelope_json
      from events
      where id = ?
    `).get(id) as EventRow | undefined;

    return row === undefined ? undefined : eventFromRow(row);
  }

  recordActivityEvent(input: RecordActivityEventInput): StoredActivityEvent {
    const id = input.id ?? nextId(this.#db, 'activity', 'act');
    const createdAt = this.#now().toISOString();
    this.#db.prepare(`
      insert into activity_events (
        id, source_event_id, source_event_name, category, target_type, target_id, target_url,
        action_type, outcome, summary, metadata_json, created_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.sourceEventId ?? null,
      input.sourceEventName ?? null,
      input.category,
      input.targetType,
      input.targetId ?? null,
      input.targetUrl ?? null,
      input.actionType,
      input.outcome,
      input.summary,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
      createdAt,
    );

    return activityFromRow(this.#db.prepare(`
      select *
      from activity_events
      where id = ?
    `).get(id) as unknown as ActivityRow);
  }

  recordAgentTask(input: RecordAgentTaskInput): StoredAgentTask {
    const now = this.#now().toISOString();
    const existing = this.getAgentTask(input.id);
    const startedAt = input.startedAt ?? existing?.startedAt ?? now;
    const status = input.status ?? existing?.status ?? 'running';
    this.#db.prepare(`
      insert into agent_tasks (
        id, title, agent_session_id, branch_name, status, issue_json, claim_json,
        log_path, stderr_log_path, pid, result, started_at, completed_at, updated_at
      ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      on conflict(id) do update set
        title = excluded.title,
        agent_session_id = excluded.agent_session_id,
        branch_name = excluded.branch_name,
        status = excluded.status,
        issue_json = excluded.issue_json,
        claim_json = excluded.claim_json,
        log_path = excluded.log_path,
        stderr_log_path = excluded.stderr_log_path,
        pid = excluded.pid,
        result = excluded.result,
        started_at = excluded.started_at,
        completed_at = excluded.completed_at,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.title,
      input.agentSessionId ?? null,
      input.branchName,
      status,
      input.issue === undefined ? null : JSON.stringify(input.issue),
      input.claim === undefined ? null : JSON.stringify(input.claim),
      input.logPath ?? null,
      input.stderrLogPath ?? null,
      input.pid ?? null,
      input.result ?? null,
      startedAt,
      input.completedAt ?? null,
      now,
    );

    return this.getAgentTask(input.id)!;
  }

  getAgentTask(id: string): StoredAgentTask | undefined {
    const row = this.#db.prepare(`
      select *
      from agent_tasks
      where id = ?
    `).get(id) as AgentTaskRow | undefined;

    return row === undefined ? undefined : agentTaskFromRow(row);
  }

  getAgentTaskByBranchName(branchName: string): StoredAgentTask | undefined {
    const row = this.#db.prepare(`
      select *
      from agent_tasks
      where branch_name = ?
      order by updated_at desc
      limit 1
    `).get(branchName) as AgentTaskRow | undefined;

    return row === undefined ? undefined : agentTaskFromRow(row);
  }

  listAgentTasks(): StoredAgentTask[] {
    return (this.#db.prepare(`
      select *
      from agent_tasks
      order by updated_at desc, id desc
    `).all() as unknown as AgentTaskRow[]).map(agentTaskFromRow);
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
      ...((input.result ?? existing.result) === undefined ? {} : { result: input.result ?? existing.result }),
      startedAt: existing.startedAt,
      ...((input.completedAt ?? existing.completedAt) === undefined
        ? {}
        : { completedAt: input.completedAt ?? existing.completedAt }),
    });
  }

  recordEventHandlerRetry(input: RecordEventHandlerRetryInput): StoredEventHandlerRetry {
    const existing = this.getEventHandlerRetry(input.eventId, input.handlerName);
    const attempts = (existing?.attempts ?? 0) + 1;
    const updatedAt = this.#now().toISOString();
    this.#db.prepare(`
      insert into event_handler_retries (
        event_id, handler_name, attempts, next_retry_at, last_error, updated_at
      ) values (?, ?, ?, ?, ?, ?)
      on conflict(event_id, handler_name) do update set
        attempts = excluded.attempts,
        next_retry_at = excluded.next_retry_at,
        last_error = excluded.last_error,
        updated_at = excluded.updated_at
    `).run(input.eventId, input.handlerName, attempts, input.nextRetryAt, input.lastError, updatedAt);

    return this.getEventHandlerRetry(input.eventId, input.handlerName)!;
  }

  getEventHandlerRetry(eventId: string, handlerName: string): StoredEventHandlerRetry | undefined {
    const row = this.#db.prepare(`
      select event_id, handler_name, attempts, next_retry_at, last_error, updated_at
      from event_handler_retries
      where event_id = ? and handler_name = ?
    `).get(eventId, handlerName) as RetryRow | undefined;

    return row === undefined ? undefined : retryFromRow(row);
  }

  listDueEventHandlerRetries(now: string, limit = 100): StoredEventHandlerRetry[] {
    return (this.#db.prepare(`
      select event_id, handler_name, attempts, next_retry_at, last_error, updated_at
      from event_handler_retries
      where next_retry_at <= ?
      order by next_retry_at asc, handler_name asc
      limit ?
    `).all(now, limit) as unknown as RetryRow[]).map(retryFromRow);
  }

  clearEventHandlerRetry(eventId: string, handlerName: string): void {
    this.#db.prepare(`
      delete from event_handler_retries
      where event_id = ? and handler_name = ?
    `).run(eventId, handlerName);
  }

  snapshot(options: SnapshotOptions = {}): OperationalStoreSnapshot {
    const activityFilter = options.hideSkippedActivityEvents ? 'where outcome <> ?' : '';
    const activityArgs = options.hideSkippedActivityEvents ? ['skipped', this.#eventLimit] : [this.#eventLimit];

    return {
      events: (this.#db.prepare(`
        select id, name, source_json, delivery_json, subject_json, occurred_at, received_at, envelope_json
        from events
        order by received_at desc, id desc
        limit ?
      `).all(this.#eventLimit) as unknown as EventRow[]).map(eventFromRow),
      activityEvents: (this.#db.prepare(`
        select *
        from activity_events
        ${activityFilter}
        order by created_at desc, id desc
        limit ?
      `).all(...activityArgs) as unknown as ActivityRow[]).map(activityFromRow),
      agentTasks: this.listAgentTasks(),
      eventHandlerRetries: (this.#db.prepare(`
        select event_id, handler_name, attempts, next_retry_at, last_error, updated_at
        from event_handler_retries
        order by next_retry_at asc, handler_name asc
      `).all() as unknown as RetryRow[]).map(retryFromRow),
      counts: {
        events: countRows(this.#db, 'events'),
        activityEvents: countRows(this.#db, 'activity_events'),
        agentTasks: countRows(this.#db, 'agent_tasks'),
        eventHandlerRetries: countRows(this.#db, 'event_handler_retries'),
      },
    };
  }

  #migrate(): void {
    this.#db.exec(`
      create table if not exists sequences (
        name text primary key,
        value integer not null
      );

      create table if not exists events (
        id text primary key,
        name text not null,
        source_json text not null,
        delivery_json text not null,
        subject_json text not null,
        occurred_at text not null,
        received_at text not null,
        envelope_json text not null
      );
      create index if not exists idx_events_received_at on events(received_at desc);

      create table if not exists activity_events (
        id text primary key,
        source_event_id text,
        source_event_name text,
        category text not null,
        target_type text not null,
        target_id text,
        target_url text,
        action_type text not null,
        outcome text not null,
        summary text not null,
        metadata_json text,
        created_at text not null
      );
      create index if not exists idx_activity_events_created_at on activity_events(created_at desc);

      create table if not exists agent_tasks (
        id text primary key,
        title text not null,
        agent_session_id text,
        branch_name text not null,
        status text not null,
        issue_json text,
        claim_json text,
        log_path text,
        stderr_log_path text,
        pid integer,
        result text,
        started_at text not null,
        completed_at text,
        updated_at text not null
      );
      create index if not exists idx_agent_tasks_branch_name on agent_tasks(branch_name);

      create table if not exists event_handler_retries (
        event_id text not null,
        handler_name text not null,
        attempts integer not null,
        next_retry_at text not null,
        last_error text not null,
        updated_at text not null,
        primary key(event_id, handler_name)
      );
      create index if not exists idx_event_handler_retries_next_retry_at
        on event_handler_retries(next_retry_at asc);
    `);
  }
}

function eventFromRow(row: EventRow): StoredOperationalEvent {
  return {
    id: row.id,
    name: row.name,
    source: JSON.parse(row.source_json) as StoredOperationalEvent['source'],
    delivery: JSON.parse(row.delivery_json) as StoredOperationalEvent['delivery'],
    subject: JSON.parse(row.subject_json) as StoredOperationalEvent['subject'],
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    envelope: JSON.parse(row.envelope_json) as RainrailEventEnvelope,
  };
}

function activityFromRow(row: ActivityRow): StoredActivityEvent {
  return {
    id: row.id,
    ...(row.source_event_id === null ? {} : { sourceEventId: row.source_event_id }),
    ...(row.source_event_name === null ? {} : { sourceEventName: row.source_event_name }),
    category: row.category,
    targetType: row.target_type,
    ...(row.target_id === null ? {} : { targetId: row.target_id }),
    ...(row.target_url === null ? {} : { targetUrl: row.target_url }),
    actionType: row.action_type,
    outcome: row.outcome as StoredActivityEvent['outcome'],
    summary: row.summary,
    ...(row.metadata_json === null ? {} : { metadata: JSON.parse(row.metadata_json) as Record<string, unknown> }),
    createdAt: row.created_at,
  };
}

function agentTaskFromRow(row: AgentTaskRow): StoredAgentTask {
  const task = {
    id: row.id,
    title: row.title,
    ...(row.agent_session_id === null ? {} : { agentSessionId: row.agent_session_id }),
    branchName: row.branch_name,
    status: row.status as RuntimeRunStatus,
    ...(row.issue_json === null ? {} : { issue: JSON.parse(row.issue_json) as unknown }),
    ...(row.claim_json === null ? {} : { claim: JSON.parse(row.claim_json) as unknown }),
    ...(row.log_path === null ? {} : { logPath: row.log_path }),
    ...(row.stderr_log_path === null ? {} : { stderrLogPath: row.stderr_log_path }),
    ...(row.pid === null ? {} : { pid: row.pid }),
    ...(row.result === null ? {} : { result: row.result }),
    startedAt: row.started_at,
    ...(row.completed_at === null ? {} : { completedAt: row.completed_at }),
    updatedAt: row.updated_at,
  };

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

function retryFromRow(row: RetryRow): StoredEventHandlerRetry {
  return {
    eventId: row.event_id,
    handlerName: row.handler_name,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    lastError: row.last_error,
    updatedAt: row.updated_at,
  };
}

function nextId(db: DatabaseSync, name: string, prefix: string): string {
  const current = db.prepare(`
    select value
    from sequences
    where name = ?
  `).get(name) as { value: number } | undefined;
  const next = (current?.value ?? 0) + 1;
  db.prepare(`
    insert into sequences (name, value)
    values (?, ?)
    on conflict(name) do update set value = excluded.value
  `).run(name, next);

  return `${prefix}_${String(next).padStart(6, '0')}`;
}

function countRows(db: DatabaseSync, tableName: string): number {
  const row = db.prepare(`select count(*) as count from ${tableName}`).get() as { count: number };
  return row.count;
}

function expectPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function stripUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T;
}
