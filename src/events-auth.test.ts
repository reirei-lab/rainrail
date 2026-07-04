import { describe, expect, it, vi } from 'vitest';

import { rainrailEventsAuthErrorResponse, verifyRainrailEventsBearerToken } from './index.js';

describe('Rainrail events auth', () => {
  it('requires a bearer token for events subscriptions', () => {
    const result = verifyRainrailEventsBearerToken(
      new Request('https://rainrail.local/events'),
      'secret-token',
    );

    expect(result).toEqual({
      ok: false,
      status: 401,
      reason: 'missing_bearer_token',
    });
  });

  it('rejects invalid bearer tokens without accepting partial matches', () => {
    const wrong = verifyRainrailEventsBearerToken(
      new Request('https://rainrail.local/events', {
        headers: { Authorization: 'Bearer wrong-token' },
      }),
      'secret-token',
    );
    const prefix = verifyRainrailEventsBearerToken(
      new Request('https://rainrail.local/events', {
        headers: { Authorization: 'Bearer secret' },
      }),
      'secret-token',
    );

    expect(wrong).toEqual({
      ok: false,
      status: 403,
      reason: 'invalid_bearer_token',
    });
    expect(prefix).toEqual({
      ok: false,
      status: 403,
      reason: 'invalid_bearer_token',
    });
  });

  it('accepts the configured bearer token', () => {
    const result = verifyRainrailEventsBearerToken(
      new Request('https://rainrail.local/events', {
        headers: { Authorization: 'Bearer secret-token' },
      }),
      'secret-token',
    );

    expect(result).toEqual({ ok: true });
  });

  it('reports missing server-side auth configuration', () => {
    const result = verifyRainrailEventsBearerToken(
      new Request('https://rainrail.local/events', {
        headers: { Authorization: 'Bearer secret-token' },
      }),
      '',
    );

    expect(result).toEqual({
      ok: false,
      status: 503,
      reason: 'events_auth_not_configured',
    });
  });

  it('returns CORS headers on auth error responses for cross-origin dashboards', async () => {
    const response = rainrailEventsAuthErrorResponse({
      ok: false,
      status: 403,
      reason: 'invalid_bearer_token',
    });

    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('Authorization');
    await expect(response.json()).resolves.toEqual({ error: 'invalid_bearer_token' });
  });

  it('compares mismatched token lengths across the maximum token length', () => {
    const charCodeAt = vi.spyOn(String.prototype, 'charCodeAt');

    try {
      const result = verifyRainrailEventsBearerToken(
        new Request('https://rainrail.local/events', {
          headers: { Authorization: 'Bearer short' },
        }),
        'much-longer-secret-token',
      );

      expect(result).toEqual({
        ok: false,
        status: 403,
        reason: 'invalid_bearer_token',
      });
      expect(charCodeAt.mock.calls.length).toBeGreaterThanOrEqual('much-longer-secret-token'.length * 2);
    } finally {
      charCodeAt.mockRestore();
    }
  });
});
