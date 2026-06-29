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
    vi.stubEnv('GH_TOKEN', 'pat-token');
    const config = {
      githubApp: {
        appId: '12345',
        installationId: '67890',
        privateKeyPath: '/does/not/matter',
      },
    };

    await expect(getGitHubFallbackAuthToken(config)).resolves.toEqual({
      token: 'pat-token',
      provider: 'env-token',
      fallback: true,
    });
    await expect(getGitHubAuthToken({ token: 'configured-token', ...config })).resolves.toEqual({
      token: 'configured-token',
      provider: 'configured-token',
      fallback: false,
    });
  });
});
