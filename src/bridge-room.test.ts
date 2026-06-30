import { describe, expect, it } from 'vitest';

import { createEventEnvelope, RainrailBridgeRoom, type RainrailBridgeRoomOptions, type RainrailBridgeRoomState } from './index.js';

const TEST_PUBLISH_TOKEN = 'test-publish-token';

describe('Rainrail bridge room', () => {
  it('stores published events and replays them through the Fetch SSE endpoint', async () => {
    const room = createTestRoom(fakeState(), { replayLimit: 10 });
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

    const publishResponse = await room.fetch(publishRequest(event));

    expect(publishResponse.status).toBe(200);
    await expect(publishResponse.json()).resolves.toMatchObject({
      ok: true,
      id: event.id,
      name: 'github.issue',
      clients: 0,
    });

    const eventsResponse = await room.fetch(eventsRequest());

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
    const room = createTestRoom(fakeState(), { replayLimit: 10 });
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
    const room = createTestRoom(storage.state, { replayLimit: 10 });
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
    const room = createTestRoom(storage.state, { replayLimit: 10 });
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
    const room = createTestRoom(storage, { replayLimit: 10 });
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
    const room = createTestRoom(failingPutState(), { replayLimit: 10 });
    const eventsResponse = await room.fetch(eventsRequest());
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
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = fixtureEvent('delivery-1', 'github.issue');

    const eventsResponse = await room.fetch(eventsRequest());
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

  it('rejects multiple rooms using the same storage backend', () => {
    const storage = fakeState();
    createTestRoom(storage, { replayLimit: 10 });

    expect(() => createTestRoom(storage, { replayLimit: 10 })).toThrow('single room');
  });

  it('does not reserve storage when constructor option validation fails', () => {
    const storage = fakeState();

    expect(() => createTestRoom(storage, { replayLimit: Number.NaN })).toThrow('replayLimit');
    expect(() => createTestRoom(storage, { replayLimit: 10 })).not.toThrow();
  });

  it('serializes subscribe refresh with publish delivery', async () => {
    const storage = fakeDelayedSecondGetState();
    const room = createTestRoom(storage.state, { replayLimit: 10 });
    const event = fixtureEvent('delivery-1', 'github.issue');
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveNextGet([]);
    await health;

    const events = room.fetch(eventsRequest());
    await flushMicrotasks();
    expect(storage.getCalls).toBe(2);
    expect(storage.pendingGetCount()).toBe(1);

    const publish = room.fetch(publishRequest(event));
    await flushMicrotasks();
    expect(storage.storedEvents()).toBeUndefined();

    storage.resolveNextGet([]);
    const eventsResponse = await events;
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    expect(await readNext(reader!)).toBe(': connected\n\n');

    expect((await publish).status).toBe(200);
    expect(await readNext(reader!)).toContain(event.id);
    await reader?.cancel();
  });

  it('skips aborted event subscription refreshes queued behind publishes', async () => {
    const storage = countingState();
    const room = createTestRoom(storage.state, { replayLimit: 10 });
    const health = await room.fetch(new Request('https://rainrail.local/healthz'));
    expect(health.status).toBe(200);
    expect(storage.getCalls).toBe(1);

    const delayedPublish = delayedJsonPublishRequest(fixtureEvent('delivery-1', 'github.issue'));
    const publish = room.fetch(delayedPublish.request);
    await flushMicrotasks();

    const controller = new AbortController();
    const events = room.fetch(eventsRequest(TEST_PUBLISH_TOKEN, {}, controller.signal));
    controller.abort();

    delayedPublish.resolve();

    expect((await publish).status).toBe(200);
    expect((await events).status).toBe(499);
    expect(storage.getCalls).toBe(2);
  });

  it('keeps duplicate replay ids at their latest occurrence when enforcing replay limits', async () => {
    const staleDuplicate = fixtureEvent('delivery-1', 'github.issue');
    const other = fixtureEvent('delivery-2', 'cloudflare.tail');
    const latestDuplicate = {
      ...staleDuplicate,
      occurredAt: '2026-06-29T18:18:22.000Z',
      payload: { action: 'replayed-latest' },
    };
    const storage = fakeState([staleDuplicate, other, latestDuplicate]);
    const room = createTestRoom(storage, { replayLimit: 1 });

    expect((await room.fetch(publishRequest(latestDuplicate))).status).toBe(200);

    expect(storage.storedEvents()).toEqual([staleDuplicate, other, latestDuplicate]);
  });

  it('returns stable 500 responses when storage restore fails for GET endpoints', async () => {
    const room = createTestRoom(failingGetState(), { replayLimit: 10 });

    const health = await room.fetch(new Request('https://rainrail.local/healthz'));
    const events = await room.fetch(eventsRequest());

    expect(health.status).toBe(500);
    await expect(health.text()).resolves.toBe('storage restore failed\n');
    expect(events.status).toBe(500);
    await expect(events.text()).resolves.toBe('storage restore failed\n');
  });

  it('rejects malformed publish envelopes before they reach storage or subscribers', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });

    const response = await room.fetch(publishRequest({}));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('invalid event envelope');
    expect(storage.storedEvents()).toEqual([]);
  });

  it('rejects publish requests without the configured capability token', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = fixtureEvent('delivery-1', 'github.issue');

    const missingToken = await room.fetch(publishRequest(event, undefined, null));
    const wrongToken = await room.fetch(publishRequest(event, undefined, 'wrong-token'));

    expect(missingToken.status).toBe(401);
    await expect(missingToken.text()).resolves.toBe('unauthorized\n');
    expect(wrongToken.status).toBe(401);
    expect(storage.storedEvents()).toEqual([]);
  });

  it('rejects event subscriptions without the configured capability token', async () => {
    const room = createTestRoom(failingGetState(), { replayLimit: 10 });

    const missingToken = await room.fetch(eventsRequest(null));
    const wrongToken = await room.fetch(eventsRequest('wrong-token'));

    expect(missingToken.status).toBe(401);
    await expect(missingToken.text()).resolves.toBe('unauthorized\n');
    expect(wrongToken.status).toBe(401);
  });

  it('does not preserve invalid URL strings in normalized envelopes', async () => {
    const subjectStorage = fakeState();
    const subjectRoom = createTestRoom(subjectStorage, { replayLimit: 10 });
    const invalidSubjectUrlEvent = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      subject: { type: 'issue', id: 'delivery-1', url: 'token=secret-subject-url' },
    };

    expect((await subjectRoom.fetch(publishRequest(invalidSubjectUrlEvent))).status).toBe(200);
    expect(subjectStorage.storedEvents()[0]?.subject).not.toHaveProperty('url');

    const referenceStorage = fakeState();
    const referenceRoom = createTestRoom(referenceStorage, { replayLimit: 10 });
    const invalidReferenceEvent = {
      ...fixtureEvent('delivery-2', 'github.issue'),
      rawPayload: { kind: 'external-reference', reference: 'token=secret-reference' },
    };

    const response = await referenceRoom.fetch(publishRequest(invalidReferenceEvent));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('reference must be a valid URL');
    expect(referenceStorage.storedEvents()).toEqual([]);
  });

  it('drops arbitrary HTTPS paths before storage', async () => {
    const subjectStorage = fakeState();
    const subjectRoom = createTestRoom(subjectStorage, { replayLimit: 10 });
    const secretSubjectUrlEvent = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      subject: { type: 'issue', id: 'delivery-1', url: 'https://storage.example/tokens/secret-subject-url' },
    };

    expect((await subjectRoom.fetch(publishRequest(secretSubjectUrlEvent))).status).toBe(200);
    expect(subjectStorage.storedEvents()[0]?.subject).not.toHaveProperty('url');

    const referenceStorage = fakeState();
    const referenceRoom = createTestRoom(referenceStorage, { replayLimit: 10 });
    const secretReferenceEvent = {
      ...fixtureEvent('delivery-2', 'github.issue'),
      rawPayload: { kind: 'external-reference', reference: 'https://storage.example/tokens/secret-reference' },
    };

    const response = await referenceRoom.fetch(publishRequest(secretReferenceEvent));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('reference must be a valid URL');
    expect(referenceStorage.storedEvents()).toEqual([]);
  });

  it('rejects non-allowlisted URL schemes before storage', async () => {
    const subjectStorage = fakeState();
    const subjectRoom = createTestRoom(subjectStorage, { replayLimit: 10 });
    const opaqueSubjectUrlEvent = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      subject: { type: 'issue', id: 'delivery-1', url: 'data:text/plain,token=secret-subject-url' },
    };

    expect((await subjectRoom.fetch(publishRequest(opaqueSubjectUrlEvent))).status).toBe(200);
    expect(subjectStorage.storedEvents()[0]?.subject).not.toHaveProperty('url');

    const referenceStorage = fakeState();
    const referenceRoom = createTestRoom(referenceStorage, { replayLimit: 10 });
    const opaqueReferenceEvent = {
      ...fixtureEvent('delivery-2', 'github.issue'),
      rawPayload: { kind: 'external-reference', reference: 'javascript:token=secret-reference' },
    };

    const response = await referenceRoom.fetch(publishRequest(opaqueReferenceEvent));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('reference must be a valid URL');
    expect(referenceStorage.storedEvents()).toEqual([]);
  });

  it('accepts Cloudflare delivery references', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = fixtureEvent('delivery-1', 'cloudflare.tail');

    const response = await room.fetch(publishRequest(event));

    expect(response.status).toBe(200);
    expect(storage.storedEvents()[0]?.rawPayload.reference).toBe('cloudflare://deliveries/delivery-1');
  });

  it('accepts safe GitHub repository and check run URLs', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const repositoryEvent = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      subject: { type: 'repository', id: 'reirei-lab/rainrail', url: 'https://github.com/reirei-lab/rainrail' },
    };
    const checkRunEvent = {
      ...fixtureEvent('delivery-2', 'github.issue'),
      subject: { type: 'check_run', id: '1234567890', url: 'https://github.com/reirei-lab/rainrail/runs/1234567890' },
    };

    expect((await room.fetch(publishRequest(repositoryEvent))).status).toBe(200);
    expect((await room.fetch(publishRequest(checkRunEvent))).status).toBe(200);

    expect(storage.storedEvents().map((event) => event.subject.url)).toEqual([
      'https://github.com/reirei-lab/rainrail',
      'https://github.com/reirei-lab/rainrail/runs/1234567890',
    ]);
  });

  it('rejects unsafe delivery reference paths before storage', async () => {
    const secretPathStorage = fakeState();
    const secretPathRoom = createTestRoom(secretPathStorage, { replayLimit: 10 });
    const secretPathEvent = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      rawPayload: { kind: 'external-reference', reference: 'github://deliveries/token=secret' },
    };

    const secretPathResponse = await secretPathRoom.fetch(publishRequest(secretPathEvent));

    expect(secretPathResponse.status).toBe(400);
    await expect(secretPathResponse.text()).resolves.toContain('reference must be a valid URL');
    expect(secretPathStorage.storedEvents()).toEqual([]);

    const nestedPathStorage = fakeState();
    const nestedPathRoom = createTestRoom(nestedPathStorage, { replayLimit: 10 });
    const nestedPathEvent = {
      ...fixtureEvent('delivery-2', 'cloudflare.tail'),
      rawPayload: { kind: 'external-reference', reference: 'cloudflare://deliveries/tokens/secret' },
    };

    const nestedPathResponse = await nestedPathRoom.fetch(publishRequest(nestedPathEvent));

    expect(nestedPathResponse.status).toBe(400);
    await expect(nestedPathResponse.text()).resolves.toContain('reference must be a valid URL');
    expect(nestedPathStorage.storedEvents()).toEqual([]);
  });

  it('rejects unknown raw payload kinds before storage', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      rawPayload: {
        kind: 'token=secret-kind',
        reference: 'github://deliveries/delivery-1',
      },
    };

    const response = await room.fetch(publishRequest(event));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('kind must be a known raw payload kind');
    expect(storage.storedEvents()).toEqual([]);
  });

  it('captures JSON parse failures while the publish waits in queue', async () => {
    const storage = fakeControllableState();
    const room = createTestRoom(storage.state, { replayLimit: 10 });
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveGet([]);
    await health;

    storage.pauseNextPut();
    const firstPublish = room.fetch(publishRequest(fixtureEvent('delivery-1', 'github.issue')));
    const secondPublish = room.fetch(rejectingJsonPublishRequest(new SyntaxError('"secret-token" is not valid JSON')));
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
      await expect(secondResponse.text()).resolves.toBe('invalid event envelope: malformed JSON\n');
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('treats aborted JSON parse failures as aborted publishes', async () => {
    const storage = fakeControllableState();
    const room = createTestRoom(storage.state, { replayLimit: 10 });
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
    const room = createTestRoom(storage.state, { replayLimit: 10 });
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

  it('drops aborted publishes after loading the latest storage snapshot and before persistence', async () => {
    const storage = fakeDelayedSecondGetState();
    const room = createTestRoom(storage.state, { replayLimit: 10 });
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveNextGet([]);
    await health;

    const controller = new AbortController();
    const publish = room.fetch(publishRequest(fixtureEvent('delivery-1', 'github.issue'), controller.signal));
    await flushMicrotasks();

    expect(storage.getCalls).toBe(2);
    expect(storage.pendingGetCount()).toBe(1);
    controller.abort();
    storage.resolveNextGet([]);

    expect((await publish).status).toBe(499);
    expect(storage.storedEvents()).toBeUndefined();
  });

  it('completes delivery when publish aborts after persistence succeeds', async () => {
    const storage = fakeControllableState();
    const room = createTestRoom(storage.state, { replayLimit: 10 });
    const health = room.fetch(new Request('https://rainrail.local/healthz'));
    expect(storage.getCalls).toBe(1);
    storage.resolveGet([]);
    await health;

    const eventsResponse = await room.fetch(eventsRequest());
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
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      subject: {
        type: 'issue',
        id: 'delivery-1',
        url: 'https://token:secret@github.com/reirei-lab/rainrail/issues/17?token=secret-subject-token#secret-fragment',
      },
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
        reference: 'github://deliveries/delivery-1',
        contentType: 'token=secret-content-type',
        sha256: 'token=secret-sha-value',
        secret: 'token-like value',
      },
    };

    const publishResponse = await room.fetch(publishRequest(event));

    expect(publishResponse.status).toBe(200);
    expect(storage.storedEvents()).toHaveLength(1);
    expect(storage.storedEvents()[0]).not.toHaveProperty('rawBody');
    expect(storage.storedEvents()[0]).not.toHaveProperty('links');
    expect(storage.storedEvents()[0]?.subject.url).toBe('https://github.com/reirei-lab/rainrail/issues/17');
    expect(storage.storedEvents()[0]?.payload).toEqual({
      action: 'opened',
      status: 'queued',
      conclusion: null,
    });
    expect(storage.storedEvents()[0]?.rawPayload.reference).toBe('github://deliveries/delivery-1');
    expect(storage.storedEvents()[0]?.rawPayload).not.toHaveProperty('contentType');
    expect(storage.storedEvents()[0]?.rawPayload).not.toHaveProperty('secret');
    expect(storage.storedEvents()[0]?.rawPayload).not.toHaveProperty('sha256');

    const eventsResponse = await room.fetch(eventsRequest());
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).not.toContain('secret raw webhook body');
    expect(chunk).not.toContain('secret-subject-token');
    expect(chunk).not.toContain('secret-fragment');
    expect(chunk).not.toContain('token:secret');
    expect(chunk).not.toContain('secret-content-type');
    expect(chunk).not.toContain('token=secret-sha-value');
    expect(chunk).not.toContain('secret-link-token');
    expect(chunk).not.toContain('secret top-level body');
    expect(chunk).not.toContain('secret top-level token');
    expect(chunk).not.toContain('secret issue body');
    expect(chunk).not.toContain('secret label');
    expect(chunk).not.toContain('token-like value');
  });

  it('normalizes unsafe source metadata before storage and SSE delivery', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      source: {
        type: 'github',
        name: 'github-webhook',
        repository: 'token=secret-repository',
        account: 'token=secret-account',
        environment: 'production',
      },
    };

    const response = await room.fetch(publishRequest(event));

    expect(response.status).toBe(200);
    expect(storage.storedEvents()[0]?.source).toEqual({
      type: 'github',
      name: 'github-webhook',
      environment: 'production',
    });

    const eventsResponse = await room.fetch(eventsRequest());
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).not.toContain('secret-repository');
    expect(chunk).not.toContain('secret-account');
  });

  it('rejects unsafe identifier fields before storage', async () => {
    const deliveryStorage = fakeState();
    const deliveryRoom = createTestRoom(deliveryStorage, { replayLimit: 10 });
    const unsafeDeliveryEvent = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      id: 'safe-event-id',
      delivery: { id: 'token=secret-delivery', receivedAt: '2026-06-29T18:18:21.000Z' },
    };

    const deliveryResponse = await deliveryRoom.fetch(publishRequest(unsafeDeliveryEvent));

    expect(deliveryResponse.status).toBe(400);
    expect(deliveryStorage.storedEvents()).toEqual([]);

    const subjectStorage = fakeState();
    const subjectRoom = createTestRoom(subjectStorage, { replayLimit: 10 });
    const unsafeSubjectEvent = {
      ...fixtureEvent('delivery-2', 'github.issue'),
      id: 'safe-event-id',
      subject: { type: 'issue', id: 'token=secret-subject' },
    };

    const subjectResponse = await subjectRoom.fetch(publishRequest(unsafeSubjectEvent));

    expect(subjectResponse.status).toBe(400);
    expect(subjectStorage.storedEvents()).toEqual([]);
  });

  it('bounds repository-shaped identifiers before storage', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const unsafeSubjectEvent = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      id: 'safe-event-id',
      subject: { type: 'repository', id: `owner/${'r'.repeat(200)}` },
    };

    const response = await room.fetch(publishRequest(unsafeSubjectEvent));

    expect(response.status).toBe(400);
    expect(storage.storedEvents()).toEqual([]);
  });

  it('rejects non-ISO timestamps before storage', async () => {
    const occurredAtStorage = fakeState();
    const occurredAtRoom = createTestRoom(occurredAtStorage, { replayLimit: 10 });
    const unsafeOccurredAtEvent = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      occurredAt: 'token=secret-occurred-at',
    };

    const occurredAtResponse = await occurredAtRoom.fetch(publishRequest(unsafeOccurredAtEvent));

    expect(occurredAtResponse.status).toBe(400);
    expect(occurredAtStorage.storedEvents()).toEqual([]);

    const receivedAtStorage = fakeState();
    const receivedAtRoom = createTestRoom(receivedAtStorage, { replayLimit: 10 });
    const unsafeReceivedAtEvent = {
      ...fixtureEvent('delivery-2', 'github.issue'),
      delivery: { id: 'delivery-2', receivedAt: 'token=secret-received-at' },
    };

    const receivedAtResponse = await receivedAtRoom.fetch(publishRequest(unsafeReceivedAtEvent));

    expect(receivedAtResponse.status).toBe(400);
    expect(receivedAtStorage.storedEvents()).toEqual([]);
  });

  it('normalizes raw payload content types before storage and SSE delivery', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      rawPayload: {
        kind: 'external-reference',
        reference: 'github://deliveries/delivery-1',
        contentType: 'Application/JSON; token=secret-parameter',
      },
    };

    const publishResponse = await room.fetch(publishRequest(event));

    expect(publishResponse.status).toBe(200);
    expect(storage.storedEvents()[0]?.rawPayload.contentType).toBe('application/json');

    const eventsResponse = await room.fetch(eventsRequest());
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).toContain('"contentType":"application/json"');
    expect(chunk).not.toContain('secret-parameter');
  });

  it('drops unsafe payload metadata values before storage and SSE delivery', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      payload: {
        action: 'token=secret-action',
        status: 'completed',
        conclusion: 'success',
      },
    };

    const publishResponse = await room.fetch(publishRequest(event));

    expect(publishResponse.status).toBe(200);
    expect(storage.storedEvents()[0]?.payload).toEqual({
      status: 'completed',
      conclusion: 'success',
    });

    const eventsResponse = await room.fetch(eventsRequest());
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).not.toContain('secret-action');
  });

  it('normalizes scalar payloads to an empty object before storage and SSE delivery', async () => {
    const storage = fakeState();
    const room = createTestRoom(storage, { replayLimit: 10 });
    const event = {
      ...fixtureEvent('delivery-1', 'github.issue'),
      payload: 'secret scalar webhook body',
    };

    const publishResponse = await room.fetch(publishRequest(event));

    expect(publishResponse.status).toBe(200);
    expect(storage.storedEvents()[0]?.payload).toEqual({});

    const eventsResponse = await room.fetch(eventsRequest());
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).not.toContain('secret scalar webhook body');
  });

  it('ignores invalid stored replay entries during restore', async () => {
    const valid = fixtureEvent('delivery-1', 'github.issue');
    const room = createTestRoom(storedReplayState([valid, {}, { ...valid, id: 'bad\nid' }]), { replayLimit: 10 });

    const health = await room.fetch(new Request('https://rainrail.local/healthz'));

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toMatchObject({ recent: 1 });

    const eventsResponse = await room.fetch(eventsRequest());
    const reader = eventsResponse.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'github.issue');
    await reader?.cancel();

    expect(chunk).toContain(valid.id);
    expect(chunk).not.toContain('bad\\nid');
  });

  it('passes Last-Event-ID to the SSE replay policy', async () => {
    const room = createTestRoom(fakeState(), { replayLimit: 10 });
    const first = fixtureEvent('delivery-1', 'github.issue');
    const second = fixtureEvent('delivery-2', 'cloudflare.tail');

    await room.fetch(publishRequest(first));
    await room.fetch(publishRequest(second));

    const response = await room.fetch(
      eventsRequest(TEST_PUBLISH_TOKEN, { 'Last-Event-ID': first.id }),
    );
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const chunk = await readUntil(reader!, 'cloudflare.tail');
    await reader?.cancel();

    expect(chunk).not.toContain('event: github.issue\n');
    expect(chunk).toContain('event: cloudflare.tail\n');
  });
});

