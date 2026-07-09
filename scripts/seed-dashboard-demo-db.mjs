#!/usr/bin/env node
import { chmodSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');

export const DEFAULT_DEMO_DATABASE_PATH = fileURLToPath(new URL('../.tmp/dashboard-demo.sqlite', import.meta.url));

const fixedNow = '2026-07-09T05:00:00.000Z';

/**
 * @param {{ databasePath?: string }} [options]
 */
export function seedDashboardDemoDatabase(options = {}) {
  const databasePath = options.databasePath ?? DEFAULT_DEMO_DATABASE_PATH;
  rebuildDatabase(databasePath);

  const database = new DatabaseSync(databasePath);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    database.exec('PRAGMA foreign_keys = ON');
    database.exec('PRAGMA journal_mode = WAL');
    createSchema(database);
    insertDemoRows(database);
    protectDatabaseFiles(databasePath);
  } finally {
    database.close();
  }
  protectDatabaseFiles(databasePath);

  return {
    databasePath,
    generatedAt: fixedNow,
    counts: {
      events: demoEvents.length,
      activityEvents: demoActivityEvents.length,
      agentTasks: demoAgentTasks.length,
      commandResults: demoCommandResults.length,
      eventHandlerRetries: demoEventHandlerRetries.length,
    },
  };
}

/**
 * @param {string} databasePath
 */
function rebuildDatabase(databasePath) {
  mkdirSync(dirname(databasePath), { recursive: true });
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    rmSync(path, { force: true });
  }
}

/**
 * @param {string} databasePath
 */
function protectDatabaseFiles(databasePath) {
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    if (existsSync(path)) chmodSync(path, 0o600);
  }
}

/**
 * @param {import('node:sqlite').DatabaseSync} database
 */
function createSchema(database) {
  database.exec(`
    CREATE TABLE operational_events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      source_json TEXT NOT NULL,
      delivery_json TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      raw_payload_reference_json TEXT NOT NULL,
      links_json TEXT
    );
    CREATE INDEX operational_events_received_at_idx
      ON operational_events (received_at DESC, id DESC);

    CREATE TABLE activity_events (
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
    CREATE INDEX activity_events_created_at_idx
      ON activity_events (created_at DESC, id DESC);

    CREATE TABLE command_results (
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
    CREATE INDEX command_results_created_at_idx
      ON command_results (created_at DESC, id DESC);

    CREATE TABLE agent_tasks (
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
    CREATE INDEX agent_tasks_updated_at_idx
      ON agent_tasks (updated_at DESC, id DESC);
    CREATE INDEX agent_tasks_branch_name_idx
      ON agent_tasks (branch_name);

    CREATE TABLE event_handler_retries (
      event_id TEXT NOT NULL,
      handler_name TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      next_retry_at TEXT NOT NULL,
      last_error TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      claimed_until_at TEXT,
      PRIMARY KEY (event_id, handler_name)
    );
    CREATE INDEX event_handler_retries_schedule_idx
      ON event_handler_retries (next_retry_at ASC, handler_name ASC);

    CREATE TABLE operational_sequences (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );
  `);
}

/**
 * @param {import('node:sqlite').DatabaseSync} database
 */
