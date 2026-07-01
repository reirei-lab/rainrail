import { describe, expect, it } from 'vitest';

import { createTaskProviderPullRequestCommentHandoff, handleChangeRequestEvent } from './pr-lifecycle.js';
import { handoffRecorder, reviewEvent, task } from './pr-lifecycle-test-helpers.js';

describe('handleChangeRequestEvent', () => {
  it('returns the matching agent task to Todo when a PR review requests changes', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const statusRecords: string[] = [];

    const result = await handleChangeRequestEvent(reviewEvent({ state: 'changes_requested' }), {
      tasks: handoffRecorder({ updates, statusRecords }),
    });

    expect(result).toMatchObject({
      handled: true,
      reason: 'change-requested pull request returned to Todo',
      pullRequestNumber: 44,
      branchName: 'agent/test-pr',
      taskId: 'agent_task_1',
      projectItemId: 'PVTI_item',
      status: 'Todo',
    });
    expect(updates[0]?.commentBody).toContain('reply directly on that GitHub review discussion');
    expect(updates[0]?.commentBody).toContain('Outcome: changes_requested');
    expect(statusRecords).toEqual(['change_requested:Todo']);
  });

  it('truncates long change-request review bodies in handoff comments', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const longBody = `Please fix this.\n\n${'x'.repeat(10_000)}`;

    await handleChangeRequestEvent(reviewEvent({ state: 'changes_requested', reviewBody: longBody }), {
      tasks: handoffRecorder({ updates }),
    });

    expect(updates[0]?.commentBody).toContain('Review body:');
    expect(updates[0]?.commentBody).toContain('...[truncated]');
    expect(updates[0]?.commentBody).not.toContain('x'.repeat(5_000));
  });

  it('ignores stale change-request reviews for an old pull request head', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleChangeRequestEvent(reviewEvent({
      state: 'changes_requested',
      headSha: 'new-sha',
      reviewCommitId: 'old-sha',
    }), {
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('review does not match the current pull request head');
    expect(updates).toEqual([]);
  });

  it('removes stale pending review requests when change requests return the issue to Todo', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const removedReviewRequests: Array<{ repository: string; number: number; reviewerLogin: string }> = [];

    const result = await handleChangeRequestEvent(reviewEvent({
      state: 'changes_requested',
      reviewerLogin: 'codex',
    }), {
      reviewRequest: { reviewerLogin: 'hiragram' },
      tasks: handoffRecorder({ updates }),
      pullRequests: {
        async getPullRequest(input) {
          return {
            repository: input.repository,
            number: input.number,
            title: 'feat: add PR lifecycle workflows',
            url: 'https://github.com/reirei-lab/rainrail/pull/44',
            authorLogin: 'reirei-agent',
            headRefName: 'agent/test-pr',
            headRepository: 'reirei-lab/rainrail',
            headSha: 'abc123',
            isDraft: false,
            state: 'OPEN',
            statusCheckRollup: [],
            reviewRequests: ['hiragram'],
          };
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

    expect(result).toMatchObject({ reason: 'change-requested pull request returned to Todo', reviewRequestRemoved: true });
    expect(removedReviewRequests).toEqual([
      { repository: 'reirei-lab/rainrail', number: 44, reviewerLogin: 'hiragram' },
    ]);
  });

  it('ignores non-change-request reviews', async () => {
    const result = await handleChangeRequestEvent(reviewEvent({ state: 'approved' }), {
      tasks: handoffRecorder(),
    });

    expect(result.reason).toBe('event is not a pull request change request');
  });

  it('does not hand off a task from a different repository with the same branch', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const result = await handleChangeRequestEvent(reviewEvent({ state: 'changes_requested' }), {
      tasks: handoffRecorder({
        updates,
        taskOverride: { issue: { contentId: 'I_other', repository: 'reirei-lab/other' } },
      }),
    });

    expect(result.reason).toBe('matched agent task belongs to another repository');
    expect(updates).toEqual([]);
  });

  it('does not hand off a task for a fork pull request that only matches the branch name', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const result = await handleChangeRequestEvent(reviewEvent({
      state: 'changes_requested',
      headRepository: 'external/fork',
    }), {
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('pull request head repository does not match the base repository');
    expect(updates).toEqual([]);
  });

  it('does not hand off a task when the pull request head repository is missing', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];
    const result = await handleChangeRequestEvent(reviewEvent({
      state: 'changes_requested',
      missingHeadRepository: true,
    }), {
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('pull request head repository does not match the base repository');
    expect(updates).toEqual([]);
  });

  it('does not hand off delayed change requests for closed pull requests', async () => {
    const updates: Array<{ reason: string; commentBody?: string }> = [];

    const result = await handleChangeRequestEvent(reviewEvent({ state: 'changes_requested', prState: 'closed' }), {
      tasks: handoffRecorder({ updates }),
    });

    expect(result.reason).toBe('pull request is already closed');
    expect(updates).toEqual([]);
  });

  it('creates the handoff comment before releasing the project issue', async () => {
    const calls: string[] = [];
    const releases: unknown[] = [];
    const handoff = createTaskProviderPullRequestCommentHandoff({
      name: 'github',
      kind: 'task-provider',
      async getIssue() {
        throw new Error('not used');
      },
      async createComment() {
        calls.push('comment');
        return { id: 'comment_1', url: 'https://github.com/reirei-lab/rainrail/issues/23#issuecomment-1' };
      },
    }, {
      releaseProjectIssue(input) {
        releases.push(input);
        calls.push(`release:${input.reason}`);
      },
    });

    const result = await handoff.returnTaskToTodo({
      task: {
        ...task,
        claim: {
          ...task.claim!,
          lockRefId: 'REF_lock',
          dispatchedLockRefId: 'REF_dispatched',
          originalStatus: 'Backlog',
        },
      },
      reason: 'checks_failed',
      commentBody: 'body',
    });

    expect(calls).toEqual(['comment', 'release:checks_failed']);
    expect(releases).toEqual([expect.objectContaining({
      issue: expect.objectContaining({ id: 'PVTI_item', contentId: 'I_issue', status: 'Backlog' }),
      claim: expect.objectContaining({
        projectItemId: 'PVTI_item',
        lockRefId: 'REF_lock',
        dispatchedLockRefId: 'REF_dispatched',
      }),
    })]);
    expect(result).toEqual({
      projectItemId: 'PVTI_item',
      status: 'Todo',
      commentUrl: 'https://github.com/reirei-lab/rainrail/issues/23#issuecomment-1',
    });
  });

  it('does not release the project issue when creating the handoff comment fails', async () => {
    const releases: unknown[] = [];
    const handoff = createTaskProviderPullRequestCommentHandoff({
      name: 'github',
      kind: 'task-provider',
      async getIssue() {
        throw new Error('not used');
      },
      async createComment() {
        throw new Error('comment failed');
      },
    }, {
      releaseProjectIssue(input) {
        releases.push(input);
      },
    });

    await expect(handoff.returnTaskToTodo({
      task,
      reason: 'checks_failed',
      commentBody: 'body',
    })).rejects.toThrow('comment failed');
    expect(releases).toEqual([]);
  });

  it('requires a comment target for comment-only handoffs', async () => {
    let commentCount = 0;
    const handoff = createTaskProviderPullRequestCommentHandoff({
      name: 'github',
      kind: 'task-provider',
      async getIssue() {
        throw new Error('not used');
      },
      async createComment() {
        commentCount += 1;
        throw new Error('not used');
      },
    });

    await expect(handoff.returnTaskToTodo({
      task: {
        ...task,
        issue: { contentId: 'DI_draft', contentType: 'DraftIssue', state: 'OPEN' },
      },
      reason: 'codex_review',
      commentBody: 'body',
    })).rejects.toThrow('comment-only handoff requires issue repository and number');
    expect(commentCount).toBe(0);
  });
});
