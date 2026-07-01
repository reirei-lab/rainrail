import { chmodSync, closeSync, constants, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join, parse, resolve } from 'node:path';

import type { AgentAssignmentRuntime } from './agent-assignment.js';
import type { RuntimeAgentTask, RuntimeProvider, RuntimeProviderContext, RuntimeRun, RuntimeRunRequest, RuntimeRunStatus } from './runtime-provider.js';

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
  kill?: ((signal?: NodeJS.Signals | number) => boolean) | undefined;
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

const maxRuntimeResumeLogBytes = 512 * 1024;

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
    startRun: async (request, context) => startOpenClawRun(options, request, context),
    resumeRun: async (request, context) => {
      if (!options.enabled) {
        throw new Error('OpenClaw runtime provider is disabled');
      }
      throwIfAborted(context?.signal);
      ensurePrivateLogDirectory(options.logDirectory);
      const logPath = join(options.logDirectory, `${safeLogFileName(request.attemptId)}.log`);
      const stderrLogPath = stderrLogPathFor(logPath);
      const { outputFd, stderrFd } = openPrivateLogFiles(logPath, stderrLogPath, 'a');
      const resumeSessionId = runtimeResumeSessionId(request.task, options.agentId);
      const args = [
        'agent',
        '--agent',
        options.agentId,
        '--session-key',
        resumeSessionId,
        '--run-id',
        runtimeResumeRunId(options, request),
        '--message',
        promptForRuntimeTaskResume(request.task, resumeSessionId),
        '--timeout',
        String(options.timeoutSeconds),
        '--json',
      ];
      try {
        const child = (options.spawnProcess ?? defaultSpawnProcess)(options.command, args, {
          detached: true,
          stdio: ['ignore', outputFd, stderrFd],
        });
        attachSpawnErrorHandler(child, options, 'resume');
        const pid = requireSpawnedPid(child, options, 'resume');
        child.unref?.();
        return {
          id: resumeSessionId,
          provider: 'openclaw',
          status: 'running',
          metadata: {
            pid,
            logPath,
            stderrLogPath,
            agentSessionId: resumeSessionId,
            branchName: request.task.branchName,
            attemptId: request.attemptId,
          },
        };
      } finally {
        closeSync(outputFd);
        closeSync(stderrFd);
      }
    },
  };
}

export async function startOpenClawRun(
  options: OpenClawRuntimeProviderOptions,
  request: RuntimeRunRequest,
  context?: RuntimeProviderContext,
): Promise<RuntimeRun> {
  if (!options.enabled) {
    throw new Error('OpenClaw runtime provider is disabled');
  }
  throwIfAborted(context?.signal);

  const task = runtimeAgentTaskInput(request.task);
  ensurePrivateLogDirectory(options.logDirectory);
  const agentSessionId = task.agentSessionId ?? generatedAgentSessionId(options, request, task);
  const logPath = join(options.logDirectory, `${safeLogFileName(agentSessionId)}.log`);
  const stderrLogPath = stderrLogPathFor(logPath);
  const { outputFd, stderrFd } = openPrivateLogFiles(logPath, stderrLogPath, 'a');
  const args = [
    'agent',
    '--agent',
    options.agentId,
    '--session-key',
    agentSessionId,
    '--run-id',
    runtimeStartRunId(options, request, task, agentSessionId),
    '--message',
    promptForRuntimeTask(task, agentSessionId),
    '--timeout',
    String(options.timeoutSeconds),
    '--json',
  ];

  try {
    const child = (options.spawnProcess ?? defaultSpawnProcess)(options.command, args, {
      detached: true,
      stdio: ['ignore', outputFd, stderrFd],
    });
    attachSpawnErrorHandler(child, options, 'start');
    const pid = requireSpawnedPid(child, options, 'start');
    child.unref?.();
    return {
      id: agentSessionId,
      provider: 'openclaw',
      status: 'running',
      metadata: {
        pid,
        logPath,
        stderrLogPath,
        agentSessionId,
        branchName: task.branchName,
        taskId: task.id,
      },
    };
  } finally {
    closeSync(outputFd);
    closeSync(stderrFd);
  }
}

