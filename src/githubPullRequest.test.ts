import { describe, expect, it, vi } from 'vitest';

import { createGitHubPullRequestProvider } from './github-provider.js';

describe('createGitHubPullRequestProvider', () => {
  it('paginates pull request review comments before workflow filtering by review id', async () => {
    const requests: string[] = [];
    const pageOne = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      pull_request_review_id: 111,
      path: 'src/old.ts',
      body: 'old comment',
    }));
    const pageTwo = [{
      id: 101,
      pull_request_review_id: 4493317816,
      path: 'src/pr-lifecycle.ts',
      body: 'new Codex comment',
      html_url: 'https://github.com/reirei-lab/rainrail/pull/44#discussion_r101',
      line: 42,
      commit_id: 'abc123',
    }];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      requests.push(String(input));
      return new Response(JSON.stringify(requests.length === 1 ? pageOne : pageTwo), { status: 200 });
    });
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => ({ token: 'token', provider: 'configured-token', fallback: false }) },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    const comments = await provider.listReviewComments?.({
      repository: 'reirei-lab/rainrail',
      number: 44,
    });
    expect(comments).toHaveLength(101);
    expect(comments?.[0]).toMatchObject({ id: 1, reviewId: 111 });
    expect(comments?.at(-1)).toMatchObject({
      id: 101,
      reviewId: 4493317816,
      path: 'src/pr-lifecycle.ts',
      line: 42,
      commitId: 'abc123',
    });
    expect(requests).toEqual([
      'https://api.github.com/repos/reirei-lab/rainrail/pulls/44/comments?per_page=100&page=1',
      'https://api.github.com/repos/reirei-lab/rainrail/pulls/44/comments?per_page=100&page=2',
    ]);
  });

  it('loads PR details for base searches so conflict checks see mergeability', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/pulls?state=open&base=main&per_page=100')) {
        return new Response(JSON.stringify([{ number: 44 }]), { status: 200 });
      }
      if (url.endsWith('/pulls/44')) {
        return new Response(JSON.stringify(githubPullRequest({ mergeable_state: 'dirty' })), { status: 200 });
      }
      if (url.endsWith('/pulls/44/reviews?per_page=100')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/status')) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/check-runs?per_page=100')) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.findOpenPullRequestsByBase?.({
      repository: 'reirei-lab/rainrail',
      baseRefName: 'main',
    })).resolves.toMatchObject([{ number: 44, mergeStateStatus: 'dirty' }]);
    expect(requests).toContain('https://api.github.com/repos/reirei-lab/rainrail/pulls/44');
  });

  it('uses owner-qualified head filters and fetches matching PR details', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.includes('/pulls?state=open&per_page=100&head=reirei-lab%3Aagent%2Ftest-pr')) {
        return new Response(JSON.stringify([{ number: 44, head: { ref: 'agent/test-pr', sha: 'abc123' } }]), { status: 200 });
      }
      if (url.endsWith('/pulls/44')) {
        return new Response(JSON.stringify(githubPullRequest()), { status: 200 });
      }
      if (url.endsWith('/pulls/44/reviews?per_page=100')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/status')) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/check-runs?per_page=100')) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.findPullRequestByHead({
      repository: 'reirei-lab/rainrail',
      headRefName: 'agent/test-pr',
    })).resolves.toMatchObject({ number: 44 });
    expect(requests[0]).toContain('head=reirei-lab%3Aagent%2Ftest-pr');
  });

  it('paginates reviews and check runs before deriving merge and check state', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/pulls/44')) {
        return new Response(JSON.stringify(githubPullRequest()), { status: 200 });
      }
      if (url.endsWith('/pulls/44/reviews?per_page=100')) {
        return new Response(JSON.stringify(Array.from({ length: 100 }, () => ({ user: { login: 'hiragram' }, state: 'APPROVED', commit_id: 'abc123' }))), { status: 200 });
      }
      if (url.endsWith('/pulls/44/reviews?per_page=100&page=2')) {
        return new Response(JSON.stringify([{ user: { login: 'hiragram' }, state: 'CHANGES_REQUESTED', commit_id: 'abc123' }]), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/status')) {
        return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/check-runs?per_page=100')) {
        return new Response(JSON.stringify({ check_runs: Array.from({ length: 100 }, () => ({ name: 'ok', status: 'completed', conclusion: 'success' })) }), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/check-runs?per_page=100&page=2')) {
        return new Response(JSON.stringify({ check_runs: [{ name: 'late', status: 'completed', conclusion: 'failure' }] }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.getPullRequest({ repository: 'reirei-lab/rainrail', number: 44 })).resolves.toMatchObject({
      headSha: 'abc123',
      reviews: expect.arrayContaining([expect.objectContaining({ authorLogin: 'hiragram', state: 'CHANGES_REQUESTED', commitId: 'abc123' })]),
      statusCheckRollup: expect.arrayContaining([expect.objectContaining({ name: 'late', conclusion: 'failure' })]),
    });
  });

  it('adds the combined commit status state to the check rollup', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/pulls/44')) {
        return new Response(JSON.stringify(githubPullRequest()), { status: 200 });
      }
      if (url.endsWith('/pulls/44/reviews?per_page=100')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/status')) {
        return new Response(JSON.stringify({
          state: 'failure',
          statuses: [{ context: 'first-page-ci', state: 'success' }],
        }), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/check-runs?per_page=100')) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.getPullRequest({ repository: 'reirei-lab/rainrail', number: 44 })).resolves.toMatchObject({
      statusCheckRollup: expect.arrayContaining([
        expect.objectContaining({ type: 'StatusRollup', name: 'combined-status', state: 'failure' }),
        expect.objectContaining({ type: 'StatusContext', name: 'first-page-ci', state: 'success' }),
      ]),
    });
  });

  it('passes the verified head SHA to GitHub merge requests', async () => {
    let mergeBody: unknown;
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/pulls/44/merge')) {
        mergeBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ merged: true }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await provider.mergePullRequest?.({
      repository: 'reirei-lab/rainrail',
      number: 44,
      mergeMethod: 'squash',
      sha: 'abc123',
    });

    expect(mergeBody).toEqual({ merge_method: 'squash', sha: 'abc123' });
  });

  it('rejects unsupported merge methods instead of defaulting to squash', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('merge request should not be sent');
    });
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.mergePullRequest?.({
      repository: 'reirei-lab/rainrail',
      number: 44,
      mergeMethod: 'MERGE' as 'merge',
      sha: 'abc123',
    })).rejects.toThrow('Unsupported GitHub pull request merge method');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

function githubPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 44,
    title: 'feat: add PR lifecycle workflows',
    html_url: 'https://github.com/reirei-lab/rainrail/pull/44',
    user: { login: 'reirei-agent' },
    head: { ref: 'agent/test-pr', sha: 'abc123' },
    draft: false,
    state: 'open',
    mergeable: false,
    mergeable_state: 'blocked',
    requested_reviewers: [],
    ...overrides,
  };
}
