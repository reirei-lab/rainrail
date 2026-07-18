import { describe, expect, it } from 'vitest';

import { getReaderOrThrow, readNext } from './test-helpers.js';

import {
  createEventEnvelope,
  createCloudflareTailIntakeAdapter,
  RainrailBridgeRoom,
  createGitHubWebhookSignature,
  createGitHubWebhookIntakeAdapter,
  createRainrailHttpApp,
  isCoreRoutePath,
  stableIntakeFallbackDeliveryId,
  type CloudflareTailEvent,
  type RainrailIntakeAdapter,
  type RainrailBridgeRoomState,
} from './index.js';

const TEST_PUBLISH_TOKEN = 'test-publish-token';

describe('Rainrail HTTP app', () => {
  it('registers provider-neutral HTTP intake adapters that publish envelopes through core', async () => {
    const storage = fakeState();
    const adapter: RainrailIntakeAdapter = {
      name: 'manual-test',
      routes: [{
        path: '/intake/manual',
        methods: ['POST'],
        async handle(request, context) {
          const body = await request.json() as { message: string };
          const event = createEventEnvelope({
            source: { type: 'system', name: 'manual-test' },
            name: 'manual.note',
            delivery: {
              id: 'manual-delivery-1',
              receivedAt: '2026-07-04T00:00:00.000Z',
            },
            occurredAt: '2026-07-04T00:00:00.000Z',
            subject: { type: 'note', id: 'manual-note-1' },
            payload: body,
            rawPayload: { kind: 'inline-redacted', reference: 'github://deliveries/manual-note-1' },
          });
          const publish = await context.publish(event);

          return Response.json({ ok: publish.ok, id: event.id }, { status: publish.ok ? 202 : 502 });
        },
      }],
    };
    const app = createTestApp(storage, { intakeAdapters: [adapter] });

    const response = await app.fetch(new Request('https://rainrail.local/intake/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      id: 'manual-test:manual-delivery-1:manual.note',
    });
    expect(storage.storedEvents().map((event) => event.id)).toEqual([
      'manual-test:manual-delivery-1:manual.note',
    ]);
  });

  it('applies intake route body limits before Fetch adapter handlers read the body', async () => {
    let handlerReached = false;
    const app = createTestApp(fakeState(), {
      intakeAdapters: [{
        name: 'limited-manual',
        routes: [{
          path: '/intake/limited',
          methods: ['POST'],
          maxBodyBytes: 4,
          async handle(request) {
            handlerReached = true;
            return Response.json({ body: await request.text() });
          },
        }],
      }],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/limited', {
      method: 'POST',
      body: '{"too":"large"}',
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: 'request_body_too_large' });
    expect(handlerReached).toBe(false);
  });

  it('returns not found for unregistered intake routes and rejects route conflicts at registration', async () => {
    const app = createTestApp(fakeState(), { intakeAdapters: [] });

    const missing = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
    }));

    expect(missing.status).toBe(404);
    await expect(missing.text()).resolves.toBe('not found\n');

    const adapter = (name: string): RainrailIntakeAdapter => ({
      name,
      routes: [{
        path: '/intake/conflict',
        methods: ['POST'],
        async handle() {
          return Response.json({ ok: true });
        },
      }],
    });

    expect(() => createTestApp(fakeState(), {
      intakeAdapters: [adapter('first'), adapter('second')],
    })).toThrow(/conflicting intake route/i);

    expect(() => createTestApp(fakeState(), {
      intakeAdapters: [{
        name: 'core-health-conflict',
        routes: [{
          path: '/healthz',
          methods: ['POST'],
          async handle() {
            return Response.json({ ok: true });
          },
        }],
      }],
    })).toThrow(/reserved by Rainrail core/i);

    expect(() => createTestApp(fakeState(), {
      intakeAdapters: [{
        name: 'core-v1-conflict',
        routes: [{
          path: '/api/v1/events/evt_1',
          methods: ['GET'],
          async handle() {
            return Response.json({ ok: true });
          },
        }],
      }],
    })).toThrow(/reserved by Rainrail core/i);

    expect(() => createTestApp(fakeState(), {
      intakeAdapters: [{
        name: 'core-v1-queue-release-conflict',
        routes: [{
          path: '/api/v1/queue/PVTI_1/release',
          methods: ['POST'],
          async handle() {
            return Response.json({ ok: true });
          },
        }],
      }],
    })).toThrow(/reserved by Rainrail core/i);

    expect(() => createTestApp(fakeState(), {
      intakeAdapters: [{
        name: 'core-queue-command-conflict',
        routes: [{
          path: '/api/v1/queue/actions/assign-next',
          methods: ['POST'],
          async handle() {
            return Response.json({ ok: true });
          },
        }],
      }],
    })).toThrow(/reserved by Rainrail core/i);

    expect(() => createTestApp(fakeState(), {
      intakeAdapters: [{
        name: 'core-settings-command-conflict',
        routes: [{
          path: '/api/v1/settings/actions/update',
          methods: ['POST'],
          async handle() {
            return Response.json({ ok: true });
          },
        }],
      }],
    })).toThrow(/reserved by Rainrail core/i);

    expect(isCoreRoutePath('/healthz')).toBe(true);
    expect(isCoreRoutePath('/api/v1/events/evt_1')).toBe(true);
    expect(isCoreRoutePath('/api/v1/queue/PVTI_1/release')).toBe(true);
    expect(isCoreRoutePath('/api/v1/queue/actions/assign-next')).toBe(true);
    expect(isCoreRoutePath('/api/v1/settings/actions/update')).toBe(true);
    expect(isCoreRoutePath('/intake/manual')).toBe(false);
  });

  it('dispatches tail batches to a registered intake adapter', async () => {
    const published = createEventEnvelope({
      source: { type: 'system', name: 'tail-test' },
      name: 'manual.tail',
      delivery: {
        id: 'tail-delivery-1',
        receivedAt: '2026-07-04T00:00:00.000Z',
      },
      occurredAt: '2026-07-04T00:00:00.000Z',
      subject: { type: 'tail', id: 'tail-1' },
      payload: { count: 2 },
      rawPayload: { kind: 'inline-redacted', reference: 'github://deliveries/tail-1' },
    });
    const storage = fakeState();
    const app = createTestApp(storage, {
      intakeAdapters: [{
        name: 'tail-test',
        async tail(events, context) {
          const response = await context.publish(published);
          return [{ ok: response.ok, count: events.length }];
        },
      }],
    });

    await expect(app.tail?.([{ id: 1 }, { id: 2 }])).resolves.toEqual([
      { ok: true, count: 2 },
    ]);
    expect(storage.storedEvents().map((event) => event.id)).toEqual([
      'tail-test:tail-delivery-1:manual.tail',
    ]);
  });

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
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Request-ID');
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

  it('accepts scoped dashboard tokens and legacy events bearer token for event streams', async () => {
    const app = createTestApp(fakeState(), {
      eventsBearerToken: 'events-token',
      dashboardAuth: {
        readOnlyToken: 'read-only-token',
        operatorToken: 'operator-token',
        adminToken: 'admin-token',
      },
    });

    for (const token of ['read-only-token', 'operator-token', 'admin-token', 'events-token']) {
      const events = await app.fetch(new Request('https://rainrail.local/events', {
        headers: { authorization: `Bearer ${token}` },
      }));
      expect(events.status).toBe(200);
      expect(events.headers.get('Content-Type')).toBe('text/event-stream');

      const reader = getReaderOrThrow(events);
      await expect(readNext(reader)).resolves.toBe(': connected\n\n');
      await reader.cancel();
    }
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

    const first = await app.tail?.([tailEvent]) as Array<{ id: string }> | undefined;
    const second = await app.tail?.([tailEvent]) as Array<{ id: string }> | undefined;

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
    expect(error.headers.get('Access-Control-Allow-Methods')).toContain('PATCH');
    await expect(error.json()).resolves.toEqual({ error: 'internal_server_error' });
  });

  it('reflects custom intake route methods in CORS preflight responses', async () => {
    const app = createTestApp(fakeState(), {
      intakeAdapters: [{
        name: 'manual-update',
        routes: [{
          path: '/intake/manual',
          methods: ['PUT'],
          async handle() {
            return Response.json({ ok: true });
          },
        }],
      }],
    });

    const preflight = await app.fetch(new Request('https://rainrail.local/intake/manual', {
      method: 'OPTIONS',
    }));

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('Access-Control-Allow-Methods')).toContain('PUT');
  });
});