export function readRuntimeRunCompletionFromLog(raw: string): RuntimeRunCompletion | undefined {
  const latestCompactionFailure = compactionFailureAfterLatestCompletionJson(raw);
  if (latestCompactionFailure !== undefined) {
    return latestCompactionFailure;
  }
  const payload = parseJsonFromLog(raw);
  if (!isRecord(payload)) {
    return compactionFailureOutsideJsonRanges(raw);
  }

  return runtimeRunCompletionFromPayload(payload);
}

function runtimeRunCompletionFromPayload(payload: Record<string, unknown>): RuntimeRunCompletion | undefined {
  const completionPayload = completionPayloadFromResponse(payload);
  const topLevelStatus = stringValue(payload.status);
  const completionStatus = stringValue(completionPayload.status);
  const explicitStatus = isTerminalRuntimeRunStatus(topLevelStatus) || topLevelStatus === 'error' || topLevelStatus === 'timeout'
    ? topLevelStatus
    : completionStatus ?? topLevelStatus;
  const outcome = outcomeFromPayload(completionPayload);
  const status = runtimeStatusFromPayload(completionPayload, explicitStatus, outcome);
  if (status === undefined) {
    return undefined;
  }

  const summary = stringValue(completionPayload.summary) ?? completionSummaryFromPayload(completionPayload) ?? stringValue(payload.summary);
  const promptError = stringValue(completionPayload.promptError) ?? stringValue(payload.promptError);
  const timeoutPhase = stringValue(completionPayload.timeoutPhase) ?? stringValue(payload.timeoutPhase);
  const stopReason = stringValue(completionPayload.stopReason)
    ?? stringValue(recordValue(completionPayload.completion)?.stopReason)
    ?? stringValue(payload.stopReason)
    ?? stringValue(recordValue(payload.completion)?.stopReason);
  return {
    status,
    outcome,
    summary: redactRuntimeCompletionText(summary),
    promptError: redactRuntimeCompletionText(promptError),
    timedOut: booleanValue(completionPayload.timedOut) ?? booleanValue(payload.timedOut),
    timeoutPhase: redactRuntimeCompletionText(timeoutPhase),
    stopReason: redactRuntimeCompletionText(stopReason),
  };
}

