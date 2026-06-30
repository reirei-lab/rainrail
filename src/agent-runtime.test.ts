import { mkdirSync, rmSync } from 'node:fs';
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
});

describe('runtime task completion and resume helpers', () => {
  it('classifies successful Codex completion payloads and compaction failures', () => {
    expect(readRuntimeRunCompletionFromLog(JSON.stringify({
      finalAssistantVisibleText: 'Outcome: implemented',
      executionTrace: { result: 'success' },
      completion: { finishReason: 'stop' },
    }))).toMatchObject({ status: 'succeeded', outcome: 'implemented' });

    expect(readRuntimeRunCompletionFromLog(
      'GatewayClientRequestError: Error: CLI transcript compaction failed for openai/gpt-5.5: Compaction timed out',
    )).toMatchObject({
      status: 'compaction_failed',
      summary: expect.stringContaining('Compaction timed out'),
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
    expect(nextRuntimeResumeAttemptId(task)).toBe('agent_task_reirei-lab-rainrail_22_resume_03');
  });
});

function temporaryDirectory(): string {
  const directory = join(tmpdir(), `rainrail-agent-runtime-${crypto.randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  temporaryDirectories.push(directory);
  return directory;
}

function runtimeRequest() {
  const event = createEventEnvelope({
    source: { type: 'github', name: 'github-project', repository: 'reirei-lab/rainrail' },
    name: 'github.issue',
    delivery: { id: 'delivery-22', receivedAt: '2026-06-30T15:07:29.000Z' },
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
      agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_22-run-22',
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
