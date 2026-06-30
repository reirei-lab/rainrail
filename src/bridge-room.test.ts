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

  it('reserves publish order before request JSON parsing completes', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { replayLimit: 10 });
    const first = fixtureEvent('delivery-1', 'github.issue');
    const second = fixtureEvent('delivery-2', 'cloudflare.tail');
    const firstRequest = delayedJsonPublishRequest(first);
    const secondRequest = delayedJsonPublishRequest(second);

    const firstPublish = room.fetch(firstRequest.request);
    const secondPublish = room.fetch(secondRequest.request);
    secondRequest.resolve();
    await flushMicrotasks();

    expect(storage.storedEvents()).toEqual([]);

    firstRequest.resolve();
    await Promise.all([firstPublish, secondPublish]);

    expect(storage.storedEvents().map((event) => event.id)).toEqual([first.id, second.id]);
  });

  it('does not broadcast when persistence fails', async () => {
    const room = new RainrailBridgeRoom(failingPutState(), { replayLimit: 10 });
    const eventsResponse = await room.fetch(new Request('https://rainrail.local/events'));
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    expect(await readNext(reader!)).toBe(': connected\n\n');

    const publishResponse = await room.fetch(publishRequest(fixtureEvent('delivery-1', 'github.issue')));

    expect(publishResponse.status).toBe(500);
    await expect(publishResponse.text()).resolves.toBe('publish failed\n');
    await expect(readNextOrTimeout(reader!)).resolves.toBe('timeout');
    await reader?.cancel();
  });

  it('treats duplicate event ids as successful no-ops', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { replayLimit: 10 });
    const event = fixtureEvent('delivery-1', 'github.issue');

    const eventsResponse = await room.fetch(new Request('https://rainrail.local/events'));
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    expect(await readNext(reader!)).toBe(': connected\n\n');

    expect((await room.fetch(publishRequest(event))).status).toBe(200);
    expect(await readNext(reader!)).toContain(event.id);
    expect((await room.fetch(publishRequest(event))).status).toBe(200);

    expect(storage.storedEvents().map((storedEvent) => storedEvent.id)).toEqual([event.id]);
    await expect(readNextOrTimeout(reader!)).resolves.toBe('timeout');
    await reader?.cancel();
  });

  it('returns stable 500 responses when storage restore fails for GET endpoints', async () => {
    const room = new RainrailBridgeRoom(failingGetState(), { replayLimit: 10 });

    const health = await room.fetch(new Request('https://rainrail.local/healthz'));
    const events = await room.fetch(new Request('https://rainrail.local/events'));

    expect(health.status).toBe(500);
    await expect(health.text()).resolves.toBe('storage restore failed\n');
    expect(events.status).toBe(500);
    await expect(events.text()).resolves.toBe('storage restore failed\n');
  });

  it('rejects malformed publish envelopes before they reach storage or subscribers', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { replayLimit: 10 });

    const response = await room.fetch(publishRequest({}));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('invalid event envelope');
    expect(storage.storedEvents()).toEqual([]);
  });

  it('captures JSON parse failures while the publish waits in queue', async () => {
    const storage = fakeControllableState();
    const room = new RainrailBridgeRoom(storage.state, { replayLimit: 10 });
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveGet([]);
    await health;

    storage.pauseNextPut();
    const firstPublish = room.fetch(publishRequest(fixtureEvent('delivery-1', 'github.issue')));
    const secondPublish = room.fetch(rejectingJsonPublishRequest(new SyntaxError('bad json')));
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      await flushMicrotasks();
      expect(unhandledRejections).toEqual([]);

      storage.resolveNextPut();
      await firstPublish;
      const secondResponse = await secondPublish;

      expect(secondResponse.status).toBe(400);
      await expect(secondResponse.text()).resolves.toContain('bad json');
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('treats aborted JSON parse failures as aborted publishes', async () => {
    const storage = fakeControllableState();
    const room = new RainrailBridgeRoom(storage.state, { replayLimit: 10 });
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveGet([]);
    await health;

    storage.pauseNextPut();
    const firstPublish = room.fetch(publishRequest(fixtureEvent('delivery-1', 'github.issue')));
    const controller = new AbortController();
    const abortError = new DOMException('The operation was aborted.', 'AbortError');
    const secondPublish = room.fetch(rejectingJsonPublishRequest(abortError, controller.signal));
    await flushMicrotasks();

    controller.abort();
    storage.resolveNextPut();

    expect((await firstPublish).status).toBe(200);
    expect((await secondPublish).status).toBe(499);
    expect(storage.storedEvents().map((event) => event.id)).toEqual(['github.issue-source:delivery-1:github.issue']);
  });

  it('drops aborted publishes before persistence or broadcast side effects', async () => {
    const storage = fakeControllableState();
    const room = new RainrailBridgeRoom(storage.state, { replayLimit: 10 });
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveGet([]);
    await health;

    storage.pauseNextPut();
    const first = fixtureEvent('delivery-1', 'github.issue');
    const second = fixtureEvent('delivery-2', 'cloudflare.tail');
    const secondController = new AbortController();
    const firstPublish = room.fetch(publishRequest(first));
    const secondPublish = room.fetch(publishRequest(second, secondController.signal));
    await flushMicrotasks();

    secondController.abort();
    storage.resolveNextPut();

    expect((await firstPublish).status).toBe(200);
    expect((await secondPublish).status).toBe(499);
    expect(storage.storedEvents().map((event) => event.id)).toEqual([first.id]);
  });

  it('completes delivery when publish aborts after persistence succeeds', async () => {
    const storage = fakeControllableState();
    const room = new RainrailBridgeRoom(storage.state, { replayLimit: 10 });
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveGet([]);
    await health;

    const eventsResponse = await room.fetch(new Request('https://rainrail.local/events'));
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    expect(await readNext(reader!)).toBe(': connected\n\n');

    storage.pauseNextPut();
    const controller = new AbortController();
    const publish = room.fetch(publishRequest(fixtureEvent('delivery-1', 'github.issue'), controller.signal));
    await flushMicrotasks();

    controller.abort();
    storage.resolveNextPut();

    expect((await publish).status).toBe(200);
    expect(storage.storedEvents().map((event) => event.id)).toEqual(['github.issue-source:delivery-1:github.issue']);
    await expect(readNext(reader!)).resolves.toContain('github.issue-source:delivery-1:github.issue');
    await reader?.cancel();
  });

  it('strips non-contract envelope fields before storage and SSE delivery', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { replayLimit: 10 });
    const event = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      links: { raw: 'https://example.test/webhook?token=secret-link-token' },
      payload: {
        action: 'opened',
        body: 'secret top-level body',
        token: 'secret top-level token',
        status: 'queued',
        conclusion: null,
        issue: { body: 'secret issue body' },
        count: 1,
        ok: true,
        empty: null,
        labels: ['secret label'],
      },
      rawBody: 'secret raw webhook body',
      rawPayload: {
        kind: 'external-reference',
        reference: 'test://delivery-1',
        secret: 'token-like value',
      },
    };

    const publishResponse = await room.fetch(publishRequest(event));

    expect(publishResponse.status).toBe(200);
    expect(storage.storedEvents()).toHaveLength(1);
    expect(storage.storedEvents()[0]).not.toHaveProperty('rawBody');
    expect(storage.storedEvents()[0]).not.toHaveProperty('links');
    expect(storage.storedEvents()[0]?.payload).toEqual({
      action: 'opened',
      status: 'queued',
      conclusion: null,
    });
    expect(storage.storedEvents()[0]?.rawPayload).not.toHaveProperty('secret');

    const eventsResponse = await room.fetch(new Request('https://rainrail.local/events'));
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).not.toContain('secret raw webhook body');
    expect(chunk).not.toContain('secret-link-token');
    expect(chunk).not.toContain('secret top-level body');
    expect(chunk).not.toContain('secret top-level token');
    expect(chunk).not.toContain('secret issue body');
    expect(chunk).not.toContain('secret label');
    expect(chunk).not.toContain('token-like value');
  });

  it('normalizes scalar payloads to an empty object before storage and SSE delivery', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { replayLimit: 10 });
    const event = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      payload: 'secret scalar webhook body',
    };

    const publishResponse = await room.fetch(publishRequest(event));

    expect(publishResponse.status).toBe(200);
    expect(storage.storedEvents()[0]?.payload).toEqual({});

    const eventsResponse = await room.fetch(new Request('https://rainrail.local/events'));
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).not.toContain('secret scalar webhook body');
  });

  it('ignores invalid stored replay entries during restore', async () => {
    const valid = fixtureEvent('delivery-1', 'github.issue');
    const room = new RainrailBridgeRoom(storedReplayState([valid, {}, { ...valid, id: 'bad\nid' }]), { replayLimit: 10 });

    const health = await room.fetch(new Request('https://rainrail.local/healthz'));

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ recent: 1 });

    const eventsResponse = await room.fetch(new Request('https://rainrail.local/events'));
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).toContain(valid.id);
    expect(chunk).not.toContain('bad\\nid');
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
    storedEvents: () => (map.get('rainrail:recent-events') ?? []) as ReturnType<typeof fixtureEvent>[],
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

