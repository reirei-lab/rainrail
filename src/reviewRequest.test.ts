import { describe, expect, it } from 'vitest';

import { handleReviewRequestEvent } from './pr-lifecycle.js';
import { checkRunEvent, pullRequest, pullRequestEvent, reviewEvent, statusEvent } from './pr-lifecycle-test-helpers.js';

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

  it('continues past non-agent check_run PRs and requests review for a later agent PR', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(checkRunEvent({ pullRequests: [{ number: 45 }, { number: 44 }] }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return input.number === 45
            ? pullRequest({ ...input, authorLogin: 'someone-else', headRefName: 'feature/manual', reviews: [] })
            : pullRequest({ ...input, reviews: [] });
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

  it('retries ready_for_review while the live draft state is not reflected yet', async () => {
    await expect(handleReviewRequestEvent(pullRequestEvent({ action: 'ready_for_review' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, isDraft: true });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    })).rejects.toThrow('pull request draft state is still being reflected');
  });

  it('ignores pull request review_requested events for other reviewers', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(pullRequestEvent({
      action: 'review_requested',
      requestedReviewer: 'someone-else',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('event is not a completed successful check for a pull request');
    expect(requestCount).toBe(0);
  });

  it('requests review when another reviewer approval resolves the last change request blocker', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(reviewEvent({
      state: 'approved',
      reviewerLogin: 'codex',
      reviewCommitId: 'abc123',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            reviews: [{ authorLogin: 'codex', state: 'APPROVED', commitId: 'abc123' }],
          });
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

  it('retries review request when a resolution review is not reflected in live reviews yet', async () => {
    await expect(handleReviewRequestEvent(reviewEvent({
      state: 'approved',
      reviewerLogin: 'codex',
      reviewCommitId: 'abc123',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            reviews: [{ authorLogin: 'codex', state: 'CHANGES_REQUESTED', commitId: 'abc123' }],
          });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
      },
    })).rejects.toThrow('pull request reviews are still being reflected');
  });

  it('requests review when a review dismissal resolves the last change request blocker', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(reviewEvent({
      action: 'dismissed',
      state: 'dismissed',
      reviewerLogin: 'codex',
      reviewCommitId: 'abc123',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            reviews: [{ authorLogin: 'codex', state: 'DISMISSED', commitId: 'abc123' }],
          });
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

  it('does not request review again while the configured reviewer approval webhook is not reflected yet', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(reviewEvent({
      state: 'approved',
      reviewerLogin: 'hiragram',
      reviewCommitId: 'abc123',
    }), {
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
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('pull request is already approved by configured reviewer');
    expect(requestCount).toBe(0);
  });

  it('requests review when the configured reviewer dismissal webhook is not reflected yet', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(reviewEvent({
      action: 'dismissed',
      state: 'dismissed',
      reviewerLogin: 'hiragram',
      reviewCommitId: 'abc123',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            reviews: [{ authorLogin: 'hiragram', state: 'APPROVED', commitId: 'abc123' }],
          });
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

  it('does not request review before the current head has any reported checks', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(pullRequestEvent({ action: 'ready_for_review' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, reviews: [], statusCheckRollup: [] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('not all checks have passed');
    expect(requestCount).toBe(0);
  });

  it('retries successful check events while the live rollup is still pending', async () => {
    await expect(handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            reviews: [],
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
    })).rejects.toThrow('pull request checks are still being reflected');
  });

  it('retries successful check events while the live rollup still shows an old failure', async () => {
    await expect(handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({
            ...input,
            reviews: [],
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
    })).rejects.toThrow('pull request checks are still being reflected');
  });

  it('retries unreflected same-SHA candidates before requesting review', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    await expect(handleReviewRequestEvent(checkRunEvent({
      pullRequests: [{ number: 45 }, { number: 44 }],
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return input.number === 45
            ? pullRequest({
                ...input,
                headRefName: 'agent/pending-pr',
                reviews: [],
                statusCheckRollup: [],
              })
            : pullRequest({ ...input, reviews: [] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview(input) {
          reviewRequests.push(input);
        },
      },
    })).rejects.toThrow('pull request checks are still being reflected');

    expect(reviewRequests).toEqual([]);
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

  it('continues past candidates that already have a pending review request', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(checkRunEvent({ pullRequests: [{ number: 45 }, { number: 44 }] }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return input.number === 45
            ? pullRequest({ ...input, headRefName: 'agent/other-pr', reviewRequests: ['hiragram'], reviews: [] })
            : pullRequest({ ...input, reviews: [] });
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

  it('requests review for every eligible same-SHA pull request candidate', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(checkRunEvent({ pullRequests: [{ number: 45 }], headSha: 'abc123' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, headRefName: 'agent/first-pr', reviews: [] });
        },
        async findPullRequestsByHead(input) {
          expect(input).toMatchObject({ repository: 'reirei-lab/rainrail', headSha: 'abc123' });
          return [pullRequest({ number: 44, headRefName: 'agent/second-pr', reviews: [] })];
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
      { repository: 'reirei-lab/rainrail', number: 45, reviewerLogin: 'hiragram' },
      { repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' },
    ]);
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

  it('does not request review for fork pull requests that only match the agent branch prefix', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ headRepository: 'external/fork', reviews: [] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('pull request is not an agent-authored target');
    expect(requestCount).toBe(0);
  });

  it('does not request review for pull requests that are no longer open', async () => {
    let requestCount = 0;

    const result = await handleReviewRequestEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ state: 'CLOSED', reviews: [] });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          requestCount += 1;
        },
      },
    });

    expect(result.reason).toBe('pull request is not open');
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

  it('requests review again when the last change request was for an old head', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(checkRunEvent({ headSha: 'new-sha' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          const target = pullRequest({
            ...input,
            headSha: 'new-sha',
            reviews: [{ authorLogin: 'hiragram', state: 'CHANGES_REQUESTED', commitId: 'old-sha' }],
          });
          delete target.reviewDecision;
          return target;
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

  it('does not expand PR-specific review request events by head SHA', async () => {
    const reviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleReviewRequestEvent(pullRequestEvent({ action: 'ready_for_review' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, reviews: [] });
        },
        async findPullRequestsByHead() {
          throw new Error('not used');
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