function insertDemoRows(database) {
  const eventInsert = database.prepare(`
    INSERT INTO operational_events (
      id, name, source_json, delivery_json, subject_json, occurred_at, received_at,
      payload_json, raw_payload_reference_json, links_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const event of demoEvents) {
    eventInsert.run(
      event.id,
      event.name,
      json(event.source),
      json(event.delivery),
      json(event.subject),
      event.occurredAt,
      event.delivery.receivedAt,
      json(event.payload),
      json(event.rawPayload),
      nullableJson(event.links),
    );
  }

  const activityInsert = database.prepare(`
    INSERT INTO activity_events (
      id, source_event_id, source_event_name, category, target_type, target_id, target_url,
      action_type, outcome, summary, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const activity of demoActivityEvents) {
    activityInsert.run(
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
      nullableJson(activity.metadata),
      activity.createdAt,
    );
  }

  const taskInsert = database.prepare(`
    INSERT INTO agent_tasks (
      id, title, agent_session_id, branch_name, status, issue_json, claim_json, log_path,
      stderr_log_path, pid, resume_attempts_json, project_claim_json, result, started_at,
      completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const task of demoAgentTasks) {
    taskInsert.run(
      task.id,
      task.title,
      task.agentSessionId ?? null,
      task.branchName,
      task.status,
      nullableJson(task.issue),
      nullableJson(task.claim),
      task.logPath ?? null,
      task.stderrLogPath ?? null,
      task.pid ?? null,
      nullableJson(task.resumeAttempts),
      nullableJson(task.projectClaim),
      task.result ?? null,
      task.startedAt,
      task.completedAt ?? null,
      task.updatedAt,
    );
  }

  const commandInsert = database.prepare(`
    INSERT INTO command_results (
      id, action_type, target_type, target_id, status, actor, client, request_id,
      dry_run, result_json, error, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const command of demoCommandResults) {
    commandInsert.run(
      command.id,
      command.actionType,
      command.targetType,
      command.targetId,
      command.status,
      command.actor,
      command.client ?? null,
      command.requestId,
      command.dryRun ? 1 : 0,
      nullableJson(command.result),
      command.error ?? null,
      nullableJson(command.metadata),
      command.createdAt,
    );
  }

  const retryInsert = database.prepare(`
    INSERT INTO event_handler_retries (
      event_id, handler_name, attempts, next_retry_at, last_error, updated_at, claimed_until_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  for (const retry of demoEventHandlerRetries) {
    retryInsert.run(
      retry.eventId,
      retry.handlerName,
      retry.attempts,
      retry.nextRetryAt,
      retry.lastError,
      retry.updatedAt,
      retry.claimedUntilAt ?? null,
    );
  }

  const sequenceInsert = database.prepare('INSERT INTO operational_sequences (name, value) VALUES (?, ?)');
  sequenceInsert.run('activity', 4);
  sequenceInsert.run('command', 3);
}

/**
 * @param {Record<string, unknown>} input
 * @returns {Record<string, any>}
 */
function event(input) {
  return {
    schemaVersion: 'rainrail.event.v1',
    ...input,
  };
}

const demoEvents = [
  event({
    id: 'evt_demo_github_issue_272',
    name: 'github.issue',
    source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
    delivery: { id: 'gh-delivery-demo-001', receivedAt: '2026-07-09T04:50:05.000Z' },
    occurredAt: '2026-07-09T04:49:58.000Z',
    subject: { type: 'issue', id: '272', url: 'https://github.com/reirei-lab/rainrail/issues/272' },
    payload: {
      action: 'opened',
      title: 'Dashboard demo: seed representative SQLite operational data',
      labels: ['dashboard', 'demo-data'],
    },
    rawPayload: {
      kind: 'external-reference',
      reference: 'github://deliveries/gh-delivery-demo-001',
      contentType: 'application/json',
      sha256: 'a4c778f8a28149d589f1121118720b3b08b2fbe03df801e6290e4fedc27357b7',
    },
    links: { issue: 'https://github.com/reirei-lab/rainrail/issues/272' },
  }),
  event({
    id: 'evt_demo_cloudflare_tail_001',
    name: 'cloudflare.tail',
    source: { type: 'cloudflare', name: 'cloudflare-tail', account: 'demo-account', environment: 'preview' },
    delivery: { id: 'cf-tail-demo-001', receivedAt: '2026-07-09T04:51:10.000Z' },
    occurredAt: '2026-07-09T04:51:02.000Z',
    subject: { type: 'worker', id: 'rainrail-preview' },
    payload: {
      scriptName: 'rainrail-preview',
      outcome: 'exception',
      message: 'Synthetic timeout while posting a webhook preview',
    },
    rawPayload: {
      kind: 'external-reference',
      reference: 'cloudflare://tails/cf-tail-demo-001',
      contentType: 'application/json',
      sha256: 'b8a5dc9bd067114acafc0e58eaef86b32235f17486d86045154d2e0c1a02b117',
    },
  }),
  event({
    id: 'evt_demo_manual_chat_001',
    name: 'rainrail.chat.message',
    source: { type: 'chat', name: 'manual-chat', repository: 'reirei-lab/rainrail' },
    delivery: { id: 'chat-delivery-demo-001', receivedAt: '2026-07-09T04:52:20.000Z' },
    occurredAt: '2026-07-09T04:52:15.000Z',
    subject: { type: 'conversation', id: 'thread-demo-dashboard' },
    payload: {
      command: '/rainrail assign-next',
      channel: '#asme_dev',
      previewOnly: false,
    },
    rawPayload: {
      kind: 'inline-redacted',
      reference: 'chat://deliveries/chat-delivery-demo-001',
      sha256: 'fdba9080a52107952a14369da0661c97375db1d95faef8dc4678f5f5fabf32f3',
    },
    links: { thread: 'https://discord.example.invalid/channels/demo/thread-demo-dashboard' },
  }),
];

const demoActivityEvents = [
  {
    id: 'act_demo_workflow_success',
    sourceEventId: 'evt_demo_github_issue_272',
    sourceEventName: 'github.issue',
    category: 'workflow',
    targetType: 'issue',
    targetId: 'reirei-lab/rainrail#272',
    targetUrl: 'https://github.com/reirei-lab/rainrail/issues/272',
    actionType: 'agent_task_started',
    outcome: 'success',
    summary: 'Started dashboard demo seed task for issue #272',
    metadata: { workflow: 'issue-to-agent', runtime: 'openclaw', agentSessionId: 'agent:demo:dashboard-running' },
    createdAt: '2026-07-09T04:50:40.000Z',
  },
  {
    id: 'act_demo_workflow_failed_retry',
    sourceEventId: 'evt_demo_cloudflare_tail_001',
    sourceEventName: 'cloudflare.tail',
    category: 'workflow',
    targetType: 'worker',
    targetId: 'rainrail-preview',
    actionType: 'cloudflare_tail_issue_report',
    outcome: 'failed',
    summary: 'Cloudflare tail issue report failed and scheduled retry',
    metadata: { retryHandler: 'cloudflare-tail-issue-reporter', attempts: 2, nextRetryAt: '2026-07-09T05:12:00.000Z' },
    createdAt: '2026-07-09T04:51:45.000Z',
  },
  {
    id: 'act_demo_workflow_skipped_non_command',
    sourceEventId: 'evt_demo_manual_chat_001',
    sourceEventName: 'rainrail.chat.message',
    category: 'workflow',
    targetType: 'conversation',
    targetId: 'thread-demo-dashboard',
    actionType: 'non_command_message_ignored',
    outcome: 'skipped',
    summary: 'Ignored a non-command chat message after classification',
    metadata: { classifier: 'manual-chat', reason: 'no actionable command' },
    createdAt: '2026-07-09T04:52:50.000Z',
  },
  {
    id: 'act_demo_codex_timeline',
    sourceEventId: 'evt_demo_github_issue_272',
    sourceEventName: 'github.issue',
    category: 'agent-runtime',
    targetType: 'agent_task',
    targetId: 'agent_task_demo_running',
    actionType: 'codex_timeline_update',
    outcome: 'success',
    summary: 'Codex activity timeline recorded implementation, tests, and PR creation phases',
    metadata: {
      provider: 'codex',
      phases: ['inspect_issue', 'write_tests', 'implement', 'verify', 'open_pr'],
      latestTrajectorySource: 'session-log',
    },
    createdAt: '2026-07-09T04:53:30.000Z',
  },
];

const baseIssue = {
  repository: 'reirei-lab/rainrail',
  number: 272,
  title: 'Dashboard demo: representative SQLite operational data seed',
  url: 'https://github.com/reirei-lab/rainrail/issues/272',
};

const demoAgentTasks = [
  {
    id: 'agent_task_demo_running',
    title: 'Seed dashboard demo SQLite DB',
    agentSessionId: 'agent:demo:dashboard-running',
    branchName: 'agent/reirei-lab-rainrail-272-dashboard-demo-sqlite-operational-data-seed',
    status: 'running',
    issue: baseIssue,
    claim: {
      projectId: 'project-demo',
      projectItemId: 'item-demo-272',
      originalStatus: 'Todo',
      lockRefId: 'refs/rainrail/locks/demo-272',
    },
    logPath: '/var/log/rainrail/demo/agent-task-running.log',
    stderrLogPath: '/var/log/rainrail/demo/agent-task-running.stderr.log',
    pid: 4242,
    resumeAttempts: [
      {
        id: 'resume-demo-001',
        status: 'running',
        pid: 4242,
        sessionKey: 'agent:demo:dashboard-running',
        logPath: '/var/log/rainrail/demo/resume-001.log',
        stderrLogPath: '/var/log/rainrail/demo/resume-001.stderr.log',
        timeoutSeconds: 1800,
      },
    ],
    startedAt: '2026-07-09T04:50:35.000Z',
    updatedAt: '2026-07-09T04:54:00.000Z',
  },
  {
    id: 'agent_task_demo_succeeded',
    title: 'Publish local dashboard docs',
    agentSessionId: 'agent:demo:dashboard-succeeded',
    branchName: 'agent/reirei-lab-rainrail-211-server-dashboard-html-assets',
    status: 'succeeded',
    issue: { repository: 'reirei-lab/rainrail', number: 211, title: 'Server dashboard HTML assets' },
    logPath: '/var/log/rainrail/demo/agent-task-succeeded.log',
    result: 'PR merged after verification',
    startedAt: '2026-07-09T03:20:00.000Z',
    completedAt: '2026-07-09T03:42:30.000Z',
    updatedAt: '2026-07-09T03:42:30.000Z',
  },
  {
    id: 'agent_task_demo_failed_stale_claim',
    title: 'Investigate flaky Cloudflare tail reporter',
    agentSessionId: 'agent:demo:dashboard-failed',
    branchName: 'agent/reirei-lab-rainrail-demo-cloudflare-tail-retry',
    status: 'stopped',
    issue: { repository: 'reirei-lab/rainrail', number: 125, title: 'Cloudflare tail issue reporter' },
    claim: {
      projectId: 'project-demo',
      projectItemId: 'item-demo-125',
      originalStatus: 'In Progress',
      lockRefId: 'refs/rainrail/locks/demo-125',
    },
    projectClaim: {
      status: 'release_failed',
      reason: 'project API returned a transient validation error',
      updatedAt: '2026-07-09T04:49:20.000Z',
      error: 'validation failed for demo project status transition',
    },
    logPath: '/var/log/rainrail/demo/agent-task-failed.log',
    stderrLogPath: '/var/log/rainrail/demo/agent-task-failed.stderr.log',
    result: 'Stopped after retry budget was exhausted',
    startedAt: '2026-07-09T02:10:00.000Z',
    completedAt: '2026-07-09T04:49:00.000Z',
    updatedAt: '2026-07-09T04:49:20.000Z',
  },
];

const demoCommandResults = [
  {
    id: 'cmd_demo_accepted_resume',
    actionType: 'agent_task_resume',
    targetType: 'agent_task',
    targetId: 'agent_task_demo_failed_stale_claim',
    status: 'accepted',
    actor: 'operator-demo',
    client: 'dashboard',
    requestId: 'req-demo-accepted-resume',
    dryRun: false,
    result: { queued: true, attemptId: 'resume-demo-002' },
    metadata: { scope: 'operator', confirmation: 'accepted' },
    createdAt: '2026-07-09T04:55:00.000Z',
  },
  {
    id: 'cmd_demo_preview_settings',
    actionType: 'settings_update',
    targetType: 'settings',
    targetId: 'runtime',
    status: 'preview',
    actor: 'operator-demo',
    client: 'dashboard',
    requestId: 'req-demo-preview-settings',
    dryRun: true,
    result: { maxConcurrentAgentTasks: 2, retryPolicy: 'exponential-backoff' },
    metadata: { scope: 'admin', previewOnly: true },
    createdAt: '2026-07-09T04:55:35.000Z',
  },
  {
    id: 'cmd_demo_failed_assign_next',
    actionType: 'queue_assign_next',
    targetType: 'queue',
    targetId: 'default',
    status: 'failed',
    actor: 'operator-demo',
    client: 'dashboard',
    requestId: 'req-demo-failed-assign-next',
    dryRun: false,
    error: 'Project claim lock is still held by agent:demo:dashboard-running',
    metadata: { scope: 'operator', retriable: false },
    createdAt: '2026-07-09T04:56:05.000Z',
  },
];

const demoEventHandlerRetries = [
  {
    eventId: 'evt_demo_cloudflare_tail_001',
    handlerName: 'cloudflare-tail-issue-reporter',
    attempts: 2,
    nextRetryAt: '2026-07-09T05:12:00.000Z',
    lastError: 'Synthetic webhook preview post timed out',
    updatedAt: '2026-07-09T04:51:50.000Z',
    claimedUntilAt: '2026-07-09T05:02:00.000Z',
  },
  {
    eventId: 'evt_demo_github_issue_272',
    handlerName: 'agent-assignment-dispatch',
    attempts: 1,
    nextRetryAt: '2026-07-09T05:20:00.000Z',
    lastError: 'Demo dispatcher is waiting for capacity',
    updatedAt: '2026-07-09T04:53:10.000Z',
  },
];

/**
 * @param {unknown} value
 */
function json(value) {
  return JSON.stringify(value);
}

/**
 * @param {unknown} value
 */
function nullableJson(value) {
  return value === undefined ? null : JSON.stringify(value);
}

/**
 * @param {string[]} argv
 */
function parseArgs(argv) {
  const args = [...argv];
  let databasePath = DEFAULT_DEMO_DATABASE_PATH;
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === '--database' || arg === '--db') {
      const value = args.shift();
      if (value === undefined) throw new Error(`${arg} requires a path`);
      databasePath = value;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true, databasePath };
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { databasePath };
}

function printHelp() {
  console.log(`Usage: node scripts/seed-dashboard-demo-db.mjs [--database PATH]

Rebuilds a deterministic SQLite operational demo database.
Default path: ${DEFAULT_DEMO_DATABASE_PATH}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
    } else {
      console.log(JSON.stringify(seedDashboardDemoDatabase(options), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
