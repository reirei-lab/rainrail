import { describe, expect, it } from 'vitest';

import type { PullRequestReviewTarget } from './pr-lifecycle.js';
import type { PluginRuntimeContext } from './workflow-plugin.js';
import { createAutoMergeWorkflow, handleAutoMergeEvent } from './pr-lifecycle.js';
import { checkRunEvent, pullRequest, pullRequestEvent, reviewEvent } from './pr-lifecycle-test-helpers.js';

describe('handleAutoMergeEvent', () => {
  it('squash merges an agent PR through the gated runtime action after reviewer approval', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(reviewEvent(), options(), runtimeContext(runtimeMerges));

    expect(result).toMatchObject({ handled: true, reason: 'pull_request_merged' });
    expect(runtimeMerges).toEqual([{
      pullRequestId: 'reirei-lab/rainrail#44',
      repository: 'reirei-lab/rainrail',
      number: 44,
      mergeMethod: 'squash',
      sha: 'abc123',
    }]);
  });

  it('requires the repository allow-list before fetching the live PR', async () => {
    let fetchCount = 0;

    const result = await handleAutoMergeEvent(reviewEvent(), {
      ...options(),
      targetRepositories: ['reirei-lab/other'],
      pullRequests: {
        ...options().pullRequests,
        async getPullRequest() {
          fetchCount += 1;
          throw new Error('not used');
        },
      },
    });

    expect(result.reason).toBe('repository is not an auto-merge target');
    expect(fetchCount).toBe(0);
  });

  it('requires the configured reviewer latest approval instead of aggregate reviewDecision', async () => {
    const result = await handleAutoMergeEvent(reviewEvent(), options({
      reviewDecision: 'APPROVED',
      reviews: [{ authorLogin: 'hiragram', state: 'CHANGES_REQUESTED' }],
    }));

    expect(result.reason).toBe('configured reviewer approval is not confirmed');
  });

  it('does not merge while another reviewer has unresolved change requests', async () => {
    const result = await handleAutoMergeEvent(checkRunEvent(), options({
      reviews: [
        { authorLogin: 'hiragram', state: 'APPROVED', commitId: 'abc123' },
        { authorLogin: 'codex', state: 'CHANGES_REQUESTED', commitId: 'abc123' },
      ],
    }));

    expect(result.reason).toBe('pull request has unresolved change requests');
  });

  it('does not let pending review drafts hide unresolved change requests', async () => {
    const result = await handleAutoMergeEvent(checkRunEvent(), options({
      reviews: [
        { authorLogin: 'hiragram', state: 'APPROVED', commitId: 'abc123' },
        { authorLogin: 'codex', state: 'CHANGES_REQUESTED', commitId: 'abc123' },
        { authorLogin: 'codex', state: 'PENDING', commitId: 'abc123' },
      ],
    }));

    expect(result.reason).toBe('pull request has unresolved change requests');
  });

  it('does not let stale actionable reviews hide current-head change requests', async () => {
    const result = await handleAutoMergeEvent(checkRunEvent({ headSha: 'new-sha' }), options({
      headSha: 'new-sha',
      reviews: [
        { authorLogin: 'hiragram', state: 'APPROVED', commitId: 'new-sha' },
        { authorLogin: 'codex', state: 'CHANGES_REQUESTED', commitId: 'new-sha' },
        { authorLogin: 'codex', state: 'APPROVED', commitId: 'old-sha' },
      ],
    }));

    expect(result.reason).toBe('pull request has unresolved change requests');
  });

  it('re-evaluates auto-merge after successful checks complete', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(checkRunEvent(), options(), runtimeContext(runtimeMerges));

    expect(result.reason).toBe('pull_request_merged');
    expect(runtimeMerges).toHaveLength(1);
  });

  it('accepts ready_for_review events so draft release can trigger auto-merge', async () => {
    const runtimeMerges: unknown[] = [];
    const workflow = createAutoMergeWorkflow(options());
    const event = pullRequestEvent({ action: 'ready_for_review' });

    if (workflow.accepts === undefined) throw new Error('auto-merge workflow has no accepts predicate');
    expect(workflow.accepts(event)).toBe(true);
    const result = await workflow.handle(event, runtimeContext(runtimeMerges));

    expect(result).toMatchObject({ reason: 'pull_request_merged' });
    expect(runtimeMerges).toEqual([expect.objectContaining({ number: 44 })]);
  });

  it('continues past non-agent check_run PRs and auto-merges a later agent PR', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(checkRunEvent({
      pullRequests: [{ number: 45 }, { number: 44 }],
    }), {
      ...options(),
      pullRequests: {
        ...options().pullRequests,
        async getPullRequest(input) {
          return input.number === 45
            ? pullRequest({ ...input, authorLogin: 'someone-else', headRefName: 'feature/manual' })
            : pullRequest(input);
        },
      },
    }, runtimeContext(runtimeMerges));

    expect(result.reason).toBe('pull_request_merged');
    expect(runtimeMerges).toEqual([expect.objectContaining({ number: 44 })]);
  });

  it('auto-merges an agent PR found after non-agent SHA search matches', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(checkRunEvent({ pullRequests: [] }), {
      ...options(),
      pullRequests: {
        ...options().pullRequests,
        async findPullRequestsByHead(input) {
          expect(input).toMatchObject({ repository: 'reirei-lab/rainrail', headSha: 'abc123' });
          return [
            pullRequest({ number: 45, authorLogin: 'someone-else', headRefName: 'feature/manual' }),
            pullRequest({ number: 44 }),
          ];
        },
      },
    }, runtimeContext(runtimeMerges));

    expect(result.reason).toBe('pull_request_merged');
    expect(runtimeMerges).toEqual([expect.objectContaining({ number: 44 })]);
  });

  it('continues past unapproved candidates and auto-merges a later approved PR', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(checkRunEvent({ pullRequests: [{ number: 45 }, { number: 44 }] }), {
      ...options(),
      pullRequests: {
        ...options().pullRequests,
        async getPullRequest(input) {
          return input.number === 45
            ? pullRequest({ ...input, reviews: [] })
            : pullRequest(input);
        },
      },
    }, runtimeContext(runtimeMerges));

    expect(result.reason).toBe('pull_request_merged');
    expect(runtimeMerges).toEqual([expect.objectContaining({ number: 44 })]);
  });

  it('does not auto-merge before the current head has any reported checks', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(reviewEvent(), options({
      statusCheckRollup: [],
    }), runtimeContext(runtimeMerges));

    expect(result.reason).toBe('not all checks have passed');
    expect(runtimeMerges).toEqual([]);
  });

  it('retries pending mergeability candidates after merging later ready PRs', async () => {
    const runtimeMerges: unknown[] = [];

    await expect(handleAutoMergeEvent(checkRunEvent({ pullRequests: [{ number: 45 }, { number: 44 }] }), {
      ...options(),
      pullRequests: {
        ...options().pullRequests,
        async getPullRequest(input) {
          return input.number === 45
            ? pullRequest({ ...input, headRefName: 'agent/other-pr', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
            : pullRequest(input);
        },
      },
    }, runtimeContext(runtimeMerges))).rejects.toThrow('pull request mergeability is still being calculated');

    expect(runtimeMerges).toEqual([expect.objectContaining({ number: 44 })]);
  });

  it('auto-merges every ready same-SHA pull request candidate', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(checkRunEvent({
      pullRequests: [{ number: 45 }],
      headSha: 'abc123',
    }), {
      ...options(),
      pullRequests: {
        ...options().pullRequests,
        async getPullRequest(input) {
          return pullRequest({ ...input, headRefName: 'agent/first-pr' });
        },
        async findPullRequestsByHead(input) {
          expect(input).toMatchObject({ repository: 'reirei-lab/rainrail', headSha: 'abc123' });
          return [pullRequest({ number: 44, headRefName: 'agent/second-pr' })];
        },
      },
    }, runtimeContext(runtimeMerges));

    expect(result.reason).toBe('pull_request_merged');
    expect(runtimeMerges).toEqual([
      expect.objectContaining({ number: 45 }),
      expect.objectContaining({ number: 44 }),
    ]);
  });

  it('keeps retrying pending mergeability candidates when no later candidate can merge', async () => {
    await expect(handleAutoMergeEvent(checkRunEvent({ pullRequests: [{ number: 45 }, { number: 44 }] }), {
      ...options(),
      pullRequests: {
        ...options().pullRequests,
        async getPullRequest(input) {
          return input.number === 45
            ? pullRequest({ ...input, headRefName: 'agent/pending-pr', mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' })
            : pullRequest({ ...input, reviews: [] });
        },
      },
    })).rejects.toThrow('pull request mergeability is still being calculated');
  });

  it('re-evaluates auto-merge after a skipped check completes the passing rollup', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(
      checkRunEvent({ conclusion: 'skipped' }),
      options(),
      runtimeContext(runtimeMerges),
    );

    expect(result.reason).toBe('pull_request_merged');
    expect(runtimeMerges).toHaveLength(1);
  });

  it('uses only approvals for the current pull request head', async () => {
    const result = await handleAutoMergeEvent(checkRunEvent({ headSha: 'new-sha' }), options({
      headSha: 'new-sha',
      reviews: [{ authorLogin: 'hiragram', state: 'APPROVED', commitId: 'old-sha' }],
    }));

    expect(result.reason).toBe('configured reviewer approval is not confirmed');
  });

  it('keeps approval when a later comment review is submitted by the same reviewer', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(checkRunEvent(), options({
      reviews: [
        { authorLogin: 'hiragram', state: 'APPROVED', commitId: 'abc123' },
        { authorLogin: 'hiragram', state: 'COMMENTED', commitId: 'abc123' },
      ],
    }), runtimeContext(runtimeMerges));

    expect(result.reason).toBe('pull_request_merged');
    expect(runtimeMerges).toHaveLength(1);
  });

  it('ignores stale approved reviews from old pull request heads', async () => {
    const result = await handleAutoMergeEvent(reviewEvent({ headSha: 'old-sha' }), options({ headSha: 'new-sha' }));

    expect(result.reason).toBe('check does not match the current pull request head');
  });

  it('only auto-merges agent branch pull requests', async () => {
    const result = await handleAutoMergeEvent(reviewEvent({ branchName: 'dependabot/npm/pkg' }), options({
      headRefName: 'dependabot/npm/pkg',
    }));

    expect(result.reason).toBe('pull request is not an agent-authored target');
  });

  it('only auto-merges pull requests from the managed repository', async () => {
    const result = await handleAutoMergeEvent(reviewEvent(), options({ headRepository: 'external/fork' }));

    expect(result.reason).toBe('pull request is not an agent-authored target');
  });

  it('retries when mergeability is still being calculated', async () => {
    await expect(handleAutoMergeEvent(reviewEvent(), options({
      mergeable: '',
      mergeStateStatus: '',
    }))).rejects.toThrow('pull request mergeability is still being calculated');
  });

  it('does not auto-merge branch-protection blocked pull requests even when mergeable is true', async () => {
    const runtimeMerges: unknown[] = [];

    const result = await handleAutoMergeEvent(reviewEvent(), options({
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
    }), runtimeContext(runtimeMerges));

    expect(result.reason).toBe('pull request is not mergeable');
    expect(runtimeMerges).toEqual([]);
  });

  it('requires a runtime merge action instead of calling the provider directly', async () => {
    await expect(handleAutoMergeEvent(reviewEvent(), options())).rejects.toThrow('Auto-merge requires a gated runtime merge action');
  });
});

function options(overrides: Partial<PullRequestReviewTarget> = {}) {
  return {
    agentLogin: 'reirei-agent',
    reviewerLogin: 'hiragram',
    branchPrefix: 'agent/',
    mergeMethod: 'squash' as const,
    targetRepositories: ['reirei-lab/rainrail'],
    pullRequests: {
      async getPullRequest() {
        return pullRequest(overrides);
      },
      async findPullRequestByHead() {
        throw new Error('not used');
      },
      async requestReview() {
        throw new Error('not used');
      },
    },
  };
}

function runtimeContext(merges: unknown[]): PluginRuntimeContext {
  return {
    runId: 'run-auto-merge-test',
    now: () => new Date('2026-07-01T00:00:00.000Z'),
    providers: {} as PluginRuntimeContext['providers'],
    runtime: {} as PluginRuntimeContext['runtime'],
    signal: new AbortController().signal,
    actions: {
      async mergePullRequest(input: unknown) {
        merges.push(input);
      },
      async startRuntime() {
        throw new Error('not used');
      },
      async readSecret() {
        throw new Error('not used');
      },
    },
  };
}
