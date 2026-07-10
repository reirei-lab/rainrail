import { mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCodexAppServerRuntimeProvider,
  type CodexAppServerProtocolClient,
  type CodexAppServerRuntimeProviderClientFactory,
  type CodexAppServerThreadStartResponse,
  type CodexAppServerTurnCompletedEvent,
  type CodexAppServerTurnStartResponse,
} from './index.js';
import { createEventEnvelope } from '../events.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
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

  it('returns an explicit unsupported resume result for the initial provider version', async () => {
    const provider = createCodexAppServerRuntimeProvider({
      enabled: true,
      command: 'codex',
      logDirectory: temporaryDirectory(),
      clientFactory: () => ({ client: new FakeCodexAppServerProtocolClient(), pid: 9315 }),
    });

    await expect(provider.resumeRun?.({
      run: { id: 'thread-315', provider: 'codex', status: 'running' },
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
    })).resolves.toMatchObject({
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

function temporaryDirectory(): string {
  const directory = join(tmpdir(), `rainrail-codex-runtime-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}
