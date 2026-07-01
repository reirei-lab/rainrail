import { describe, expect, it } from 'vitest';

import { handleCodexReviewEvent } from './pr-lifecycle.js';
import { handoffRecorder, pullRequest, reviewEvent } from './pr-lifecycle-test-helpers.js';

describe('handleCodexReviewEvent', () => {
  it('returns the matching issue to Todo with inline Codex review comments', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const result = await handleCodexReviewEvent(reviewEvent({ state: 'commented' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async listReviewComments() {
          return [
            { id: 1, reviewId: 111, path: 'src/old.ts', body: 'old comment' },
            {
              id: 2,
              reviewId: 4493317816,
              path: 'src/pr-lifecycle.ts',
              line: 42,
              body: 'Please handle this inline comment.',
              url: 'https://github.com/reirei-lab/rainrail/pull/44#discussion_r2',
              commitId: 'abc123',
            },
          ];
        },
      },
    });

    expect(result).toMatchObject({
      handled: true,
      reason: 'Codex review returned issue to Todo',
      taskId: 'agent_task_1',
      status: 'Todo',
    });
    expect(updates[0]?.commentBody).toContain('Codex inline review comments:');
    expect(updates[0]?.commentBody).toContain('src/pr-lifecycle.ts:42');
    expect(updates[0]?.commentBody).toContain('Please handle this inline comment.');
    expect(updates[0]?.commentBody).not.toContain('old comment');
  });

  it('removes stale pending review requests when Codex review returns the issue to Todo', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const removedReviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({ state: 'commented' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      reviewRequest: { reviewerLogin: 'hiragram' },
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, reviewRequests: ['hiragram'] });
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
        async listReviewComments() {
          return [{ id: 2, reviewId: 4493317816, path: 'src/pr-lifecycle.ts', body: 'comment' }];
        },
      },
    });

    expect(result).toMatchObject({ reason: 'Codex review returned issue to Todo', reviewRequestRemoved: true });
    expect(removedReviewRequests).toEqual([
      { repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' },
    ]);
  });

  it('ignores stale Codex reviews for an old pull request head', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({
      state: 'commented',
      headSha: 'new-sha',
      reviewCommitId: 'old-sha',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('review does not match the current pull request head');
    expect(updates).toEqual([]);
  });

  it('prefers the live pull request head over the review payload head when detecting stale Codex reviews', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({
      state: 'commented',
      headSha: 'old-sha',
      reviewCommitId: 'old-sha',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, headSha: 'new-sha' });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async listReviewComments() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('review does not match the current pull request head');
    expect(updates).toEqual([]);
  });

  it('does not hand off Codex reviews when the live pull request is already closed', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({
      state: 'commented',
      headSha: 'abc123',
      reviewCommitId: 'abc123',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, state: 'CLOSED', headSha: 'abc123' });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async listReviewComments() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('pull request is already closed');
    expect(updates).toEqual([]);
  });

  it('checks live pull request head before handing off Codex reviews when payload head is missing', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({
      state: 'commented',
      missingHeadSha: true,
      reviewCommitId: 'old-sha',
    }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest(input) {
          return pullRequest({ ...input, headSha: 'new-sha' });
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async listReviewComments() {
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('review does not match the current pull request head');
    expect(updates).toEqual([]);
  });

  it('accepts normalized GitHub review payloads with string review ids', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({ state: 'commented', stringReviewId: true }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async listReviewComments() {
          return [{ id: 2, reviewId: 4493317816, path: 'src/pr-lifecycle.ts', body: 'comment' }];
        },
      },
    });

    expect(result).toMatchObject({
      handled: true,
      reason: 'Codex review returned issue to Todo',
    });
    expect(updates[0]?.commentBody).toContain('Review ID: 4493317816');
  });

  it('does not require optional GitHub issue content ids', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({ state: 'commented' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({
        updates,
        taskOverride: { issue: { repository: 'reirei-lab/rainrail', number: 23, state: 'OPEN' } },
      }),
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async listReviewComments() {
          return [{ id: 2, reviewId: 4493317816, path: 'src/pr-lifecycle.ts', body: 'comment' }];
        },
      },
    });

    expect(result.reason).toBe('Codex review returned issue to Todo');
    expect(updates[0]?.commentBody).toContain('Codex inline review comments:');
  });

  it('ignores Codex reviews from fork pull requests that only match the agent branch name', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({ headRepository: 'external/fork' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('event is not a Codex review');
    expect(updates).toEqual([]);
  });

  it('marks truncated Codex inline comment summaries as incomplete', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    await handleCodexReviewEvent(reviewEvent({ state: 'commented' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async listReviewComments() {
          return Array.from({ length: 12 }, (_, index) => ({
            id: index + 1,
            reviewId: 4493317816,
            path: `src/file-${index + 1}.ts`,
            body: `comment ${index + 1}`,
          }));
        },
      },
    });

    expect(updates[0]?.commentBody).toContain('Only the first 10 inline comments are shown; 2 more were omitted.');
    expect(updates[0]?.commentBody).toContain('Fetch the full PR review before replying so no inline discussion is missed.');
  });

  it('still returns the issue to Todo when inline comments cannot be loaded', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({ state: 'commented' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest() {
          throw new Error('not used');
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async listReviewComments() {
          throw new Error('boom');
        },
      },
    });

    expect(result.handled).toBe(true);
    expect(updates[0]?.commentBody).toContain('Codex inline review comments could not be loaded automatically: boom');
  });

  it('ignores Codex changes requested reviews so change-request handles the handoff', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({ state: 'changes_requested' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('event is not a Codex review');
    expect(updates).toEqual([]);
  });

  it('ignores Codex approved reviews so auto-merge can handle them', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({ state: 'approved' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      targetRepositories: ['reirei-lab/rainrail'],
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('event is not a Codex review');
    expect(updates).toEqual([]);
  });
});
