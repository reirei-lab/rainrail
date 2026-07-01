import { describe, expect, it } from 'vitest';

import { handleCodexReviewEvent } from './pr-lifecycle.js';
import { handoffRecorder, reviewEvent } from './pr-lifecycle-test-helpers.js';

describe('handleCodexReviewEvent', () => {
  it('returns the matching issue to Todo with inline Codex review comments', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const result = await handleCodexReviewEvent(reviewEvent(), {
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

  it('accepts normalized GitHub review payloads with string review ids', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent({ stringReviewId: true }), {
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

  it('still returns the issue to Todo when inline comments cannot be loaded', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleCodexReviewEvent(reviewEvent(), {
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
});
