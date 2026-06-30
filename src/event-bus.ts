import type { RainrailEventEnvelope } from './events.js';
import { formatRainrailSseComment, formatRainrailSseEvent } from './sse.js';

const encoder = new TextEncoder();

export interface RainrailEventBusOptions {
  replayLimit?: number;
}

export interface RainrailEventBusSubscriber {
  write(chunk: string): void;
  close?: () => void;
}

export interface RainrailReadableStreamOptions {
  replay?: boolean;
  lastEventId?: string;
  signal?: AbortSignal;
  keepAliveIntervalMs?: number;
}

export interface RainrailEventBus {
  publish(event: RainrailEventEnvelope): void;
  subscribe(subscriber: RainrailEventBusSubscriber, options?: { replay?: boolean; lastEventId?: string }): () => void;
  createReadableStream(options?: RainrailReadableStreamOptions): ReadableStream<Uint8Array>;
  loadReplay(events: RainrailEventEnvelope[]): void;
  readonly clientCount: number;
  readonly recentCount: number;
  readonly recentEvents: RainrailEventEnvelope[];
}

export function createRainrailEventBus(options: RainrailEventBusOptions = {}): RainrailEventBus {
  return new InMemoryRainrailEventBus(options);
}

class InMemoryRainrailEventBus implements RainrailEventBus {
  #clients = new Set<RainrailEventBusSubscriber>();
  #recent: RainrailEventEnvelope[] = [];
  #replayLimit: number;

  constructor(options: RainrailEventBusOptions) {
    this.#replayLimit = normalizeReplayLimit(options.replayLimit);
  }

  publish(event: RainrailEventEnvelope): void {
    const replayEvent = cloneEvent(event);
    const chunk = formatRainrailSseEvent(replayEvent);

    this.#recent.push(replayEvent);
    this.#trimRecent();

    for (const client of Array.from(this.#clients)) {
      try {
        client.write(chunk);
      } catch {
        this.#disconnect(client);
      }
    }
  }

  subscribe(subscriber: RainrailEventBusSubscriber, options: { replay?: boolean; lastEventId?: string } = {}): () => void {
    try {
      subscriber.write(formatRainrailSseComment('connected'));

      if (options.replay ?? true) {
        for (const event of this.#replayEventsAfter(options.lastEventId)) {
          subscriber.write(formatRainrailSseEvent(event));
        }
      }
    } catch (error) {
      closeSubscriber(subscriber);
      throw error;
    }

    this.#clients.add(subscriber);

    return () => {
      this.#disconnect(subscriber);
    };
  }

  createReadableStream(options: RainrailReadableStreamOptions = {}): ReadableStream<Uint8Array> {
    let unsubscribe: (() => void) | undefined;
    let keepAliveTimer: ReturnType<typeof setInterval> | undefined;

    const close = (): void => {
      if (keepAliveTimer !== undefined) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = undefined;
      }

      unsubscribe?.();
      unsubscribe = undefined;
    };

    const stream = new ReadableStream<Uint8Array>({
      start: (controller) => {
        if (options.signal?.aborted) {
          controller.close();
          return;
        }

        let closed = false;
        const subscriber: RainrailEventBusSubscriber = {
          write: (chunk) => {
            if (closed) return;
            controller.enqueue(encoder.encode(chunk));
          },
          close: () => {
            if (closed) return;
            closed = true;
            try {
              controller.close();
            } catch {
              // The stream may already be closing because the client cancelled it.
            }
          },
        };

        unsubscribe = this.subscribe(
          subscriber,
          {
            ...(options.replay === undefined ? {} : { replay: options.replay }),
            ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
          },
        );

        const keepAliveIntervalMs = normalizeKeepAliveInterval(options.keepAliveIntervalMs);
        if (keepAliveIntervalMs !== undefined) {
          keepAliveTimer = setInterval(() => {
            try {
              subscriber.write(formatRainrailSseComment('keep-alive'));
            } catch {
              close();
            }
          }, keepAliveIntervalMs);
          unrefTimer(keepAliveTimer);
        }

        options.signal?.addEventListener('abort', close, { once: true });
        if (options.signal?.aborted) {
          close();
        }
      },
      cancel: close,
    });

    return stream;
  }

  loadReplay(events: RainrailEventEnvelope[]): void {
    if (this.#replayLimit <= 0) {
      this.#recent = [];
      return;
    }

    this.#recent = events.flatMap(cloneSerializableEvent).slice(-this.#replayLimit);
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get recentCount(): number {
    return this.#recent.length;
  }

  get recentEvents(): RainrailEventEnvelope[] {
    return this.#recent.map(cloneEvent);
  }

  #trimRecent(): void {
    if (this.#recent.length > this.#replayLimit) {
      this.#recent.splice(0, this.#recent.length - this.#replayLimit);
    }
  }

  #replayEventsAfter(lastEventId: string | undefined): RainrailEventEnvelope[] {
    if (lastEventId === undefined) {
      return this.#recent.slice();
    }

    let lastIndex = -1;
    for (let index = this.#recent.length - 1; index >= 0; index -= 1) {
      if (this.#recent[index]?.id === lastEventId) {
        lastIndex = index;
        break;
      }
    }

    return lastIndex === -1 ? this.#recent.slice() : this.#recent.slice(lastIndex + 1);
  }

  #disconnect(subscriber: RainrailEventBusSubscriber): void {
    if (!this.#clients.delete(subscriber)) return;

    closeSubscriber(subscriber);
  }
}

function cloneEvent(event: RainrailEventEnvelope): RainrailEventEnvelope {
  return JSON.parse(JSON.stringify(event)) as RainrailEventEnvelope;
}

function cloneSerializableEvent(event: RainrailEventEnvelope): RainrailEventEnvelope[] {
  try {
    const replayEvent = cloneEvent(event);
    formatRainrailSseEvent(replayEvent);
    return [replayEvent];
  } catch {
    return [];
  }
}

function normalizeReplayLimit(replayLimit: number | undefined): number {
  if (replayLimit === undefined) return 100;

  if (!Number.isFinite(replayLimit) || !Number.isInteger(replayLimit) || replayLimit < 0) {
    throw new RangeError('replayLimit must be a finite non-negative integer');
  }

  return replayLimit;
}

function normalizeKeepAliveInterval(keepAliveIntervalMs: number | undefined): number | undefined {
  if (keepAliveIntervalMs === undefined) return undefined;

  return Number.isFinite(keepAliveIntervalMs) && keepAliveIntervalMs > 0 ? keepAliveIntervalMs : undefined;
}

function closeSubscriber(subscriber: RainrailEventBusSubscriber): void {
  try {
    subscriber.close?.();
  } catch {
    // Cleanup should not break publish, subscribe, or cancel paths for other subscribers.
  }
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const maybeNodeTimer = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeNodeTimer.unref?.();
}
