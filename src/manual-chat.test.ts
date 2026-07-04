import { describe, expect, it, vi } from 'vitest';

import {
  createManualInputEvent,
  createManualInputIntakeAdapter,
  createPluginLoader,
  createRainrailHttpApp,
  RainrailBridgeRoom,
  rainrailHttpRequestBodyLimit,
  shouldReadRainrailHttpRequestBody,
  type ManualInputRainrailEvent,
  type PluginRuntimeContext,
  type RainrailBridgeRoomState,
} from './index.js';

const TEST_PUBLISH_TOKEN = 'test-publish-token';

describe('manual and chat input source contract', () => {
  it('normalizes web chat messages as conversation-scoped Rainrail events', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:20:00.000Z'),
      deliveryId: 'chat-delivery-1',
      conversationId: 'conversation-123',
      messageId: 'message-456',
      message: 'Run the release workflow for rainrail',
      actor: {
        id: 'user-1',
        displayName: 'hiragram',
        type: 'user',
      },
      attachments: [
        {
          id: 'attachment-1',
          name: 'screenshot.png',
          contentType: 'image/png',
          url: 'https://github.com/reirei-lab/rainrail/issues/104',
        },
      ],
      replyTarget: {
        id: 'message-455',
      },
      rawBody: JSON.stringify({ message: 'Run the release workflow for rainrail', extraProviderField: 'ignored' }),
      contentType: 'application/json',
    });

    expect(event).toMatchObject({
      id: 'web-chat:chat-delivery-1:rainrail.chat.message',
      schemaVersion: 'rainrail.event.v1',
      source: {
        type: 'chat',
        name: 'web-chat',
      },
      name: 'rainrail.chat.message',
      delivery: {
        id: 'chat-delivery-1',
        receivedAt: '2026-07-04T09:20:00.000Z',
      },
      occurredAt: '2026-07-04T09:20:00.000Z',
      subject: {
        type: 'conversation',
        id: 'conversation-123',
      },
      payload: {
        provider: 'rainrail',
        channel: 'chat',
        action: 'message',
        conversation: {
          id: 'conversation-123',
        },
        message: {
          id: 'message-456',
          text: 'Run the release workflow for rainrail',
        },
        actor: {
          id: 'user-1',
          displayName: 'hiragram',
          type: 'user',
        },
        attachments: [
          {
            id: 'attachment-1',
            name: 'screenshot.png',
            contentType: 'image/png',
            url: 'https://github.com/reirei-lab/rainrail/issues/104',
          },
        ],
        replyTarget: {
          id: 'message-455',
        },
      },
      rawPayload: {
        kind: 'inline-redacted',
        reference: 'chat://deliveries/chat-delivery-1',
        contentType: 'application/json',
      },
    });
    expect(event.rawPayload.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(event.payload).not.toHaveProperty('extraProviderField');
  });

  it('rejects blank conversation ids and messages before creating events', async () => {
    await expect(createManualInputEvent({
      channel: 'chat',
      conversationId: '   ',
      message: 'hello',
    })).rejects.toThrow('conversationId is required');

    await expect(createManualInputEvent({
      channel: 'chat',
      conversationId: 'conversation-blank-message',
      message: '   ',
    })).rejects.toThrow('message is required');
  });

  it('publishes manual HTTP input without retaining provider-specific raw request fields', async () => {
    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'manual',
          bearerToken: 'manual-intake-token',
          routePath: '/intake/manual',
          receivedAt: () => new Date('2026-07-04T09:21:00.000Z'),
          deliveryId: () => 'manual-delivery-1',
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/manual', {
      method: 'POST',
      headers: {
        authorization: 'Bearer manual-intake-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'manual-session-1',
        messageId: 'manual-message-1',
        message: 'Start a one-off maintenance run',
        actor: { id: 'hiragram', displayName: 'hiragram' },
        rawProviderPayload: { secret: 'do-not-store' },
      }),
    }));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      id: 'manual-input:manual-delivery-1:rainrail.manual.message',
      name: 'rainrail.manual.message',
      source: 'manual',
    });

    const storedEvent = storage.storedEvents()[0] as { id: string; source: { name: string } } | undefined;
    expect(storedEvent).toMatchObject({
      id: 'manual-input:manual-delivery-1:rainrail.manual.message',
      name: 'rainrail.manual.message',
      source: { type: 'manual', name: 'manual-input' },
      subject: { type: 'conversation', id: 'manual-session-1' },
      payload: {
        provider: 'rainrail',
        channel: 'manual',
        action: 'message',
        conversation: { id: 'manual-session-1' },
        message: {
          id: 'manual-message-1',
          text: 'Start a one-off maintenance run',
        },
      },
      rawPayload: {
        kind: 'inline-redacted',
        reference: 'manual://deliveries/manual-delivery-1',
        contentType: 'application/json',
      },
    });
    expect(JSON.stringify(storedEvent)).not.toContain('rawProviderPayload');
    expect(JSON.stringify(storedEvent)).not.toContain('do-not-store');
  });

  it('normalizes HTTP content type before publishing manual input events', async () => {
    const adapter = createManualInputIntakeAdapter({
      channel: 'chat',
      bearerToken: 'chat-intake-token',
      receivedAt: () => new Date('2026-07-04T09:21:05.000Z'),
      deliveryId: () => 'chat-content-type',
    });
    let published: ManualInputRainrailEvent | undefined;

    const response = await adapter.routes?.[0]?.handle(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer chat-intake-token',
        'content-type': 'application/json; token=secret',
      },
      body: JSON.stringify({
        conversationId: 'chat-content-type-session',
        message: 'hello',
      }),
    }), {
      publish: async (event) => {
        published = event as ManualInputRainrailEvent;
        return { ok: true, status: 200 };
      },
    });

    expect(response?.status).toBe(202);
    expect(published?.rawPayload.contentType).toBe('application/json');
    expect(JSON.stringify(published)).not.toContain('token=secret');
  });

  it('requires a bearer token before accepting manual or chat HTTP input', async () => {
    expect(() => createManualInputIntakeAdapter({
      channel: 'chat',
      bearerToken: '',
    })).toThrow(/bearer token/i);

    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          receivedAt: () => new Date('2026-07-04T09:21:10.000Z'),
          deliveryId: () => 'chat-auth-delivery',
        }),
      ],
    });

    const missing = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'chat-session-auth',
        message: 'hello',
      }),
    }));
    expect(missing.status).toBe(401);
    await expect(missing.json()).resolves.toEqual({ error: 'missing_bearer_token' });

    const wrong = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer wrong-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'chat-session-auth',
        message: 'hello',
      }),
    }));
    expect(wrong.status).toBe(401);
    await expect(wrong.json()).resolves.toEqual({ error: 'invalid_bearer_token' });
    expect(storage.storedEvents()).toEqual([]);
  });

  it('does not ask the HTTP app to pre-read manual input bodies before adapter auth', async () => {
    const options = {
      room: new RainrailBridgeRoom(fakeState(), { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          maxBodyBytes: 4,
        }),
      ],
    };

    expect(shouldReadRainrailHttpRequestBody('/intake/chat', 'POST', options)).toBe(false);
    expect(rainrailHttpRequestBodyLimit('/intake/chat', 'POST', options)).toBeUndefined();

    const app = createRainrailHttpApp(options);
    const response = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      body: '{"too":"large"}',
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'missing_bearer_token' });
  });

  it('keeps generated delivery ids unique for long conversation ids', async () => {
    const longConversationId = `conversation-${'a'.repeat(180)}`;
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:20.000Z'),
      conversationId: longConversationId,
      messageId: 'message-one',
      message: 'first',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:21.000Z'),
      conversationId: longConversationId,
      messageId: 'message-two',
      message: 'second',
    });

    expect(first.delivery.id).not.toBe(second.delivery.id);
    expect(first.id).not.toBe(second.id);
    expect(first.delivery.id).toContain('message-one');
    expect(second.delivery.id).toContain('message-two');
    expect(first.delivery.id.length).toBeLessThanOrEqual(128);
    expect(second.delivery.id.length).toBeLessThanOrEqual(128);
  });

  it('publishes long conversation ids through HTTP intake with a short event id', async () => {
    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          receivedAt: () => new Date('2026-07-04T09:21:22.000Z'),
        }),
      ],
    });
    const response = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer chat-intake-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: `conversation-${'b'.repeat(180)}`,
        messageId: 'message-long-conversation',
        message: 'hello',
      }),
    }));

    expect(response.status).toBe(202);
    const body = await response.json() as { id: string };
    expect(body.id.length).toBeLessThanOrEqual(128);
    expect(storage.storedEvents()[0]).toMatchObject({
      id: body.id,
      delivery: {
        id: expect.stringContaining('message-long-conversation'),
      },
    });
  });

  it('normalizes custom source names before publishing through HTTP intake', async () => {
    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          sourceName: `web chat ${'source-'.repeat(24)}`,
          receivedAt: () => new Date('2026-07-04T09:21:22.000Z'),
          deliveryId: () => 'chat-custom-source',
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer chat-intake-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'conversation-custom-source',
        messageId: 'message-custom-source',
        message: 'hello',
      }),
    }));

    expect(response.status).toBe(202);
    const storedEvent = storage.storedEvents()[0] as { id: string; source: { name: string } } | undefined;
    expect(storedEvent?.source.name).toMatch(/^web-chat-source-/);
    expect(storedEvent?.source.name.length).toBeLessThanOrEqual(128);
    expect(storedEvent?.id.length).toBeLessThanOrEqual(128);
  });

  it('uses delivery-reference-safe ids for colon-bearing external ids', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      conversationId: 'slack:C123',
      messageId: 'slack:message:456',
      message: 'hello',
    });

    expect(event.delivery.id).not.toContain(':');
    expect(new URL(event.rawPayload.reference).pathname).not.toContain(':');
  });

  it('keeps delivery ids distinct when external ids differ only by unsafe separators', async () => {
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      deliveryId: 'chat:a:b',
      conversationId: 'conversation-separator',
      message: 'first',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      deliveryId: 'chat/a/b',
      conversationId: 'conversation-separator',
      message: 'second',
    });
    const third = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:25.000Z'),
      conversationId: 'slack:C123',
      messageId: 'message/456',
      message: 'third',
    });
    const fourth = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:26.000Z'),
      conversationId: 'slack/C123',
      messageId: 'message:456',
      message: 'fourth',
    });

    expect(first.delivery.id).not.toBe(second.delivery.id);
    expect(third.delivery.id).not.toBe(fourth.delivery.id);
    for (const event of [first, second, third, fourth]) {
      expect(event.delivery.id).toMatch(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
      expect(event.rawPayload.reference).toBe(`chat://deliveries/${event.delivery.id}`);
    }
  });

  it('keeps long conversation identifiers distinct after normalization', async () => {
    const prefix = 'conversation-prefix-'.repeat(8);
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      conversationId: `${prefix}-one`,
      messageId: 'message-one',
      message: 'first',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      conversationId: `${prefix}-two`,
      messageId: 'message-two',
      message: 'second',
    });

    expect(first.subject.id).not.toBe(second.subject.id);
    expect(first.payload.conversation.id).toBe(first.subject.id);
    expect(second.payload.conversation.id).toBe(second.subject.id);
    expect(first.subject.id.length).toBeLessThanOrEqual(128);
    expect(second.subject.id.length).toBeLessThanOrEqual(128);
  });

  it('keeps conversation identifiers distinct when normalization would otherwise be empty', async () => {
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      conversationId: '会話一',
      messageId: 'message-one',
      message: 'first',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      conversationId: '会話二',
      messageId: 'message-two',
      message: 'second',
    });

    expect(first.subject.id).not.toBe(second.subject.id);
    expect(first.subject.id).toMatch(/^conversation-[A-Za-z0-9]+$/);
    expect(second.subject.id).toMatch(/^conversation-[A-Za-z0-9]+$/);
  });

  it('hashes credential-looking conversation and message identifiers before storage', async () => {
    const tokenLikeConversationId = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const tokenLikeMessageId = 'github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      conversationId: tokenLikeConversationId,
      messageId: tokenLikeMessageId,
      message: 'hello',
    });

    const serialized = JSON.stringify(event);
    expect(event.subject.id).toMatch(/^conversation-[A-Za-z0-9]+$/);
    expect(event.payload.conversation.id).toBe(event.subject.id);
    expect(event.payload.message.id).toMatch(/^message-[A-Za-z0-9]+$/);
    expect(event.delivery.id).toMatch(/^chat-delivery-[A-Za-z0-9]+-message-[A-Za-z0-9]+$/);
    expect(serialized).not.toContain(tokenLikeConversationId);
    expect(serialized).not.toContain(tokenLikeMessageId);
  });

  it('hashes key-value credential-looking identifiers before storage', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      sourceName: 'token: source-secret',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      deliveryId: 'session=delivery-secret',
      conversationId: 'session=conversation-secret',
      messageId: 'token: message-secret',
      message: 'hello',
    });

    const serialized = JSON.stringify(event);
    expect(event.source.name).toMatch(/^source-[A-Za-z0-9]+$/);
    expect(event.subject.id).toMatch(/^conversation-[A-Za-z0-9]+$/);
    expect(event.payload.message.id).toMatch(/^message-[A-Za-z0-9]+$/);
    expect(event.delivery.id).toMatch(/^chat-delivery-[A-Za-z0-9]+$/);
    expect(serialized).not.toContain('source-secret');
    expect(serialized).not.toContain('delivery-secret');
    expect(serialized).not.toContain('conversation-secret');
    expect(serialized).not.toContain('message-secret');
    expect(serialized).not.toContain('session=');
    expect(serialized).not.toContain('token:');
  });

  it('hashes URL credential-looking identifiers before storage', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      conversationId: 'https://user:conversation-secret@example.com/room',
      messageId: 'https://chat.example/rooms/session/secret-message-token',
      message: 'hello',
    });

    const serialized = JSON.stringify(event);
    expect(event.subject.id).toMatch(/^conversation-[A-Za-z0-9]+$/);
    expect(event.payload.conversation.id).toBe(event.subject.id);
    expect(event.payload.message.id).toMatch(/^message-[A-Za-z0-9]+$/);
    expect(event.delivery.id).toMatch(/^chat-delivery-[A-Za-z0-9]+-message-[A-Za-z0-9]+$/);
    expect(serialized).not.toContain('conversation-secret');
    expect(serialized).not.toContain('secret-message-token');
    expect(serialized).not.toContain('user:');
  });

  it('drops blank actor fields before storage', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      conversationId: 'conversation-blank-actor',
      message: 'hello',
      actor: {
        id: '   ',
        displayName: '   ',
        type: '   ',
      },
    });

    expect(event.payload).not.toHaveProperty('actor');
  });

  it('keeps delivery ids distinct for long conversations that share message ids', async () => {
    const prefix = 'conversation-delivery-prefix-'.repeat(7);
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:23.000Z'),
      conversationId: `${prefix}-one`,
      messageId: 'message-reused',
      message: 'first',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      conversationId: `${prefix}-two`,
      messageId: 'message-reused',
      message: 'second',
    });

    expect(first.delivery.id).not.toBe(second.delivery.id);
    expect(first.id).not.toBe(second.id);
    expect(first.delivery.id).toContain('message-reused');
    expect(second.delivery.id).toContain('message-reused');
    expect(first.delivery.id.length).toBeLessThanOrEqual(128);
    expect(second.delivery.id.length).toBeLessThanOrEqual(128);
  });

  it('keeps non-GitHub conversation URLs out of the subject while preserving payload context', async () => {
    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          receivedAt: () => new Date('2026-07-04T09:21:24.000Z'),
          deliveryId: () => 'chat-conversation-url',
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer chat-intake-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'chat-url-session',
        conversationUrl: 'https://chat.example/conversations/123?token=secret',
        message: 'hello',
      }),
    }));

    expect(response.status).toBe(202);
    const storedEvent = storage.storedEvents()[0] as { subject?: unknown } | undefined;
    expect(storedEvent).toMatchObject({
      subject: {
        type: 'conversation',
        id: 'chat-url-session',
      },
      payload: {
        conversation: {
          id: 'chat-url-session',
          url: 'https://chat.example/conversations/123',
        },
      },
    });
    expect(storedEvent?.subject).not.toHaveProperty('url');
  });

  it('redacts credential-bearing header lines from message text before storage', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      conversationId: 'conversation-header-secret',
      message: [
        'Please inspect this request:',
        'Authorization: Bearer abc.def.ghi',
        'Cookie: session=secret-cookie; theme=dark',
        'then continue',
      ].join('\n'),
    });

    expect(event.payload.message.text).toContain('Authorization: [redacted]');
    expect(event.payload.message.text).toContain('Cookie: [redacted]');
    expect(event.payload.message.text).not.toContain('Bearer abc.def.ghi');
    expect(event.payload.message.text).not.toContain('secret-cookie');
  });

  it('redacts non-HTTPS URLs instead of preserving credential-like path segments', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      conversationId: 'conversation-http-secret-url',
      message: 'Open http://example.com/reset/sensitive-reset-token-12345?token=secret and continue',
    });

    expect(event.payload.message.text).toContain('[redacted-url]');
    expect(event.payload.message.text).not.toContain('sensitive-reset-token-12345');
    expect(event.payload.message.text).not.toContain('token=secret');
  });

  it('keeps generated delivery ids unique for long message ids with the same prefix', async () => {
    const prefix = 'message-prefix-'.repeat(12);
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      conversationId: 'conversation-long-message',
      messageId: `${prefix}-one`,
      message: 'first',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:25.000Z'),
      conversationId: 'conversation-long-message',
      messageId: `${prefix}-two`,
      message: 'second',
    });

    expect(first.delivery.id).not.toBe(second.delivery.id);
    expect(first.id).not.toBe(second.id);
  });

  it('falls back to random delivery ids when message ids are empty strings', async () => {
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      conversationId: 'conversation-empty-message',
      messageId: '',
      message: 'first',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:25.000Z'),
      conversationId: 'conversation-empty-message',
      messageId: '   ',
      message: 'second',
    });

    expect(first.delivery.id).not.toBe(second.delivery.id);
    expect(first.id).not.toBe(second.id);
    expect(first.payload.message).not.toHaveProperty('id');
    expect(second.payload.message).not.toHaveProperty('id');
  });

  it('treats blank explicit delivery ids as unspecified', async () => {
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:24.000Z'),
      deliveryId: '',
      conversationId: 'conversation-empty-delivery',
      messageId: 'message-1',
      message: 'first',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:25.000Z'),
      deliveryId: '   ',
      conversationId: 'conversation-empty-delivery',
      messageId: 'message-2',
      message: 'second',
    });

    expect(first.delivery.id).toBe('chat-conversation-empty-delivery-message-1');
    expect(second.delivery.id).toBe('chat-conversation-empty-delivery-message-2');
    expect(first.id).not.toBe(second.id);
  });

  it('normalizes leading punctuation in conversation and message identifiers', async () => {
    const first = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:25.000Z'),
      deliveryId: '_delivery',
      conversationId: '_session',
      messageId: '.thread',
      message: 'hello',
    });
    const second = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:25.000Z'),
      deliveryId: 'chat-delivery-_delivery',
      conversationId: 'conversation-_session',
      messageId: 'message-.thread',
      message: 'hello',
    });

    expect(first.delivery.id).toMatch(/^chat-delivery-_delivery-[A-Za-z0-9]+$/);
    expect(first.subject.id).toMatch(/^conversation-_session-[A-Za-z0-9]+$/);
    expect(first.payload.message.id).toMatch(/^message-.thread-[A-Za-z0-9]+$/);
    expect(first.delivery.id).not.toBe(second.delivery.id);
    expect(first.subject.id).not.toBe(second.subject.id);
    expect(first.payload.message.id).not.toBe(second.payload.message.id);
  });

  it('drops blank reply target ids from HTTP intake payloads', async () => {
    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          receivedAt: () => new Date('2026-07-04T09:21:25.000Z'),
          deliveryId: () => 'chat-blank-reply',
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer chat-intake-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'chat-blank-reply-session',
        message: 'hello',
        replyTarget: {
          id: '   ',
          url: 'https://chat.example/messages/1',
        },
      }),
    }));

    expect(response.status).toBe(202);
    expect(storage.storedEvents()[0]).toMatchObject({
      payload: {
        conversation: { id: 'chat-blank-reply-session' },
      },
    });
    expect(JSON.stringify(storage.storedEvents()[0])).not.toContain('replyTarget');
  });

  it('drops blank reply target ids before direct event storage', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:25.000Z'),
      deliveryId: 'chat-direct-blank-reply',
      conversationId: 'chat-direct-blank-reply-session',
      message: 'hello',
      replyTarget: {
        id: '   ',
        url: 'https://chat.example/messages/1',
      },
    });

    expect(event.payload).not.toHaveProperty('replyTarget');
  });

  it('drops blank attachment ids before storage', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:25.000Z'),
      deliveryId: 'chat-blank-attachment',
      conversationId: 'chat-blank-attachment-session',
      message: 'hello',
      attachments: [
        {
          id: '   ',
          name: 'screenshot.png',
        },
      ],
    });

    expect(event.payload.attachments).toEqual([
      { name: 'screenshot.png' },
    ]);
  });

  it('rejects unsafe manual and chat raw payload references in bridge storage', async () => {
    const storage = fakeState();
    const room = new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN });
    const event = await createManualInputEvent({
      channel: 'chat',
      receivedAt: new Date('2026-07-04T09:21:26.000Z'),
      deliveryId: 'safe-delivery',
      conversationId: 'safe-conversation',
      message: 'hello',
    });

    const response = await room.fetch(new Request('https://rainrail-room.local/publish', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_PUBLISH_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...event,
        rawPayload: {
          ...event.rawPayload,
          reference: 'chat://tokens/secret-value',
        },
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toContain('reference must be a valid URL');
    expect(storage.storedEvents()).toEqual([]);
  });

  it('redacts credential-looking user text before publishing chat payloads', async () => {
    const directEvent = await createManualInputEvent({
      channel: 'chat',
      deliveryId: 'direct-redaction-delivery',
      conversationId: 'direct-redaction-session',
      message: 'access_token=gho_direct client_secret: direct-secret sessionToken=direct-session token={"access":"abc"} secret: ["abc","def"] github_pat_abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ghp_abcdefghijklmnopqrstuvwxyz0123456789 bearer abc.def.ghi DATABASE_URL=postgres://user:db-pass@db/prod https://user:web-pass@example.com/path https://example.com/reset/sensitive-reset-token-12345',
    });
    expect(directEvent.payload.message.text).toBe('access_token=[redacted] client_secret: [redacted] sessionToken=[redacted] token=[redacted] secret: [redacted] [redacted-token] [redacted-token] bearer [redacted] DATABASE_URL=[redacted-url] [redacted-url] https://example.com/[redacted]/[redacted]');
    expect(directEvent.payload.message.text).not.toContain('"access":"abc"');
    expect(directEvent.payload.message.text).not.toContain('"def"');

    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          receivedAt: () => new Date('2026-07-04T09:21:30.000Z'),
          deliveryId: () => 'chat-redaction-delivery',
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer chat-intake-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'chat-session-1',
        message: 'Please debug with token=super-secret, password: hunter2, {"apiKey":"abc123"}, access_token=gho_secret, github_token=ghp_secret, client_secret: oauth-secret, sessionToken=browser-secret, and Bearer abc.def.ghi',
        actor: { displayName: 'secret=actor-secret' },
      }),
    }));

    expect(response.status).toBe(202);
    const storedEvent = storage.storedEvents()[0];
    expect(storedEvent).toMatchObject({
      payload: {
        message: {
          text: 'Please debug with token=[redacted], password: [redacted], {"apiKey":"[redacted]"}, access_token=[redacted], github_token=[redacted], client_secret: [redacted], sessionToken=[redacted], and Bearer [redacted]',
        },
        actor: {
          displayName: 'secret=[redacted]',
        },
      },
    });
    expect(JSON.stringify(storedEvent)).not.toContain('super-secret');
    expect(JSON.stringify(storedEvent)).not.toContain('hunter2');
    expect(JSON.stringify(storedEvent)).not.toContain('abc123');
    expect(JSON.stringify(storedEvent)).not.toContain('gho_secret');
    expect(JSON.stringify(storedEvent)).not.toContain('ghp_secret');
    expect(JSON.stringify(storedEvent)).not.toContain('oauth-secret');
    expect(JSON.stringify(storedEvent)).not.toContain('browser-secret');
    expect(JSON.stringify(storedEvent)).not.toContain('abc.def.ghi');
    expect(JSON.stringify(storedEvent)).not.toContain('actor-secret');
  });

  it('bounds and sanitizes manual and chat URL payload strings', async () => {
    const longPath = 'a'.repeat(9_000);
    const event = await createManualInputEvent({
      channel: 'chat',
      deliveryId: 'url-bound-delivery',
      conversationId: 'url-bound-session',
      conversationUrl: `https://chat.example/reset/sensitive-reset-token-12345/${longPath}?token=secret#fragment`,
      message: 'hello',
      attachments: [{
        id: 'attachment-url',
        url: `https://files.example/download/${longPath}?downloadToken=secret`,
      }],
      replyTarget: {
        id: 'reply-url',
        url: `https://chat.example/session/${longPath}?sessionToken=secret`,
      },
    });

    expect(event.payload.conversation.url?.length).toBeLessThanOrEqual(8_000);
    expect(event.payload.conversation.url).toContain('/[redacted]/[redacted]/');
    expect(event.payload.conversation.url).not.toContain('sensitive-reset-token-12345');
    expect(event.payload.conversation.url).not.toContain('token=secret');
    expect(event.payload.conversation.url).not.toContain('#fragment');
    expect(event.payload.attachments?.[0]?.url?.length).toBeLessThanOrEqual(8_000);
    expect(event.payload.replyTarget?.url?.length).toBeLessThanOrEqual(8_000);
  });

  it('limits manual and chat attachments before publishing payloads', async () => {
    const event = await createManualInputEvent({
      channel: 'chat',
      deliveryId: 'attachment-limit-delivery',
      conversationId: 'attachment-limit-session',
      message: 'hello',
      attachments: Array.from({ length: 40 }, (_, index) => ({
        id: `attachment-${index}`,
        name: `attachment-${index}.txt`,
      })),
    });

    expect(event.payload.attachments).toHaveLength(20);
    expect(event.payload.attachments?.at(-1)?.id).toBe('attachment-19');
  });

  it('uses nested HTTP message ids for deterministic deliveries', async () => {
    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          bearerToken: 'chat-intake-token',
          receivedAt: () => new Date('2026-07-04T09:21:31.000Z'),
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: {
        authorization: 'Bearer chat-intake-token',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        conversationId: 'chat-session-nested-message',
        message: {
          id: 'nested-message-id',
          text: 'retry-safe hello',
        },
      }),
    }));

    expect(response.status).toBe(202);
    expect(storage.storedEvents()[0]).toMatchObject({
      delivery: {
        id: 'chat-chat-session-nested-message-nested-message-id',
      },
      payload: {
        message: {
          id: 'nested-message-id',
          text: 'retry-safe hello',
        },
      },
    });
  });

  it('lets workflow plugins accept chat input and start runtime work', async () => {
    const startRuntime = vi.fn(async () => ({ id: 'runtime-chat-1', status: 'queued' }));
    const loader = createPluginLoader({
      runtime: mockRuntimeContext({
        actions: {
          mergePullRequest: async () => {
            throw new Error('merge is not configured');
          },
          startRuntime,
          readSecret: async () => {
            throw new Error('secret access is not configured');
          },
        },
      }),
    });
    loader.on<ManualInputRainrailEvent>('rainrail.chat.message', async (event, context) => context.actions.startRuntime({
      runtimeId: 'codex-chat',
      conversationId: event.subject.id,
      prompt: event.payload.message.text,
    }), { name: 'chat-runtime-start', capabilities: ['runtime:start'] });
    const event = await createManualInputEvent({
      channel: 'chat',
      deliveryId: 'chat-runtime-delivery',
      receivedAt: new Date('2026-07-04T09:22:00.000Z'),
      conversationId: 'conversation-runtime',
      messageId: 'message-runtime',
      message: 'Investigate deployment failure',
      rawBody: '{}',
    });

    await expect(loader.dispatch(event)).resolves.toEqual([
      {
        pluginName: 'chat-runtime-start',
        eventId: 'web-chat:chat-runtime-delivery:rainrail.chat.message',
        status: 'fulfilled',
        value: { id: 'runtime-chat-1', status: 'queued' },
      },
    ]);
    expect(startRuntime).toHaveBeenCalledWith(
      {
        runtimeId: 'codex-chat',
        conversationId: 'conversation-runtime',
        prompt: 'Investigate deployment failure',
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

function mockRuntimeContext(overrides: Partial<PluginRuntimeContext> = {}): PluginRuntimeContext {
  return {
    runId: 'run-manual-chat-1',
    now: () => new Date('2026-07-04T09:22:00.000Z'),
    providers: {
      tasks: {
        name: 'mock-tasks',
        kind: 'task-provider',
        getIssue: async () => {
          throw new Error('mock getIssue is not configured');
        },
        createComment: async () => {
          throw new Error('mock createComment is not configured');
        },
      },
    },
    runtime: {
      name: 'mock-runtime',
      kind: 'runtime-provider',
      startRun: async () => ({
        id: 'run:mock',
        provider: 'codex',
        status: 'queued',
      }),
    },
    signal: new AbortController().signal,
    actions: {
      mergePullRequest: async () => {
        throw new Error('mock mergePullRequest action is not configured');
      },
      startRuntime: async () => {
        throw new Error('mock startRuntime action is not configured');
      },
      readSecret: async () => {
        throw new Error('mock readSecret action is not configured');
      },
    },
    ...overrides,
  };
}

function fakeState(): RainrailBridgeRoomState & { storedEvents(): unknown[] } {
  const data = new Map<string, unknown>();

  return {
    storage: {
      async get(key) {
        return data.get(key) ?? null;
      },
      async put(key, value) {
        data.set(key, value);
      },
      async compareAndSet(key, expected, value) {
        if (data.get(key) !== expected) return false;
        data.set(key, value);
        return true;
      },
    },
    storedEvents() {
      const events = data.get('rainrail:recent-events');
      return Array.isArray(events) ? events : [];
    },
  };
}
