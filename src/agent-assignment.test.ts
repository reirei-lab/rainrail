import { describe, expect, it, vi } from 'vitest';

import { assignNextProjectIssueToAgent } from './agent-assignment.js';
import type { ProjectIssue } from './project-issues.js';

describe('assignNextProjectIssueToAgent', () => {
  it('claims the next task queue issue before dispatching an agent', async () => {
    const calls: string[] = [];
    const issue = projectIssue({ number: 21, title: 'Project issue selection' });
    const claimProjectIssue = vi.fn(async () => {
      calls.push('claim');
      return { projectItemId: 'item_21', commentUrl: 'https://github.com/reirei-lab/rainrail/issues/21#issuecomment-1' };
    });
    const dispatchAgent = vi.fn(async () => {
      calls.push('dispatch');
      return { sessionKey: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_21' };
    });

    await expect(assignNextProjectIssueToAgent({
      queue: {
        name: 'github-project',
        kind: 'task-queue-provider',
        listProjectIssues: async () => [issue],
        claimProjectIssue,
      },
      runtime: {
        runId: 'run-21',
        workflow: 'project-issue-selection',
        agentId: 'main',
        sessionKeyPrefix: 'rainrail',
        dispatchAgent,
      },
    })).resolves.toMatchObject({
      assigned: true,
      reason: 'started',
      task: {
        id: 'agent_task_reirei-lab-rainrail_21',
        agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_21',
        branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      },
    });
    expect(calls).toEqual(['claim', 'dispatch']);
    expect(claimProjectIssue).toHaveBeenCalledWith(expect.objectContaining({
      issue,
      agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      commentBody: expect.stringContaining('started an agent to process this issue'),
    }));
  });

  it('releases a claimed issue when dispatch fails', async () => {
    const issue = projectIssue({ number: 21, title: 'Project issue selection' });
    const claim = { projectItemId: 'item_21' };
    const releaseProjectIssue = vi.fn(async () => undefined);

    await expect(assignNextProjectIssueToAgent({
      queue: {
        name: 'github-project',
        kind: 'task-queue-provider',
        listProjectIssues: async () => [issue],
        claimProjectIssue: async () => claim,
        releaseProjectIssue,
      },
      runtime: {
        runId: 'run-21',
        workflow: 'project-issue-selection',
        agentId: 'main',
        sessionKeyPrefix: 'rainrail',
        dispatchAgent: async () => {
          throw new Error('runtime unavailable');
        },
      },
    })).resolves.toMatchObject({
      assigned: false,
      reason: 'failed_to_start_agent',
      task: {
        claim,
        error: 'runtime unavailable',
      },
    });
    expect(releaseProjectIssue).toHaveBeenCalledWith({
      issue,
      claim,
      agentSessionId: 'agent:main:rainrail-agent_task_reirei-lab-rainrail_21',
      branchName: 'agent/reirei-lab-rainrail-21-project-issue-selection',
      reason: 'runtime unavailable',
    });
  });

  it('does not claim or dispatch when an in-progress issue blocks startup', async () => {
    const claimProjectIssue = vi.fn();
    const dispatchAgent = vi.fn();

    await expect(assignNextProjectIssueToAgent({
      queue: {
        name: 'github-project',
        kind: 'task-queue-provider',
        listProjectIssues: async () => [
          projectIssue({ number: 21, status: 'Todo' }),
          projectIssue({ id: 'item_20', number: 20, status: 'In Progress' }),
        ],
        claimProjectIssue,
      },
      runtime: {
        runId: 'run-21',
        workflow: 'project-issue-selection',
        agentId: 'main',
        sessionKeyPrefix: 'rainrail',
        dispatchAgent,
      },
    })).resolves.toMatchObject({
      assigned: false,
      reason: 'blocked_by_in_progress',
    });
    expect(claimProjectIssue).not.toHaveBeenCalled();
    expect(dispatchAgent).not.toHaveBeenCalled();
  });

  it('does not claim or dispatch a closed issue', async () => {
    const claimProjectIssue = vi.fn();
    const dispatchAgent = vi.fn();

    await expect(assignNextProjectIssueToAgent({
      queue: {
        name: 'github-project',
        kind: 'task-queue-provider',
        listProjectIssues: async () => [
          projectIssue({ state: 'CLOSED', status: 'Todo' }),
        ],
        claimProjectIssue,
      },
      runtime: {
        runId: 'run-21',
        workflow: 'project-issue-selection',
        agentId: 'main',
        sessionKeyPrefix: 'rainrail',
        dispatchAgent,
      },
    })).resolves.toMatchObject({
      assigned: false,
      reason: 'no_todo_issue',
    });
    expect(claimProjectIssue).not.toHaveBeenCalled();
    expect(dispatchAgent).not.toHaveBeenCalled();
  });
});

function projectIssue(overrides: Partial<ProjectIssue> = {}): ProjectIssue {
  return {
    id: 'item_21',
    contentId: 'issue_node_21',
    contentType: 'Issue',
    title: 'Issue title',
    state: 'OPEN',
    status: 'Todo',
    assigneeLogins: ['reirei-agent'],
    repository: 'reirei-lab/rainrail',
    number: 21,
    url: 'https://github.com/reirei-lab/rainrail/issues/21',
    ...overrides,
  };
}
