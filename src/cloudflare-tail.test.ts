import { describe, expect, it } from 'vitest';

import {
  RainrailBridgeRoom,
  createCloudflareIssueReporterWorkflow,
  createCloudflareTailEvent,
  createCloudflareTailSourcePlugin,
  createInMemoryCloudflareErrorIssueStore,
  publishCloudflareTailEvents,
  type RainrailEventEnvelope,
  type RainrailBridgeRoomState,
  type TaskQueueProvider,
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

  it('keeps exception stacks usable by the Cloudflare issue reporter workflow', async () => {
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({
        outcome: 'exception',
        exceptions: [{
          name: 'TypeError',
          message: "Cannot read properties of null (reading 'toAuth')",
          stack: [
            "TypeError: Cannot read properties of null (reading 'toAuth')",
            '    at resolveCurrentHumanAccount (worker.js:1510:24)',
            '    at handleCurrentHuman (worker.js:1377:18)',
          ].join('\n'),
        }],
      }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });
    const createdIssues: Array<{ title: string; body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 24,
            url: 'https://github.com/reirei-lab/rainrail/issues/24',
          };
        },
      },
    });

    await expect(workflow.handle(event, runtimeContext())).resolves.toMatchObject({
      handled: true,
      reason: 'created_cloudflare_error_issue',
      issue: {
        number: 24,
      },
    });
    expect(event.payload.exceptions[0]?.stack).toContain('resolveCurrentHumanAccount');
    expect(createdIssues[0]?.title).toBe('[asme-site] TypeError in resolveCurrentHumanAccount');
    expect(createdIssues[0]?.body).toContain('resolveCurrentHumanAccount @ worker.js');
  });

  it('keeps usable stack frames when bounding a multi-line exception message', async () => {
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({
        outcome: 'exception',
        exceptions: [{
          name: 'TypeError',
          message: 'multi-line exception message',
          stack: [
            'TypeError: multi-line exception message',
            ...Array.from({ length: 12 }, (_, index) => `message detail ${index}`),
            '    at resolveCurrentHumanAccount (worker.js:1510:24)',
            '    at handleCurrentHuman (worker.js:1377:18)',
            '    at Object.fetch (worker.js:42:7)',
            ...Array.from({ length: 80 }, (_, index) => `    at extraFrame${index} (worker.js:${index}:1)`),
          ].join('\n'),
        }],
      }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });
    const createdIssues: Array<{ title: string; body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 25,
            url: 'https://github.com/reirei-lab/rainrail/issues/25',
          };
        },
      },
    });

    await expect(workflow.handle(event, runtimeContext())).resolves.toMatchObject({
      handled: true,
      reason: 'created_cloudflare_error_issue',
    });
    expect(event.payload.exceptions[0]?.stack).toContain('resolveCurrentHumanAccount');
    expect(event.payload.exceptions[0]?.stack).toContain('... truncated ...');
    expect(createdIssues[0]?.title).toBe('[asme-site] TypeError in resolveCurrentHumanAccount');
  });

  it('redacts tail URLs and exception strings before publishing while keeping stack frames', async () => {
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({
        outcome: 'exception',
        scriptName: 'asme-site token=tail-worker-secret\nextra',
        url: 'https://asme.dev/token/secret-path-value/me?token=tail-url-secret#access_token=fragment-secret',
        exceptions: [{
          name: 'TypeError token=tail-name-secret',
          message: 'failed token="tail-message-secret" authorization: Bearer tail-auth-secret {"password":"tail-json-secret"} {"resetCode":"tail-open-secret password: tail-colon-secret token = "tail-spaced-token-secret" password = tail-spaced-password-secret DATABASE_URL=postgres://app:tail-db-pass@db/prod CACHE_URL=redis://tail-user-token@cache/0 sessionId=tail-session-id-secret',
          stack: [
            `TypeError: ${'x'.repeat(1_500)} token=tail-stack-secret {"password":"tail-stack-json-secret"} {"password":{"x":"tail-unclosed-structured-secret" password: tail-stack-colon-secret`,
            '    at resolveCurrentHumanAccount (worker.js:1510:24)',
            '    at handleCurrentHuman (worker.js:1377:18)',
          ].join('\n'),
        }],
      }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });

    expect(event.payload.url).toBe('https://asme.dev/[redacted]/[redacted]/me');
    expect(event.payload.scriptName).toBe('asme-site token=[redacted] extra');
    expect(JSON.stringify(event.payload)).not.toContain('tail-worker-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-url-secret');
    expect(JSON.stringify(event.payload)).not.toContain('fragment-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-name-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-message-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-auth-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-json-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-open-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-colon-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-spaced-token-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-spaced-password-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-db-pass');
    expect(JSON.stringify(event.payload)).not.toContain('tail-user-token');
    expect(JSON.stringify(event.payload)).not.toContain('tail-session-id-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-stack-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-stack-json-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-unclosed-structured-secret');
    expect(JSON.stringify(event.payload)).not.toContain('tail-stack-colon-secret');
    expect(event.payload.exceptions[0]?.message).toContain('token=[redacted]');
    expect(event.payload.exceptions[0]?.stack).toContain('resolveCurrentHumanAccount');
    expect(event.payload.exceptions[0]?.stack).toContain('... truncated ...');
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

  it('routes response stream disconnects as cloudflare.error', async () => {
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({
        outcome: 'responseStreamDisconnected',
        status: 200,
        exceptions: [],
      }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });

    expect(event.name).toBe('cloudflare.error');
    expect(event.payload).toMatchObject({
      action: 'responseStreamDisconnected',
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
    expect(storage.storedEvents()[0]?.payload).toMatchObject({
      action: 'exception',
      status: '500',
      conclusion: 'failure',
      scriptName: 'asme-site',
      exceptions: [{
        name: 'Error',
        message: 'boom',
      }],
    });
  });

  it('keeps sanitized Cloudflare error details when events pass through the bridge', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const createdIssues: Array<{ title: string; body: string }> = [];
    const workflow = createCloudflareIssueReporterWorkflow({
      repository: 'reirei-lab/rainrail',
      store: createInMemoryCloudflareErrorIssueStore(),
      issues: {
        findOpenIssueByFingerprint: async () => undefined,
        createIssue: async (input) => {
          createdIssues.push(input);
          return {
            number: 24,
            url: 'https://github.com/reirei-lab/rainrail/issues/24',
          };
        },
      },
    });
    const event = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({
        outcome: 'exception',
        url: 'https://asme.dev/me?token=secret-token',
        exceptions: [{
          name: 'TypeError',
          message: 'failed with token=secret-token',
          stack: [
            'TypeError: failed with token=secret-token',
            '    at resolveCurrentHumanAccount (worker.js:1510:24)',
          ].join('\n'),
        }],
      }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });

    const publishResponse = await room.fetch(publishRequest(event));
    expect(publishResponse.status).toBe(200);
    const stored = storage.storedEvents()[0];

    expect(stored?.payload).toMatchObject({
      scriptName: 'asme-site',
      url: 'https://asme.dev/me',
      exceptions: [{
        name: 'TypeError',
        message: 'failed with token=[redacted]',
        stack: expect.stringContaining('resolveCurrentHumanAccount'),
      }],
    });
    expect(JSON.stringify(stored?.payload)).not.toContain('secret-token');
    await expect(workflow.handle(stored!, runtimeContext())).resolves.toMatchObject({
      handled: true,
      reason: 'created_cloudflare_error_issue',
    });
    expect(createdIssues[0]?.title).toBe('[asme-site] TypeError in resolveCurrentHumanAccount');
  });

  it('bounds Cloudflare exception fields before publishing tail events', async () => {
    const published: RainrailEventEnvelope[] = [];
    const longStack = Array.from({ length: 80 }, (_, index) => `    at frame${index} (worker.js:${index}:1)`).join('\n');

    await publishCloudflareTailEvents([
      cloudflareTailFixture({
        outcome: 'exception',
        exceptions: [{
          name: `HugeError ${'n'.repeat(500)} name-tail`,
          message: `message ${'m'.repeat(2_000)} message-tail`,
          stack: `${longStack}\nstack-tail`,
        }],
      }),
    ], {
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      publish: async (event) => {
        published.push(event);
        return Response.json({ ok: true });
      },
    });

    const payload = published[0]?.payload as { exceptions?: Array<{ name?: string; message?: string; stack?: string }> } | undefined;
    const exception = payload?.exceptions?.[0];
    expect(exception?.name).toContain('... truncated ...');
    expect(exception?.message).toContain('... truncated ...');
    expect(exception?.stack).toContain('... truncated ...');
    expect(exception?.name).not.toContain('name-tail');
    expect(exception?.message).not.toContain('message-tail');
    expect(exception?.stack).not.toContain('stack-tail');
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
    expect(storage.storedEvents()[0]?.rawPayload.reference).toContain('queue-delivery-1-0');
    expect(storage.storedEvents()[0]?.rawPayload.reference).not.toContain(':delivery');
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

  it('keeps error event ids publishable when source names leave only 34 delivery id characters', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const sourceName = 'a'.repeat(76);
    const result = await publishCloudflareTailEvents([
      cloudflareTailFixture({
        outcome: 'exception',
        cfRay: null,
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

  it('uses explicit short event ids when source names leave too little room for delivery ids', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const sourceName = 'a'.repeat(100);
    const result = await publishCloudflareTailEvents([
      cloudflareTailFixture({
        outcome: 'exception',
        cfRay: null,
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

  it('keeps cf-ray suffixes distinct when long source names leave one suffix character', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN, replayLimit: 10 });
    const sourceName = 'a'.repeat(100);
    const result = await publishCloudflareTailEvents([
      cloudflareTailFixture({
        outcome: 'exception',
        cfRay: 'ray-1',
      }),
      cloudflareTailFixture({
        outcome: 'exception',
        cfRay: 'ray-2',
      }),
    ], {
      sourceName,
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      publish: (event) => room.fetch(publishRequest(event)),
    });

    expect(result.every((item) => item.ok)).toBe(true);
    expect(result[0]?.id).not.toBe(result[1]?.id);
    expect(storage.storedEvents()).toHaveLength(2);
  });

  it('keeps distinct fallback delivery ids distinct after reference-safe encoding', async () => {
    const withColon = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'queue:delivery:1',
    });
    const withDash = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'queue-delivery-1',
    });

    expect(withColon.delivery.id).not.toBe(withDash.delivery.id);
    expect(withColon.id).not.toBe(withDash.id);
    expect(withColon.rawPayload.reference).not.toBe(withDash.rawPayload.reference);
  });

  it('keeps fallback delivery ids that differ only by case distinct', async () => {
    const upperCase = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'DeployA',
    });
    const lowerCase = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'deploya',
    });

    expect(upperCase.delivery.id).not.toBe(lowerCase.delivery.id);
    expect(upperCase.id).not.toBe(lowerCase.id);
    expect(upperCase.rawPayload.reference).not.toBe(lowerCase.rawPayload.reference);
  });

  it('keeps fallback delivery ids that differ by trailing punctuation distinct', async () => {
    const withDot = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'deploy.',
    });
    const withoutDot = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', cfRay: null }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
      fallbackDeliveryId: 'deploy',
    });

    expect(withDot.delivery.id).not.toBe(withoutDot.delivery.id);
    expect(withDot.id).not.toBe(withoutDot.id);
    expect(withDot.rawPayload.reference).not.toBe(withoutDot.rawPayload.reference);
  });

  it('keeps long worker names distinct when their first 64 characters match', async () => {
    const sharedPrefix = 'worker-'.repeat(11);
    const first = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', scriptName: `${sharedPrefix}alpha` }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });
    const second = await createCloudflareTailEvent({
      tailEvent: cloudflareTailFixture({ outcome: 'ok', scriptName: `${sharedPrefix}bravo` }),
      receivedAt: new Date('2026-06-15T08:12:01.000Z'),
    });

    expect(first.subject.id).not.toBe(second.subject.id);
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
  url = 'https://asme.dev/me',
  eventTimestamp = Date.parse('2026-06-15T08:12:00.000Z'),
}: {
  outcome: string;
  status?: number;
  cfRay?: string | null;
  exceptions?: Array<{ name?: string; message?: string; stack?: string; timestamp?: number | string }>;
  scriptName?: string;
  url?: string;
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
        url,
        headers,
      },
      response: {
        status,
      },
    },
  };
}

function runtimeContext() {
  return {
    runId: 'run-cloudflare-tail',
    now: () => new Date('2026-06-15T08:12:01.000Z'),
    providers: {
      tasks: {
        name: 'mock-tasks',
        kind: 'task-provider' as const,
        getIssue: async () => {
          throw new Error('not used');
        },
        createComment: async () => {
          throw new Error('not used');
        },
      },
      queue: queueProvider(),
    },
    runtime: {
      name: 'mock-runtime',
      kind: 'runtime-provider' as const,
      startRun: async () => {
        throw new Error('not used');
      },
    },
    signal: new AbortController().signal,
    actions: {
      mergePullRequest: async () => {
        throw new Error('not used');
      },
      startRuntime: async () => {
        throw new Error('not used');
      },
      readSecret: async () => {
        throw new Error('not used');
      },
    },
  };
}

function queueProvider(): TaskQueueProvider {
  return {
    name: 'mock-queue',
    kind: 'task-queue-provider',
    listProjectIssues: async () => [],
    claimProjectIssue: async () => ({ projectItemId: 'unused' }),
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