function createTestRoom(
  state: RainrailBridgeRoomState,
  options: Omit<RainrailBridgeRoomOptions, 'publishToken'> = {},
): RainrailBridgeRoom {
  return new RainrailBridgeRoom(state, { publishToken: TEST_PUBLISH_TOKEN, ...options });
}

function fakeState(initialEvents: unknown[] = []) {
  const map = new Map<string, unknown>();
  map.set('rainrail:recent-events', initialEvents);

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
  const deliveryScheme = name.startsWith('cloudflare') ? 'cloudflare' : 'github';

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
      reference: `${deliveryScheme}://deliveries/${deliveryId}`,
    },
  });
}

function publishRequest(event: unknown, signal?: AbortSignal, publishToken: string | null = TEST_PUBLISH_TOKEN): Request {
  return new Request('https://rainrail.local/publish', {
    method: 'POST',
    headers: publishToken === null ? {} : { Authorization: `Bearer ${publishToken}` },
    body: JSON.stringify(event),
    ...(signal === undefined ? {} : { signal }),
  });
}

function eventsRequest(
  publishToken: string | null = TEST_PUBLISH_TOKEN,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
): Request {
  return new Request('https://rainrail.local/events', {
    headers: {
      ...headers,
      ...(publishToken === null ? {} : { Authorization: `Bearer ${publishToken}` }),
    },
    ...(signal === undefined ? {} : { signal }),
  });
}

