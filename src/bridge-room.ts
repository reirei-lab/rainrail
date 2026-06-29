import type { RainrailEventEnvelope } from './events.js';
import { createRainrailEventBus, type RainrailEventBus } from './event-bus.js';
import { formatRainrailSseEvent, rainrailSseHeaders } from './sse.js';

const RECENT_EVENTS_KEY = 'rainrail:recent-events';
const DEFAULT_REPLAY_LIMIT = 100;

type PublishEventResult =
  | { ok: true; event: RainrailEventEnvelope }
  | { ok: false; error: unknown };

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
  readonly #replayLimit: number;
  readonly #keepAliveIntervalMs: number | undefined;
  #loading: Promise<void> | undefined;
  #publishQueue: Promise<void> = Promise.resolve();
  #loaded = false;

  constructor(state: RainrailBridgeRoomState, options: RainrailBridgeRoomOptions = {}) {
    this.#state = state;
    this.#replayLimit = options.replayLimit ?? DEFAULT_REPLAY_LIMIT;
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
    const eventResultPromise: Promise<PublishEventResult> = request
      .json()
      .then(validatePublishEnvelope)
      .then(
        (event) => ({ ok: true, event }),
        (error: unknown) => ({ ok: false, error }),
      );

    const publishResult = this.#publishQueue.then(async () => {
      const eventResult = await eventResultPromise;
      if (!eventResult.ok) {
        return new Response(`invalid event envelope: ${errorMessage(eventResult.error)}\n`, { status: 400 });
      }

      try {
        if (request.signal.aborted) {
          return abortedPublishResponse();
        }

        await this.#loadRecentEvents();
        if (request.signal.aborted) {
          return abortedPublishResponse();
        }

        const { event } = eventResult;
        const previousRecentEvents = this.#bus.recentEvents;
        await this.#state.storage.put(RECENT_EVENTS_KEY, this.#nextRecentEvents(event));
        if (request.signal.aborted) {
          await this.#state.storage.put(RECENT_EVENTS_KEY, previousRecentEvents);
          return abortedPublishResponse();
        }

        this.#bus.publish(event);
      } catch {
        return new Response('publish failed\n', { status: 500 });
      }

      return Response.json({
        ok: true,
        id: eventResult.event.id,
        name: eventResult.event.name,
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
        this.#bus.loadReplay(stored.flatMap(validateStoredReplayEvent));
      }

      this.#loaded = true;
    })().finally(() => {
      this.#loading = undefined;
    });

    return this.#loading;
  }

  #nextRecentEvents(event: RainrailEventEnvelope): RainrailEventEnvelope[] {
    if (this.#replayLimit <= 0) return [];

    return [...this.#bus.recentEvents, event].slice(-this.#replayLimit);
  }
}

function validatePublishEnvelope(value: unknown): RainrailEventEnvelope {
  if (!isRecord(value)) {
    throw new TypeError('body must be a JSON object');
  }

  expectString(value, 'id');
  const schemaVersion = expectString(value, 'schemaVersion');
  expectString(value, 'name');
  expectString(value, 'occurredAt');
  const source = expectRecord(value, 'source');
  const delivery = expectRecord(value, 'delivery');
  const subject = expectRecord(value, 'subject');
  const rawPayload = expectRecord(value, 'rawPayload');

  if (schemaVersion !== 'rainrail.event.v1') {
    throw new TypeError('schemaVersion must be rainrail.event.v1');
  }

  expectString(source, 'type');
  expectString(source, 'name');
  expectString(delivery, 'id');
  expectString(delivery, 'receivedAt');
  expectString(subject, 'type');
  expectString(subject, 'id');
  expectString(rawPayload, 'kind');
  expectString(rawPayload, 'reference');

  if (!('payload' in value)) {
    throw new TypeError('payload is required');
  }

  const event = value as unknown as RainrailEventEnvelope;
  formatRainrailSseEvent(event);
  return event;
}

function validateStoredReplayEvent(value: unknown): RainrailEventEnvelope[] {
  try {
    return [validatePublishEnvelope(value)];
  } catch {
    return [];
  }
}

function expectString(record: Record<string, unknown>, key: string): string {
  if (typeof record[key] !== 'string' || record[key].length === 0) {
    throw new TypeError(`${key} must be a non-empty string`);
  }

  return record[key];
}

function expectRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(record[key])) {
    throw new TypeError(`${key} must be an object`);
  }

  return record[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortedPublishResponse(): Response {
  return new Response('request aborted\n', { status: 499 });
}