function redactRuntimeCompletionText(value: string | undefined): string | undefined {
  return value
    ?.replace(/Authorization:\s*[^\n\r]*/gi, 'Authorization: [redacted-authorization]')
    .replace(/Set-Cookie:\s*[^\n\r]*/gi, 'Set-Cookie: [redacted-cookie]')
    .replace(/Cookie:\s*[^\n\r]*/gi, 'Cookie: [redacted-cookie]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/g, 'Bearer [redacted-token]')
    .replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[redacted-token]')
    .replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[redacted-token]')
    .replace(/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[redacted-token]')
    .replace(/\b((?:[A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSPHRASE|API[-_]?KEY)|api[-_]?key|token|secret|password|passphrase|_auth)\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\n\r]*)/gi, '$1[redacted]');
}

function compactionFailureFromLog(raw: string, summarySource = raw): RuntimeRunCompletion | undefined {
  if (!/CLI transcript compaction failed/i.test(raw)) {
    return undefined;
  }
  return {
    status: 'compaction_failed',
    summary: redactRuntimeCompletionText(lastNonEmptyLine(summarySource)),
    timedOut: /timed out/i.test(raw),
    timeoutPhase: 'compaction',
  };
}

function compactionFailureAfterLatestCompletionJson(raw: string): RuntimeRunCompletion | undefined {
  let latestCompletionEnd = -1;
  const jsonObjects = parseJsonObjectsFromLogWithPositions(raw);
  const ignoredRanges = [
    ...jsonObjects.map((object) => ({ start: object.index, end: object.end })),
    ...parseJsonStringRangesFromLog(raw),
  ];
  for (const candidate of jsonObjects) {
    if (
      isRecord(candidate.payload)
      && runtimeRunCompletionFromPayload(candidate.payload) !== undefined
      && isTrustedRuntimeCompletionLogObject(raw, candidate)
    ) {
      latestCompletionEnd = candidate.end;
    }
  }
  let latestFailure: RuntimeRunCompletion | undefined;
  for (const match of raw.matchAll(/[^\r\n]*CLI transcript compaction failed[^\r\n]*/gi)) {
    const phraseOffset = match[0].toLowerCase().indexOf('cli transcript compaction failed');
    const index = (match.index ?? -1) + phraseOffset;
    if (ignoredRanges.some((range) => index >= range.start && index <= range.end)) {
      continue;
    }
    if (index > latestCompletionEnd) {
      latestFailure = compactionFailureFromLog(match[0], compactionFailureSummarySource(raw, match.index ?? 0, match[0]));
    }
  }
  return latestFailure;
}

function compactionFailureOutsideJsonRanges(raw: string): RuntimeRunCompletion | undefined {
  const ignoredRanges = [
    ...parseJsonObjectsFromLogWithPositions(raw).map((object) => ({ start: object.index, end: object.end })),
    ...parseJsonStringRangesFromLog(raw),
  ];
  let latestFailure: RuntimeRunCompletion | undefined;
  for (const match of raw.matchAll(/[^\r\n]*CLI transcript compaction failed[^\r\n]*/gi)) {
    const phraseOffset = match[0].toLowerCase().indexOf('cli transcript compaction failed');
    const index = (match.index ?? -1) + phraseOffset;
    if (ignoredRanges.some((range) => index >= range.start && index <= range.end)) {
      continue;
    }
    latestFailure = compactionFailureFromLog(match[0], compactionFailureSummarySource(raw, match.index ?? 0, match[0]));
  }
  return latestFailure;
}

function compactionFailureSummarySource(raw: string, matchIndex: number, matchLine: string): string {
  const redactedMatchLine = redactRuntimeCompletionText(matchLine) ?? matchLine;
  if (redactedMatchLine !== matchLine) {
    return redactedMatchLine;
  }
  const followingLines = raw.slice(matchIndex + matchLine.length).split(/\r?\n/);
  for (const line of followingLines) {
    if (line.trim() === '') {
      continue;
    }
    const redactedLine = redactRuntimeCompletionText(line) ?? line;
    if (redactedLine !== line) {
      return redactedLine;
    }
  }
  return matchLine;
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

export function nextRuntimeResumeAttemptId(
  task: Pick<RuntimeAgentTask, 'id' | 'resumeAttempts'> & { agentSessionId?: string },
): string {
  const sequence = String(task.resumeAttempts.length + 1).padStart(2, '0');
  const taskPrefix = boundedSafeFileName(task.id, 64);
  const sessionId = task.agentSessionId !== undefined
    ? `_${boundedSafeFileName(task.agentSessionId, 40)}_${shortHash(task.agentSessionId)}`
    : '';
  return `${taskPrefix}${sessionId}_${shortHash(`${task.id}:${task.agentSessionId ?? ''}`)}_resume_${sequence}`;
}

function runtimeStartRunId(
  options: OpenClawRuntimeProviderOptions,
  request: RuntimeRunRequest,
  task: RuntimeAgentTaskInput,
  agentSessionId: string,
): string {
  return boundedRunId([
    options.sessionKeyPrefix,
    'start',
    request.workflow,
    request.event.delivery.id,
    task.id,
    'session',
    shortHash(agentSessionId),
  ].join('-'));
}

function runtimeResumeRunId(options: OpenClawRuntimeProviderOptions, request: { attemptId: string }): string {
  return boundedRunId(`${options.sessionKeyPrefix}-resume-${request.attemptId}`);
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

function promptForRuntimeTaskResume(task: RuntimeAgentTask, sessionKey = task.agentSessionId): string {
  return [
    'あなたは Rainrail によって再開された GitHub issue 処理エージェントです。',
    '',
    `Session key: ${sessionKey}`,
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
    issue: issueFieldsFromValue(value),
  };
}

function runtimeStatusFromPayload(
  payload: Record<string, unknown>,
  explicitStatus: string | undefined,
  outcome = outcomeFromPayload(payload),
): RuntimeRunStatus | undefined {
  if (explicitStatus === 'error') {
    return 'failed';
  }
  if (explicitStatus === 'timeout') {
    return 'timed_out';
  }
  if (explicitStatus === 'in_flight') {
    return 'running';
  }
  if (isFailureRuntimeRunStatus(explicitStatus)) {
    return explicitStatus;
  }
  if (explicitStatus === 'needs_human' || explicitStatus === 'split_recommended') {
    return explicitStatus;
  }
  if (outcome === 'needs_human' || outcome === 'split_recommended') {
    return outcome;
  }
  if (outcome === 'implemented' || outcome === 'updated_issue') {
    return 'succeeded';
  }
  if (explicitStatus === 'ok') {
    return 'succeeded';
  }
  if (isCanonicalRuntimeRunStatus(explicitStatus)) {
    return explicitStatus;
  }
  const executionTrace = recordValue(payload.executionTrace);
  const completion = recordValue(payload.completion);
  if (
    completionTextsFromPayload(payload).length > 0
    && normalize(executionTrace?.result) === 'success'
    && normalize(completion?.finishReason) === 'stop'
  ) {
    return 'succeeded';
  }
  return undefined;
}

function isFailureRuntimeRunStatus(status: string | undefined): status is RuntimeRunStatus {
  return status === 'failed'
    || status === 'canceled'
    || status === 'stopped'
    || status === 'timed_out'
    || status === 'compaction_failed';
}

function isCanonicalRuntimeRunStatus(status: string | undefined): status is RuntimeRunStatus {
  return status === 'queued'
    || status === 'running'
    || status === 'succeeded'
    || status === 'failed'
    || status === 'canceled'
    || status === 'stopped'
    || status === 'timed_out'
    || status === 'compaction_failed'
    || status === 'needs_human'
    || status === 'split_recommended';
}

function isTerminalRuntimeRunStatus(status: string | undefined): boolean {
  return status !== 'queued' && status !== 'running' && isCanonicalRuntimeRunStatus(status);
}

function outcomeFromPayload(payload: Record<string, unknown>): string | undefined {
  const finalTexts = [
    stringValue(payload.finalAssistantVisibleText) ?? stringValue(payload.finalAssistantRawText),
  ].filter((text): text is string => text !== undefined);
  const payloadTexts = Array.isArray(payload.payloads)
    ? payload.payloads
      .map((item) => stringValue(recordValue(item)?.text))
      .filter((text): text is string => text !== undefined)
      .reverse()
    : [];
  for (const text of [...finalTexts, ...payloadTexts]) {
    const outcomes = [...text.matchAll(/\bOutcome:\s*(implemented|updated_issue|needs_human|split_recommended)\b/g)];
    const latest = outcomes.at(-1)?.[1];
    if (latest !== undefined) {
      return latest;
    }
  }
  return undefined;
}

function completionSummaryFromPayload(payload: Record<string, unknown>): string | undefined {
  return completionTextsFromPayload(payload)[0];
}

function completionTextsFromPayload(payload: Record<string, unknown>): string[] {
  const texts = [stringValue(payload.finalAssistantVisibleText) ?? stringValue(payload.finalAssistantRawText)]
    .filter((text): text is string => text !== undefined);
  const payloads = payload.payloads;
  if (!Array.isArray(payloads)) {
    return texts;
  }
  for (const item of payloads) {
    const text = stringValue(recordValue(item)?.text);
    if (text !== undefined) {
      texts.push(text);
    }
  }
  return texts;
}

function completionPayloadFromResponse(payload: Record<string, unknown>): Record<string, unknown> {
  const result = recordValue(payload.result);
  if (result === undefined) {
    return payload;
  }
  return {
    ...payload,
    ...result,
    status: result.status ?? payload.status,
    summary: result.summary ?? payload.summary,
    finalAssistantVisibleText: result.finalAssistantVisibleText ?? payload.finalAssistantVisibleText,
    finalAssistantRawText: result.finalAssistantRawText ?? payload.finalAssistantRawText,
    payloads: result.payloads ?? payload.payloads,
  };
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
  for (const candidate of parseJsonObjectsFromLogWithPositions(raw)) {
    if (
      isRecord(candidate.payload)
      && runtimeRunCompletionFromPayload(candidate.payload) !== undefined
      && isTrustedRuntimeCompletionLogObject(raw, candidate)
    ) {
      latest = candidate.payload;
    }
  }
  return latest;
}

function parseJsonObjectsFromLogWithPositions(raw: string): Array<{ payload: unknown; index: number; end: number }> {
  const payloads: Array<{ payload: unknown; index: number; end: number }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '{') {
      continue;
    }
    const end = findJsonObjectEnd(raw, index);
    if (end === undefined) {
      continue;
    }
    try {
      payloads.push({ payload: JSON.parse(raw.slice(index, end + 1)) as unknown, index, end });
      index = end;
    } catch {
      // Logs may contain partial JSON fragments.
    }
  }
  return payloads;
}

function parseJsonStringRangesFromLog(raw: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < raw.length; index += 1) {
    if (raw[index] !== '"') {
      continue;
    }
    let escaped = false;
    for (let end = index + 1; end < raw.length; end += 1) {
      const char = raw[end];
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        ranges.push({ start: index, end });
        index = end;
        break;
      }
    }
  }
  return ranges;
}

