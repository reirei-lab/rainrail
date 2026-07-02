import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGitHubTaskProvider } from './github-provider.js';
import { clearGitHubRateLimitSnapshots, getGitHubRateLimitSnapshots } from './github-rate-limit.js';

afterEach(() => {
  clearGitHubRateLimitSnapshots();
  vi.unstubAllEnvs();
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

  it('creates issues and searches open issues through the GitHub task provider', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        node_id: 'issue-created-node-id',
        number: 24,
        title: 'Cloudflare issue',
        state: 'open',
        body: 'Issue body',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/24',
      }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        items: [{
          node_id: 'issue-found-node-id',
          number: 99,
          title: 'Existing Cloudflare issue',
          state: 'open',
          html_url: 'https://github.com/reirei-lab/rainrail/issues/99',
        }],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const provider = createGitHubTaskProvider({
      auth: {
        getAuthToken: async () => ({
          token: 'issue-token',
          provider: 'configured-token',
          fallback: false,
        }),
      },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.createIssue?.({
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      title: 'Cloudflare issue',
      body: 'Issue body',
      labels: ['automated-error'],
    })).resolves.toMatchObject({
      id: 'issue-created-node-id',
      number: 24,
      url: 'https://github.com/reirei-lab/rainrail/issues/24',
    });
    await expect(provider.searchIssues?.({
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      state: 'open',
      query: '"<!-- error-fingerprint: sha256:abc"',
    })).resolves.toMatchObject([
      {
        id: 'issue-found-node-id',
        number: 99,
      },
    ]);

    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      'https://api.github.com/repos/reirei-lab/rainrail/issues',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          title: 'Cloudflare issue',
          body: 'Issue body',
          labels: ['automated-error'],
        }),
      }),
    );
    const searchUrl = fetchImpl.mock.calls[1]?.[0] as URL;
    expect(searchUrl.toString()).toContain('https://api.github.com/search/issues?q=');
    expect(searchUrl.searchParams.get('q')).toBe('repo:reirei-lab/rainrail is:issue is:open "<!-- error-fingerprint: sha256:abc"');
  });

  it.each([
    [
      'getIssue',
      async (provider: ReturnType<typeof createGitHubTaskProvider>) => provider.getIssue({
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        number: 84,
      }),
      { node_id: 'issue-node-id', title: 'Missing number' },
    ],
    [
      'createIssue',
      async (provider: ReturnType<typeof createGitHubTaskProvider>) => provider.createIssue?.({
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        title: 'Missing mapped title',
        body: 'The response title is intentionally missing.',
      }),
      { node_id: 'issue-node-id', number: 84 },
    ],
    [
      'searchIssues',
      async (provider: ReturnType<typeof createGitHubTaskProvider>) => provider.searchIssues?.({
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        query: 'edge case',
      }),
      { items: [{ node_id: 'issue-node-id', number: 84 }] },
    ],
  ])('fails fast when %s receives an issue payload missing required fields', async (_name, callProvider, payload) => {
    const provider = createGitHubTaskProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: (async () => new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    });

    await expect(callProvider(provider)).rejects.toThrow('GitHub issue response is missing required issue fields');
  });

  it('returns an empty issue search result for a valid empty GitHub search payload', async () => {
    const provider = createGitHubTaskProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: (async () => new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as typeof fetch,
    });

    await expect(provider.searchIssues?.({
      provider: 'github',
      repository: 'reirei-lab/rainrail',
      query: 'no matches',
    })).resolves.toEqual([]);
  });

  it('rejects GitHub comment creation when the REST API returns a non-OK response', async () => {
    const provider = createGitHubTaskProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: (async () => new Response(JSON.stringify({ message: 'Forbidden' }), { status: 403 })) as typeof fetch,
    });

    await expect(provider.createComment({
      target: {
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        number: 84,
      },
      body: 'Outcome: updated_issue',
    })).rejects.toThrow('GitHub comment request failed with HTTP 403');
  });

  it('passes task context abort signals to issue fetches', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      node_id: 'issue-node-id',
      number: 20,
      title: 'Signal-aware issue',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = createGitHubTaskProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await provider.getIssue(
      {
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        number: 20,
      },
      { signal: controller.signal },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/reirei-lab/rainrail/issues/20',
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('does not start issue fetches when auth resolves after task abort', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      node_id: 'issue-node-id',
      number: 20,
      title: 'Late issue',
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = createGitHubTaskProvider({
      auth: {
        getAuthToken: async () => {
          controller.abort(new Error('issue lookup aborted after auth'));
          return undefined;
        },
      },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.getIssue(
      {
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        number: 20,
      },
      { signal: controller.signal },
    )).rejects.toThrow('issue lookup aborted after auth');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('passes task context abort signals to comment fetches', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      node_id: 'comment-node-id',
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = createGitHubTaskProvider({
      auth: { getAuthToken: async () => undefined },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await provider.createComment(
      {
        target: {
          provider: 'github',
          repository: 'reirei-lab/rainrail',
          number: 20,
        },
        body: 'Queued run:20',
      },
      { signal: controller.signal },
    );

    expect(fetchImpl).toHaveBeenCalledWith(
      'https://api.github.com/repos/reirei-lab/rainrail/issues/20/comments',
      expect.objectContaining({
        signal: controller.signal,
      }),
    );
  });

  it('does not start comment fetches when the signal aborts while waiting for auth', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({
      node_id: 'comment-node-id',
    }), {
      status: 201,
      headers: { 'content-type': 'application/json' },
    }));
    const provider = createGitHubTaskProvider({
      auth: {
        getAuthToken: async () => {
          controller.abort(new Error('comment creation timed out'));
          return {
            token: 'comment-token',
            provider: 'env-token' as const,
            fallback: false,
          };
        },
      },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.createComment(
      {
        target: {
          provider: 'github',
          repository: 'reirei-lab/rainrail',
          number: 20,
        },
        body: 'Queued run:20',
      },
      { signal: controller.signal },
    )).rejects.toThrow('comment creation timed out');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('keeps GitHub App token fetches independent from task context abort signals', async () => {
    const controller = new AbortController();
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-provider-auth-signal-'));
    const keyPath = join(directory, 'private-key.pem');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }), 'utf8');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        token: 'installation-token',
        expires_at: '2026-06-29T15:00:00.000Z',
      }), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        node_id: 'issue-node-id',
        number: 20,
        title: 'Signal-aware auth issue',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const provider = createGitHubTaskProvider({
      config: {
        githubApp: {
          appId: '12345',
          installationId: '67890',
          privateKeyPath: keyPath,
        },
      },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    try {
      await provider.getIssue(
        {
          provider: 'github',
          repository: 'reirei-lab/rainrail',
          number: 20,
        },
        { signal: controller.signal },
      );

      expect(fetchImpl).toHaveBeenNthCalledWith(
        1,
        'https://api.github.com/app/installations/67890/access_tokens',
        expect.not.objectContaining({
          signal: controller.signal,
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('falls back to env auth when default GitHub App auth cannot mint a token', async () => {
    vi.stubEnv('GH_TOKEN', 'fallback-token');
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-provider-fallback-'));
    const keyPath = join(directory, 'private-key.pem');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }), 'utf8');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ message: 'secondary rate limit' }), {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'retry-after': '60',
        },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        node_id: 'issue-node-id',
        number: 20,
        title: 'Fallback issue',
        state: 'open',
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    const provider = createGitHubTaskProvider({
      config: {
        githubApp: {
          appId: '12345',
          installationId: '67890',
          privateKeyPath: keyPath,
        },
      },
      fetch: fetchImpl as unknown as typeof fetch,
    });

    try {
      await expect(provider.getIssue({
        provider: 'github',
        repository: 'reirei-lab/rainrail',
        number: 20,
      })).resolves.toMatchObject({
        id: 'issue-node-id',
        title: 'Fallback issue',
      });
      expect(fetchImpl).toHaveBeenLastCalledWith(
        'https://api.github.com/repos/reirei-lab/rainrail/issues/20',
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: 'Bearer fallback-token',
          }),
        }),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