function delayedJsonPublishRequest(event: unknown) {
  let resolve: (() => void) | undefined;
  const request = new Request('https://rainrail.local/publish', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TEST_PUBLISH_TOKEN}` },
  });
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
    headers: { Authorization: `Bearer ${TEST_PUBLISH_TOKEN}` },
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

function countingState() {
  let getCalls = 0;
  let stored: unknown[] = [];

  return {
    get getCalls() {
      return getCalls;
    },
    state: {
      storage: {
        get: async () => {
          getCalls += 1;
          return stored;
        },
        put: async (_key: string, value: unknown) => {
          stored = Array.isArray(value) ? value : [];
        },
      },
    },
  };
}

function fakeDelayedSecondGetState() {
  let getCalls = 0;
  let stored: unknown = undefined;
  const pendingGets: Array<(value: unknown) => void> = [];

  return {
    get getCalls() {
      return getCalls;
    },
    state: {
      storage: {
        get: async () => {
          getCalls += 1;
          if (getCalls <= 2) {
            return new Promise((resolve) => pendingGets.push(resolve));
          }

          return stored;
        },
        put: async (_key: string, value: unknown) => {
          stored = value;
        },
      },
    },
    pendingGetCount: () => pendingGets.length,
    resolveNextGet: (value: unknown) => {
      pendingGets.shift()?.(value);
    },
    storedEvents: () => stored as ReturnType<typeof fixtureEvent>[] | undefined,
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
