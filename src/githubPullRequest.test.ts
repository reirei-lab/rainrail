import { describe, expect, it, vi } from 'vitest';

import { createGitHubPullRequestProvider } from './github-provider.js';

describe('createGitHubPullRequestProvider', () => {
  it.each([
    ['GitHub App token', { token: 'app-token', provider: 'github-app' as const, fallback: false }],
    ['fallback token', { token: 'fallback-token', provider: 'gh-cli' as const, fallback: true }],
  ])('paginates pull request review comments with a %s before workflow filtering by review id', async (_label, authToken) => {
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
      auth: { getAuthToken: async () => authToken },
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

  it('returns every same-SHA pull request candidate for workflow filtering', async () => {
    const requests: string[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      requests.push(url);
      if (url.endsWith('/pulls?state=open&per_page=100')) {
        return new Response(JSON.stringify([
          { number: 45, head: { ref: 'feature/manual', sha: 'abc123' } },
          { number: 44, head: { ref: 'agent/test-pr', sha: 'abc123' } },
          { number: 43, head: { ref: 'agent/other', sha: 'other-sha' } },
        ]), { status: 200 });
      }
      if (url.endsWith('/pulls/45')) {
        return new Response(JSON.stringify(githubPullRequest({
          number: 45,
          user: { login: 'someone-else' },
          head: { ref: 'feature/manual', sha: 'abc123', repo: { full_name: 'reirei-lab/rainrail' } },
        })), { status: 200 });
      }
      if (url.endsWith('/pulls/44')) {
        return new Response(JSON.stringify(githubPullRequest()), { status: 200 });
      }
      if (url.includes('/reviews?per_page=100')) {
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

    await expect(provider.findPullRequestsByHead?.({
      repository: 'reirei-lab/rainrail',
      headRefName: 'agent/test-pr',
      headSha: 'abc123',
    })).resolves.toMatchObject([
      { number: 45, authorLogin: 'someone-else' },
      { number: 44, authorLogin: 'reirei-agent' },
    ]);
    expect(requests[0]).toBe('https://api.github.com/repos/reirei-lab/rainrail/pulls?state=open&per_page=100');
    expect(requests).toContain('https://api.github.com/repos/reirei-lab/rainrail/pulls/45');
    expect(requests).toContain('https://api.github.com/repos/reirei-lab/rainrail/pulls/44');
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
      headRepository: 'reirei-lab/rainrail',
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

  it('ignores empty pending combined status when check runs have passed', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/pulls/44')) {
        return new Response(JSON.stringify(githubPullRequest()), { status: 200 });
      }
      if (url.endsWith('/pulls/44/reviews?per_page=100')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/status')) {
        return new Response(JSON.stringify({ state: 'pending', total_count: 0, statuses: [] }), { status: 200 });
      }
      if (url.endsWith('/commits/abc123/check-runs?per_page=100')) {
        return new Response(JSON.stringify({
          check_runs: [{ name: 'Typecheck, Test, Build', status: 'completed', conclusion: 'success' }],
        }), { status: 200 });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.getPullRequest({ repository: 'reirei-lab/rainrail', number: 44 })).resolves.toMatchObject({
      statusCheckRollup: [
        { type: 'CheckRun', name: 'Typecheck, Test, Build', status: 'completed', conclusion: 'success' },
      ],
    });
  });

  it('does not expose merge as a raw provider method', () => {
    const provider = createGitHubPullRequestProvider({
      auth: { getAuthToken: async () => undefined },
    });

    expect('mergePullRequest' in provider).toBe(false);
  });
});

function githubPullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 44,
    title: 'feat: add PR lifecycle workflows',
    html_url: 'https://github.com/reirei-lab/rainrail/pull/44',
    user: { login: 'reirei-agent' },
    head: { ref: 'agent/test-pr', sha: 'abc123', repo: { full_name: 'reirei-lab/rainrail' } },
    draft: false,
    state: 'open',
    mergeable: false,
    mergeable_state: 'blocked',
    requested_reviewers: [],
    ...overrides,
  };
}
