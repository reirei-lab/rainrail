import type { GitHubAuthProvider } from './auth.js';

export interface GitHubRateLimitSnapshot {
  resource: 'rest' | 'graphql';
  authProvider?: GitHubAuthProvider;
  fallback?: boolean;
  limit?: number;
  remaining?: number;
  used?: number;
  reset?: number;
  observedAt: string;
}

const snapshots = new Map<GitHubRateLimitSnapshot['resource'], GitHubRateLimitSnapshot>();

export function recordGitHubRateLimit(
  resource: GitHubRateLimitSnapshot['resource'],
  headers: Headers,
  auth?: Pick<GitHubRateLimitSnapshot, 'authProvider' | 'fallback'>,
): void {
  const snapshot: GitHubRateLimitSnapshot = {
    resource,
    ...(auth?.authProvider === undefined ? {} : { authProvider: auth.authProvider }),
    ...(auth?.fallback === undefined ? {} : { fallback: auth.fallback }),
    observedAt: new Date().toISOString(),
  };
  const limit = numberHeader(headers, 'x-ratelimit-limit');
  const remaining = numberHeader(headers, 'x-ratelimit-remaining');
  const used = numberHeader(headers, 'x-ratelimit-used');
  const reset = numberHeader(headers, 'x-ratelimit-reset');
  if (limit !== undefined) {
    snapshot.limit = limit;
  }
  if (remaining !== undefined) {
    snapshot.remaining = remaining;
  }
  if (used !== undefined) {
    snapshot.used = used;
  }
  if (reset !== undefined) {
    snapshot.reset = reset;
  }
  if (
    snapshot.limit === undefined
    && snapshot.remaining === undefined
    && snapshot.used === undefined
    && snapshot.reset === undefined
  ) {
    return;
  }
  snapshots.set(resource, snapshot);
}

export function getGitHubRateLimitSnapshots(): GitHubRateLimitSnapshot[] {
  return [...snapshots.values()];
}

export function clearGitHubRateLimitSnapshots(): void {
  snapshots.clear();
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || value.length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
