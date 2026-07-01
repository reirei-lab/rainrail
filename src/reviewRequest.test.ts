import { describe, expect, it } from 'vitest';

import { handleReviewRequestEvent } from './pr-lifecycle.js';
import { checkRunEvent, pullRequest } from './pr-lifecycle-test-helpers.js';

describe('handleReviewRequestEvent', () => {
  it('requests a review for an agent PR when all checks pass', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest(input);
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview(input) {
          reviewRequests.push(input);
        },
      },
    });

    expect(result).toMatchObject({ handled: true, reason: 'review_requested' });
    expect(reviewRequests).toEqual([
      { repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' },
    ]);
  });

  it('does not request twice while a reviewer request is already pending', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ reviewRequests: ['hiragram'] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('review was already requested');
    expect(requestCount).toBe(0);
  });
});
