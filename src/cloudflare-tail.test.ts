import { describe, expect, it } from 'vitest';

import {
  RainrailBridgeRoom,
  createCloudflareTailEvent,
  createCloudflareTailSourcePlugin,
  publishCloudflareTailEvents,
  type RainrailEventEnvelope,
  type RainrailBridgeRoomState,
} from './index.js';

const TEST_PUBLISH_TOKEN = 'test-publish-token';

describe('Cloudflare tail source', () => {
  it('normalizes Cloudflare Worker exceptions as subscribable cloudflare.error events', async () => {
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({
        outcome: 'exception',
        exceptions: [{
          name: 'TypeError',
          message: 'Cannot read properties of null',
          timestamp: Date.parse('2026-06-15T08:12:00.000Z'),
        }],
      }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });

    expect(event).toMatchObject({
      source: {
        type: 'cloudflare',
        name: 'cloudflare-tail',
      },
      name: 'cloudflare.error',
      delivery: {
        receivedAt: '2026-06-15T08:12:01.000Z',
      },
      occurredAt: '2026-06-15T08:12:00.000Z',
      subject: {
        type: 'worker',
        id: 'asme-site',
      },
      payload: {
        action: 'exception',
        status: '500',
        conclusion: 'failure',
        scriptName: 'asme-site',
        scriptVersion: 'script-version-1',
        method: 'GET',
        url: 'https://asme.dev/me',
        cfRay: 'ray-1',
        exceptions: [{
          name: 'TypeError',
          message: 'Cannot read properties of null',
          timestamp: '2026-06-15T08:12:00.000Z',
        }],
      },
      rawPayload: {
        kind: 'external-reference',
      },
    });
    expect(event.id).toBe('cloudflare-tail:tail-asme-site-20260615T081200000Z-ray-1:cloudflare.error');
    expect(event.delivery.id).toBe('tail-asme-site-20260615T081200000Z-ray-1');
    expect(event.rawPayload.reference).toBe('cloudflare://deliveries/tail-asme-site-20260615T081200000Z-ray-1');
  });

  it('normalizes successful Cloudflare Worker invocations as cloudflare.tail events', async () => {
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', status: 200, cfRay: 'ray-2' }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });

    expect(event.name).toBe('cloudflare.tail');
    expect(event.payload).toMatchObject({
      action: 'ok',
      status: '200',
      conclusion: 'success',
      cfRay: 'ray-2',
    });
    expect(event.delivery.id).toBe('tail-asme-site-20260615T081200000Z-ray-2');
  });

  it('exposes Cloudflare tail normalization as a Rainrail source plugin', async () => {
    const plugin = createCloudflareTailSourcePlugin('worker-tail');
    const event = await plugin.normalize(
      cloudflareTailFixture({ outcome: 'ok', status: 204, cfRay: 'ray-3' }),
      {
        pluginName: 'worker-tail',
        deliveryId: 'ignored-by-tail-source',
        receivedAt: '2026-06-15T08:12:02.000Z',
        metadata: { account: 'prod-account', environment: 'production' },
        rawPayload: {
          kind: 'external-reference',
          reference: 'cloudflare://deliveries/ignored-by-tail-source',
        },
      },
    );

    expect(event.source).toEqual({
      type: 'cloudflare',
      name: 'worker-tail',
      account: 'prod-account',
      environment: 'production',
    });
    expect(event.delivery.receivedAt).toBe('2026-06-15T08:12:02.000Z');
    expect(event.name).toBe('cloudflare.tail');
  });

  it('uses source plugin context delivery ids when cf-ray is missing', async () => {
    const plugin = createCloudflareTailSourcePlugin('worker-tail');
    const context = {
      pluginName: 'worker-tail',
      deliveryId: 'stable-delivery-1',
      receivedAt: '2026-06-15T08:12:02.000Z',
      metadata: {},
      rawPayload: {
        kind: 'external-reference' as const,
        reference: 'cloudflare://deliveries/stable-delivery-1',
      },
    };

    const first = await plugin.normalize(cloudflareTailFixture({ outcome: 'ok', cfRay: null }), context);
    const second = await plugin.normalize(cloudflareTailFixture({ outcome: 'ok', cfRay: null }), context);

    expect(first.delivery.id).toBe('tail-asme-site-20260615T081200000Z-stable-delivery-1');
    expect(second.id).toBe(first.id);
  });

  it('classifies outcome exception as cloudflare.error even without exception details', async () => {
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'exception', exceptions: [] }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });

    expect(event.name).toBe('cloudflare.error');
    expect(event.payload).toMatchObject({
      action: 'exception',
      conclusion: 'failure',
    });
  });

  it('preserves failure outcome spelling and routes it as cloudflare.error', async () => {
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({
        outcome: 'exceededCpu',
        status: 200,
        exceptions: [],
      }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });

    expect(event.name).toBe('cloudflare.error');
    expect(event.payload).toMatchObject({
      action: 'exceededCpu',
      status: '200',
      conclusion: 'failure',
    });
  });

  it('publishes Cloudflare tail batches into the Rainrail events stream', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const eventsResponse = await room.fetch(eventsRequest());
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    expect(await readNext(reader!)).toBe(': connected\n\n');

    const result = await publishCloudflareTailEvents([
      cloudflareTailFixture({
        outcome: 'exception',
        exceptions: [{ name: 'Error', message: 'boom' }],
      }),
    ], {
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      publish: (event) => room.fetch(publishRequest(event)),
    });

    const chunk = await readUntil(reader!, 'cloudflare.error');
    await reader?.cancel();

    expect(result).toEqual([{ ok: true, id: 'cloudflare-tail:tail-asme-site-20260615T081200000Z-ray-1:cloudflare.error' }]);
    expect(chunk).toContain('event: cloudflare.error\n');
    expect(chunk).toContain('"source":{"type":"cloudflare","name":"cloudflare-tail"}');
    expect(chunk).toContain('"subject":{"type":"worker","id":"asme-site"}');
    expect(storage.storedEvents()[0]?.payload).toEqual({
      action: 'exception',
      status: '500',
      conclusion: 'failure',
    });
  });

  it('keeps fallback delivery ids unique inside a cf-ray-less batch', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const result = await publishCloudflareTailEvents([
      cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
    ], {
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'stable-batch-delivery',
      publish: (event) => room.fetch(publishRequest(event)),
    });

    expect(result).toEqual([
      { ok: true, id: 'cloudflare-tail:tail-asme-site-20260615T081200000Z-stable-batch-delivery-0:cloudflare.tail' },
      { ok: true, id: 'cloudflare-tail:tail-asme-site-20260615T081200000Z-stable-batch-delivery-1:cloudflare.tail' },
    ]);
    expect(storage.storedEvents()).toHaveLength(2);
  });

  it('publishes Cloudflare tail batches in input order', async () => {
    const arrivals: Array<string | null> = [];

    await publishCloudflareTailEvents([
      cloudflareTailFixture({ outcome: 'ok', cfRay: 'ray-1' }),
      cloudflareTailFixture({ outcome: 'ok', cfRay: 'ray-2' }),
    ], {
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      publish: async (event) => {
        if (event.payload.cfRay === 'ray-1') {
          await delay(10);
        }
        arrivals.push(event.payload.cfRay);
        return Response.json({ ok: true });
      },
    });

    expect(arrivals).toEqual(['ray-1', 'ray-2']);
  });

  it('keeps default event ids publishable for long worker names without cf-ray', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const result = await publishCloudflareTailEvents([
      cloudflareTailFixture({
        outcome: 'exception',
        cfRay: null,
        scriptName: 'very-long-worker-name-that-used-to-overflow-rainrail-event-identifier-limits',
      }),
    ], {
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'stable-delivery-without-cf-ray',
      publish: (event) => room.fetch(publishRequest(event)),
    });

    expect(result[0]?.ok).toBe(true);
    expect(result[0]?.id).toContain('stable-delivery-without-cf-ray');
    expect(result[0]?.id.length).toBeLessThanOrEqual(128);
    expect(storage.storedEvents()).toHaveLength(1);
  });

  it('keeps fallback delivery ids with colons publishable as Cloudflare references', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const result = await publishCloudflareTailEvents([
      cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
    ], {
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'queue:delivery:1',
      publish: (event) => room.fetch(publishRequest(event)),
    });

    expect(result[0]?.ok).toBe(true);
    expect(storage.storedEvents()[0]?.rawPayload.reference).toBe('cloudflare://deliveries/tail-asme-site-20260615T081200000Z-queue-delivery-1-0');
  });

  it('keeps retry ids stable when eventTimestamp is missing', async () => {
    const first = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', eventTimestamp: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'stable-missing-timestamp',
    });
    await delay(10);
    const second = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', eventTimestamp: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'stable-missing-timestamp',
    });

    expect(first.occurredAt).toBe('2026-06-15T08:12:01.000Z');
    expect(second.id).toBe(first.id);
  });

  it('keeps event ids publishable when source names are long', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const sourceName = 'a'.repeat(64);
    const result = await publishCloudflareTailEvents([
      cloudflareTailFixture({
        outcome: 'exception',
        cfRay: null,
        scriptName: 'very-long-worker-name-that-used-to-overflow-rainrail-event-identifier-limits',
      }),
    ], {
      sourceName,
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'stable-delivery-without-cf-ray',
      publish: (event) => room.fetch(publishRequest(event)),
    });

    expect(result[0]?.ok).toBe(true);
    expect(result[0]?.id.length).toBeLessThanOrEqual(128);
    expect(storage.storedEvents()).toHaveLength(1);
  });

  it('does not collapse long fallback suffixes to unknown when preserving their ends', async () => {
    const first = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: `${'a'.repeat(40)}-${'b'.repeat(31)}`,
    });
    const second = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: `${'c'.repeat(40)}-${'d'.repeat(31)}`,
    });

    expect(first.delivery.id).not.toContain('unknown-ray');
    expect(second.delivery.id).not.toContain('unknown-ray');
    expect(second.id).not.toBe(first.id);
  });
});

