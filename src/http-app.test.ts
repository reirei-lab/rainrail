import { describe, expect, it } from 'vitest';

import { getReaderOrThrow, readNext } from './test-helpers.js';

import {
  RainrailBridgeRoom,
  createGitHubWebhookSignature,
  createRainrailHttpApp,
  type CloudflareTailEvent,
  type RainrailBridgeRoomState,
} from './index.js';

const TEST_PUBLISH_TOKEN = 'test-publish-token';

describe('Rainrail HTTP app', () => {
  it('accepts a signed GitHub webhook and publishes it through the shared bridge room', async () => {
    const storage = fakeState();
    const app = createTestApp(storage);
    const rawBody = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      issue: {
        number: 19,
        title: 'Node server / Cloudflare Worker entrypoint',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/19',
      },
    });

    const response = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-19',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));

    expect(response.status).toBe(202);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*');
    await expect(response.json()).resolves.toEqual({
      ok: true,
      id: 'github-webhook:delivery-19:github.issue',
      name: 'github.issue',
      source: 'github',
    });
    expect(storage.storedEvents().map((event) => event.id)).toEqual([
      'github-webhook:delivery-19:github.issue',
    ]);
  });

  it('uses the same bridge room core for health and authenticated event streams', async () => {
    const app = createTestApp(fakeState(), { eventsBearerToken: 'events-token' });
    const health = await app.fetch(new Request('https://rainrail.local/healthz'));

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      ok: true,
      runtime: 'test-runtime',
      room: {
        ok: true,
        clients: 0,
        recent: 0,
      },
    });

    const missingAuth = await app.fetch(new Request('https://rainrail.local/events'));
    expect(missingAuth.status).toBe(401);
    await expect(missingAuth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const events = await app.fetch(new Request('https://rainrail.local/events', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(events.status).toBe(200);
    expect(events.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = getReaderOrThrow(events);
    await expect(readNext(reader)).resolves.toBe(': connected\n\n');
    await reader.cancel();
  });

  it('requires event stream auth configuration instead of opening events publicly', async () => {
    const app = createTestApp(fakeState());

    const response = await app.fetch(new Request('https://rainrail.local/events'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'events_auth_not_configured' });
  });

  it('rejects oversized GitHub webhook bodies before signature verification', async () => {
    const app = createTestApp(fakeState(), { maxWebhookBodyBytes: 4 });
    const response = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'oversized-delivery',
        'x-hub-signature-256': 'sha256=invalid',
      },
      body: '{"too":"large"}',
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'request_body_too_large' });
  });

  it('uses a stable fallback delivery id for retried Cloudflare tail batches without cf-ray', async () => {
    const storage = fakeState();
    const app = createTestApp(storage);
    const tailEvent: CloudflareTailEvent = {
      eventTimestamp: '2026-06-30T12:00:00.000Z',
      outcome: 'ok',
      scriptName: 'rainrail-worker',
      event: {
        request: {
          method: 'GET',
          url: 'https://rainrail.example/healthz',
          headers: {},
        },
        response: { status: 200 },
      },
    };

    const first = await app.tail?.([tailEvent]);
    const second = await app.tail?.([tailEvent]);

    expect(second).toEqual(first);
    expect(storage.storedEvents().map((event) => event.id)).toEqual([
      first?.[0]?.id,
    ]);
  });

  it('handles CORS preflight, unsupported methods, and uncaught route errors consistently', async () => {
    const app = createTestApp(fakeState());

    const preflight = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'OPTIONS',
    }));
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('POST');

    const wrongMethod = await app.fetch(new Request('https://rainrail.local/webhooks/github'));
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('Allow')).toBe('POST, OPTIONS');
    await expect(wrongMethod.json()).resolves.toEqual({ error: 'method_not_allowed' });

    const failingApp = createRainrailHttpApp({
      githubWebhookSecret: 'secret',
      publishToken: TEST_PUBLISH_TOKEN,
      runtime: 'test-runtime',
      room: {
        fetch: async () => {
          throw new Error('storage connection string: postgres://secret');
        },
      },
    });
    const error = await failingApp.fetch(new Request('https://rainrail.local/healthz'));
    expect(error.status).toBe(500);
    await expect(error.json()).resolves.toEqual({ error: 'internal_server_error' });
  });
});

function createTestApp(
  storage: ReturnType<typeof fakeState>,
  options: { eventsBearerToken?: string; maxWebhookBodyBytes?: number } = {},
) {
  const room = new RainrailBridgeRoom(storage, {
    publishToken: TEST_PUBLISH_TOKEN,
    replayLimit: 10,
  });

  return createRainrailHttpApp({
    room,
    githubWebhookSecret: 'secret',
    publishToken: TEST_PUBLISH_TOKEN,
    runtime: 'test-runtime',
    ...options,
  });
}

function fakeState(initialEvents: unknown[] = []): RainrailBridgeRoomState & {
  storedEvents(): Array<{ id: string }>;
} {
  const values = new Map<string, unknown>([['rainrail:recent-events', initialEvents]]);

  return {
    storage: {
      async get(key) {
        return values.get(key);
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
    storedEvents() {
      return values.get('rainrail:recent-events') as Array<{ id: string }>;
    },
  };
}
