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

  it('does not keep subscribers or timers when the signal is already aborted', async () => {
    vi.useFakeTimers();
    try {
      const bus = createRainrailEventBus({ replayLimit: 10 });
      const controller = new AbortController();
      controller.abort();

      const stream = bus.createReadableStream({
        signal: controller.signal,
        keepAliveIntervalMs: 1000,
      });
      const reader = stream.getReader();

      expect(bus.clientCount).toBe(0);
      await expect(reader.read()).resolves.toMatchObject({ done: true });
      await vi.advanceTimersByTimeAsync(1000);
      expect(bus.clientCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats replayLimit 0 as no replay during cold-start restore', () => {
    const bus = createRainrailEventBus({ replayLimit: 0 });
    const writes: string[] = [];

    bus.loadReplay([
      fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17'),
      fixtureEvent('cloudflare-tail', 'delivery-2', 'cloudflare.tail', 'worker', 'api-worker'),
    ]);
    bus.subscribe({ write: (chunk) => writes.push(chunk) });

    expect(bus.recentCount).toBe(0);
    expect(writes.join('')).toBe(': connected\n\n');
  });

  it('rejects non-finite and non-integer replay limits', () => {
    expect(() => createRainrailEventBus({ replayLimit: Number.NaN })).toThrow('replayLimit');
    expect(() => createRainrailEventBus({ replayLimit: Number.POSITIVE_INFINITY })).toThrow('replayLimit');
    expect(() => createRainrailEventBus({ replayLimit: -1 })).toThrow('replayLimit');
    expect(() => createRainrailEventBus({ replayLimit: 1.5 })).toThrow('replayLimit');
  });

  it('ignores non-positive and non-finite keepalive intervals', async () => {
    vi.useFakeTimers();
    try {
      const bus = createRainrailEventBus({ replayLimit: 10 });
      const stream = bus.createReadableStream({ keepAliveIntervalMs: 0 });
      const reader = stream.getReader();

      expect(await readNext(reader)).toBe(': connected\n\n');
      await vi.advanceTimersByTimeAsync(1000);
      const next = readNextOrTimeout(reader);
      await vi.advanceTimersByTimeAsync(20);
      await expect(next).resolves.toBe('timeout');
      await reader.cancel();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not load replay events that fail SSE validation', () => {
    const bus = createRainrailEventBus({ replayLimit: 10 });
    const valid = fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17');
    const invalid = { ...fixtureEvent('github-webhook', 'delivery-2', 'github.review', 'review', 'review-1'), id: 'bad\nid' };
    const writes: string[] = [];

    bus.loadReplay([valid, invalid]);
    bus.subscribe({ write: (chunk) => writes.push(chunk) });

    expect(bus.recentCount).toBe(1);
    expect(writes.join('')).toContain(valid.id);
    expect(writes.join('')).not.toContain('bad\\nid');
  });

  it('replays only events after the supplied last event id', async () => {
    const bus = createRainrailEventBus({ replayLimit: 10 });
    const first = fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17');
    const second = fixtureEvent('cloudflare-tail', 'delivery-2', 'cloudflare.tail', 'worker', 'api-worker');
    const third = fixtureEvent('github-webhook', 'delivery-3', 'github.review', 'review', 'review-1');

    bus.publish(first);
    bus.publish(second);
    bus.publish(third);

    const stream = bus.createReadableStream({ lastEventId: first.id });
    const reader = stream.getReader();
    const chunks = [await readNext(reader), await readNext(reader), await readNext(reader)].join('');
    await reader.cancel();

    expect(chunks).toContain(': connected\n\n');
    expect(chunks).not.toContain('event: github.issue\n');
    expect(chunks).toContain('event: cloudflare.tail\n');
    expect(chunks).toContain('event: github.review\n');
  });

  it('replays from the last matching event when duplicate ids exist', async () => {
    const bus = createRainrailEventBus({ replayLimit: 10 });
    const first = fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17');
    const second = fixtureEvent('cloudflare-tail', 'delivery-2', 'cloudflare.tail', 'worker', 'api-worker');
    const duplicate = { ...fixtureEvent('github-webhook', 'delivery-3', 'github.review', 'review', 'review-1'), id: first.id };
    const fourth = fixtureEvent('github-webhook', 'delivery-4', 'github.check_run', 'check_run', 'check-1');

    bus.publish(first);
    bus.publish(second);
    bus.publish(duplicate);
    bus.publish(fourth);

    const stream = bus.createReadableStream({ lastEventId: first.id });
    const reader = stream.getReader();
    const chunks = [await readNext(reader), await readNext(reader)].join('');
    await reader.cancel();

    expect(chunks).toContain(': connected\n\n');
    expect(chunks).not.toContain('event: cloudflare.tail\n');
    expect(chunks).not.toContain('event: github.review\n');
    expect(chunks).toContain('event: github.check_run\n');
  });

  it('does not expose mutable replay event references', () => {
    const bus = createRainrailEventBus({ replayLimit: 10 });
    const event = fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17');
    bus.publish(event);

    const recent = bus.recentEvents;
    recent[0]!.id = 'mutated-id';
    (recent[0]!.payload as Record<string, unknown>).subjectId = 'mutated-payload';

    const writes: string[] = [];
    bus.subscribe({ write: (chunk) => writes.push(chunk) });

    expect(writes.join('')).toContain(event.id);
    expect(writes.join('')).toContain('"subjectId":"17"');
    expect(writes.join('')).not.toContain('mutated-id');
    expect(writes.join('')).not.toContain('mutated-payload');
  });

  it('does not pollute replay when an event cannot be serialized', () => {
    const bus = createRainrailEventBus({ replayLimit: 10 });
    const event = fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    event.payload = circular;

    expect(() => bus.publish(event)).toThrow();
    expect(bus.recentCount).toBe(0);

    const writes: string[] = [];
    bus.subscribe({ write: (chunk) => writes.push(chunk) });
    expect(writes.join('')).toBe(': connected\n\n');
  });

  it('runs subscriber cleanup when a broadcast write fails', () => {
    const bus = createRainrailEventBus({ replayLimit: 10 });
    let closed = 0;

    bus.subscribe({
      write: (chunk) => {
        if (chunk.includes('event: github.issue\n')) {
          throw new Error('writer closed');
        }
      },
      close: () => {
        closed += 1;
      },
    });

    expect(bus.clientCount).toBe(1);
    bus.publish(fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17'));

    expect(bus.clientCount).toBe(0);
    expect(closed).toBe(1);
  });

  it('runs subscriber cleanup when initial replay write fails', () => {
    const bus = createRainrailEventBus({ replayLimit: 10 });
    let closed = 0;
    bus.publish(fixtureEvent('github-webhook', 'delivery-1', 'github.issue', 'issue', '17'));

    expect(() =>
      bus.subscribe({
        write: (chunk) => {
          if (chunk.includes('event: github.issue\n')) {
            throw new Error('replay writer closed');
          }
        },
        close: () => {
          closed += 1;
        },
      }),
    ).toThrow('replay writer closed');

    expect(bus.clientCount).toBe(0);
    expect(closed).toBe(1);
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

async function readNextOrTimeout(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  return Promise.race([
    readNext(reader),
    new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 20)),
  ]);
}
