import { spawn } from 'node:child_process';
import { chmodSync, closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import * as fs from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import type { RuntimeProvider, RuntimeProviderContext, RuntimeRun, RuntimeRunRequest, RuntimeRunStatus } from '../runtime-provider.js';
import {
  createCodexAppServerProtocolClient,
  type CodexAppServerProtocolClient,
  type CodexAppServerThreadStartParams,
  type CodexAppServerTurnCompletedEvent,
} from './protocol-client.js';
import type { CodexAppServerRequestFrame } from './client.js';
import {
  createStdioCodexAppServerTransport,
  type SpawnCodexAppServerProcess,
  type StdioCodexAppServerChildProcess,
} from './stdio-transport.js';

export interface CodexAppServerRuntimeProviderOptions {
  enabled: boolean;
  command: string;
  args?: string[] | undefined;
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  inheritEnv?: boolean | undefined;
  logDirectory: string;
  turnTimeoutMs?: number | undefined;
  requestTimeoutMs?: number | undefined;
  closeTimeoutMs?: number | undefined;
  thread?: Partial<CodexAppServerThreadStartParams> | undefined;
  requestHandler?: CodexAppServerRuntimeProviderRequestHandler | undefined;
  spawnProcess?: SpawnCodexAppServerProcess | undefined;
  writeLogChunk?: CodexAppServerRuntimeProviderLogWriter | undefined;
  clientFactory?: CodexAppServerRuntimeProviderClientFactory | undefined;
}

export type CodexAppServerRuntimeProviderLogWriter = (fd: number, chunk: Buffer | string) => void;
export type CodexAppServerRuntimeProviderRequestHandler = (
  frame: CodexAppServerRequestFrame,
) => unknown | Promise<unknown>;

export type CodexAppServerRuntimeProviderClientFactory = (
  options: CodexAppServerRuntimeProviderClientFactoryOptions,
) => CodexAppServerRuntimeProviderClient;

export interface CodexAppServerRuntimeProviderClientFactoryOptions {
  command: string;
  args: string[];
  cwd?: string | undefined;
  env?: Record<string, string | undefined> | undefined;
  inheritEnv?: boolean | undefined;
  requestTimeoutMs: number;
  stdoutLogPath: string;
  stderrLogPath: string;
  stdoutFd: number;
  stderrFd: number;
  writeLogChunk?: CodexAppServerRuntimeProviderLogWriter | undefined;
  spawnProcess?: SpawnCodexAppServerProcess | undefined;
}

export interface CodexAppServerRuntimeProviderClient {
  client: CodexAppServerProtocolClient;
  pid?: number | undefined;
  logWriteError?: (() => Error | undefined) | undefined;
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

const defaultCodexAppServerArgs = ['app-server', '--listen', 'stdio://'];
const defaultTurnTimeoutMs = 30 * 60 * 1000;
const defaultRequestTimeoutMs = 60_000;
const defaultCloseTimeoutMs = 5_000;

export function createCodexAppServerRuntimeProvider(options: CodexAppServerRuntimeProviderOptions): RuntimeProvider {
  return {
    name: 'codex',
    kind: 'runtime-provider',
    startRun: async (request, context) => startCodexAppServerRun(options, request, context),
    resumeRun: async (request) => ({
      id: request.attemptId,
      provider: 'codex',
      status: 'needs_human',
      metadata: {
        attemptId: request.attemptId,
        taskId: request.task.id,
        branchName: request.task.branchName,
        resumeSupported: false,
        error: 'Codex App Server runtime provider does not support resumeRun in the initial implementation',
      },
    }),
  };
}

export async function startCodexAppServerRun(
  options: CodexAppServerRuntimeProviderOptions,
  request: RuntimeRunRequest,
  context?: RuntimeProviderContext,
): Promise<RuntimeRun> {
  if (!options.enabled) {
    throw new Error('Codex App Server runtime provider is disabled');
  }
  throwIfAborted(context?.signal);

  const task = runtimeAgentTaskInput(request.task);
  const turnTimeoutMs = options.turnTimeoutMs ?? defaultTurnTimeoutMs;
  const closeTimeoutMs = options.closeTimeoutMs ?? defaultCloseTimeoutMs;
  const threadParams = codexAppServerThreadParams(options);
  if (requiresCodexAppServerRequestHandler(threadParams) && options.requestHandler === undefined) {
    throw new Error('Codex App Server runtime provider requires a request handler when approvalPolicy is not never');
  }
  ensurePrivateLogDirectory(options.logDirectory);
  const logName = `${boundedSafeFileName(task.id, 72)}-${shortHash(`${request.workflow}:${request.event.delivery.id}:${task.id}:${task.branchName ?? ''}`)}`;
  const logPath = join(options.logDirectory, `${logName}.log`);
  const stderrLogPath = join(options.logDirectory, `${logName}.stderr.log`);
  const { outputFd, stderrFd } = openPrivateLogFiles(logPath, stderrLogPath);
  let runtimeClient: CodexAppServerRuntimeProviderClient | undefined;
  let threadId: string | undefined;
  let turnId: string | undefined;
  let unregisterRequestHandler: (() => void) | undefined;
  const metadataBase = {
    logPath,
    stderrLogPath,
    branchName: task.branchName,
    taskId: task.id,
    appServerCommand: options.command,
  };

  try {
    const clientFactoryOptions: CodexAppServerRuntimeProviderClientFactoryOptions = {
      command: options.command,
      args: options.args ?? defaultCodexAppServerArgs,
      requestTimeoutMs: options.requestTimeoutMs ?? defaultRequestTimeoutMs,
      stdoutLogPath: logPath,
      stderrLogPath,
      stdoutFd: outputFd,
      stderrFd,
    };
    if (options.cwd !== undefined) clientFactoryOptions.cwd = options.cwd;
    if (options.env !== undefined) clientFactoryOptions.env = options.env;
    if (options.inheritEnv !== undefined) clientFactoryOptions.inheritEnv = options.inheritEnv;
    if (options.spawnProcess !== undefined) clientFactoryOptions.spawnProcess = options.spawnProcess;
    if (options.writeLogChunk !== undefined) clientFactoryOptions.writeLogChunk = options.writeLogChunk;
    runtimeClient = (options.clientFactory ?? createDefaultCodexAppServerRuntimeProviderClient)(clientFactoryOptions);
    unregisterRequestHandler = options.requestHandler === undefined
      ? undefined
      : runtimeClient.client.onRequest(options.requestHandler);

    await awaitAbortable(runtimeClient.client.connect(), context?.signal);
    await awaitAbortable(runtimeClient.client.initialize({
      clientInfo: { name: 'rainrail', title: 'Rainrail', version: '0.5.0' },
      capabilities: null,
    }), context?.signal);
    throwIfCodexAppServerLogWriteFailed(runtimeClient);
    const thread = await awaitAbortable(runtimeClient.client.startThread(threadParams), context?.signal);
    throwIfCodexAppServerLogWriteFailed(runtimeClient);
    threadId = thread.thread.id;
    const turn = await awaitAbortable(runtimeClient.client.startTurn({
      threadId,
      input: [{
        type: 'text',
        text: promptForRuntimeTask(task),
        text_elements: [],
      }],
    }), context?.signal);
    turnId = turn.turn.id;
    throwIfCodexAppServerLogWriteFailed(runtimeClient);
    const completed = await waitForCodexTurn(runtimeClient.client, {
      threadId,
      turnId,
      timeoutMs: turnTimeoutMs,
      signal: context?.signal,
    });
    throwIfCodexAppServerLogWriteFailed(runtimeClient);
    const completionStatus = stringValue(completed.turn.status);
    return {
      id: threadId,
      provider: 'codex',
      status: runtimeStatusFromCodexTurn(completed),
      metadata: metadataWithDefinedValues({
        ...metadataBase,
        pid: runtimeClient.pid,
        threadId,
        turnId,
        sessionId: thread.thread.sessionId,
        completionStatus,
      }),
    };
  } catch (error) {
    if (turnId === undefined) {
      throw error;
    }
    const status = isTimeoutError(error) ? 'timed_out' : isAbortError(error) ? 'canceled' : 'failed';
    return {
      id: threadId ?? task.agentSessionId ?? task.id,
      provider: 'codex',
      status,
      metadata: metadataWithDefinedValues({
        ...metadataBase,
        pid: runtimeClient?.pid,
        threadId,
        turnId,
        timeoutMs: status === 'timed_out' ? turnTimeoutMs : undefined,
        error: error instanceof Error ? error.message : String(error),
      }),
    };
  } finally {
    unregisterRequestHandler?.();
    await closeCodexAppServerRuntimeClient(runtimeClient, closeTimeoutMs);
    closeSync(outputFd);
    closeSync(stderrFd);
  }
}

function codexAppServerThreadParams(options: CodexAppServerRuntimeProviderOptions): CodexAppServerThreadStartParams {
  const threadParams: CodexAppServerThreadStartParams = {
    approvalPolicy: 'never',
    ephemeral: true,
    sessionStartSource: 'rainrail',
    threadSource: 'rainrail',
    ...definedCodexThreadOptions(options.thread),
  };
  if (options.cwd !== undefined && threadParams.cwd === undefined) threadParams.cwd = options.cwd;
  return threadParams;
}

function definedCodexThreadOptions(
  thread: Partial<CodexAppServerThreadStartParams> | undefined,
): Partial<CodexAppServerThreadStartParams> {
  if (thread === undefined) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(thread).filter(([, value]) => value !== undefined),
  ) as Partial<CodexAppServerThreadStartParams>;
}

function requiresCodexAppServerRequestHandler(threadParams: CodexAppServerThreadStartParams): boolean {
  return threadParams.approvalPolicy !== undefined && threadParams.approvalPolicy !== null && threadParams.approvalPolicy !== 'never';
}

function createDefaultCodexAppServerRuntimeProviderClient(
  options: CodexAppServerRuntimeProviderClientFactoryOptions,
): CodexAppServerRuntimeProviderClient {
  let pid: number | undefined;
  let logWriteError: Error | undefined;
  const spawnProcess: SpawnCodexAppServerProcess = (command, args, spawnOptions) => {
    const child = (options.spawnProcess ?? defaultSpawnCodexAppServerProcess)(command, args, spawnOptions);
    pid = child.pid;
    const writeLogChunk = options.writeLogChunk ?? writeCodexAppServerLogChunk;
    child.stdout?.on('data', (chunk: Buffer | string) => {
      logWriteError ??= captureLogWriteError(() => writeLogChunk(options.stdoutFd, chunk));
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      logWriteError ??= captureLogWriteError(() => writeLogChunk(options.stderrFd, chunk));
    });
    return child;
  };
  const transportOptions = {
    command: options.command,
    args: options.args,
    spawnProcess,
  };
  if (options.cwd !== undefined) Object.assign(transportOptions, { cwd: options.cwd });
  if (options.env !== undefined) Object.assign(transportOptions, { env: options.env });
  if (options.inheritEnv !== undefined) Object.assign(transportOptions, { inheritEnv: options.inheritEnv });
  const transport = createStdioCodexAppServerTransport(transportOptions);
  return {
    client: createCodexAppServerProtocolClient({
      transport,
      requestTimeoutMs: options.requestTimeoutMs,
    }),
    get pid() {
      return pid;
    },
    logWriteError: () => logWriteError,
  };
}

function writeCodexAppServerLogChunk(fd: number, chunk: Buffer | string): void {
  if (typeof chunk === 'string') {
    fs.writeSync(fd, chunk);
    return;
  }
  fs.writeSync(fd, chunk, 0, chunk.byteLength);
}

function captureLogWriteError(write: () => void): Error | undefined {
  try {
    write();
    return undefined;
  } catch (error) {
    return new Error('Failed to write Codex App Server runtime log', {
      cause: error,
    });
  }
}

function throwIfCodexAppServerLogWriteFailed(runtimeClient: CodexAppServerRuntimeProviderClient): void {
  const error = runtimeClient.logWriteError?.();
  if (error !== undefined) {
    throw error;
  }
}

async function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) {
    return promise;
  }
  if (signal.aborted) {
    throw abortReason(signal);
  }
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        abortListener = () => reject(abortReason(signal));
        signal.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
  } finally {
    if (abortListener !== undefined) {
      signal.removeEventListener('abort', abortListener);
    }
  }
}

