import { closeSync, mkdirSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

import type { AgentAssignmentRuntime } from './agent-assignment.js';
import type { RuntimeAgentTask, RuntimeProvider, RuntimeRun, RuntimeRunRequest, RuntimeRunStatus } from './runtime-provider.js';

interface AgentAssignmentRuntimeProviderOptions {
  runtime: RuntimeProvider;
  event: RuntimeRunRequest['event'];
  runId: string;
  workflow: string;
  agentId: string;
  sessionKeyPrefix: string;
  requestedBy: string;
}

export interface OpenClawRuntimeProviderOptions {
  enabled: boolean;
  command: string;
  agentId: string;
  sessionKeyPrefix: string;
  timeoutSeconds: number;
  logDirectory: string;
  spawnProcess?: SpawnProcess;
  onSpawnError?: (event: OpenClawSpawnErrorEvent) => void;
}

type SpawnProcess = (command: string, args: string[], options: {
  detached: boolean;
  stdio: unknown[];
}) => SpawnedChild;

interface SpawnedChild {
  pid?: number | undefined;
  unref?: (() => void) | undefined;
  on?: ((event: 'error', listener: (error: Error) => void) => unknown) | undefined;
}

export interface OpenClawSpawnErrorEvent {
  command: string;
  phase: 'start' | 'resume';
  error: Error;
}

type RuntimeAgentTaskInput = {
  id: string;
  title: string;
  agentSessionId?: string | undefined;
  branchName?: string | undefined;
  issue?: {
    repository?: string | undefined;
    number?: number | undefined;
    title?: string | undefined;
    url?: string | undefined;
  } | undefined;
};

export interface RuntimeRunCompletion {
  status: RuntimeRunStatus;
  outcome?: 'implemented' | 'updated_issue' | 'needs_human' | 'split_recommended' | string | undefined;
  summary?: string | undefined;
  promptError?: string | undefined;
  timedOut?: boolean | undefined;
  timeoutPhase?: string | undefined;
  stopReason?: string | undefined;
}

export function createAgentAssignmentRuntimeFromProvider(
  options: AgentAssignmentRuntimeProviderOptions,
): AgentAssignmentRuntime {
  return {
    runId: options.runId,
    workflow: options.workflow,
    agentId: options.agentId,
    sessionKeyPrefix: options.sessionKeyPrefix,
    dispatchAgent: async ({ task, workflow }) => options.runtime.startRun({
      workflow,
      event: options.event,
      task,
      requestedBy: options.requestedBy,
      inputs: {
        agentSessionId: task.agentSessionId,
        branchName: task.branchName,
        issue: task.issue,
      },
    }),
  };
}

export function createOpenClawRuntimeProvider(options: OpenClawRuntimeProviderOptions): RuntimeProvider {
  return {
    name: 'openclaw',
    kind: 'runtime-provider',
    startRun: async (request) => startOpenClawRun(options, request),
    resumeRun: async (request) => {
      if (!options.enabled) {
        throw new Error('OpenClaw runtime provider is disabled');
      }
      mkdirSync(options.logDirectory, { recursive: true });
      const logPath = join(options.logDirectory, `${safeFileName(request.attemptId)}.log`);
      const outputFd = openSync(logPath, 'a');
      const args = [
        'agent',
        '--agent',
        options.agentId,
        '--session-key',
        request.task.agentSessionId,
        '--message',
        promptForRuntimeTaskResume(request.task),
        '--timeout',
        String(options.timeoutSeconds),
        '--json',
      ];
      try {
        const child = (options.spawnProcess ?? defaultSpawnProcess)(options.command, args, {
          detached: true,
          stdio: ['ignore', outputFd, outputFd],
        });
        attachSpawnErrorHandler(child, options, 'resume');
        child.unref?.();
        return {
          id: request.task.agentSessionId,
          provider: 'openclaw',
          status: 'running',
          metadata: {
            pid: child.pid,
            logPath,
            agentSessionId: request.task.agentSessionId,
            branchName: request.task.branchName,
            attemptId: request.attemptId,
          },
        };
      } finally {
        closeSync(outputFd);
      }
    },
  };
}

export async function startOpenClawRun(
  options: OpenClawRuntimeProviderOptions,
  request: RuntimeRunRequest,
): Promise<RuntimeRun> {
  if (!options.enabled) {
    throw new Error('OpenClaw runtime provider is disabled');
  }

  const task = runtimeAgentTaskInput(request.task);
  mkdirSync(options.logDirectory, { recursive: true });
  const agentSessionId = task.agentSessionId ?? `agent:${options.agentId}:${options.sessionKeyPrefix}-${task.id}`;
  const logPath = join(options.logDirectory, `${safeFileName(task.id)}.log`);
  const outputFd = openSync(logPath, 'w');
  const args = [
    'agent',
    '--agent',
    options.agentId,
    '--session-key',
    agentSessionId,
    '--message',
    promptForRuntimeTask(task, agentSessionId),
    '--timeout',
    String(options.timeoutSeconds),
    '--json',
  ];

  try {
    const child = (options.spawnProcess ?? defaultSpawnProcess)(options.command, args, {
      detached: true,
      stdio: ['ignore', outputFd, outputFd],
    });
    attachSpawnErrorHandler(child, options, 'start');
    child.unref?.();
    return {
      id: agentSessionId,
      provider: 'openclaw',
      status: 'running',
      metadata: {
        pid: child.pid,
        logPath,
        agentSessionId,
        branchName: task.branchName,
        taskId: task.id,
      },
    };
  } finally {
    closeSync(outputFd);
  }
}

export function readRuntimeRunCompletionFromLog(raw: string): RuntimeRunCompletion | undefined {
  if (/CLI transcript compaction failed/i.test(raw)) {
    return {
      status: 'compaction_failed',
      summary: lastNonEmptyLine(raw),
      timedOut: /timed out/i.test(raw),
      timeoutPhase: 'compaction',
    };
  }

  const payload = parseJsonFromLog(raw);
  if (!isRecord(payload)) {
    return undefined;
  }

  const explicitStatus = stringValue(payload.status);
  const status = runtimeStatusFromPayload(payload, explicitStatus);
  if (status === undefined) {
    return undefined;
  }

  return {
    status,
    outcome: outcomeFromPayload(payload),
    summary: stringValue(payload.summary) ?? completionSummaryFromPayload(payload),
    promptError: stringValue(payload.promptError),
    timedOut: booleanValue(payload.timedOut),
    timeoutPhase: stringValue(payload.timeoutPhase),
    stopReason: stringValue(payload.stopReason) ?? stringValue(recordValue(payload.completion)?.stopReason),
  };
}

export function runningRuntimeTaskPid(task: RuntimeAgentTask, isRunning: (pid: number) => boolean): number | undefined {
  if (task.pid !== undefined && isRunning(task.pid)) {
    return task.pid;
  }
  const runningAttempt = task.resumeAttempts.find((attempt) =>
    attempt.status === 'running' && attempt.pid !== undefined && isRunning(attempt.pid)
  );
  return runningAttempt?.pid;
}

export function nextRuntimeResumeAttemptId(task: Pick<RuntimeAgentTask, 'id' | 'resumeAttempts'>): string {
  return `${task.id}_resume_${String(task.resumeAttempts.length + 1).padStart(2, '0')}`;
}

function promptForRuntimeTask(task: RuntimeAgentTaskInput, sessionKey: string): string {
  const issue = task.issue ?? {};
  const repo = issue.repository ?? 'unknown repository';
  const issueNumber = issue.number === undefined ? '(unknown issue number)' : `#${issue.number}`;
  const issueUrl = issue.url ?? '(no issue URL)';
  return [
    'あなたは Rainrail によって起動された GitHub issue 処理エージェントです。',
    '',
    `Session key: ${sessionKey}`,
    `Repository: ${repo}`,
    `Issue: ${issueNumber}`,
    `Issue URL: ${issueUrl}`,
    `Issue title: ${issue.title ?? task.title}`,
    `Branch to use: ${task.branchName ?? '(runtime did not provide a branch)'}`,
    '',
    'issue本文、issueコメント履歴、リポジトリの現状を確認したうえで、最も価値がある次の行動を自分で選んでください。',
    '作業後はissueに簡潔な結果コメントを残してください。',
    '結果コメントには `Outcome: implemented | updated_issue | needs_human | split_recommended` のいずれかを含めてください。',
    '',
    'mainには直接commitしないでください。',
  ].join('\n');
}

function promptForRuntimeTaskResume(task: RuntimeAgentTask): string {
  return [
    'あなたは Rainrail によって再開された GitHub issue 処理エージェントです。',
    '',
    `Session key: ${task.agentSessionId}`,
    `Branch to use: ${task.branchName}`,
    `Existing task log: ${task.logPath}`,
    '',
    '同じ session key の会話履歴を踏まえて、未完了の作業を続けてください。',
    'PRが既にある場合は、そのPRを更新してください。',
    'mainには直接commitしないでください。',
  ].join('\n');
}

function runtimeAgentTaskInput(value: unknown): RuntimeAgentTaskInput {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') {
    throw new Error('OpenClaw runtime task requires id and title');
  }
  return {
    id: value.id,
    title: value.title,
    agentSessionId: stringValue(value.agentSessionId),
    branchName: stringValue(value.branchName),
    issue: isRecord(value.issue) ? {
      repository: stringValue(value.issue.repository),
      number: typeof value.issue.number === 'number' ? value.issue.number : undefined,
      title: stringValue(value.issue.title),
      url: stringValue(value.issue.url),
    } : undefined,
  };
}

