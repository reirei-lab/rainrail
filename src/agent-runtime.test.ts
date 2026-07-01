import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, writeSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createEventEnvelope } from './events.js';
import {
  createAgentAssignmentRuntimeFromProvider,
  createOpenClawRuntimeProvider,
  nextRuntimeResumeAttemptId,
  readRuntimeRunCompletionFromLog,
  runningRuntimeTaskPid,
} from './agent-runtime.js';
import type { RuntimeAgentTask } from './runtime-provider.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  temporaryDirectories.splice(0).forEach((directory) => rmSync(directory, { recursive: true, force: true }));
});

describe('createAgentAssignmentRuntimeFromProvider', () => {
  it('lets workflow tests use a mock runtime provider for agent dispatch', async () => {
    const startRun = vi.fn(async () => ({
      id: 'run:mock',
      provider: 'openclaw' as const,
      status: 'running' as const,
      metadata: { agentSessionId: 'agent:main:rainrail-22' },
    }));
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-project', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-22', receivedAt: '2026-06-30T15:07:29.000Z' },
      occurredAt: '2026-06-30T15:07:29.000Z',
      subject: { type: 'issue', id: '22' },
      payload: { action: 'queued' },
      rawPayload: { kind: 'external-reference', reference: 'github://issues/22' },
    });

    const runtime = createAgentAssignmentRuntimeFromProvider({
      runtime: {
        name: 'mock-openclaw',
        kind: 'runtime-provider',
        startRun,
      },
      event,
      runId: 'run-22',
      workflow: 'project-issue-selection',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      requestedBy: 'reirei-agent',
    });

    await expect(runtime.dispatchAgent({
      workflow: runtime.workflow,
      runId: runtime.runId,
      issue: {
        id: 'item_22',
        contentId: 'issue_node_22',
        contentType: 'Issue',
        title: 'OpenClaw runtime',
        state: 'OPEN',
        status: 'Todo',
        assigneeLogins: ['reirei-agent'],
        repository: 'reirei-lab/rainrail',
        number: 22,
        url: 'https://github.com/reirei-lab/rainrail/issues/22',
      },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22',
        branchName: 'agent/reirei-lab-rainrail-22-openclaw-runtime-run-22',
        issue: {
          id: 'item_22',
          title: 'OpenClaw runtime',
          assigneeLogins: ['reirei-agent'],
        },
      },
    })).resolves.toMatchObject({ id: 'run:mock', status: 'running' });

    expect(startRun).toHaveBeenCalledWith(expect.objectContaining({
      workflow: 'project-issue-selection',
      requestedBy: 'reirei-agent',
      event,
      task: expect.objectContaining({
        id: 'agent_task_reirei-lab-rainrail_22',
        agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22',
        branchName: 'agent/reirei-lab-rainrail-22-openclaw-runtime-run-22',
      }),
    }));
  });
});

