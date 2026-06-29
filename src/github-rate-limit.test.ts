import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearGitHubRateLimitSnapshots,
  getGitHubRateLimitSnapshots,
  recordGitHubRateLimit,
} from './github-rate-limit.js';

afterEach(() => {
  clearGitHubRateLimitSnapshots();
  vi.useRealTimers();
});

describe('GitHub rate limit snapshots', () => {
  it('records REST and GraphQL headers with auth provider metadata', () => {
    vi.setSystemTime(new Date('2026-06-30T01:02:03.000Z'));

    recordGitHubRateLimit('graphql', new Headers({
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4998',
      'x-ratelimit-used': '2',
      'x-ratelimit-reset': '1782784923',
    }), {
      authProvider: 'env-token',
      fallback: true,
    });

    expect(getGitHubRateLimitSnapshots()).toEqual([
      {
        resource: 'graphql',
        authProvider: 'env-token',
        fallback: true,
        limit: 5000,
        remaining: 4998,
        used: 2,
        reset: 1782784923,
        observedAt: '2026-06-30T01:02:03.000Z',
      },
    ]);
  });

  it('ignores responses without rate limit headers', () => {
    recordGitHubRateLimit('rest', new Headers());

    expect(getGitHubRateLimitSnapshots()).toEqual([]);
  });
});