function issueFieldsFromValue(value: Record<string, unknown>): RuntimeAgentTaskInput['issue'] {
  const source = isRecord(value.issue) ? value.issue : value;
  const repository = stringValue(source.repository);
  const number = typeof source.number === 'number' ? source.number : undefined;
  const title = stringValue(source.title);
  const url = stringValue(source.url);
  return repository === undefined && number === undefined && title === undefined && url === undefined
    ? undefined
    : { repository, number, title, url };
}

function runtimeResumeSessionId(task: RuntimeAgentTask, agentId: string): string {
  for (const logPaths of runtimeResumeLogPathGroups(task)) {
    let groupFallbackSessionKey: string | null | undefined;
    for (const [index, logPath] of logPaths.entries()) {
      try {
        const fallbackSessionKey = extractFallbackRuntimeSessionKey(readRuntimeResumeLogTail(logPath), agentId, {
          allowClearingCompletion: !(index === 0 && logPaths.length > 1),
          allowCompletionMetadata: !(index === 0 && logPaths.length > 1),
        });
        if (fallbackSessionKey === null) {
          groupFallbackSessionKey = null;
        } else if (fallbackSessionKey !== undefined && groupFallbackSessionKey === undefined) {
          groupFallbackSessionKey = fallbackSessionKey;
        }
      } catch {
        // Missing historical logs should not block a resume attempt.
      }
    }
    if (groupFallbackSessionKey === null) {
      return task.agentSessionId;
    }
    if (groupFallbackSessionKey !== undefined) {
      return groupFallbackSessionKey;
    }
  }
  return task.agentSessionId;
}

