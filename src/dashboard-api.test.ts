import { describe, expect, it } from 'vitest';

import {
  createEventEnvelope,
  createGitHubWebhookSignature,
  createRainrailHttpApp,
  RainrailBridgeRoom,
  RainrailOperationalStore,
  type RainrailBridgeRoomState,
} from './index.js';

describe('Rainrail dashboard API', () => {
  it('serves provider-neutral operational state through the HTTP app', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-25', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '25', url: 'https://github.com/reirei-lab/rainrail/issues/25' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-25' },
    }));
    operationalStore.recordActivityEvent({
      category: 'plugin',
      targetType: 'event',
      actionType: 'plugin_executed',
      outcome: 'success',
      summary: 'plugin execution completed',
    });

    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      githubWebhookSecret: 'secret',
      publishToken: 'publish-token',
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const stateResponse = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toMatchObject({
      counts: { events: 1, activityEvents: 1 },
      events: [{ id: event.id, name: 'github.issue', source: { type: 'github' } }],
      activityEvents: [{ summary: 'plugin execution completed' }],
    });

    const detailResponse = await app.fetch(new Request(`https://rainrail.local/api/events/${encodeURIComponent(event.id)}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: event.id,
      envelope: { subject: { type: 'issue', id: '25' } },
    });

    operationalStore.close();
  });

  it('protects operational dashboard API with the event bearer token', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const event = operationalStore.recordEvent(createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: { id: 'delivery-auth', receivedAt: '2026-07-02T00:00:00.000Z' },
      occurredAt: '2026-07-02T00:00:00.000Z',
      subject: { type: 'issue', id: '25' },
      payload: { action: 'opened' },
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/delivery-auth' },
    }));
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      githubWebhookSecret: 'secret',
      publishToken: 'publish-token',
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const missingStateAuth = await app.fetch(new Request('https://rainrail.local/api/state'));
    expect(missingStateAuth.status).toBe(401);
    await expect(missingStateAuth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const missingDetailAuth = await app.fetch(new Request(`https://rainrail.local/api/events/${event.id}`));
    expect(missingDetailAuth.status).toBe(401);
    await expect(missingDetailAuth.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const state = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(state.status).toBe(200);

    const detail = await app.fetch(new Request(`https://rainrail.local/api/events/${event.id}`, {
      headers: { authorization: 'Bearer events-token' },
    }));
    expect(detail.status).toBe(200);

    operationalStore.close();
  });

  it('returns a stable unavailable response when the operational store is not configured', async () => {
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      githubWebhookSecret: 'secret',
      publishToken: 'publish-token',
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/state'));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'operational_store_not_configured' });
  });

  it('records HTTP-ingressed events in the operational store after publish succeeds', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      githubWebhookSecret: 'secret',
      publishToken: 'publish-token',
      eventsBearerToken: 'events-token',
      operationalStore,
    });
    const rawBody = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      issue: {
        number: 25,
        title: 'store、retry/reconcile、dashboard/API を移植する',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/25',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-operational-store',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));
    expect(webhook.status).toBe(202);

    const state = await app.fetch(new Request('https://rainrail.local/api/state', {
      headers: { authorization: 'Bearer events-token' },
    }));
    await expect(state.json()).resolves.toMatchObject({
      events: [{ id: 'github-webhook:delivery-operational-store:github.issue' }],
    });

    operationalStore.close();
  });

  it('does not fail an already-published webhook when operational event recording fails', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      githubWebhookSecret: 'secret',
      publishToken: 'publish-token',
      eventsBearerToken: 'events-token',
      operationalStore,
    });
    operationalStore.close();
    const rawBody = JSON.stringify({
      action: 'opened',
      repository: {
        full_name: 'reirei-lab/rainrail',
        html_url: 'https://github.com/reirei-lab/rainrail',
      },
      issue: {
        number: 25,
        title: 'store、retry/reconcile、dashboard/API を移植する',
        html_url: 'https://github.com/reirei-lab/rainrail/issues/25',
      },
    });

    const webhook = await app.fetch(new Request('https://rainrail.local/webhooks/github', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'delivery-operational-store-failure',
        'x-hub-signature-256': await createGitHubWebhookSignature('secret', rawBody),
      },
      body: rawBody,
    }));

    expect(webhook.status).toBe(202);
    await expect(webhook.json()).resolves.toMatchObject({
      id: 'github-webhook:delivery-operational-store-failure:github.issue',
    });
  });

  it('treats malformed percent-encoded event ids as client errors', async () => {
    const operationalStore = new RainrailOperationalStore({
      databasePath: ':memory:',
      eventLimit: 10,
      now: () => new Date('2026-07-02T00:00:00.000Z'),
    });
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(fakeState(), { publishToken: 'publish-token' }),
      githubWebhookSecret: 'secret',
      publishToken: 'publish-token',
      eventsBearerToken: 'events-token',
      operationalStore,
    });

    const response = await app.fetch(new Request('https://rainrail.local/api/events/%E0%A4%A', {
      headers: { authorization: 'Bearer events-token' },
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: 'invalid_event_id' });
    operationalStore.close();
  });
});

function fakeState(): RainrailBridgeRoomState {
  const values = new Map<string, unknown>([['rainrail:recent-events', []]]);
  return {
    storage: {
      async get(key) {
        return values.get(key);
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
  };
}
