import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearGitHubAppTokenCache,
  getGitHubAuthToken,
  getGitHubFallbackAuthToken,
  getGitHubToken,
  isGitHubRateLimitResponse,
} from './github-auth.js';
import { clearGitHubRateLimitSnapshots, getGitHubRateLimitSnapshots } from './github-rate-limit.js';

afterEach(() => {
  clearGitHubAppTokenCache();
  clearGitHubRateLimitSnapshots();
  vi.unstubAllEnvs();
});

describe('getGitHubToken', () => {
  it('mints and caches GitHub App installation tokens', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'rainrail-github-app-'));
    const keyPath = join(directory, 'private-key.pem');
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    writeFileSync(keyPath, privateKey.export({ type: 'pkcs1', format: 'pem' }), 'utf8');
    const requests: Array<{ url: string; authorization?: string }> = [];

    try {
      const config = {
        githubApp: {
          appId: '12345',
          installationId: '67890',
          privateKeyPath: keyPath,
        },
      };
      const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
        requests.push({
          url: String(url),
          authorization: String(new Headers(init?.headers).get('authorization')),
        });
        return new Response(JSON.stringify({
          token: 'installation-token',
          expires_at: new Date(Date.now() + 60 * 60_000).toISOString(),
        }), {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-limit': '5000',
            'x-ratelimit-remaining': '4999',
          },
        });
      };

      await expect(getGitHubToken(config, fetchImpl as typeof fetch)).resolves.toBe('installation-token');
      await expect(getGitHubToken(config, fetchImpl as typeof fetch)).resolves.toBe('installation-token');

      expect(requests).toHaveLength(1);
      expect(requests[0]?.url).toBe('https://api.github.com/app/installations/67890/access_tokens');
      expect(requests[0]?.authorization).toMatch(/^Bearer .+\..+\..+$/u);
      expect(getGitHubRateLimitSnapshots()).toMatchObject([
        {
          resource: 'rest',
          authProvider: 'github-app',
          remaining: 4999,
        },
      ]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('prefers explicitly configured tokens over GitHub App auth', async () => {
    let requestCount = 0;
    const token = await getGitHubToken({
      token: 'configured-token',
      githubApp: {
        appId: '12345',
        installationId: '67890',
        privateKeyPath: '/does/not/matter',
      },
    }, (async () => {
      requestCount += 1;
      throw new Error('not used');
    }) as typeof fetch);

    expect(token).toBe('configured-token');
    expect(requestCount).toBe(0);
  });

  it('exposes the selected auth provider and env fallback token', async () => {
    vi.stubEnv('GH_TOKEN', 'gh-token');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');
    const config = {
      githubApp: {
        appId: '12345',
        installationId: '67890',
        privateKeyPath: '/does/not/matter',
      },
    };

    await expect(getGitHubFallbackAuthToken(config)).resolves.toEqual({
      token: 'gh-token',
      provider: 'env-token',
      fallback: true,
    });
    await expect(getGitHubAuthToken({ token: 'configured-token', ...config })).resolves.toEqual({
      token: 'configured-token',
      provider: 'configured-token',
      fallback: false,
    });
  });

  it('falls back to GITHUB_TOKEN when GH_TOKEN is defined but empty', async () => {
    vi.stubEnv('GH_TOKEN', '');
    vi.stubEnv('GITHUB_TOKEN', 'github-token');

    await expect(getGitHubAuthToken({})).resolves.toEqual({
      token: 'github-token',
      provider: 'env-token',
      fallback: false,
    });
  });

  it('reads gh CLI tokens only from the active github.com host', async () => {
    vi.stubEnv('GH_CLI_PATH', '/tmp/test-gh');
    const calls: Array<{ file: string; args: string[] }> = [];

    await expect(getGitHubFallbackAuthToken({
      githubApp: {
        appId: '12345',
        installationId: '67890',
        privateKeyPath: '/does/not/matter',
      },
    }, async (file, args) => {
      calls.push({ file, args });
      return { stdout: 'cli-token\n', stderr: '' };
    })).resolves.toEqual({
      token: 'cli-token',
      provider: 'gh-cli',
      fallback: true,
    });
    expect(calls).toEqual([
      {
        file: '/tmp/test-gh',
        args: ['auth', 'token', '--hostname', 'github.com'],
      },
    ]);
  });

  it('treats retry-after 403 responses as rate limited', () => {
    expect(isGitHubRateLimitResponse(new Response('', {
      status: 403,
      headers: {
        'retry-after': '60',
        'x-ratelimit-remaining': '4999',
      },
    }))).toBe(true);
  });
});