function createTestApp(
  storage: ReturnType<typeof fakeState>,
  options: {
    eventsBearerToken?: string;
    dashboardAuth?: Parameters<typeof createRainrailHttpApp>[0]['dashboardAuth'];
    maxWebhookBodyBytes?: number;
    intakeAdapters?: RainrailIntakeAdapter[];
  } = {},
) {
  const room = new RainrailBridgeRoom(storage, {
    publishToken: TEST_PUBLISH_TOKEN,
    replayLimit: 10,
  });

  return createRainrailHttpApp({
    room,
    publishToken: TEST_PUBLISH_TOKEN,
    runtime: 'test-runtime',
    ...(options.eventsBearerToken === undefined ? {} : { eventsBearerToken: options.eventsBearerToken }),
    ...(options.dashboardAuth === undefined ? {} : { dashboardAuth: options.dashboardAuth }),
    intakeAdapters: options.intakeAdapters ?? [
      createGitHubWebhookIntakeAdapter({
        secret: 'secret',
        ...(options.maxWebhookBodyBytes === undefined ? {} : { maxBodyBytes: options.maxWebhookBodyBytes }),
      }),
      createCloudflareTailIntakeAdapter({
        fallbackDeliveryId: stableIntakeFallbackDeliveryId,
      }),
    ],
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