function runtimeStatusFromPayload(payload: Record<string, unknown>, explicitStatus: string | undefined): RuntimeRunStatus | undefined {
  if (explicitStatus === 'ok') {
    return 'succeeded';
  }
  if (explicitStatus === 'timeout') {
    return 'timed_out';
  }
  if (explicitStatus === 'error') {
    return 'failed';
  }
  if (explicitStatus === 'needs_human' || explicitStatus === 'split_recommended') {
    return explicitStatus;
  }
  const executionTrace = recordValue(payload.executionTrace);
  const completion = recordValue(payload.completion);
  if (
    typeof payload.finalAssistantVisibleText === 'string'
    && normalize(executionTrace?.result) === 'success'
    && normalize(completion?.finishReason) === 'stop'
  ) {
    return 'succeeded';
  }
  return undefined;
}

function outcomeFromPayload(payload: Record<string, unknown>): string | undefined {
  const text = stringValue(payload.finalAssistantVisibleText) ?? completionSummaryFromPayload(payload);
  return text?.match(/\bOutcome:\s*(implemented|updated_issue|needs_human|split_recommended)\b/)?.[1];
}

function completionSummaryFromPayload(payload: Record<string, unknown>): string | undefined {
  const finalText = stringValue(payload.finalAssistantVisibleText) ?? stringValue(payload.finalAssistantRawText);
  if (finalText !== undefined) {
    return finalText;
  }
  const payloads = payload.payloads;
  if (!Array.isArray(payloads)) {
    return undefined;
  }
  for (const item of payloads) {
    const text = stringValue(recordValue(item)?.text);
    if (text !== undefined) {
      return text;
    }
  }
  return undefined;
}

