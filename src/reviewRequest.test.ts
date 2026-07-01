import { describe, expect, it } from 'vitest';

import { handleReviewRequestEvent } from './pr-lifecycle.js';
import { checkRunEvent, pullRequest, pullRequestEvent, statusEvent } from './pr-lifecycle-test-helpers.js';

describe('handleReviewRequestEvent', () => {
  it('requests a review for an agent PR when all checks pass', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, reviews: [] });
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

  it('requests a review when the final check completes with a neutral conclusion', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(checkRunEvent({ conclusion: 'neutral' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, reviews: [] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview(input) {
          reviewRequests.push(input);
        },
      },
    });

    expect(result.reason).toBe('review_requested');
    expect(reviewRequests).toEqual([
      { repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' },
    ]);
  });

  it('re-evaluates review requests when a draft PR becomes ready for review', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(pullRequestEvent({ action: 'ready_for_review' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, reviews: [] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview(input) {
          reviewRequests.push(input);
        },
      },
    });

    expect(result.reason).toBe('review_requested');
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
          return pullRequest({ reviewRequests: ['hiragram'], reviews: [] });
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

  it('does not request review when the configured reviewer already approved the current head', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ reviews: [{ authorLogin: 'hiragram', state: 'APPROVED', commitId: 'abc123' }] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('pull request is already approved by configured reviewer');
    expect(requestCount).toBe(0);
  });

  it('does not request review while the latest review still requests changes', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          const target = pullRequest({ reviews: [{ authorLogin: 'hiragram', state: 'CHANGES_REQUESTED' }] });
          delete target.reviewDecision;
          return target;
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('pull request has unresolved change requests');
    expect(requestCount).toBe(0);
  });

  it('keeps unresolved changes requested per reviewer latest state', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          const target = pullRequest({
            reviews: [
              { authorLogin: 'reviewer-a', state: 'CHANGES_REQUESTED' },
              { authorLogin: 'reviewer-b', state: 'APPROVED' },
            ],
          });
          delete target.reviewDecision;
          return target;
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('pull request has unresolved change requests');
    expect(requestCount).toBe(0);
  });

  it('requests review from successful commit status events', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(statusEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead(input) {
          expect(input).toMatchObject({ repository: 'reirei-lab/rainrail', headSha: 'abc123' });
          return pullRequest({ reviews: [] });
        },
        async requestReview(input) {
          reviewRequests.push(input);
        },
      },
    });

    expect(result.reason).toBe('review_requested');
    expect(reviewRequests).toEqual([{ repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' }]);
  });

  it('reads normalized commit status state from the resource', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(statusEvent({ normalizedResourceOnly: true }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead(input) {
          expect(input).toMatchObject({ repository: 'reirei-lab/rainrail', headSha: 'abc123' });
          return pullRequest({ reviews: [] });
        },
        async requestReview(input) {
          reviewRequests.push(input);
        },
      },
    });

    expect(result.reason).toBe('review_requested');
    expect(reviewRequests).toEqual([{ repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' }]);
  });

  it('ignores stale successful checks from old pull request heads', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(checkRunEvent({ headSha: 'old-sha' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ headSha: 'new-sha' });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('check does not match the current pull request head');
    expect(requestCount).toBe(0);
  });

  it('keeps changes requested when a later comment review is submitted by the same reviewer', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          const target = pullRequest({
            reviews: [
              { authorLogin: 'hiragram', state: 'CHANGES_REQUESTED' },
              { authorLogin: 'hiragram', state: 'COMMENTED' },
            ],
          });
          delete target.reviewDecision;
          return target;
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('pull request has unresolved change requests');
    expect(requestCount).toBe(0);
  });
});
