import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitHubTaskProvider } from './github-provider.js';
import { clearGitHubRateLimitSnapshots, getGitHubRateLimitSnapshots } from './github-rate-limit.js';

afterEach(() => {
  clearGitHubRateLimitSnapshots();
});

describe('createGitHubTaskProvider', () => {
  it('uses the injected auth provider when calling the GitHub API', async () => {
    const getAuthToken = vi.fn(async () => ({
      token: 'injected-token',
      provider: 'configured-token' as const,
      fallback: false,
    }));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      node_id: 'issue-node-id',
      number: 20,
      title: 'Move provider auth into Rainrail',
      state: 'open',
      body: 'Issue body',
      html_url: 'https://github.com/reirei-lab/rainrail/issues/20',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = createGitHubTaskProvider({
      auth: { getAuthToken },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.getIssue({
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      number: 20,
    })).resolves.toMatchObject({
      id: 'issue-node-id',
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      number: 20,
      title: 'Move provider auth into Rainrail',
    });

    expect(getAuthToken).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/reirei-lab/rainrail/issues/20',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer injected-token',
        }),
      }),
    );
  });

  it('creates comments with the injected auth provider and records REST rate limit headers', async () => {
    const provider = createGitHubTaskProvider({
      auth: {
        getAuthToken: async () => ({
          token: 'comment-token',
          provider: 'env-token',
          fallback: true,
        }),
      },
      fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
        expect(init).toMatchObject({
          method: 'POST',
          body: JSON.stringify({ body: 'Queued run:20' }),
          headers: expect.objectContaining({
            Authorization: 'Bearer comment-token',
          }),
        });
        return new Response(JSON.stringify({
          node_id: 'comment-node-id',
          html_url: 'https://github.com/reirei-lab/rainrail/issues/20#issuecomment-1',
        }), {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '4997',
          },
        });
      }) as typeof fetch,
    });

    await expect(provider.createComment({
      target: {
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        number: 20,
      },
      body: 'Queued run:20',
    })).resolves.toEqual({
      id: 'comment-node-id',
      url: 'https://github.com/reirei-lab/rainrail/issues/20#issuecomment-1',
    });
    expect(getGitHubRateLimitSnapshots()).toMatchObject([
      {
        resource: 'rest',
        authProvider: 'env-token',
        fallback: true,
        remaining: 4997,
      },
    ]);
  });
});
