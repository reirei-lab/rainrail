import { describe, expect, it } from 'vitest';

import {
  createEventEnvelope,
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
      operationalStore,
    });

    const stateResponse = await app.fetch(new Request('https://rainrail.local/api/state'));
    expect(stateResponse.status).toBe(200);
    await expect(stateResponse.json()).resolves.toMatchObject({
      counts: { events: 1, activityEvents: 1 },
      events: [{ id: event.id, name: 'github.issue', source: { type: 'github' } }],
      activityEvents: [{ summary: 'plugin execution completed' }],
    });

    const detailResponse = await app.fetch(new Request(`https://rainrail.local/api/events/${encodeURIComponent(event.id)}`));
    expect(detailResponse.status).toBe(200);
    await expect(detailResponse.json()).resolves.toMatchObject({
      id: event.id,
      envelope: { subject: { type: 'issue', id: '25' } },
    });

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