describe('createOpenClawRuntimeProvider', () => {
  it('keeps real OpenClaw startup behind an enabled capability gate', async () => {
    const spawnProcess = vi.fn();
    const provider = createOpenClawRuntimeProvider({
      enabled: false,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 600,
      logDirectory: temporaryDirectory(),
      spawnProcess,
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow('OpenClaw runtime provider is disabled');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('starts OpenClaw agent tasks with session, branch, timeout, json log metadata', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await expect(provider.startRun(runtimeRequest())).resolves.toMatchObject({
      id: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22',
      provider: 'openclaw',
      status: 'running',
      metadata: {
        pid: 4242,
        agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22',
        branchName: 'agent/reirei-lab-rainrail-22-openclaw-runtime-run-22',
      },
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      'agent',
      '--agent',
      'main',
      '--session-key',
      'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22',
      '--run-id',
      expect.stringMatching(/^rainrail-start-project-issue-selection-delivery-22-agent-task-reirei-lab-rainrail-22-session-[a-f0-9]{12}-[a-f0-9]{12}$/),
      '--timeout',
      '900',
      '--json',
    ]), expect.objectContaining({
      detached: true,
      stdio: expect.arrayContaining(['ignore']),
    }));
  });

  it('creates start and resume logs with private permissions', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const started = await provider.startRun(runtimeRequest());
    const resumed = await provider.resumeRun?.({
      run: started,
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: String(started.metadata?.logPath),
        stderrLogPath: String(started.metadata?.stderrLogPath),
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(statMode(logDirectory)).toBe(0o700);
    expect(statMode(String(started.metadata?.logPath))).toBe(0o600);
    expect(statMode(String(started.metadata?.stderrLogPath))).toBe(0o600);
    expect(statMode(String(resumed?.metadata?.logPath))).toBe(0o600);
    expect(statMode(String(resumed?.metadata?.stderrLogPath))).toBe(0o600);
  });

  it('does not follow pre-existing symlinks when creating runtime logs', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const targetFile = join(logDirectory, 'outside-target.log');
    const agentSessionId = 'agent:main:symlink-session';
    const logPath = join(logDirectory, `${safeRuntimeLogFileName(agentSessionId)}.log`);
    writeFileSync(targetFile, 'do-not-touch', 'utf8');
    symlinkSync(targetFile, logPath);
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await expect(provider.startRun(runtimeRequest({ agentSessionId }))).rejects.toThrow();

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(readFileSync(targetFile, 'utf8')).toBe('do-not-touch');
  });

  it('rejects pre-existing non-regular runtime log paths before spawning', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const agentSessionId = 'agent:main:directory-log-session';
    const logPath = join(logDirectory, `${safeRuntimeLogFileName(agentSessionId)}.log`);
    mkdirSync(logPath, { recursive: true });
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await expect(provider.startRun(runtimeRequest({ agentSessionId }))).rejects.toThrow(/regular file/i);

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('rejects symlinked runtime log directories before creating logs', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const root = temporaryDirectory();
    const targetDirectory = join(root, 'actual-logs');
    const logDirectory = join(root, 'linked-logs');
    mkdirSync(targetDirectory, { recursive: true });
    symlinkSync(targetDirectory, logDirectory, 'dir');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow(/symlink/i);

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('rejects symlinked runtime log path components inside the worktree', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const root = join(process.cwd(), `.rainrail-agent-runtime-${crypto.randomUUID()}`);
    temporaryDirectories.push(root);
    const targetDirectory = join(root, 'actual-logs');
    const linkedComponent = join(root, 'linked-component');
    const logDirectory = join(linkedComponent, 'nested-logs');
    mkdirSync(targetDirectory, { recursive: true });
    symlinkSync(targetDirectory, linkedComponent, 'dir');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow(/symlink/i);

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('passes stable run ids to start and resume OpenClaw invocations', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const started = await provider.startRun(runtimeRequest());
    await provider.resumeRun?.({
      run: started,
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: String(started.metadata?.logPath),
        stderrLogPath: String(started.metadata?.stderrLogPath),
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenNthCalledWith(1, 'openclaw', expect.arrayContaining([
      '--run-id',
      expect.stringMatching(/^rainrail-start-project-issue-selection-delivery-22-agent-task-reirei-lab-rainrail-22-session-[a-f0-9]{12}-[a-f0-9]{12}$/),
    ]), expect.anything());
    expect(spawnProcess).toHaveBeenNthCalledWith(2, 'openclaw', expect.arrayContaining([
      '--run-id',
      expect.stringMatching(/^rainrail-resume-agent-task-reirei-lab-rainrail-22-resume-01-[a-f0-9]{12}$/),
    ]), expect.anything());
  });

  it('keeps run ids distinct for task ids that normalize to the same value', async () => {
    const spawnProcess = vi.fn((_command: string, _args: string[]) => ({ pid: 4242, unref: vi.fn() }));
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory: temporaryDirectory(),
      spawnProcess,
    });

    await provider.startRun(runtimeRequest({ taskId: 'task_a' }));
    await provider.startRun(runtimeRequest({ taskId: 'task-a' }));

    const firstArgs = spawnProcess.mock.calls[0]![1] as string[];
    const secondArgs = spawnProcess.mock.calls[1]![1] as string[];
    const firstRunId = firstArgs[firstArgs.indexOf('--run-id') + 1];
    const secondRunId = secondArgs[secondArgs.indexOf('--run-id') + 1];
    expect(firstRunId).toMatch(/^rainrail-start-project-issue-selection-delivery-22-task-a-session-[a-f0-9]{12}-[a-f0-9]{12}$/);
    expect(secondRunId).toMatch(/^rainrail-start-project-issue-selection-delivery-22-task-a-session-[a-f0-9]{12}-[a-f0-9]{12}$/);
    expect(firstRunId).not.toBe(secondRunId);
  });

  it('keeps JSON stdout separate from diagnostic stderr for completion parsing', async () => {
    const logDirectory = temporaryDirectory();
    const spawnProcess = vi.fn((_command, _args, options) => {
      const stdoutFd = options.stdio[1] as number;
      const stderrFd = options.stdio[2] as number;
      expect(stdoutFd).not.toBe(stderrFd);
      writeSync(stdoutFd, JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
      }));
      writeSync(stderrFd, '{"status":"failed","summary":"diagnostic only"}\n');
      return { pid: 4242, unref: vi.fn() };
    });
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const started = await provider.startRun(runtimeRequest());
    const stdoutLog = readFileSync(String(started.metadata?.logPath), 'utf8');
    const stderrLog = readFileSync(String(started.metadata?.stderrLogPath), 'utf8');

    expect(readRuntimeRunCompletionFromLog(stdoutLog)).toMatchObject({
      status: 'succeeded',
      outcome: 'implemented',
    });
    expect(stderrLog).toContain('diagnostic only');
    expect(stdoutLog).not.toContain('diagnostic only');
  });

  it('uses a run-specific start log path for repeated starts of the same issue task', async () => {
    const spawnProcess = vi.fn((_command: string, _args: string[]) => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const first = await provider.startRun(runtimeRequest({
      agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-a',
    }));
    const second = await provider.startRun(runtimeRequest({
      agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-b',
    }));

    expect(first.metadata?.logPath).toContain('run-a');
    expect(second.metadata?.logPath).toContain('run-b');
    expect(first.metadata?.logPath).not.toBe(second.metadata?.logPath);
    const firstArgs = spawnProcess.mock.calls[0]![1] as string[];
    const secondArgs = spawnProcess.mock.calls[1]![1] as string[];
    expect(firstArgs[firstArgs.indexOf('--run-id') + 1]).not.toBe(secondArgs[secondArgs.indexOf('--run-id') + 1]);
  });

  it('does not truncate existing start logs when a start request is retried', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const first = await provider.startRun(runtimeRequest());
    writeFileSync(String(first.metadata?.logPath), JSON.stringify({
      status: 'ok',
      meta: { agentMeta: { fallbackSessionKey: 'agent:main:explicit:gateway-fallback-existing' } },
    }), 'utf8');
    const second = await provider.startRun(runtimeRequest());

    expect(second.metadata?.logPath).toBe(first.metadata?.logPath);
    expect(readFileSync(String(second.metadata?.logPath), 'utf8')).toContain('gateway-fallback-existing');
  });

  it('keeps long start log filenames within common filename limits', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const longSessionId = `agent:main:${'very-long-owner-name-'.repeat(8)}${'very-long-repository-name-'.repeat(8)}${'uuid-'.repeat(40)}`;
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const started = await provider.startRun(runtimeRequest({ agentSessionId: longSessionId }));

    expect(Buffer.byteLength(basename(String(started.metadata?.logPath)), 'utf8')).toBeLessThanOrEqual(180);
    expect(basename(String(started.metadata?.logPath))).toMatch(/_[a-f0-9]{12}\.log$/);
  });

  it('uses collision-resistant start log paths for distinct session keys', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const first = await provider.startRun(runtimeRequest({ agentSessionId: 'agent:main:foo' }));
    writeFileSync(String(first.metadata?.logPath), 'first run completion', 'utf8');
    const second = await provider.startRun(runtimeRequest({ agentSessionId: 'agent_main_foo' }));

    expect(first.metadata?.logPath).not.toBe(second.metadata?.logPath);
    expect(readFileSync(String(first.metadata?.logPath), 'utf8')).toBe('first run completion');
  });

  it('generates distinct start sessions and logs when tasks omit agent session ids', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const first = await provider.startRun(runtimeRequest({ agentSessionId: null, deliveryId: 'delivery-run-a' }));
    const second = await provider.startRun(runtimeRequest({ agentSessionId: null, deliveryId: 'delivery-run-b' }));

    expect(first.id).toContain('delivery-run-a');
    expect(second.id).toContain('delivery-run-b');
    expect(first.id).not.toBe(second.id);
    expect(first.metadata?.logPath).not.toBe(second.metadata?.logPath);
  });

  it('includes workflow names in generated sessions when tasks omit agent session ids', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    const triage = await provider.startRun({
      ...runtimeRequest({ agentSessionId: null }),
      workflow: 'triage',
    });
    const implementation = await provider.startRun({
      ...runtimeRequest({ agentSessionId: null }),
      workflow: 'implementation',
    });

    expect(triage.id).toContain('triage');
    expect(implementation.id).toContain('implementation');
    expect(triage.id).not.toBe(implementation.id);
    expect(triage.metadata?.logPath).not.toBe(implementation.metadata?.logPath);
  });

  it('passes top-level task issue fields into the start prompt', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory: temporaryDirectory(),
      spawnProcess,
    });

    await provider.startRun({
      ...runtimeRequest(),
      task: {
        id: 'issue_22',
        title: 'OpenClaw runtime',
        repository: 'reirei-lab/rainrail',
        number: 22,
        url: 'https://github.com/reirei-lab/rainrail/issues/22',
      },
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--message',
      expect.stringContaining('Repository: reirei-lab/rainrail'),
    ]), expect.anything());
    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--message',
      expect.stringContaining('Issue URL: https://github.com/reirei-lab/rainrail/issues/22'),
    ]), expect.anything());
  });

  it('resumes OpenClaw agent tasks in the existing session with an attempt log', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await expect(provider.resumeRun?.({
      run: { id: 'agent:main:existing-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:existing-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: 'var/agent-task-logs/task.log',
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    })).resolves.toMatchObject({
      id: 'agent:main:existing-session',
      provider: 'openclaw',
      status: 'running',
      metadata: {
        pid: 5151,
        attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
        agentSessionId: 'agent:main:existing-session',
      },
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      'agent',
      '--session-key',
      'agent:main:existing-session',
      '--message',
      expect.stringContaining('Existing task log: var/agent-task-logs/task.log'),
      '--json',
    ]), expect.anything());
  });

  it('does not start OpenClaw when the caller signal is already aborted', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 4242, unref: vi.fn() }));
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory: temporaryDirectory(),
      spawnProcess,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(provider.startRun(runtimeRequest(), { signal: controller.signal })).rejects.toThrow('aborted');
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('does not terminate a started OpenClaw run when the caller signal aborts after ownership transfers', async () => {
    const kill = vi.fn();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory: temporaryDirectory(),
      spawnProcess: vi.fn(() => ({ pid: 4242, unref: vi.fn(), kill })),
    });
    const controller = new AbortController();

    await expect(provider.startRun(runtimeRequest(), { signal: controller.signal })).resolves.toMatchObject({
      status: 'running',
    });
    controller.abort();

    expect(kill).not.toHaveBeenCalled();
  });

  it('does not terminate a resumed OpenClaw run when the caller signal aborts after ownership transfers', async () => {
    const kill = vi.fn();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory: temporaryDirectory(),
      spawnProcess: vi.fn(() => ({ pid: 5151, unref: vi.fn(), kill })),
    });
    const controller = new AbortController();

    await expect(provider.resumeRun?.({
      run: { id: 'agent:main:existing-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:existing-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: 'var/agent-task-logs/task.log',
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    }, { signal: controller.signal })).resolves.toMatchObject({
      status: 'running',
    });
    controller.abort();

    expect(kill).not.toHaveBeenCalled();
  });

  it('resumes the fallback session key recorded in the previous task log', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, [
      'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-abc123',
      JSON.stringify({
        status: 'ok',
        result: {
          finalAssistantVisibleText: 'Outcome: implemented',
          meta: {
            agentMeta: {
              sessionId: 'gateway-fallback-abc123',
              fallbackSessionKey: 'agent:main:explicit:gateway-fallback-abc123',
            },
          },
        },
      }),
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await expect(provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    })).resolves.toMatchObject({
      id: 'agent:main:explicit:gateway-fallback-abc123',
      metadata: { agentSessionId: 'agent:main:explicit:gateway-fallback-abc123' },
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-abc123',
    ]), expect.anything());
  });

  it('does not scan whole historical logs for fallback markers when resuming', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, [
      'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-old-history',
      'x'.repeat(2 * 1024 * 1024),
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('resumes the fallback session key recorded in top-level completion metadata', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, JSON.stringify({
      status: 'ok',
      payloads: [{ text: 'Outcome: implemented' }],
      meta: {
        agentMeta: {
          sessionId: 'gateway-fallback-top-level',
          fallbackSessionKey: 'agent:main:explicit:gateway-fallback-top-level',
        },
      },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-top-level',
    ]), expect.anything());
  });

  it('resumes fallback sessions recorded only as completion session ids', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, JSON.stringify({
      status: 'ok',
      meta: {
        agentMeta: {
          sessionId: 'gateway-fallback-session-only',
        },
      },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-session-only',
    ]), expect.anything());
  });

  it('resumes the fallback session marker recorded in stderr logs', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const startStderrLogPath = `${logDirectory}/task.stderr.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    const resumeStderrLogPath = `${logDirectory}/resume-1.stderr.log`;
    writeFileSync(startLogPath, JSON.stringify({ status: 'timed_out', summary: 'gateway timeout before completion metadata' }), 'utf8');
    writeFileSync(startStderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-start-stderr', 'utf8');
    writeFileSync(resumeLogPath, 'resume stdout without fallback marker', 'utf8');
    writeFileSync(resumeStderrLogPath, [
      JSON.stringify({ status: 'failed', summary: 'gateway diagnostic before fallback marker' }),
      'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-resume-stderr',
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        stderrLogPath: startStderrLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-resume-stderr',
    ]), expect.anything());
  });

  it('does not clear fallback lookup from stderr status JSON diagnostics', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    const resumeStderrLogPath = `${logDirectory}/resume-1.stderr.log`;
    writeFileSync(startLogPath, 'started intended session', 'utf8');
    writeFileSync(resumeLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-stdout', 'utf8');
    writeFileSync(resumeStderrLogPath, JSON.stringify({
      status: 'ok',
      meta: { agentMeta: { sessionId: 'diagnostic-session' } },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-stdout',
    ]), expect.anything());
  });

  it('does not resume fallback sessions from stderr completion JSON diagnostics', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    const resumeStderrLogPath = `${logDirectory}/resume-1.stderr.log`;
    writeFileSync(startLogPath, 'started intended session', 'utf8');
    writeFileSync(resumeLogPath, 'resume stdout without fallback marker', 'utf8');
    writeFileSync(resumeStderrLogPath, JSON.stringify({
      status: 'ok',
      meta: { agentMeta: { sessionId: 'gateway-fallback-diagnostic' } },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('resumes the last fallback marker when a single stderr log contains retry history', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const startStderrLogPath = `${logDirectory}/task.stderr.log`;
    writeFileSync(startLogPath, JSON.stringify({ status: 'timed_out' }), 'utf8');
    writeFileSync(startStderrLogPath, [
      'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-old',
      'retry diagnostics',
      'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-new',
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        stderrLogPath: startStderrLogPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-new',
    ]), expect.anything());
  });

  it('resumes the fallback session recorded in the latest resume attempt log', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const firstResumeLogPath = `${logDirectory}/resume-1.log`;
    const secondResumeLogPath = `${logDirectory}/resume-2.log`;
    writeFileSync(startLogPath, 'started intended session', 'utf8');
    writeFileSync(firstResumeLogPath, 'first resume used intended session', 'utf8');
    writeFileSync(secondResumeLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-latest', 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: firstResumeLogPath },
          { id: 'resume-2', status: 'stopped', logPath: secondResumeLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_03',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-latest',
    ]), expect.anything());
  });

  it('resumes the last fallback candidate within an appended log regardless of metadata or marker source', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, [
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { fallbackSessionKey: 'agent:main:explicit:gateway-fallback-old' } },
      }),
      'retry diagnostics',
      'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-new',
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-new',
    ]), expect.anything());
  });

  it('does not resume stale fallback candidates after a later normal completion', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, [
      JSON.stringify({
        status: 'ok',
        meta: { agentMeta: { fallbackSessionKey: 'agent:main:explicit:gateway-fallback-stale' } },
      }),
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
        meta: { agentMeta: { sessionId: 'intended-session' } },
      }),
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('resumes stderr fallback markers before stale stdout fallback metadata in the same attempt', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    const resumeStderrLogPath = `${logDirectory}/resume-1.stderr.log`;
    writeFileSync(startLogPath, 'started intended session', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({
      status: 'ok',
      meta: { agentMeta: { fallbackSessionKey: 'agent:main:explicit:gateway-fallback-stale' } },
    }), 'utf8');
    writeFileSync(resumeStderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-current', 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-current',
    ]), expect.anything());
  });

  it('stops fallback lookup when the latest resume log has a normal completion', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    writeFileSync(startLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-stale', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: 'Outcome: implemented',
      meta: { agentMeta: { sessionId: 'intended-session' } },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('stops fallback lookup when the latest resume log has a strict status-only terminal completion', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    const resumeStderrLogPath = `${logDirectory}/resume-1.stderr.log`;
    writeFileSync(startLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-stale', 'utf8');
    writeFileSync(resumeStderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-stderr', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({ status: 'succeeded', summary: 'done' }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('clears same-attempt stderr fallback when stdout has a normal completion', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    const resumeStderrLogPath = `${logDirectory}/resume-1.stderr.log`;
    writeFileSync(startLogPath, '', 'utf8');
    writeFileSync(resumeStderrLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-stale', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: 'Outcome: implemented',
      meta: { agentMeta: { sessionId: 'intended-session' } },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath, stderrLogPath: resumeStderrLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('keeps fallback lookup when the latest resume log only reports in-flight', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    writeFileSync(startLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-active', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({
      status: 'in_flight',
      summary: 'duplicate run is still active',
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-active',
    ]), expect.anything());
  });

  it('keeps fallback lookup when the latest resume log only reports running progress', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    writeFileSync(startLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-active', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({
      status: 'running',
      meta: { agentMeta: {} },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-active',
    ]), expect.anything());
  });

  it('keeps fallback lookup when the latest resume log reports timeout alias failure', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const startLogPath = `${logDirectory}/task.log`;
    const resumeLogPath = `${logDirectory}/resume-1.log`;
    writeFileSync(startLogPath, 'EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-active', 'utf8');
    writeFileSync(resumeLogPath, JSON.stringify({
      status: 'timeout',
      meta: { agentMeta: {} },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: startLogPath,
        resumeAttempts: [
          { id: 'resume-1', status: 'stopped', logPath: resumeLogPath },
        ],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_02',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:explicit:gateway-fallback-active',
    ]), expect.anything());
  });

  it('closes the stdout log when opening the stderr log fails', async () => {
    const logDirectory = temporaryDirectory();
    const attemptId = 'agent_task_reirei-lab-rainrail_22_resume_01';
    const stderrLogPath = `${logDirectory}/${testSafeLogFileName(attemptId)}.stderr.log`;
    mkdirSync(stderrLogPath);
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess: vi.fn(() => ({ pid: 5151, unref: vi.fn() })),
    });

    await expect(provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath: `${logDirectory}/task.log`,
        resumeAttempts: [],
      },
      attemptId,
      requestedBy: 'reirei-agent',
    })).rejects.toThrow();

    expect((provider as { name: string }).name).toBe('openclaw');
  });

  it('does not resume fallback markers quoted inside JSON completion text', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: '調査対象ログ: EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-quoted',
      result: {
        meta: {
          agentMeta: {
            sessionId: 'intended-session',
          },
        },
      },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('does not resume fallback markers quoted inside bannered JSON completion text', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, [
      'OpenClaw agent starting',
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: '調査対象ログ: EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-banner-quoted',
        result: {
          meta: {
            agentMeta: {
              sessionId: 'intended-session',
            },
          },
        },
      }),
      'OpenClaw agent finished',
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('does not resume fallback markers quoted inside escaped JSON strings', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
      }),
      JSON.stringify('EMBEDDED FALLBACK: Gateway timed out; running embedded agent with fresh session gateway-fallback-quoted'),
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('does not treat bare fallback-looking text as a resume session marker', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, [
      'user pasted gateway-fallback-not-a-runtime-session in the issue body',
      'tool output: {"agentMeta":{"fallbackSessionKey":"agent:main:other-session"}}',
      'tool output: {"fallbackSessionKey":"agent:main:other-session"}',
    ].join('\n'), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('does not resume fallback keys from strict diagnostic JSON', async () => {
    const spawnProcess = vi.fn(() => ({ pid: 5151, unref: vi.fn() }));
    const logDirectory = temporaryDirectory();
    const logPath = `${logDirectory}/task.log`;
    writeFileSync(logPath, JSON.stringify({
      meta: {
        agentMeta: {
          fallbackSessionKey: 'agent:main:explicit:gateway-fallback-quoted',
        },
      },
    }), 'utf8');
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory,
      spawnProcess,
    });

    await provider.resumeRun?.({
      run: { id: 'agent:main:intended-session', provider: 'openclaw', status: 'stopped' },
      task: {
        id: 'agent_task_reirei-lab-rainrail_22',
        title: 'OpenClaw runtime',
        agentSessionId: 'agent:main:intended-session',
        branchName: 'agent/reirei-lab-rainrail-22',
        logPath,
        resumeAttempts: [],
      },
      attemptId: 'agent_task_reirei-lab-rainrail_22_resume_01',
      requestedBy: 'reirei-agent',
    });

    expect(spawnProcess).toHaveBeenCalledWith('openclaw', expect.arrayContaining([
      '--session-key',
      'agent:main:intended-session',
    ]), expect.anything());
  });

  it('handles asynchronous spawn errors instead of leaving them unobserved', async () => {
    const child = new EventEmitter() as EventEmitter & { pid: number; unref: () => void };
    child.pid = 6262;
    child.unref = vi.fn();
    const onSpawnError = vi.fn();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'missing-openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory: temporaryDirectory(),
      spawnProcess: vi.fn(() => child),
      onSpawnError,
    });

    await expect(provider.startRun(runtimeRequest())).resolves.toMatchObject({
      status: 'running',
      metadata: { pid: 6262 },
    });

    child.emit('error', new Error('spawn missing-openclaw ENOENT'));

    expect(onSpawnError).toHaveBeenCalledWith(expect.objectContaining({
      command: 'missing-openclaw',
      phase: 'start',
      error: expect.any(Error),
    }));
  });

  it('rejects start runs when spawn returns no process id', async () => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = vi.fn();
    const provider = createOpenClawRuntimeProvider({
      enabled: true,
      command: 'missing-openclaw',
      agentId: 'main',
      sessionKeyPrefix: 'rainrail',
      timeoutSeconds: 900,
      logDirectory: temporaryDirectory(),
      spawnProcess: vi.fn(() => child),
    });

    await expect(provider.startRun(runtimeRequest())).rejects.toThrow('did not report a process id');

    expect(child.unref).not.toHaveBeenCalled();
  });
});

describe('runtime task completion and resume helpers', () => {
  it('classifies successful Codex completion payloads and compaction failures', () => {
    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      finalAssistantVisibleText: 'Outcome: implemented',
      executionTrace: { result: 'success' },
      completion: { finishReason: 'stop' },
    }))).toMatchObject({ status: 'succeeded', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: 'I investigated a log line saying CLI transcript compaction failed.',
    }))).toMatchObject({ status: 'succeeded' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: 'Outcome: needs_human',
    }))).toMatchObject({ status: 'needs_human', outcome: 'needs_human' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: 'Outcome: split_recommended',
    }))).toMatchObject({ status: 'split_recommended', outcome: 'split_recommended' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: [
        '引用: Outcome: needs_human',
        '実際の最終結果です。',
        'Outcome: implemented',
      ].join('\n'),
    }))).toMatchObject({ status: 'succeeded', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      payloads: [{ text: '修正して PR を更新しました。\n\nOutcome: implemented' }],
      meta: { agentMeta: { sessionId: 'session-1' } },
    }))).toMatchObject({ status: 'succeeded', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      finalAssistantRawText: 'raw only completion',
      executionTrace: { result: 'success' },
      completion: { finishReason: 'stop' },
    }))).toMatchObject({ status: 'succeeded', summary: 'raw only completion' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      result: {
        payloads: [
          { text: 'Issue に調査結果を追記しました。' },
          { text: 'Outcome: updated_issue' },
        ],
        meta: { agentMeta: { sessionId: 'session-2' } },
      },
    }))).toMatchObject({ status: 'succeeded', outcome: 'updated_issue' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: '追加確認が必要です。\n\nOutcome: needs_human',
      result: {
        meta: {
          agentMeta: {
            sessionId: 'session-metadata-only',
          },
        },
      },
    }))).toMatchObject({ status: 'needs_human', outcome: 'needs_human' });

    expect(readRuntimeRunCompletionFromLog(
      'GatewayClientRequestError: Error: CLI transcript compaction failed for openai/gpt-5.5: Compaction timed out',
    )).toMatchObject({
      status: 'compaction_failed',
      summary: expect.stringContaining('Compaction timed out'),
    });
  });

  it('redacts credentials from runtime completion summaries', () => {
    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'failed',
      summary: 'failed with Authorization: Bearer github_pat_completionSecret',
      promptError: 'WEBHOOK_SECRET=correct horse battery',
      timeoutPhase: 'Cookie: session=abc123; csrf=secret',
      stopReason: 'password=hunter2 backup phrase',
    }))).toMatchObject({
      status: 'failed',
      summary: 'failed with Authorization: [redacted-authorization]',
      promptError: 'WEBHOOK_SECRET=[redacted]',
      timeoutPhase: 'Cookie: [redacted-cookie]',
      stopReason: 'password=[redacted]',
    });
    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'failed',
      summary: 'failed with Set-Cookie: session=abc123; csrf=secret',
      promptError: 'standalone Bearer opaque-session-token',
    }))).toMatchObject({
      status: 'failed',
      summary: 'failed with Set-Cookie: [redacted-cookie]',
      promptError: 'standalone Bearer [redacted-token]',
    });
    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'failed',
      summary: [
        'failed with private key',
        '-----BEGIN OPENSSH PRIVATE KEY-----',
        'placeholder-private-key',
        '-----END OPENSSH PRIVATE KEY-----',
      ].join('\n'),
      promptError: [
        '-----BEGIN PRIVATE KEY-----',
        'placeholder-private-key',
        '-----END PRIVATE KEY-----',
      ].join('\n'),
    }))).toMatchObject({
      status: 'failed',
      summary: 'failed with private key\n[redacted-private-key]',
      promptError: '[redacted-private-key]',
    });
    expect(readRuntimeRunCompletionFromLog([
      'GatewayClientRequestError: Error: CLI transcript compaction failed for openai/gpt-5.5',
      'Authorization: Bearer github_pat_compactionSecret',
    ].join('\n'))).toMatchObject({
      status: 'compaction_failed',
      summary: 'Authorization: [redacted-authorization]',
    });
  });

  it('prefers trailing compaction failure text over stale appended JSON completions', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
      }),
      'GatewayClientRequestError: Error: CLI transcript compaction failed for openai/gpt-5.5: Compaction timed out',
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'compaction_failed',
      summary: expect.stringContaining('Compaction timed out'),
      timeoutPhase: 'compaction',
    });
  });

  it('prefers compaction failure text after the latest JSON even when followed by footer diagnostics', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
      }),
      'GatewayClientRequestError: Error: CLI transcript compaction failed for openai/gpt-5.5: Compaction timed out',
      'OpenClaw agent finished',
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'compaction_failed',
      summary: expect.stringContaining('Compaction timed out'),
      timeoutPhase: 'compaction',
    });
  });

  it('ignores compaction failure text quoted inside appended diagnostic JSON', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
      }),
      JSON.stringify({ message: 'CLI transcript compaction failed for quoted target log' }),
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'succeeded',
      outcome: 'implemented',
    });
  });

  it('ignores compaction failure text quoted inside prefixed diagnostic JSON', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
      }),
      `diag: ${JSON.stringify({ message: 'CLI transcript compaction failed for quoted target log' })}`,
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'succeeded',
      outcome: 'implemented',
    });
  });

  it('ignores compaction failure text when the log only contains prefixed diagnostic JSON', () => {
    const raw = `diag: ${JSON.stringify({ message: 'CLI transcript compaction failed for quoted target log' })}`;

    expect(readRuntimeRunCompletionFromLog(raw)).toBeUndefined();
  });

  it('ignores compaction failure text quoted inside escaped diagnostic JSON', () => {
    const raw = `diag: ${JSON.stringify(JSON.stringify({ message: 'CLI transcript compaction failed for quoted target log' }))}`;

    expect(readRuntimeRunCompletionFromLog(raw)).toBeUndefined();
  });

  it('does not let advisory Outcome text override explicit failure statuses', () => {
    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'error',
      finalAssistantVisibleText: 'Outcome: needs_human',
    }))).toMatchObject({ status: 'failed', outcome: 'needs_human' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'timed_out',
      finalAssistantVisibleText: 'Outcome: split_recommended',
    }))).toMatchObject({ status: 'timed_out', outcome: 'split_recommended' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'ok',
      result: {
        status: 'failed',
        payloads: [{ text: '途中で失敗しました。\n\nOutcome: implemented' }],
      },
    }))).toMatchObject({ status: 'failed', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'failed',
      result: {
        status: 'ok',
        payloads: [{ text: 'Outcome: implemented' }],
      },
    }))).toMatchObject({ status: 'failed', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'error',
      result: {
        status: 'ok',
        payloads: [{ text: 'Outcome: implemented' }],
      },
    }))).toMatchObject({ status: 'failed', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'timeout',
      result: {
        status: 'ok',
        payloads: [{ text: 'Outcome: implemented' }],
      },
    }))).toMatchObject({ status: 'timed_out', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'needs_human',
      result: {
        status: 'ok',
        payloads: [{ text: 'Outcome: implemented' }],
      },
    }))).toMatchObject({ status: 'needs_human', outcome: 'implemented' });
  });

  it('prefers top-level final text over payload texts when resolving Outcome', () => {
    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'ok',
      finalAssistantVisibleText: '実際の最終結果です。\nOutcome: implemented',
      payloads: [
        { text: '引用: Outcome: split_recommended' },
        { text: '古い調査メモ: Outcome: needs_human' },
      ],
    }))).toMatchObject({ status: 'succeeded', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      status: 'ok',
      payloads: [
        { text: '古い調査メモ: Outcome: needs_human' },
        { text: '最後の payload: Outcome: implemented' },
      ],
    }))).toMatchObject({ status: 'succeeded', outcome: 'implemented' });
  });

  it('accepts canonical runtime completion statuses from JSON logs', () => {
    for (const status of ['failed', 'canceled', 'stopped', 'timed_out', 'compaction_failed'] as const) {
      expect(readRuntimeRunCompletionFromLog(JSON.stringify({ status, summary: `${status} run` }))).toMatchObject({
        status,
        summary: `${status} run`,
      });
    }

    expect(readRuntimeRunCompletionFromLog(JSON.stringify({ status: 'in_flight', summary: 'duplicate run' }))).toMatchObject({
      status: 'running',
      summary: 'duplicate run',
    });
  });

  it('treats appended in-flight duplicate run responses as running completions', () => {
    const raw = [
      JSON.stringify({ status: 'failed', summary: 'stale terminal completion' }),
      JSON.stringify({ status: 'in_flight', summary: 'duplicate run is still active' }),
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'running',
      summary: 'duplicate run is still active',
    });
  });

  it('uses appended status-only terminal completions as the latest runtime result', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
        summary: 'stale successful completion',
      }),
      JSON.stringify({ status: 'failed', summary: 'retry failed after append' }),
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'failed',
      summary: 'retry failed after append',
    });
  });

  it('uses appended terminal completions even when they omit summary', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
        summary: 'stale successful completion',
      }),
      JSON.stringify({ status: 'failed', promptError: 'retry failed after append' }),
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'failed',
      promptError: 'retry failed after append',
    });
  });

  it('uses appended alias status-only completions as the latest runtime result', () => {
    expect(readRuntimeRunCompletionFromLog([
      JSON.stringify({ status: 'failed', summary: 'stale failed completion' }),
      JSON.stringify({ status: 'ok', summary: 'retry succeeded' }),
    ].join('\n'))).toMatchObject({
      status: 'succeeded',
      summary: 'retry succeeded',
    });

    expect(readRuntimeRunCompletionFromLog([
      JSON.stringify({ status: 'ok', summary: 'stale successful completion' }),
      JSON.stringify({ status: 'error', summary: 'retry failed' }),
    ].join('\n'))).toMatchObject({
      status: 'failed',
      summary: 'retry failed',
    });

    expect(readRuntimeRunCompletionFromLog([
      JSON.stringify({ status: 'ok', summary: 'stale successful completion' }),
      JSON.stringify({ status: 'timeout', summary: 'retry timed out' }),
    ].join('\n'))).toMatchObject({
      status: 'timed_out',
      summary: 'retry timed out',
    });
  });

  it('uses appended result status-only completions as the latest runtime result', () => {
    expect(readRuntimeRunCompletionFromLog([
      JSON.stringify({ status: 'failed', summary: 'stale failed completion' }),
      JSON.stringify({ result: { status: 'ok', summary: 'retry succeeded' } }),
    ].join('\n'))).toMatchObject({
      status: 'succeeded',
      summary: 'retry succeeded',
    });

    expect(readRuntimeRunCompletionFromLog([
      JSON.stringify({ status: 'failed', summary: 'stale failed completion' }),
      JSON.stringify({ result: { status: 'in_flight', summary: 'retry is active' } }),
    ].join('\n'))).toMatchObject({
      status: 'running',
      summary: 'retry is active',
    });
  });

  it('uses appended queued and running status-only completions as the latest runtime result', () => {
    expect(readRuntimeRunCompletionFromLog([
      JSON.stringify({ status: 'failed', summary: 'stale failed completion' }),
      JSON.stringify({ status: 'running' }),
    ].join('\n'))).toMatchObject({
      status: 'running',
    });

    expect(readRuntimeRunCompletionFromLog([
      JSON.stringify({ status: 'failed', summary: 'stale failed completion' }),
      JSON.stringify({ status: 'queued' }),
    ].join('\n'))).toMatchObject({
      status: 'queued',
    });
  });

  it('does not use prefixed diagnostic completion fragments as runtime completions', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
        summary: 'real completion',
      }),
      `diag: ${JSON.stringify({ status: 'failed', completion: { finishReason: 'stop' }, summary: 'quoted diagnostic failure' })}`,
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'succeeded',
      outcome: 'implemented',
      summary: 'real completion',
    });
  });

  it('does not use appended diagnostic JSON fragments as runtime completions', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
        summary: 'real completion',
      }),
      'tool result quoted target log:',
      JSON.stringify({ status: 'failed', summary: 'quoted diagnostic failure' }),
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'succeeded',
      outcome: 'implemented',
      summary: 'real completion',
    });
  });

  it('does not use appended result-only diagnostic JSON fragments as runtime completions', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
        summary: 'real completion',
      }),
      'tool result quoted target log:',
      JSON.stringify({ result: { status: 'failed', summary: 'quoted result diagnostic failure' } }),
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'succeeded',
      outcome: 'implemented',
      summary: 'real completion',
    });
  });

  it('does not use appended empty completion diagnostic fragments as runtime completions', () => {
    const raw = [
      JSON.stringify({
        status: 'ok',
        finalAssistantVisibleText: 'Outcome: implemented',
        summary: 'real completion',
      }),
      'tool result quoted target log:',
      JSON.stringify({ status: 'failed', completion: {}, summary: 'quoted empty completion failure' }),
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'succeeded',
      outcome: 'implemented',
      summary: 'real completion',
    });
  });

  it('keeps nested JSON payload objects from replacing the top-level completion', () => {
    const raw = [
      'banner',
      JSON.stringify({
        finalAssistantVisibleText: 'Outcome: implemented',
        executionTrace: { result: 'success' },
        completion: { finishReason: 'stop' },
        payloads: [{ status: 'failed', summary: 'nested tool result' }],
      }),
      'footer',
    ].join('\n');

    expect(readRuntimeRunCompletionFromLog(raw)).toMatchObject({
      status: 'succeeded',
      outcome: 'implemented',
    });
  });

  it('detects running task attempts and creates stable resume attempt ids', () => {
    const task: RuntimeAgentTask = {
      id: 'agent_task_reirei-lab-rainrail_22',
      title: 'OpenClaw runtime',
      agentSessionId: 'agent:main:session',
      branchName: 'agent/reirei-lab-rainrail-22',
      logPath: 'var/log/task.log',
      pid: 111,
      resumeAttempts: [
        { id: 'agent_task_reirei-lab-rainrail_22_resume_01', status: 'stopped', logPath: 'resume-1.log' },
        { id: 'agent_task_reirei-lab-rainrail_22_resume_02', status: 'running', pid: 222, logPath: 'resume-2.log' },
      ],
    };

    expect(runningRuntimeTaskPid(task, (pid) => pid === 222)).toBe(222);
    expect(nextRuntimeResumeAttemptId(task)).toMatch(/^agent_task_reirei-lab-rainrail_22_agent_main_session_[a-f0-9]{12}_[a-f0-9]{12}_resume_03$/);
  });

  it('keeps resume attempt ids distinct for the same issue task in different sessions', () => {
    const first = nextRuntimeResumeAttemptId({
      id: 'agent_task_reirei-lab-rainrail_22',
      agentSessionId: 'agent:main:run-a',
      resumeAttempts: [],
    });
    const second = nextRuntimeResumeAttemptId({
      id: 'agent_task_reirei-lab-rainrail_22',
      agentSessionId: 'agent:main:run-b',
      resumeAttempts: [],
    });

    expect(first).toContain('run-a');
    expect(second).toContain('run-b');
    expect(first).not.toBe(second);
  });

  it('keeps resume attempt ids distinct for session keys that normalize to the same name', () => {
    const first = nextRuntimeResumeAttemptId({
      id: 'agent_task_reirei-lab-rainrail_22',
      agentSessionId: 'agent:main:foo',
      resumeAttempts: [],
    });
    const second = nextRuntimeResumeAttemptId({
      id: 'agent_task_reirei-lab-rainrail_22',
      agentSessionId: 'agent_main_foo',
      resumeAttempts: [],
    });

    expect(first).not.toBe(second);
  });

  it('keeps long resume attempt ids within common filename limits', () => {
    const longTaskId = `agent_task_${'very-long-owner-name-'.repeat(5)}${'very-long-repository-name-'.repeat(5)}_issue_${'1234567890'.repeat(6)}`;
    const longSessionId = `agent:main:${longTaskId}:${'uuid-'.repeat(30)}`;
    const attemptId = nextRuntimeResumeAttemptId({
      id: longTaskId,
      agentSessionId: longSessionId,
      resumeAttempts: Array.from({ length: 98 }, (_, index) => ({
        id: `attempt-${index + 1}`,
        status: 'stopped',
        logPath: `resume-${index + 1}.log`,
      })),
    });

    expect(Buffer.byteLength(`${attemptId}.log`, 'utf8')).toBeLessThanOrEqual(180);
    expect(attemptId).toMatch(/_[a-f0-9]{12}_[a-f0-9]{12}_resume_99$/);
  });
});

function temporaryDirectory(): string {
  const directory = join(tmpdir(), `rainrail-agent-runtime-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

function testSafeLogFileName(value: string): string {
  return `${value.replace(/[^A-Za-z0-9._-]/g, '_')}_${createHash('sha256').update(value).digest('hex').slice(0, 12)}`;
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function runtimeRequest(overrides: { agentSessionId?: string | null; deliveryId?: string; taskId?: string } = {}) {
  const event = createEventEnvelope({
    source: { type: 'github', name: 'github-project', repository: 'reirei-lab/rainrail' },
    name: 'github.issue',
    delivery: { id: overrides.deliveryId ?? 'delivery-22', receivedAt: '2026-06-30T15:07:29.000Z' },
    occurredAt: '2026-06-30T15:07:29.000Z',
    subject: { type: 'issue', id: '22' },
    payload: { action: 'queued' },
    rawPayload: { kind: 'external-reference', reference: 'github://issues/22' },
  });
  return {
    workflow: 'project-issue-selection',
    event,
    requestedBy: 'reirei-agent',
    task: {
      id: overrides.taskId ?? 'agent_task_reirei-lab-rainrail_22',
      title: 'OpenClaw runtime',
      ...(overrides.agentSessionId === null
        ? {}
        : { agentSessionId: overrides.agentSessionId ?? 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22' }),
      branchName: 'agent/reirei-lab-rainrail-22-openclaw-runtime-run-22',
      issue: {
        id: 'item_22',
        title: 'OpenClaw runtime',
        assigneeLogins: ['reirei-agent'],
        repository: 'reirei-lab/rainrail',
        number: 22,
        url: 'https://github.com/reirei-lab/rainrail/issues/22',
      },
    },
  };
}

function safeRuntimeLogFileName(value: string): string {
  const safe = value.replace(/[^A-Za-z0-9._-]/g, '_');
  const hash = createHash('sha256').update(value).digest('hex').slice(0, 12);
  return `${safe.length <= 140 ? safe : `${safe.slice(0, 127)}_${hash}`}_${hash}`;
}
