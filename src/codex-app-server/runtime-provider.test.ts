import { EventEmitter } from 'node:events';
import { mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCodexAppServerRuntimeProvider,
  type CodexAppServerProtocolClient,
  type CodexAppServerRuntimeProviderClientFactory,
  type SpawnCodexAppServerProcess,
  type CodexAppServerThreadStartParams,
  type CodexAppServerThreadStartResponse,
  type CodexAppServerTurnCompletedEvent,
  type CodexAppServerTurnStartResponse,
} from './index.js';
import { createEventEnvelope } from '../events.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe('createCodexAppServerRuntimeProvider', () => {
  it('keeps Codex App Server startup behind an enabled capability gate', async () => {
    const clientFactory = vi.fn<CodexAppServerRuntimeProviderClientFactory>();
    const provider = createCodexAppServerRuntimeProvider({
      enabled: false,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory,
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow('Codex App Server runtime provider is disabled');
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('keeps Codex App Server resume behind the enabled capability gate', async () => {
    const provider = createCodexAppServerRuntimeProvider({
      enabled: false,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({ client: new FakeCodexAppServerProtocolClient(), pid: 9315 }),
    });

    await expect(provider.resumeRun?.(runtimeResumeRequest())).rejects.toThrow(
      'Codex App Server runtime provider is disabled',
    );
  });

  it('starts one app-server process, thread, and task turn with operational metadata', async () => {
    const client = new FakeCodexAppServerProtocolClient();
    client.threadResponse = { thread: { id: 'thread-315', sessionId: 'session-315' } };
    client.turnResponse = { turn: { id: 'turn-315', status: 'inProgress' } };
    client.completedTurn = { threadId: 'thread-315', turn: { id: 'turn-315', status: 'completed' } };
    const logDirectory = temporaryDirectory();
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      args: ['app-server', '--listen', 'stdio://'],
      cwd: '/repo',
      logDirectory,
      turnTimeoutMs: 60_000,
      clientFactory: () => ({ client, pid: 9315 }),
    });

    await expect(provider.startRun(runtimeRequest())).resolves.toMatchObject({
      id: 'thread-315',
      provider: 'codex',
      status: 'succeeded',
      metadata: {
        pid: 9315,
        threadId: 'thread-315',
        turnId: 'turn-315',
        taskId: 'agent_task_reirei-lab-rainrail_315',
        branchName: 'agent/reirei-lab-rainrail-315-codex-app-server-runtimeprovider',
      },
    });

    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.initialize).toHaveBeenCalledWith({
      clientInfo: { name: 'rainrail', title: 'Rainrail', version: expect.any(String) },
      capabilities: null,
    });
    expect(client.startThread).toHaveBeenCalledWith(expect.objectContaining({
      cwd: '/repo',
      approvalPolicy: 'never',
      ephemeral: true,
      sessionStartSource: 'rainrail',
      threadSource: 'rainrail',
    }));
    expect(client.startTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'thread-315',
      input: [expect.objectContaining({
        type: 'text',
        text: expect.stringContaining('Issue: #315'),
      })],
    }));
    expect(client.waitForTurnCompleted).toHaveBeenCalledWith({
      threadId: 'thread-315',
      turnId: 'turn-315',
      timeoutMs: 60_000,
    });
    expect(client.close).toHaveBeenCalledOnce();

    const metadata = await provider.startRun(runtimeRequest({ taskId: 'agent_task_reirei-lab-rainrail_315_second' }));
    expect(statMode(logDirectory)).toBe(0o700);
    expect(statMode(String(metadata.metadata?.logPath))).toBe(0o600);
    expect(statMode(String(metadata.metadata?.stderrLogPath))).toBe(0o600);
  });

  it.each([
    ['failed', 'failed'],
    ['error', 'failed'],
    ['cancelled', 'canceled'],
    ['interrupted', 'canceled'],
    ['timedOut', 'timed_out'],
  ] as const)('maps completed turn status %s to runtime status %s', async (turnStatus, runtimeStatus) => {
    const client = new FakeCodexAppServerProtocolClient();
    client.completedTurn = { threadId: 'thread-315', turn: { id: 'turn-315', status: turnStatus } };
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({ client, pid: 9315 }),
    });

    await expect(provider.startRun(runtimeRequest())).resolves.toMatchObject({
      status: runtimeStatus,
      metadata: {
        completionStatus: turnStatus,
      },
    });
  });

  it('marks completed turns with error payloads as failed even when status is missing', async () => {
    const client = new FakeCodexAppServerProtocolClient();
    client.completedTurn = {
      threadId: 'thread-315',
      turn: {
        id: 'turn-315',
        error: { message: 'tool execution failed' },
      },
    };
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({ client, pid: 9315 }),
    });

    await expect(provider.startRun(runtimeRequest())).resolves.toMatchObject({
      status: 'failed',
    });
  });

  it('marks stuck turns as timed out and closes the app-server process', async () => {
    vi.useFakeTimers();
    const client = new FakeCodexAppServerProtocolClient();
    client.completedTurnPromise = new Promise(() => undefined);
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      turnTimeoutMs: 1_000,
      clientFactory: () => ({ client, pid: 9315 }),
    });

    const started = provider.startRun(runtimeRequest());
    await vi.advanceTimersByTimeAsync(1_001);

    await expect(started).resolves.toMatchObject({
      status: 'timed_out',
      metadata: {
        pid: 9315,
        timeoutMs: 1_000,
      },
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('does not block timeout results on a stuck app-server close', async () => {
    vi.useFakeTimers();
    const client = new FakeCodexAppServerProtocolClient();
    client.completedTurnPromise = new Promise(() => undefined);
    client.close.mockImplementationOnce(() => new Promise(() => undefined));
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      turnTimeoutMs: 1_000,
      closeTimeoutMs: 250,
      clientFactory: () => ({ client, pid: 9315 }),
    });

    const started = provider.startRun(runtimeRequest());
    await vi.advanceTimersByTimeAsync(1_251);

    await expect(started).resolves.toMatchObject({
      status: 'timed_out',
      metadata: {
        timeoutMs: 1_000,
      },
    });
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('disables stale log mirroring and force kills after close timeout', async () => {
    vi.useFakeTimers();
    const client = new FakeCodexAppServerProtocolClient();
    client.completedTurnPromise = new Promise(() => undefined);
    client.close.mockImplementationOnce(() => new Promise(() => undefined));
    const stopLogMirroring = vi.fn();
    const forceKill = vi.fn();
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      turnTimeoutMs: 1_000,
      closeTimeoutMs: 250,
      clientFactory: () => ({ client, pid: 9315, stopLogMirroring, forceKill }),
    });

    const started = provider.startRun(runtimeRequest());
    await vi.advanceTimersByTimeAsync(1_251);

    await expect(started).resolves.toMatchObject({ status: 'timed_out' });
    expect(stopLogMirroring).toHaveBeenCalledOnce();
    expect(forceKill).toHaveBeenCalledOnce();
  });

  it('cancels a running turn immediately when the caller signal aborts', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const client = new FakeCodexAppServerProtocolClient();
    client.completedTurnPromise = new Promise(() => undefined);
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      turnTimeoutMs: 30 * 60 * 1000,
      clientFactory: () => ({ client, pid: 9315 }),
    });

    const started = provider.startRun(runtimeRequest(), { signal: controller.signal });
    const expectation = expect(started).resolves.toMatchObject({
      status: 'canceled',
      metadata: {
        error: 'workflow aborted',
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('workflow aborted'));
    await vi.advanceTimersByTimeAsync(1);

    await expectation;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('classifies caller aborts as canceled without depending on the abort reason text', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const client = new FakeCodexAppServerProtocolClient();
    client.completedTurnPromise = new Promise(() => undefined);
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({ client, pid: 9315 }),
    });

    const started = provider.startRun(runtimeRequest(), { signal: controller.signal });
    const expectation = expect(started).resolves.toMatchObject({
      status: 'canceled',
      metadata: {
        error: 'manual cancel',
      },
    });
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('manual cancel'));
    await vi.advanceTimersByTimeAsync(1);

    await expectation;
  });

  it('aborts startup handshakes immediately and closes the app-server process', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const client = new FakeCodexAppServerProtocolClient();
    client.initialize.mockImplementationOnce(() => new Promise(() => undefined));
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({ client, pid: 9315 }),
    });

    const started = provider.startRun(runtimeRequest(), { signal: controller.signal });
    const expectation = expect(started).rejects.toThrow('startup canceled');
    await vi.advanceTimersByTimeAsync(1);
    controller.abort(new Error('startup canceled'));
    await vi.advanceTimersByTimeAsync(1);

    await expectation;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('requires a request handler when approval policy allows app-server requests', async () => {
    const client = new FakeCodexAppServerProtocolClient();
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      thread: { approvalPolicy: 'on-request' },
      clientFactory: () => ({ client, pid: 9315 }),
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow(/request handler/i);
    expect(client.connect).not.toHaveBeenCalled();
  });

  it('registers the configured request handler before starting non-never approval runs', async () => {
    const client = new FakeCodexAppServerProtocolClient();
    const requestHandler = vi.fn();
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      thread: { approvalPolicy: 'on-request' },
      requestHandler,
      clientFactory: () => ({ client, pid: 9315 }),
    });

    await expect(provider.startRun(runtimeRequest())).resolves.toMatchObject({ status: 'succeeded' });

    expect(client.onRequest).toHaveBeenCalledWith(requestHandler);
    expect(client.onRequest.mock.invocationCallOrder[0]).toBeLessThan(client.connect.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER);
  });

  it('keeps the request handler registered until the turn completes', async () => {
    const client = new FakeCodexAppServerProtocolClient();
    const completed = deferred<CodexAppServerTurnCompletedEvent>();
    client.completedTurnPromise = completed.promise;
    const unregisterRequestHandler = vi.fn();
    client.onRequest.mockReturnValueOnce(unregisterRequestHandler);
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      thread: { approvalPolicy: 'on-request' },
      requestHandler: vi.fn(),
      clientFactory: () => ({ client, pid: 9315 }),
    });

    const started = provider.startRun(runtimeRequest());
    await vi.waitFor(() => expect(client.waitForTurnCompleted).toHaveBeenCalledOnce());
    expect(unregisterRequestHandler).not.toHaveBeenCalled();

    completed.resolve({ threadId: 'thread-315', turn: { id: 'turn-315', status: 'completed' } });

    await expect(started).resolves.toMatchObject({ status: 'succeeded' });
    expect(unregisterRequestHandler).toHaveBeenCalledOnce();
  });

  it('records accepted turn ids before checking throwable post-start conditions', async () => {
    const client = new FakeCodexAppServerProtocolClient();
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({
        client,
        pid: 9315,
        logWriteError: () => client.startTurn.mock.calls.length > 0
          ? new Error('Failed to write Codex App Server runtime log')
          : undefined,
      }),
    });

    await expect(provider.startRun(runtimeRequest())).resolves.toMatchObject({
      status: 'failed',
      metadata: {
        threadId: 'thread-315',
        turnId: 'turn-315',
        error: 'Failed to write Codex App Server runtime log',
      },
    });
  });

  it('does not let undefined thread options erase runtime defaults', async () => {
    const client = new FakeCodexAppServerProtocolClient();
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      thread: { approvalPolicy: undefined } as unknown as Partial<CodexAppServerThreadStartParams>,
      clientFactory: () => ({ client, pid: 9315 }),
    });

    await expect(provider.startRun(runtimeRequest())).resolves.toMatchObject({ status: 'succeeded' });
    expect(client.startThread).toHaveBeenCalledWith(expect.objectContaining({
      approvalPolicy: 'never',
    }));
  });

  it('rejects startup errors before a turn is accepted so assignment can release the claim', async () => {
    const client = new FakeCodexAppServerProtocolClient();
    client.startThread.mockRejectedValueOnce(new Error('Codex App Server thread/start failed'));
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({ client, pid: 9315 }),
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow('Codex App Server thread/start failed');
    expect(client.close).toHaveBeenCalledOnce();
  });

  it('captures app-server log write failures without throwing from stream data listeners', async () => {
    const writeLogChunk = vi.fn(() => {
      const error = new Error('ENOSPC: no space left on device');
      (error as NodeJS.ErrnoException).code = 'ENOSPC';
      throw error;
    });
    const child = new FakeStdioCodexAppServerChildProcess();
    const spawnProcess = vi.fn<SpawnCodexAppServerProcess>(() => child);
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      spawnProcess,
      writeLogChunk,
    });

    const started = provider.startRun(runtimeRequest());
    child.respondToNextRequest({
      userAgent: 'codex-cli/0.139.0',
      platformFamily: 'unix',
      platformOs: 'macos',
    });

    await expect(started).rejects.toThrow('Failed to write Codex App Server runtime log');
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('rejects symlinked runtime log path components before starting app-server', async () => {
    const clientFactory = vi.fn<CodexAppServerRuntimeProviderClientFactory>(() => ({
      client: new FakeCodexAppServerProtocolClient(),
      pid: 9315,
    }));
    const root = join(process.cwd(), `.rainrail-codex-runtime-${crypto.randomUUID()}`);
    temporaryDirectories.push(root);
    const targetDirectory = join(root, 'actual-logs');
    const linkedComponent = join(root, 'linked-component');
    const logDirectory = join(linkedComponent, 'nested-logs');
    mkdirSync(targetDirectory, { recursive: true });
    symlinkSync(targetDirectory, linkedComponent, 'dir');
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory,
      clientFactory,
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow(/symlink/i);

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rejects parent directory traversal in runtime log paths before symlink checks', async () => {
    const clientFactory = vi.fn<CodexAppServerRuntimeProviderClientFactory>(() => ({
      client: new FakeCodexAppServerProtocolClient(),
      pid: 9315,
    }));
    const root = join(process.cwd(), `.rainrail-codex-runtime-${crypto.randomUUID()}`);
    temporaryDirectories.push(root);
    const targetDirectory = join(root, 'actual-logs');
    const linkedComponent = join(root, 'linked-component');
    const logDirectory = `${linkedComponent}/../logs`;
    mkdirSync(targetDirectory, { recursive: true });
    symlinkSync(targetDirectory, linkedComponent, 'dir');
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory,
      clientFactory,
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow(/parent directory/i);

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('rejects pre-existing non-regular log files before opening them', async () => {
    const clientFactory = vi.fn<CodexAppServerRuntimeProviderClientFactory>(() => ({
      client: new FakeCodexAppServerProtocolClient(),
      pid: 9315,
    }));
    const logDirectory = temporaryDirectory();
    execFileSync('mkfifo', [runtimeLogPath(logDirectory)]);
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory,
      clientFactory,
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow(/regular file/i);

    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('returns an explicit unsupported resume result for the initial provider version', async () => {
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({ client: new FakeCodexAppServerProtocolClient(), pid: 9315 }),
    });

    await expect(provider.resumeRun?.(runtimeResumeRequest())).resolves.toMatchObject({
      id: 'attempt-1',
      provider: 'codex',
      status: 'needs_human',
      metadata: {
        resumeSupported: false,
      },
    });
  });
});