function readRuntimeResumeLogTail(logPath: string): string {
  const size = statSync(logPath).size;
  const start = Math.max(0, size - maxRuntimeResumeLogBytes);
  const fd = openSync(logPath, 'r');
  try {
    const buffer = Buffer.alloc(size - start);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start === 0) {
      return text;
    }
    const newlineIndex = text.search(/[\n\r]/);
    return newlineIndex === -1 ? text : text.slice(newlineIndex + 1);
  } finally {
    closeSync(fd);
  }
}

function runtimeResumeLogPathGroups(task: RuntimeAgentTask): string[][] {
  return [
    ...task.resumeAttempts.slice().reverse().map((attempt) => [
      attempt.stderrLogPath ?? stderrLogPathFor(attempt.logPath),
      attempt.logPath,
    ]),
    [
      task.stderrLogPath ?? stderrLogPathFor(task.logPath),
      task.logPath,
    ],
  ];
}

function runtimeResumeLogPaths(task: RuntimeAgentTask): string[] {
  return runtimeResumeLogPathGroups(task).flat();
}

function extractFallbackRuntimeSessionKey(
  log: string,
  agentId: string,
  options: { allowClearingCompletion?: boolean; allowCompletionMetadata?: boolean } = {},
): string | null | undefined {
  const allowClearingCompletion = options.allowClearingCompletion !== false;
  const allowCompletionMetadata = options.allowCompletionMetadata !== false;
  const strictPayload = parseStrictJsonObject(log);
  if (strictPayload !== undefined) {
    if (!allowCompletionMetadata) {
      return undefined;
    }
    if (
      runtimeRunCompletionFromPayload(strictPayload) === undefined
      || (!isTrustedRuntimeCompletionFragment(strictPayload) && !isStatusOnlyTerminalCompletion(strictPayload))
    ) {
      return undefined;
    }
    const fallbackSessionKey = fallbackSessionKeyFromPayload(strictPayload, agentId);
    if (fallbackSessionKey !== undefined) {
      return fallbackSessionKey;
    }
    return allowClearingCompletion && fallbackLookupClearingCompletion(strictPayload) ? null : undefined;
  }
  let latest: { index: number; key: string | undefined } | undefined;
  const jsonObjects = parseJsonObjectsFromLogWithPositions(log);
  const ignoredRanges = [
    ...jsonObjects.map((object) => ({ start: object.index, end: object.end })),
    ...parseJsonStringRangesFromLog(log),
  ];
  for (const object of jsonObjects) {
    if (
      !allowCompletionMetadata
      ||
      !isRecord(object.payload)
      || runtimeRunCompletionFromPayload(object.payload) === undefined
      || !isTrustedRuntimeCompletionLogObject(log, object)
    ) {
      continue;
    }
    const key = fallbackSessionKeyFromPayload(object.payload, agentId);
    const clearsFallback = allowClearingCompletion && fallbackLookupClearingCompletion(object.payload);
    if ((key !== undefined || clearsFallback) && (latest === undefined || object.index > latest.index)) {
      latest = { index: object.index, key };
    }
  }
  for (const match of log.matchAll(/EMBEDDED FALLBACK:[^\n\r]*fresh session\s+(gateway-fallback-[A-Za-z0-9._-]+)/gi)) {
    const index = match.index ?? 0;
    if (ignoredRanges.some((range) => index >= range.start && index <= range.end)) {
      continue;
    }
    if (latest === undefined || index > latest.index) {
      latest = { index, key: `agent:${agentId}:explicit:${match[1]}` };
    }
  }
  return latest === undefined ? undefined : latest.key ?? null;
}

