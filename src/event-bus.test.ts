import { describe, expect, it, vi } from 'vitest';

import { createEventEnvelope, createRainrailEventBus, type RainrailEventEnvelope } from './index.js';

describe('Rainrail event bus', () => {
  it('replays recent events, broadcasts new events, and removes disconnected Node writers', () => {
    const bus = createRainrailEventBus({ replayLimit: 1 });
    const githubIssue = fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17');
    const cloudflareTail = fixtureEvent('cloudflare-tail', 'delivery-2', 'cloudflare.tail', 'worker', 'api-worker');
    const githubReview = fixtureEvent('github-webhook', 'delivery-3', 'github.review', 'review', 'review-1');
    const writes: string[] = [];

    bus.publish(githubIssue);
    bus.publish(cloudflareTail);

    const unsubscribe = bus.subscribe({
      write: (chunk) => writes.push(chunk),
      close: () => writes.push('closed'),
    });

    expect(bus.clientCount).toBe(1);
    expect(bus.recentCount).toBe(1);
    expect(writes.join('')).not.toContain('github.issue');
    expect(writes.join('')).toContain(': connected\n\n');
    expect(writes.join('')).toContain('event: cloudflare.tail\n');

    bus.publish(githubReview);
    expect(writes.join('')).toContain('event: github.review\n');

    unsubscribe();
    expect(bus.clientCount).toBe(0);
    expect(writes.at(-1)).toBe('closed');
  });

  it('creates a Worker-compatible SSE stream with replay, keepalive, and abort cleanup', async () => {
    vi.useFakeTimers();
    try {
      const bus = createRainrailEventBus({ replayLimit: 10 });
      const controller = new AbortController();
      bus.publish(fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17'));

      const stream = bus.createReadableStream({
        signal: controller.signal,
        keepAliveIntervalMs: 1000,
      });
      const reader = stream.getReader();

      expect(bus.clientCount).toBe(1);
      expect(await readNext(reader)).toBe(': connected\n\n');
      expect(await readNext(reader)).toContain('event: github.issue\n');

      await vi.advanceTimersByTimeAsync(1000);
      expect(await readNext(reader)).toBe(': keep-alive\n\n');

      controller.abort();
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      expect(bus.clientCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

function fixtureEvent(
  sourceName: string,
  deliveryId: string,
  name: RainrailEventEnvelope['name'],
  subjectType: RainrailEventEnvelope['subject']['type'],
  subjectId: string,
): RainrailEventEnvelope {
  return createEventEnvelope({
    source: { type: sourceName.startsWith('cloudflare') ? 'cloudflare' : 'github', name: sourceName },
    name,
    delivery: {
      id: deliveryId,
      receivedAt: '2026-06-29T18:18:21.000Z',
    },
    occurredAt: '2026-06-29T18:18:20.000Z',
    subject: { type: subjectType, id: subjectId },
    payload: { subjectId },
    rawPayload: {
      kind: 'external-reference',
      reference: `${sourceName}://${deliveryId}`,
    },
  });
}

async function readNext(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  expect(done).toBe(false);
  return new TextDecoder().decode(value);
}
