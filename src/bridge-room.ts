import type { RainrailEventEnvelope } from './events.js';
import { createRainrailEventBus, type RainrailEventBus } from './event-bus.js';
import { rainrailSseHeaders } from './sse.js';

const RECENT_EVENTS_KEY = 'rainrail:recent-events';

export interface RainrailBridgeRoomStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export interface RainrailBridgeRoomState {
  storage: RainrailBridgeRoomStorage;
}

export interface RainrailBridgeRoomOptions {
  replayLimit?: number;
  keepAliveIntervalMs?: number;
}

export class RainrailBridgeRoom {
  readonly #state: RainrailBridgeRoomState;
  readonly #bus: RainrailEventBus;
  readonly #keepAliveIntervalMs: number | undefined;
  #loading: Promise<void> | undefined;
  #publishQueue: Promise<void> = Promise.resolve();
  #loaded = false;

  constructor(state: RainrailBridgeRoomState, options: RainrailBridgeRoomOptions = {}) {
    this.#state = state;
    this.#bus = createRainrailEventBus(
      options.replayLimit === undefined ? {} : { replayLimit: options.replayLimit },
    );
    this.#keepAliveIntervalMs = options.keepAliveIntervalMs;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      await this.#loadRecentEvents();

      return Response.json({
        ok: true,
        clients: this.#bus.clientCount,
        recent: this.#bus.recentCount,
      });
    }

    if (request.method === 'POST' && url.pathname === '/publish') {
      return this.#publish(request);
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      return this.#subscribe(request);
    }

    return new Response('not found\n', { status: 404 });
  }

  async #publish(request: Request): Promise<Response> {
    const event = (await request.json()) as RainrailEventEnvelope;

    const publishResult = this.#publishQueue.then(async () => {
      await this.#loadRecentEvents();

      this.#bus.publish(event);
      await this.#state.storage.put(RECENT_EVENTS_KEY, this.#bus.recentEvents);

      return Response.json({
        ok: true,
        id: event.id,
        name: event.name,
        clients: this.#bus.clientCount,
      });
    });

    this.#publishQueue = publishResult.then(
      () => undefined,
      () => undefined,
    );

    return publishResult;
  }

  async #subscribe(request: Request): Promise<Response> {
    await this.#loadRecentEvents();

    const lastEventId = request.headers.get('Last-Event-ID');

    return new Response(
      this.#bus.createReadableStream({
        signal: request.signal,
        ...(lastEventId === null ? {} : { lastEventId }),
        ...(this.#keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: this.#keepAliveIntervalMs }),
      }),
      {
        headers: rainrailSseHeaders,
      },
    );
  }

  async #loadRecentEvents(): Promise<void> {
    if (this.#loaded) return;

    this.#loading ??= (async () => {
      const stored = await this.#state.storage.get(RECENT_EVENTS_KEY);
      if (Array.isArray(stored)) {
        this.#bus.loadReplay(stored as RainrailEventEnvelope[]);
      }

      this.#loaded = true;
    })().finally(() => {
      this.#loading = undefined;
    });

    return this.#loading;
  }
}
