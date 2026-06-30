import { describe, expect, it } from 'vitest';

import { verifyRainrailEventsBearerToken } from './index.js';

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
});
