import { describe, expect, it } from 'vitest';

import { handleConflictCheckEvent } from './pr-lifecycle.js';
import { handoffRecorder, pullRequest, pushEvent } from './pr-lifecycle-test-helpers.js';

describe('handleConflictCheckEvent', () => {
  it('returns conflicted task issues to Todo and removes pending review requests', async () => {
    const removed: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleConflictCheckEvent(pushEvent(), {
      tasks: handoffRecorder(),
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
            pullRequest({ mergeable: 'CONFLICTING', reviewRequests: ['hiragram'] }),
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
    expect(removed).toEqual([{ repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' }]);
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
});
