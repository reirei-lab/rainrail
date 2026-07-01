import { describe, expect, it } from 'vitest';

import { handleAutoMergeEvent } from './pr-lifecycle.js';
import { pullRequest, reviewEvent } from './pr-lifecycle-test-helpers.js';

describe('handleAutoMergeEvent', () => {
  it('squash merges an agent PR after the configured reviewer approves it', async () => {
    const merges: Array<{ repository: string; number: number; mergeMethod: string }> = [];

    const result = await handleAutoMergeEvent(reviewEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      mergeMethod: 'squash',
      targetRepositories: ['reirei-lab/rainrail'],
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
        async mergePullRequest(input) {
          merges.push(input);
        },
      },
    });

    expect(result).toMatchObject({ handled: true, reason: 'pull_request_merged' });
    expect(merges).toEqual([{ repository: 'reirei-lab/rainrail', number: 44, mergeMethod: 'squash' }]);
  });

  it('requires the repository allow-list before fetching the live PR', async () => {
    let fetchCount = 0;

    const result = await handleAutoMergeEvent(reviewEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      mergeMethod: 'squash',
      targetRepositories: ['reirei-lab/other'],
      pullRequests: {
        async getPullRequest() {
          fetchCount += 1;
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('repository is not an auto-merge target');
    expect(fetchCount).toBe(0);
  });

  it('requires the configured reviewer latest approval instead of aggregate reviewDecision', async () => {
    let mergeCount = 0;

    const result = await handleAutoMergeEvent(reviewEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      mergeMethod: 'squash',
      targetRepositories: ['reirei-lab/rainrail'],
      pullRequests: {
        async getPullRequest() {
          return pullRequest({
            reviewDecision: 'APPROVED',
            reviews: [{ authorLogin: 'hiragram', state: 'CHANGES_REQUESTED' }],
          });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async mergePullRequest() {
          mergeCount += 1;
        },
      },
    });

    expect(result.reason).toBe('configured reviewer approval is not confirmed');
    expect(mergeCount).toBe(0);
  });
});
