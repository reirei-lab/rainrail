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
});

function cloudflareTailFixture({
  outcome,
  status = 500,
  cfRay = 'ray-1',
  exceptions = [],
}: {
  outcome: string;
  status?: number;
  cfRay?: string;
  exceptions?: Array<{ name?: string; message?: string; timestamp?: number | string }>;
}) {
  return {
    eventTimestamp: Date.parse('2026-06-15T08:12:00.000Z'),
    outcome,
    scriptName: 'asme-site',
    scriptVersion: { id: 'script-version-1' },
    exceptions,
    event: {
      request: {
        method: 'GET',
        url: 'https://asme.dev/me',
        headers: {
          'cf-ray': cfRay,
        },
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