async function closeCodexAppServerRuntimeClient(
  runtimeClient: CodexAppServerRuntimeProviderClient | undefined,
  timeoutMs: number,
): Promise<void> {
  if (runtimeClient === undefined) {
    return;
  }
  const closePromise = runtimeClient.client.close();
  closePromise.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      closePromise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } catch {
    // Cleanup failure must not mask the runtime result or startup error.
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function waitForCodexTurn(
  client: CodexAppServerProtocolClient,
  target: { threadId: string; turnId: string; timeoutMs: number; signal?: AbortSignal | undefined },
): Promise<CodexAppServerTurnCompletedEvent> {
  let timer: NodeJS.Timeout | undefined;
  let abortListener: (() => void) | undefined;
  try {
    return await Promise.race([
      client.waitForTurnCompleted(target),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Codex App Server turn timed out')), target.timeoutMs);
      }),
      new Promise<never>((_, reject) => {
        const signal = target.signal;
        if (signal === undefined) {
          return;
        }
        if (signal.aborted) {
          reject(abortReason(signal));
          return;
        }
        abortListener = () => reject(abortReason(signal));
        signal.addEventListener('abort', abortListener, { once: true });
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    if (target.signal !== undefined && abortListener !== undefined) {
      target.signal.removeEventListener('abort', abortListener);
    }
  }
}

function runtimeStatusFromCodexTurn(event: CodexAppServerTurnCompletedEvent): RuntimeRunStatus {
  const status = normalize(stringValue(event.turn.status));
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'canceled' || status === 'cancelled' || status === 'interrupted') return 'canceled';
  if (status === 'timedout' || status === 'timed_out' || status === 'timeout') return 'timed_out';
  if (status === 'stopped') return 'stopped';
  return 'succeeded';
}

function promptForRuntimeTask(task: RuntimeAgentTaskInput): string {
  const issue = task.issue ?? {};
  const repo = issue.repository ?? 'unknown repository';
  const issueNumber = issue.number === undefined ? '(unknown issue number)' : `#${issue.number}`;
  const issueUrl = issue.url ?? '(no issue URL)';
  return [
    'あなたは Rainrail によって起動された GitHub issue 処理エージェントです。',
    '',
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

function runtimeAgentTaskInput(value: unknown): RuntimeAgentTaskInput {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.title !== 'string') {
    throw new Error('Codex App Server runtime task requires id and title');
  }
  return {
    id: value.id,
    title: value.title,
    agentSessionId: stringValue(value.agentSessionId),
    branchName: stringValue(value.branchName),
    issue: issueFieldsFromValue(value),
  };
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

function ensurePrivateLogDirectory(directory: string): void {
  assertNoParentDirectorySegments(directory);
  const nearestExistingPath = nearestExistingPathComponent(directory);
  assertNoSymlinkPathComponents(nearestExistingPath, directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertNoSymlinkPathComponents(nearestExistingPath, directory);
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink()) {
    throw new Error('Codex App Server runtime log directory must not be a symlink');
  }
  if (!stat.isDirectory()) {
    throw new Error('Codex App Server runtime log directory must be a directory');
  }
  chmodSync(directory, 0o700);
}

function openPrivateLogFiles(logPath: string, stderrLogPath: string): { outputFd: number; stderrFd: number } {
  const outputFd = openPrivateLogFile(logPath);
  try {
    return { outputFd, stderrFd: openPrivateLogFile(stderrLogPath) };
  } catch (error) {
    closeSync(outputFd);
    throw error;
  }
}

function openPrivateLogFile(path: string): number {
  assertNoParentDirectorySegments(path);
  const directory = dirname(path);
  assertNoSymlinkPathComponents(nearestExistingPathComponent(directory), directory);
  const fd = openSync(path, constants.O_CREAT | constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new Error(`Codex App Server runtime log path must be a regular file: ${path}`);
    }
    fchmodSync(fd, 0o600);
    return fd;
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function assertNoParentDirectorySegments(path: string): void {
  if (path.split(/[\\/]+/).includes('..')) {
    throw new Error('Codex App Server runtime log path must not include parent directory segments');
  }
}

function nearestExistingPathComponent(path: string): string {
  let current = resolve(path);
  for (;;) {
    try {
      lstatSync(current);
      return current;
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function assertNoSymlinkPathComponents(startPath: string, targetPath: string): void {
  const start = resolve(startPath);
  const target = resolve(targetPath);
  const paths = [start];
  const relativePath = relative(start, target);
  if (relativePath !== '') {
    let current = start;
    for (const segment of relativePath.split(/[\\/]+/).filter((part) => part !== '')) {
      current = join(current, segment);
      paths.push(current);
    }
  }
  for (const path of paths) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        throw new Error(`Codex App Server runtime log path must not include symlinks: ${path}`);
      }
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }
  }
}

function boundedSafeFileName(value: string, maxLength: number): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  const safe = normalized.length === 0 ? 'run' : normalized;
  return safe.length <= maxLength ? safe : safe.slice(0, maxLength).replace(/[-._]+$/g, '');
}

function shortHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw abortReason(signal);
  }
}

function abortReason(signal: AbortSignal): Error {
  const message = signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === 'string'
      ? signal.reason
      : 'Codex App Server runtime provider aborted';
  return new CodexAppServerRuntimeAbortError(message, { cause: signal.reason });
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && /timed out|timeout/i.test(error.message);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted/i.test(error.message));
}

class CodexAppServerRuntimeAbortError extends Error {
  override name = 'AbortError';
}

function normalize(value: string | undefined): string | undefined {
  return value?.toLowerCase().replace(/[\s-]+/g, '_');
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function metadataWithDefinedValues(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultSpawnCodexAppServerProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio: ['pipe', 'pipe', 'pipe'];
  },
): StdioCodexAppServerChildProcess {
  return spawn(command, args, options) as StdioCodexAppServerChildProcess;
}
