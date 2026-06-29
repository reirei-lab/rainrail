import { describe, expect, it } from 'vitest';

import { createEventEnvelope, RainrailBridgeRoom } from './index.js';

describe('Rainrail bridge room', () => {
  it('stores published events and replays them through the Fetch SSE endpoint', async () => {
    const room = new RainrailBridgeRoom(fakeState(), { replayLimit: 10 });
    const event = createEventEnvelope({
      source: { type: 'github', name: 'github-webhook', repository: 'reirei-lab/rainrail' },
      name: 'github.issue',
      delivery: {
        id: 'delivery-17',
        receivedAt: '2026-06-29T18:18:21.000Z',
      },
      occurredAt: '2026-06-29T18:18:20.000Z',
      subject: { type: 'issue', id: '17' },
      payload: { action: 'opened' },
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-17',
      },
    });

    const publishResponse = await room.fetch(
      new Request('https://rainrail.local/publish', {
        method: 'POST',
        body: JSON.stringify(event),
      }),
    );

    expect(publishResponse.status).toBe(200);
    await expect(publishResponse.json()).resolves.toMatchObject({
      ok: true,
      id: event.id,
      name: 'github.issue',
      clients: 0,
    });

    const eventsResponse = await room.fetch(new Request('https://rainrail.local/events'));

    expect(eventsResponse.status).toBe(200);
    expect(eventsResponse.headers.get('Content-Type')).toBe('text/event-stream');

    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).toContain(': connected\n\n');
    expect(chunk).toContain('event: github.issue\n');
    expect(chunk).toContain('"id":"github-webhook:delivery-17:github.issue"');
  });

  it('reports health for current subscribers and replay buffer', async () => {
    const room = new RainrailBridgeRoom(fakeState(), { replayLimit: 10 });
    const response = await room.fetch(new Request('https://rainrail.local/healthz'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      clients: 0,
      recent: 0,
    });
  });

  it('serializes initial restore so concurrent publishes do not replay stale storage', async () => {
    const storage = fakeControllableState();
    const room = new RainrailBridgeRoom(storage.state, { replayLimit: 10 });
    const first = fixtureEvent('delivery-1', 'github.issue');
    const second = fixtureEvent('delivery-2', 'cloudflare.tail');

    const firstPublish = room.fetch(publishRequest(first));
    const secondPublish = room.fetch(publishRequest(second));
    await flushMicrotasks();

    expect(storage.getCalls).toBe(1);
    storage.resolveGet([]);

    await Promise.all([firstPublish, secondPublish]);

    expect(storage.storedEvents().map((event) => event.id)).toEqual([first.id, second.id]);
  });

  it('serializes publish persistence so slow stale snapshots cannot overwrite newer events', async () => {
    const storage = fakeControllableState();
    const room = new RainrailBridgeRoom(storage.state, { replayLimit: 10 });
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveGet([]);
    await health;

    storage.pauseNextPut();
    const first = fixtureEvent('delivery-1', 'github.issue');
    const second = fixtureEvent('delivery-2', 'cloudflare.tail');
    const firstPublish = room.fetch(publishRequest(first));
    const secondPublish = room.fetch(publishRequest(second));
    await flushMicrotasks();

    expect(storage.pendingPutCount()).toBe(1);
    storage.resolveNextPut();
    await Promise.all([firstPublish, secondPublish]);

    expect(storage.storedEvents().map((event) => event.id)).toEqual([first.id, second.id]);
  });

  it('passes Last-Event-ID to the SSE replay policy', async () => {
    const room = new RainrailBridgeRoom(fakeState(), { replayLimit: 10 });
    const first = fixtureEvent('delivery-1', 'github.issue');
    const second = fixtureEvent('delivery-2', 'cloudflare.tail');

    await room.fetch(publishRequest(first));
    await room.fetch(publishRequest(second));

    const response = await room.fetch(
      new Request('https://rainrail.local/events', {
        headers: { 'Last-Event-ID': first.id },
      }),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'cloudflare.tail');
    await reader?.cancel();

    expect(chunk).not.toContain('event: github.issue\n');
    expect(chunk).toContain('event: cloudflare.tail\n');
  });
});

function fakeState() {
  const map = new Map<string, unknown>();

  return {
    storage: {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
    },
  };
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, expected: string): Promise<string> {
  const decoder = new TextDecoder();
  let text = '';

  for (let index = 0; index < 10; index += 1) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
    if (text.includes(expected)) return text;
  }

  return text;
}

function fixtureEvent(deliveryId: string, name: 'github.issue' | 'cloudflare.tail') {
  return createEventEnvelope({
    source: { type: name.startsWith('cloudflare') ? 'cloudflare' : 'github', name: `${name}-source` },
    name,
    delivery: {
      id: deliveryId,
      receivedAt: '2026-06-29T18:18:21.000Z',
    },
    occurredAt: '2026-06-29T18:18:20.000Z',
    subject: { type: name.startsWith('cloudflare') ? 'worker' : 'issue', id: deliveryId },
    payload: { deliveryId },
    rawPayload: {
      kind: 'external-reference',
      reference: `test://${deliveryId}`,
    },
  });
}

function publishRequest(event: unknown): Request {
  return new Request('https://rainrail.local/publish', {
    method: 'POST',
    body: JSON.stringify(event),
  });
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function fakeControllableState() {
  let getCalls = 0;
  let stored: unknown = undefined;
  let resolveGet: ((value: unknown) => void) | undefined;
  let getPromise: Promise<unknown> | undefined;
  const pendingPuts: Array<() => void> = [];
  let shouldPauseNextPut = false;

  return {
    get getCalls() {
      return getCalls;
    },
    state: {
      storage: {
        get: async () => {
          getCalls += 1;
          getPromise ??= new Promise((resolve) => {
            resolveGet = resolve;
          });
          return getPromise;
        },
        put: async (_key: string, value: unknown) => {
          if (shouldPauseNextPut) {
            shouldPauseNextPut = false;
            await new Promise<void>((resolve) => pendingPuts.push(resolve));
          }
          stored = value;
        },
      },
    },
    resolveGet: (value: unknown) => {
      resolveGet?.(value);
    },
    pauseNextPut: () => {
      shouldPauseNextPut = true;
    },
    pendingPutCount: () => pendingPuts.length,
    resolveNextPut: () => {
      pendingPuts.shift()?.();
    },
    storedEvents: () => stored as ReturnType<typeof fixtureEvent>[],
  };
}