function fallbackLookupClearingCompletion(payload: Record<string, unknown>): boolean {
  const completion = runtimeRunCompletionFromPayload(payload);
  return completion?.status === 'succeeded'
    || completion?.status === 'needs_human'
    || completion?.status === 'split_recommended';
}

function parseStrictJsonObject(raw: string): Record<string, unknown> | undefined {
  try {
    const payload = JSON.parse(raw) as unknown;
    return recordValue(payload);
  } catch {
    return undefined;
  }
}

function fallbackSessionKeyFromPayload(payload: Record<string, unknown>, agentId: string): string | undefined {
  for (const source of [payload, recordValue(payload.result)]) {
    const agentMeta = recordValue(recordValue(source?.meta)?.agentMeta);
    const key = stringValue(agentMeta?.fallbackSessionKey);
    if (key !== undefined) {
      return key;
    }
    const sessionId = stringValue(agentMeta?.sessionId);
    if (sessionId?.startsWith('gateway-fallback-') === true) {
      return `agent:${agentId}:explicit:${sessionId}`;
    }
  }
  return undefined;
}

function isTrustedRuntimeCompletionFragment(payload: Record<string, unknown>): boolean {
  if (stringValue(payload.status) === 'in_flight') {
    return true;
  }
  const completionPayload = completionPayloadFromResponse(payload);
  return hasRuntimeCompletionSignal(payload)
    || hasRuntimeCompletionSignal(completionPayload)
    || (hasRuntimeAgentMeta(payload) && stringValue(completionPayload.status) !== undefined);
}

function isTrustedRuntimeCompletionLogObject(
  raw: string,
  object: { payload: unknown; index: number; end: number },
): boolean {
  if (!isRecord(object.payload)) {
    return false;
  }
  if (hasDiagnosticPrefixBeforeJsonObject(raw, object.index)) {
    return false;
  }
  return isTrustedRuntimeCompletionFragment(object.payload)
    || isStatusOnlyTerminalCompletion(object.payload);
}

function isStatusOnlyTerminalCompletion(payload: Record<string, unknown>): boolean {
  const status = stringValue(completionPayloadFromResponse(payload).status);
  return status === 'ok'
    || status === 'error'
    || status === 'timeout'
    || status === 'in_flight'
    || status === 'queued'
    || status === 'running'
    || isTerminalRuntimeRunStatus(status);
}

function hasDiagnosticPrefixBeforeJsonObject(raw: string, index: number): boolean {
  const lineStart = Math.max(raw.lastIndexOf('\n', index - 1), raw.lastIndexOf('\r', index - 1)) + 1;
  const sameLinePrefix = raw.slice(lineStart, index).trim();
  if (/\b(?:diag|diagnostic|quoted|tool result)\b/i.test(sameLinePrefix)) {
    return true;
  }
  const previousText = raw.slice(0, lineStart).trimEnd();
  const previousLineStart = Math.max(previousText.lastIndexOf('\n'), previousText.lastIndexOf('\r')) + 1;
  const previousLine = previousText.slice(previousLineStart).trim();
  return /(?:quoted|diagnostic|tool result)[^{}]*:\s*$/i.test(previousLine);
}

