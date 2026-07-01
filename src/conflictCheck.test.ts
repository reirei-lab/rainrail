import { describe, expect, it } from 'vitest';

import { handleConflictCheckEvent } from './pr-lifecycle.js';
import { handoffRecorder, pullRequest, pushEvent } from './pr-lifecycle-test-helpers.js';

describe('handleConflictCheckEvent', () => {
  it('returns conflicted task issues to Todo and removes pending review requests', async () => {
    const removed: Array<{ repository: string; number: number; reviewerLogin: string }> = [];
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleConflictCheckEvent(pushEvent(), {
      tasks: handoffRecorder({ updates }),
      reviewRequest: { enabled: true, reviewerLogin: 'hiragram' },
      delayMs: 0,
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async findOpenPullRequestsByBase(input) {
          expect(input).toEqual({ repository: 'reirei-lab/rainrail', baseRefName: 'main' });
          return [
            pullRequest({ mergeStateStatus: 'DIRTY', reviewRequests: ['hiragram'] }),
            pullRequest({ number: 45, headRefName: 'agent/clean', mergeable: 'MERGEABLE' }),
          ];
        },
        async requestReview() {
          throw new Error('not used');
        },
        async removeReviewRequest(input) {
          removed.push(input);
        },
      },
    });

    expect(result).toMatchObject({
      handled: true,
      reason: 'conflicting pull requests returned to Todo',
      baseRefName: 'main',
      checkedPullRequests: 2,
    });
    expect(updates[0]?.commentBody).toContain('Rainrail detected that the agent PR has merge conflicts.');
    expect(updates[0]?.commentBody).toContain('Outcome: conflict');
    expect(removed).toEqual([{ repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' }]);
  });

  it('does not return fork pull requests to Todo when only the branch name matches', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleConflictCheckEvent(pushEvent(), {
      tasks: handoffRecorder({ updates }),
      delayMs: 0,
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async findOpenPullRequestsByBase() {
          return [pullRequest({ mergeStateStatus: 'DIRTY', headRepository: 'external/fork' })];
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('conflicting pull requests had no matching claimed agent tasks');
    expect(updates).toEqual([]);
  });

  it('retries when open PR mergeability is still being calculated', async () => {
    await expect(handleConflictCheckEvent(pushEvent(), {
      tasks: handoffRecorder(),
      delayMs: 0,
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async findOpenPullRequestsByBase() {
          return [pullRequest({ mergeable: 'UNKNOWN' })];
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    })).rejects.toThrow('pull request mergeability is still being calculated');
  });

  it('retries even when some open PRs are already known conflicts', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    await expect(handleConflictCheckEvent(pushEvent(), {
      tasks: handoffRecorder({ updates }),
      delayMs: 0,
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async findOpenPullRequestsByBase() {
          return [
            pullRequest({ mergeStateStatus: 'DIRTY' }),
            pullRequest({ number: 45, headRefName: 'agent/pending', mergeable: 'UNKNOWN' }),
          ];
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    })).rejects.toThrow('pull request mergeability is still being calculated');
    expect(updates).toEqual([]);
  });

  it('does not treat branch-protection blocked pull requests as conflicts', async () => {
    const result = await handleConflictCheckEvent(pushEvent(), {
      tasks: handoffRecorder(),
      delayMs: 0,
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async findOpenPullRequestsByBase() {
          return [pullRequest({ mergeable: 'BLOCKED', mergeStateStatus: 'BLOCKED' })];
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('no conflicting pull requests target the pushed branch');
  });
});
