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

  it('passes task context abort signals to GitHub App token requests', async () => {
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
        expect.objectContaining({
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