function hasRuntimeCompletionSignal(payload: Record<string, unknown>): boolean {
  return completionTextsFromPayload(payload).length > 0
    || hasRuntimeCompletionObjectSignal(recordValue(payload.completion))
    || hasRuntimeExecutionTraceSignal(recordValue(payload.executionTrace));
}

function hasRuntimeCompletionObjectSignal(payload: Record<string, unknown> | undefined): boolean {
  return stringValue(payload?.finishReason) !== undefined
    || stringValue(payload?.stopReason) !== undefined;
}

function hasRuntimeExecutionTraceSignal(payload: Record<string, unknown> | undefined): boolean {
  return stringValue(payload?.result) !== undefined
    || stringValue(payload?.status) !== undefined;
}

function hasRuntimeAgentMeta(payload: Record<string, unknown>): boolean {
  return [payload, recordValue(payload.result)].some((source) =>
    recordValue(recordValue(source?.meta)?.agentMeta) !== undefined
  );
}

function extractFallbackRuntimeSessionId(log: string): string | undefined {
  const matches = [...log.matchAll(/EMBEDDED FALLBACK:[^\n\r]*fresh session\s+(gateway-fallback-[A-Za-z0-9._-]+)/gi)];
  return matches.at(-1)?.[1];
}

function generatedAgentSessionId(
  options: OpenClawRuntimeProviderOptions,
  request: RuntimeRunRequest,
  task: RuntimeAgentTaskInput,
): string {
  return `agent:${options.agentId}:${options.sessionKeyPrefix}-${request.workflow}-${task.id}-${request.event.delivery.id}`;
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

function ensurePrivateLogDirectory(directory: string): void {
  assertNoSymlinkPathComponents(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkPathComponents(directory);
  chmodSync(directory, 0o700);
}

function assertNoSymlinkPathComponents(directory: string): void {
  const absolutePath = resolve(directory);
  const root = parse(absolutePath).root;
  const segments = absolutePath.slice(root.length).split(/[\\/]+/).filter((segment) => segment !== '');
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`runtime log directory path contains a symlink: ${current}`);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return;
      }
      throw error;
    }
  }
}

function openPrivateLogFile(path: string, flags: 'a' | 'w'): number {
  const openFlags = flags === 'a'
    ? constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW
    : constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW;
  const fd = openSync(path, openFlags, 0o600);
  fchmodSync(fd, 0o600);
  return fd;
}

function openPrivateLogFiles(
  logPath: string,
  stderrLogPath: string,
  flags: 'a' | 'w',
): { outputFd: number; stderrFd: number } {
  const outputFd = openPrivateLogFile(logPath, flags);
  try {
    return { outputFd, stderrFd: openPrivateLogFile(stderrLogPath, flags) };
  } catch (error) {
    closeSync(outputFd);
    throw error;
  }
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

function requireSpawnedPid(
  child: SpawnedChild,
  options: OpenClawRuntimeProviderOptions,
  phase: OpenClawSpawnErrorEvent['phase'],
): number {
  if (child.pid !== undefined) {
    return child.pid;
  }
  const error = new Error('OpenClaw runtime spawn did not report a process id');
  options.onSpawnError?.({
    command: options.command,
    phase,
    error,
  });
  throw error;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new Error('OpenClaw runtime start was aborted');
  }
}

function stderrLogPathFor(logPath: string): string {
  return logPath.endsWith('.log') ? logPath.replace(/\.log$/, '.stderr.log') : `${logPath}.stderr`;
}

function safeFileName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

function boundedSafeFileName(value: string, maxLength: number): string {
  const safe = safeFileName(value);
  if (safe.length <= maxLength) {
    return safe;
  }
  const suffix = `_${shortHash(value)}`;
  return `${safe.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
}

function safeLogFileName(value: string): string {
  return `${boundedSafeFileName(value, 140)}_${shortHash(value)}`;
}

function safeRunId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function boundedRunId(value: string): string {
  const safe = safeRunId(value) || 'run';
  const suffix = `-${shortHash(value)}`;
  if (safe.length + suffix.length <= 160) {
    return `${safe}${suffix}`;
  }
  return `${safe.slice(0, 160 - suffix.length).replace(/-+$/g, '')}${suffix}`;
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
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

function isFailureStatus(status: string | undefined): boolean {
  return status === 'error' || status === 'timeout' || isFailureRuntimeRunStatus(status);
}

function normalize(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