class FakeCodexAppServerProtocolClient implements CodexAppServerProtocolClient {
  threadResponse: CodexAppServerThreadStartResponse = { thread: { id: 'thread-315' } };
  turnResponse: CodexAppServerTurnStartResponse = { turn: { id: 'turn-315', status: 'inProgress' } };
  completedTurn: CodexAppServerTurnCompletedEvent = { threadId: 'thread-315', turn: { id: 'turn-315', status: 'completed' } };
  completedTurnPromise: Promise<CodexAppServerTurnCompletedEvent> | undefined;

  connect = vi.fn(async () => undefined);
  close = vi.fn(async () => undefined);
  initialize = vi.fn(async () => ({
    userAgent: 'codex-cli/0.139.0',
    platformFamily: 'unix',
    platformOs: 'macos',
  }));
  startThread = vi.fn(async () => this.threadResponse);
  startTurn = vi.fn(async () => this.turnResponse);
  waitForTurnCompleted = vi.fn(async () => {
    if (this.completedTurnPromise !== undefined) {
      return this.completedTurnPromise;
    }
    return this.completedTurn;
  });
  onRequest = vi.fn(() => () => undefined);
  onAssistantDelta = vi.fn(() => () => undefined);
  onTurnCompleted = vi.fn(() => () => undefined);
}