async function readNext(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return new TextDecoder().decode(value);
}

async function readNextOrTimeout(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  return Promise.race([
    readNext(reader),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 20)),
  ]);
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

function publishRequest(event: unknown, signal?: AbortSignal): Request {
  return new Request('https://rainrail.local/publish', {
    method: 'POST',
    body: JSON.stringify(event),
    ...(signal === undefined ? {} : { signal }),
  });
}

function delayedJsonPublishRequest(event: unknown) {
  let resolve: (() => void) | undefined;
  const request = new Request('https://rainrail.local/publish', { method: 'POST' });
  const json = async () => {
    await new Promise<void>((innerResolve) => {
      resolve = innerResolve;
    });
    return event;
  };

  Object.defineProperty(request, 'json', { value: json });

  return {
    request,
    resolve: () => resolve?.(),
  };
}

function rejectingJsonPublishRequest(error: unknown, signal?: AbortSignal): Request {
  const request = new Request('https://rainrail.local/publish', {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  });
  Object.defineProperty(request, 'json', {
    value: async () => {
      throw error;
    },
  });
  return request;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function failingPutState() {
  return {
    storage: {
      get: async () => [],
      put: async () => {
        throw new Error('storage unavailable');
      },
    },
  };
}

function failingGetState() {
  return {
    storage: {
      get: async () => {
        throw new Error('storage unavailable');
      },
      put: async () => undefined,
    },
  };
}

function storedReplayState(events: unknown[]) {
  return {
    storage: {
      get: async () => events,
      put: async () => undefined,
    },
  };
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
