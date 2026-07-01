import { describe, expect, it } from 'vitest';

import type { PluginRuntimeContext } from './workflow-plugin.js';
import { handleAutoMergeEvent } from './pr-lifecycle.js';
import { checkRunEvent, pullRequest, reviewEvent } from './pr-lifecycle-test-helpers.js';

describe('handleAutoMergeEvent', () => {
  it('squash merges an agent PR after the configured reviewer approves it', async () => {
    const merges: Array<{ repository: string; number: number; mergeMethod: string; sha?: string }> = [];

    const result = await handleAutoMergeEvent(reviewEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
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
    expect(merges).toEqual([{ repository: 'reirei-lab/rainrail', number: 44, mergeMethod: 'squash', sha: 'abc123' }]);
  });

  it('requires the repository allow-list before fetching the live PR', async () => {
    let fetchCount = 0;

    const result = await handleAutoMergeEvent(reviewEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
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
      branchPrefix: 'agent/',
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

  it('re-evaluates auto-merge after successful checks complete', async () => {
    const merges: Array<{ repository: string; number: number; mergeMethod: string; sha?: string }> = [];

    const result = await handleAutoMergeEvent(checkRunEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      mergeMethod: 'squash',
      targetRepositories: ['reirei-lab/rainrail'],
      pullRequests: {
        async getPullRequest() {
          const target = pullRequest();
          delete target.reviewDecision;
          return target;
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

    expect(result.reason).toBe('pull_request_merged');
    expect(merges).toEqual([{ repository: 'reirei-lab/rainrail', number: 44, mergeMethod: 'squash', sha: 'abc123' }]);
  });

  it('ignores stale approved reviews from old pull request heads', async () => {
    let mergeCount = 0;

    const result = await handleAutoMergeEvent(reviewEvent({ headSha: 'old-sha' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      mergeMethod: 'squash',
      targetRepositories: ['reirei-lab/rainrail'],
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ headSha: 'new-sha' });
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

    expect(result.reason).toBe('check does not match the current pull request head');
    expect(mergeCount).toBe(0);
  });

  it('only auto-merges agent branch pull requests', async () => {
    let mergeCount = 0;

    const result = await handleAutoMergeEvent(reviewEvent({ branchName: 'dependabot/npm/pkg' }), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      mergeMethod: 'squash',
      targetRepositories: ['reirei-lab/rainrail'],
      pullRequests: {
        async getPullRequest() {
          return pullRequest({ headRefName: 'dependabot/npm/pkg' });
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

    expect(result.reason).toBe('pull request is not an agent-authored target');
    expect(mergeCount).toBe(0);
  });

  it('retries when mergeability is still being calculated', async () => {
    await expect(handleAutoMergeEvent(reviewEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
      mergeMethod: 'squash',
      targetRepositories: ['reirei-lab/rainrail'],
      pullRequests: {
        async getPullRequest() {
          const target = pullRequest();
          delete target.mergeable;
          delete target.mergeStateStatus;
          return target;
        },
        async findPullRequestByHead() {
          throw new Error('not used');
        },
        async requestReview() {
          throw new Error('not used');
        },
        async mergePullRequest() {
          throw new Error('not used');
        },
      },
    })).rejects.toThrow('pull request mergeability is still being calculated');
  });

  it('falls back to the runtime merge action when the provider is read-only', async () => {
    const runtimeMerges: unknown[] = [];
    const context = {
      signal: new AbortController().signal,
      actions: {
        async mergePullRequest(input: unknown) {
          runtimeMerges.push(input);
        },
      },
    } as PluginRuntimeContext;

    const result = await handleAutoMergeEvent(reviewEvent(), {
      agentLogin: 'reirei-agent',
      reviewerLogin: 'hiragram',
      branchPrefix: 'agent/',
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
      },
    }, context);

    expect(result.reason).toBe('pull_request_merged');
    expect(runtimeMerges).toEqual([{
      pullRequestId: 'reirei-lab/rainrail#44',
      repository: 'reirei-lab/rainrail',
      number: 44,
      mergeMethod: 'squash',
      sha: 'abc123',
    }]);
  });
});
