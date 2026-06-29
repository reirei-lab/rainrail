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
    this.#replayLimit = options.replayLimit ?? 100;
  }

  publish(event: RainrailEventEnvelope): void {
    const chunk = formatRainrailSseEvent(event);

    this.#recent.push(event);
    this.#trimRecent();

    for (const client of this.#clients) {
      try {
        client.write(chunk);
      } catch {
        this.#clients.delete(client);
      }
    }
  }

  subscribe(subscriber: RainrailEventBusSubscriber, options: { replay?: boolean; lastEventId?: string } = {}): () => void {
    subscriber.write(formatRainrailSseComment('connected'));

    if (options.replay ?? true) {
      for (const event of this.#replayEventsAfter(options.lastEventId)) {
        subscriber.write(formatRainrailSseEvent(event));
      }
    }

    this.#clients.add(subscriber);

    return () => {
      this.#clients.delete(subscriber);
      subscriber.close?.();
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

        if (options.keepAliveIntervalMs !== undefined) {
          keepAliveTimer = setInterval(() => {
            try {
              subscriber.write(formatRainrailSseComment('keep-alive'));
            } catch {
              close();
            }
          }, options.keepAliveIntervalMs);
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
    this.#recent = this.#replayLimit <= 0 ? [] : events.slice(-this.#replayLimit);
  }

  get clientCount(): number {
    return this.#clients.size;
  }

  get recentCount(): number {
    return this.#recent.length;
  }

  get recentEvents(): RainrailEventEnvelope[] {
    return [...this.#recent];
  }

  #trimRecent(): void {
    if (this.#recent.length > this.#replayLimit) {
      this.#recent.splice(0, this.#recent.length - this.#replayLimit);
    }
  }

  #replayEventsAfter(lastEventId: string | undefined): RainrailEventEnvelope[] {
    if (lastEventId === undefined) {
      return this.#recent;
    }

    const lastIndex = this.#recent.findIndex((event) => event.id === lastEventId);
    return lastIndex === -1 ? this.#recent : this.#recent.slice(lastIndex + 1);
  }
}

function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const maybeNodeTimer = timer as ReturnType<typeof setInterval> & { unref?: () => void };
  maybeNodeTimer.unref?.();
}
