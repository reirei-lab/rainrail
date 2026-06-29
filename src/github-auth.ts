import { execFile } from 'node:child_process';
import { createSign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { recordGitHubRateLimit } from './github-rate-limit.js';

export interface GitHubAppAuthConfig {
  appId: string;
  installationId: string;
  privateKeyPath: string;
}

export interface GitHubAuthConfig {
  token?: string;
  githubApp?: GitHubAppAuthConfig;
}

export type GitHubAuthProvider = 'configured-token' | 'github-app' | 'env-token' | 'gh-cli';

export interface GitHubAuthToken {
  token: string;
  provider: GitHubAuthProvider;
  fallback: boolean;
}

interface CachedInstallationToken {
  token: string;
  expiresAtMs: number;
  pending?: Promise<string>;
}

type FetchLike = typeof fetch;

const installationTokenCache = new Map<string, CachedInstallationToken>();
const tokenRefreshSkewMs = 5 * 60_000;
const execFileAsync = promisify(execFile);
let cachedGhCliToken: string | undefined;

export async function getGitHubToken(
  config: GitHubAuthConfig,
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  return (await getGitHubAuthToken(config, fetchImpl))?.token;
}

export async function getGitHubAuthToken(
  config: GitHubAuthConfig,
  fetchImpl: FetchLike = fetch,
): Promise<GitHubAuthToken | undefined> {
  if (config.token !== undefined && config.token.length > 0) {
    return { token: config.token, provider: 'configured-token', fallback: false };
  }
  if (config.githubApp !== undefined) {
    return {
      token: await githubAppInstallationToken(config.githubApp, fetchImpl),
      provider: 'github-app',
      fallback: false,
    };
  }
  return getEnvGitHubAuthToken();
}

export async function getGitHubFallbackAuthToken(config: GitHubAuthConfig): Promise<GitHubAuthToken | undefined> {
  if (config.token !== undefined && config.token.length > 0) {
    return undefined;
  }
  if (config.githubApp === undefined) {
    return undefined;
  }
  const envToken = getEnvGitHubAuthToken();
  if (envToken !== undefined) {
    return { ...envToken, fallback: true };
  }
  const ghCliToken = await getGhCliAuthToken();
  return ghCliToken === undefined ? undefined : { ...ghCliToken, fallback: true };
}

export function isGitHubRateLimitMessage(error: unknown): boolean {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return message.includes('rate limit')
    || message.includes('secondary rate limit')
    || message.includes('http 429')
    || message.includes('api rate limit exceeded');
}

export function isGitHubRateLimitResponse(response: Response): boolean {
  if (response.status === 429) {
    return true;
  }
  if (response.status !== 403) {
    return false;
  }
  const remaining = response.headers.get('x-ratelimit-remaining');
  return remaining === '0';
}

export function clearGitHubAppTokenCache(): void {
  installationTokenCache.clear();
  cachedGhCliToken = undefined;
}

function getEnvGitHubAuthToken(): GitHubAuthToken | undefined {
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  return envToken !== undefined && envToken.length > 0
    ? { token: envToken, provider: 'env-token', fallback: false }
    : undefined;
}

async function getGhCliAuthToken(): Promise<GitHubAuthToken | undefined> {
  if (cachedGhCliToken !== undefined) {
    return { token: cachedGhCliToken, provider: 'gh-cli', fallback: false };
  }
  for (const ghPath of ghPathCandidates()) {
    try {
      const { stdout, stderr } = await execFileAsync(ghPath, ['auth', 'status', '--show-token'], {
        maxBuffer: 200_000,
      });
      const token = parseGhAuthStatusToken(`${stdout}\n${stderr}`);
      if (token !== undefined) {
        cachedGhCliToken = token;
        return { token, provider: 'gh-cli', fallback: false };
      }
    } catch {
      // Try the next gh path, or fall back to no token.
    }
  }
  return undefined;
}

function parseGhAuthStatusToken(output: string): string | undefined {
  const match = output.match(/Token:\s*(\S+)/u);
  const token = match?.[1];
  return token === undefined || token.length === 0 ? undefined : token;
}

function ghPathCandidates(): string[] {
  return [
    process.env.GH_CLI_PATH,
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    'gh',
  ].filter((value): value is string => value !== undefined && value.length > 0);
}

async function githubAppInstallationToken(
  config: GitHubAppAuthConfig,
  fetchImpl: FetchLike,
): Promise<string> {
  const cacheKey = [
    config.appId,
    config.installationId,
    config.privateKeyPath,
  ].join('\0');
  const now = Date.now();
  const cached = installationTokenCache.get(cacheKey);
  if (cached !== undefined && cached.expiresAtMs - tokenRefreshSkewMs > now) {
    return cached.token;
  }
  if (cached?.pending !== undefined) {
    return cached.pending;
  }

  const pending = createInstallationToken(config, fetchImpl)
    .then(({ token, expiresAtMs }) => {
      installationTokenCache.set(cacheKey, { token, expiresAtMs });
      return token;
    })
    .catch((error) => {
      if (installationTokenCache.get(cacheKey)?.pending === pending) {
        installationTokenCache.delete(cacheKey);
      }
      throw error;
    });
  installationTokenCache.set(cacheKey, {
    token: '',
    expiresAtMs: 0,
    pending,
  });
  return pending;
}

async function createInstallationToken(
  config: GitHubAppAuthConfig,
  fetchImpl: FetchLike,
): Promise<{ token: string; expiresAtMs: number }> {
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${await createGitHubAppJwt(config)}`,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );
  recordGitHubRateLimit('rest', response.headers, { authProvider: 'github-app' });
  if (!response.ok) {
    throw new Error(`GitHub App installation token request failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as { token?: unknown; expires_at?: unknown };
  if (typeof payload.token !== 'string' || payload.token.length === 0) {
    throw new Error('GitHub App installation token response did not include a token');
  }
  if (typeof payload.expires_at !== 'string') {
    throw new Error('GitHub App installation token response did not include an expiration');
  }
  const expiresAtMs = Date.parse(payload.expires_at);
  if (!Number.isFinite(expiresAtMs)) {
    throw new Error('GitHub App installation token response included an invalid expiration');
  }
  return {
    token: payload.token,
    expiresAtMs,
  };
}

async function createGitHubAppJwt(config: GitHubAppAuthConfig): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = base64UrlJson({ alg: 'RS256', typ: 'JWT' });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: config.appId,
  });
  const signingInput = `${header}.${payload}`;
  const privateKey = await readFile(config.privateKeyPath, 'utf8');
  const signature = createSign('RSA-SHA256')
    .update(signingInput)
    .sign(privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
