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
