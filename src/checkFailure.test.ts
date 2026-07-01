import { describe, expect, it } from 'vitest';

import { handleCheckFailureEvent } from './pr-lifecycle.js';
import { checkRunEvent, handoffRecorder, pullRequest, statusEvent } from './pr-lifecycle-test-helpers.js';

describe('handleCheckFailureEvent', () => {
  it('comments on the issue and returns it to Todo when an agent PR check fails', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          return pullRequest({
            statusCheckRollup: [
              { type: 'CheckRun', name: 'Typecheck, Test, Build', status: 'COMPLETED', conclusion: 'FAILURE' },
            ],
          });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result).toMatchObject({
      handled: true,
      reason: 'failed PR checks returned issue to Todo',
      taskId: 'agent_task_1',
    });
    expect(updates[0]?.commentBody).toContain('- Check: Typecheck, Test, Build');
    expect(updates[0]?.commentBody).toContain('Outcome: checks_failed');
  });

  it('ignores successful checks', async () => {
    const result = await handleCheckFailureEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder(),
    });

    expect(result.reason).toBe('event is not a completed failed check for a pull request');
  });

  it('ignores stale failed checks from old pull request heads', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure', headSha: 'old-sha' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ headSha: 'new-sha' });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('check does not match the current pull request head');
    expect(updates).toEqual([]);
  });

  it('ignores failed checks for pull requests that are no longer open', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ state: 'CLOSED' });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('pull request is not open');
    expect(updates).toEqual([]);
  });

  it('ignores old failed check events once the live rollup has passed', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          return pullRequest();
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('current pull request checks have passed');
    expect(updates).toEqual([]);
  });

  it('ignores failed checks for fork pull requests that only match the agent branch prefix', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ headRepository: 'external/fork' });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('pull request is not an agent-authored target');
    expect(updates).toEqual([]);
  });

  it('returns issues to Todo from failed commit status events', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(statusEvent({ state: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead(input) {
          expect(input).toMatchObject({ repository: 'reirei-lab/rainrail', headSha: 'abc123' });
          return pullRequest({
            statusCheckRollup: [
              { type: 'StatusContext', name: 'legacy-ci', state: 'failure' },
            ],
          });
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('failed PR checks returned issue to Todo');
    expect(updates[0]?.commentBody).toContain('- Check: legacy-ci');
  });

  it('does not return issues to Todo from pending commit status events', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(statusEvent({ state: 'pending' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('event is not a completed failed check for a pull request');
    expect(updates).toEqual([]);
  });
});