function cloudflareTailFixture({
  outcome,
  status = 500,
  cfRay = 'ray-1',
  exceptions = [],
  scriptName = 'asme-site',
  eventTimestamp = Date.parse('2026-06-15T08:12:00.000Z'),
}: {
  outcome: string;
  status?: number;
  cfRay?: string | null;
  exceptions?: Array<{ name?: string; message?: string; timestamp?: number | string }>;
  scriptName?: string;
  eventTimestamp?: number | string | null;
}) {
  const headers = cfRay === null ? {} : { 'cf-ray': cfRay };

  return {
    ...(eventTimestamp === null ? {} : { eventTimestamp }),
    outcome,
    scriptName,
    scriptVersion: { id: 'script-version-1' },
    exceptions,
    event: {
      request: {
        method: 'GET',
        url: 'https://asme.dev/me',
        headers,
      },
      response: {
        status,
      },
    },
  };
}

function fakeState(initialEvents: unknown[] = []): RainrailBridgeRoomState & { storedEvents: () => RainrailEventEnvelope[] } {
  const map = new Map<string, unknown>();
  map.set('rainrail:recent-events', initialEvents);

  return {
    storage: {
      get: async (key: string) => map.get(key),
      put: async (key: string, value: unknown) => {
        map.set(key, value);
      },
    },
    storedEvents: () => (map.get('rainrail:recent-events') ?? []) as RainrailEventEnvelope[],
  };
}

function publishRequest(event: unknown): Request {
  return new Request('https://rainrail.local/publish', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_PUBLISH_TOKEN}` },
    body: JSON.stringify(event),
  });
}

function eventsRequest(): Request {
  return new Request('https://rainrail.local/events', {
    headers: { Authorization: `Bearer ${TEST_PUBLISH_TOKEN}` },
  });
}

async function readNext(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return new TextDecoder().decode(value);
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

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
