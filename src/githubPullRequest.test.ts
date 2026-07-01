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
});