function parseJsonFromLog(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return parseLastJsonObjectFromLog(raw);
  }
}

function parseLastJsonObjectFromLog(raw: string): unknown {
  let latest: unknown;
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '{') {
      continue;
    }
    const end = findJsonObjectEnd(raw, index);
    if (end === undefined) {
      continue;
    }
    try {
      const candidate = JSON.parse(raw.slice(index, end + 1));
      if (isRecord(candidate) && runtimeStatusFromPayload(candidate, stringValue(candidate.status)) !== undefined) {
        latest = candidate;
      }
    } catch {
      // Logs may contain partial JSON fragments.
    }
  }
  return latest;
}

function findJsonObjectEnd(raw: string, start: number): number | undefined {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }
  return undefined;
}

function defaultSpawnProcess(command: string, args: string[], options: { detached: boolean; stdio: unknown[] }): SpawnedChild {
  return spawn(command, args, options as never) as SpawnedChild;
}

function attachSpawnErrorHandler(
  child: SpawnedChild,
  options: OpenClawRuntimeProviderOptions,
  phase: OpenClawSpawnErrorEvent['phase'],
): void {
  child.on?.('error', (error) => {
    options.onSpawnError?.({
      command: options.command,
      phase,
      error,
    });
  });
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function lastNonEmptyLine(value: string): string {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? value.trim();
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
