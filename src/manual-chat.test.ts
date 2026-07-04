import { describe, expect, it, vi } from 'vitest';

import {
  createManualInputEvent,
  createManualInputIntakeAdapter,
  createPluginLoader,
  createRainrailHttpApp,
  RainrailBridgeRoom,
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

  it('publishes manual HTTP input without retaining provider-specific raw request fields', async () => {
    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'manual',
          routePath: '/intake/manual',
          receivedAt: () => new Date('2026-07-04T09:21:00.000Z'),
          deliveryId: () => 'manual-delivery-1',
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/manual', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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

    const storedEvent = storage.storedEvents()[0];
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

  it('redacts credential-looking user text before publishing chat payloads', async () => {
    const storage = fakeState();
    const app = createRainrailHttpApp({
      room: new RainrailBridgeRoom(storage, { publishToken: TEST_PUBLISH_TOKEN }),
      publishToken: TEST_PUBLISH_TOKEN,
      intakeAdapters: [
        createManualInputIntakeAdapter({
          channel: 'chat',
          receivedAt: () => new Date('2026-07-04T09:21:30.000Z'),
          deliveryId: () => 'chat-redaction-delivery',
        }),
      ],
    });

    const response = await app.fetch(new Request('https://rainrail.local/intake/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        conversationId: 'chat-session-1',
        message: 'Please debug with token=super-secret and Bearer abc.def.ghi',
        actor: { displayName: 'secret=actor-secret' },
      }),
    }));

    expect(response.status).toBe(202);
    const storedEvent = storage.storedEvents()[0];
    expect(storedEvent).toMatchObject({
      payload: {
        message: {
          text: 'Please debug with token=[redacted] and Bearer [redacted]',
        },
        actor: {
          displayName: 'secret=[redacted]',
        },
      },
    });
    expect(JSON.stringify(storedEvent)).not.toContain('super-secret');
    expect(JSON.stringify(storedEvent)).not.toContain('abc.def.ghi');
    expect(JSON.stringify(storedEvent)).not.toContain('actor-secret');
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