class FakeStdioCodexAppServerChildProcess extends EventEmitter {
  pid = 9315;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill = vi.fn(() => {
    this.emit('close', 0, null);
    return true;
  });

  constructor() {
    super();
    this.stdin.on('data', (chunk: Buffer) => {
      const frame = JSON.parse(chunk.toString('utf8')) as { id?: string | number; method?: string };
      if (frame.method === 'initialized') {
        return;
      }
      const response = this.#responses.shift();
      if (response === undefined || frame.id === undefined) {
        return;
      }
      this.stdout.write(`${JSON.stringify({ id: frame.id, result: response })}\n`);
    });
  }

  readonly #responses: unknown[] = [];

  respondToNextRequest(result: unknown): void {
    this.#responses.push(result);
  }
}

function runtimeRequest(overrides: { taskId?: string } = {}) {
  return {
    workflow: 'project-issue-selection',
    requestedBy: 'reirei-agent',
    event: createEventEnvelope({
      source: { type: 'github', name: 'github-project', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-315', receivedAt: '2026-07-10T13:18:03.000Z' },
      occurredAt: '2026-07-10T13:18:03.000Z',
      subject: { type: 'issue', id: '315' },
      payload: { action: 'queued' },
      rawPayload: { kind: 'external-reference', reference: 'github://issues/315' },
    }),
    task: {
      id: overrides.taskId ?? 'agent_task_reirei-lab-rainrail_315',
      title: 'Codex App Server RuntimeProvider を実装する',
      agentSessionId: 'agent:main:reirei-harness-agent_task_reirei-lab-rainrail_315',
      branchName: 'agent/reirei-lab-rainrail-315-codex-app-server-runtimeprovider',
      issue: {
        repository: 'reirei-lab/rainrail',
        number: 315,
        title: 'Codex App Server RuntimeProvider を実装する',
        url: 'https://github.com/reirei-lab/rainrail/issues/315',
      },
    },
  };
}

function runtimeResumeRequest() {
  return {
    run: { id: 'thread-315', provider: 'codex' as const, status: 'running' as const },
    task: {
      id: 'agent_task_reirei-lab-rainrail_315',
      title: 'Codex App Server RuntimeProvider',
      agentSessionId: 'thread-315',
      branchName: 'agent/reirei-lab-rainrail-315-codex-app-server-runtimeprovider',
      logPath: '/tmp/thread-315.log',
      resumeAttempts: [],
    },
    attemptId: 'attempt-1',
    requestedBy: 'reirei-agent',
  };
}

function temporaryDirectory(): string {
  const directory = join(tmpdir(), `rainrail-codex-runtime-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function runtimeLogPath(logDirectory: string): string {
  const task = runtimeRequest().task;
  return join(logDirectory, `${boundedSafeFileName(task.id, 72)}-${shortHash([
    'project-issue-selection',
    'delivery-315',
    task.id,
    task.branchName,
  ].join(':'))}.log`);
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

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: Error) => void = () => undefined;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}
