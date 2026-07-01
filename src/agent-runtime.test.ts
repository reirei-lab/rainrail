import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

    const first = await provider.startRun(runtimeRequest({
      agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-a',
    }));
    const second = await provider.startRun(runtimeRequest({
      agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-b',
    }));

    expect(first.metadata?.logPath).toContain('run-a');
    expect(second.metadata?.logPath).toContain('run-b');
    expect(first.metadata?.logPath).not.toBe(second.metadata?.logPath);
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
      payloads: [{ text: '修正して PR を更新しました。\n\nOutcome: implemented' }],
      meta: { agentMeta: { sessionId: 'session-1' } },
    }))).toMatchObject({ status: 'succeeded', outcome: 'implemented' });

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
      status: 'needs_human',
      result: {
        status: 'ok',
        payloads: [{ text: 'Outcome: implemented' }],
      },
    }))).toMatchObject({ status: 'needs_human', outcome: 'implemented' });
  });

  it('accepts canonical runtime completion statuses from JSON logs', () => {
    for (const status of ['failed', 'canceled', 'stopped', 'timed_out', 'compaction_failed'] as const) {
      expect(readRuntimeRunCompletionFromLog(JSON.stringify({ status, summary: `${status} run` }))).toMatchObject({
        status,
        summary: `${status} run`,
      });
    }
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
    expect(nextRuntimeResumeAttemptId(task)).toMatch(/^agent_task_reirei-lab-rainrail_22_agent_main_session_[a-f0-9]{12}_resume_03$/);
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
});

function temporaryDirectory(): string {
  const directory = join(tmpdir(), `rainrail-agent-runtime-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

function statMode(path: string): number {
  return statSync(path).mode & 0o777;
}

function runtimeRequest(overrides: { agentSessionId?: string | null; deliveryId?: string } = {}) {
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
      id: 'agent_task_reirei-lab-rainrail_22',
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
