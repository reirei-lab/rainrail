import { describe, expect, it } from 'vitest';

import type { AgentTaskHandoffClient } from './pr-lifecycle.js';
import { handleCheckFailureEvent } from './pr-lifecycle.js';
import { checkRunEvent, handoffRecorder, pullRequest, statusEvent, task } from './pr-lifecycle-test-helpers.js';

describe('handleCheckFailureEvent', () => {
  it('comments on the issue and returns it to Todo when an agent PR check fails', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
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

  it('removes stale pending review requests when failed checks return the issue to Todo', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const removedReviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      reviewRequest: { reviewerLogin: 'hiragram' },
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
        async getPullRequest() {
          return pullRequest({
            reviewRequests: ['hiragram'],
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
        async removeReviewRequest(input) {
          removedReviewRequests.push(input);
        },
      },
    });

    expect(result).toMatchObject({ reason: 'failed PR checks returned issue to Todo', reviewRequestRemoved: true });
    expect(removedReviewRequests).toEqual([
      { repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' },
    ]);
  });

  it('keeps the failed-check handoff successful when stale review request cleanup fails', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      reviewRequest: { reviewerLogin: 'hiragram' },
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
        async getPullRequest() {
          return pullRequest({
            reviewRequests: ['hiragram'],
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
        async removeReviewRequest() {
          throw new Error('review request already gone');
        },
      },
    });

    expect(result).toMatchObject({ reason: 'failed PR checks returned issue to Todo' });
    expect(result).not.toHaveProperty('reviewRequestRemoved');
    expect(updates).toHaveLength(1);
  });

  it('treats completed startup_failure check runs as current failures', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'startup_failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
        async getPullRequest() {
          return pullRequest({
            statusCheckRollup: [
              { type: 'CheckRun', name: 'Typecheck, Test, Build', status: 'COMPLETED', conclusion: 'startup_failure' },
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

    expect(result.reason).toBe('failed PR checks returned issue to Todo');
    expect(updates).toHaveLength(1);
  });

  it('treats the failed check event as current when the live rollup is still empty', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure', headSha: 'abc123' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
        async getPullRequest(input) {
          return pullRequest({ ...input, headSha: 'abc123', statusCheckRollup: [] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('failed PR checks returned issue to Todo');
    expect(updates).toHaveLength(1);
  });

  it('treats the failed check event as current while the live rollup is still pending', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure', headSha: 'abc123' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            headSha: 'abc123',
            statusCheckRollup: [
              { type: 'CheckRun', name: 'Typecheck, Test, Build', status: 'IN_PROGRESS' },
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

    expect(result.reason).toBe('failed PR checks returned issue to Todo');
    expect(updates).toHaveLength(1);
  });

  it('continues past non-agent check_run PRs and returns a later agent PR issue to Todo', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({
      conclusion: 'failure',
      pullRequests: [{ number: 45 }, { number: 44 }],
    }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
        async getPullRequest(input) {
          return input.number === 45
            ? pullRequest({ ...input, authorLogin: 'someone-else', headRefName: 'feature/manual' })
            : pullRequest({
                ...input,
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

    expect(result.reason).toBe('failed PR checks returned issue to Todo');
    expect(updates).toHaveLength(1);
  });

  it('continues past failed candidates that no longer have a matching task', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({
      conclusion: 'failure',
      pullRequests: [{ number: 45 }, { number: 44 }],
    }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            headRefName: input.number === 45 ? 'agent/released-task' : 'agent/test-pr',
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

    expect(result.reason).toBe('failed PR checks returned issue to Todo');
    expect(updates).toHaveLength(1);
  });

  it('returns every failed same-SHA pull request issue to Todo', async () => {
    const updates: string[] = [];

    const result = await handleCheckFailureEvent(checkRunEvent({
      conclusion: 'failure',
      pullRequests: [{ number: 45 }],
      headSha: 'abc123',
    }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: branchTaskRecorder(updates),
      pullRequests: {
        kind: 'pull-request-provider' as const,
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            headRefName: 'agent/first-pr',
            statusCheckRollup: [
              { type: 'CheckRun', name: 'Typecheck, Test, Build', status: 'COMPLETED', conclusion: 'FAILURE' },
            ],
          });
        },
        async findPullRequestsByHead(input) {
          expect(input).toMatchObject({ repository: 'reirei-lab/rainrail', headSha: 'abc123' });
          return [pullRequest({
            number: 44,
            headRefName: 'agent/second-pr',
            statusCheckRollup: [
              { type: 'CheckRun', name: 'Typecheck, Test, Build', status: 'COMPLETED', conclusion: 'FAILURE' },
            ],
          })];
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('failed PR checks returned issue to Todo');
    expect(updates).toEqual(['agent/first-pr', 'agent/second-pr']);
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
        kind: 'pull-request-provider' as const,
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
        kind: 'pull-request-provider' as const,
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

  it('retries failed check events while the live rollup still shows an old success', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    await expect(handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
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
    })).rejects.toThrow('pull request checks are still being reflected');

    expect(updates).toEqual([]);
  });

  it('ignores failed checks for fork pull requests that only match the agent branch prefix', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCheckFailureEvent(checkRunEvent({ conclusion: 'failure' }), {
      agentLogin: 'reirei-agent',
      branchPrefix: 'agent/',
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        kind: 'pull-request-provider' as const,
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
        kind: 'pull-request-provider' as const,
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

function branchTaskRecorder(updates: string[]): AgentTaskHandoffClient {
  return {
    getAgentTaskByBranchName(branchName) {
      return {
        ...task,
        id: `task:${branchName}`,
        branchName,
      };
    },
    async returnTaskToTodo(input) {
      updates.push(input.task.branchName);
      return {
        projectItemId: input.task.claim?.projectItemId ?? 'PVTI_item',
        status: 'Todo',
        commentUrl: 'https://github.com/reirei-lab/rainrail/issues/23#issuecomment-1',
      };
    },
  };
}
