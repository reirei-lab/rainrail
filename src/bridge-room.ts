import type { RainrailEventEnvelope } from './events.js';
import { createRainrailEventBus, type RainrailEventBus } from './event-bus.js';
import { formatRainrailSseEvent, rainrailSseHeaders } from './sse.js';

const RECENT_EVENTS_KEY = 'rainrail:recent-events';
const DEFAULT_REPLAY_LIMIT = 100;
const ALLOWED_PAYLOAD_KEYS = new Set(['action', 'status', 'conclusion']);
const claimedStorages = new WeakSet<RainrailBridgeRoomStorage>();

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
  publishToken: string;
  replayLimit?: number;
  keepAliveIntervalMs?: number;
}

export class RainrailBridgeRoom {
  readonly #state: RainrailBridgeRoomState;
  readonly #bus: RainrailEventBus;
  readonly #publishToken: string;
  readonly #replayLimit: number;
  readonly #keepAliveIntervalMs: number | undefined;
  #loading: Promise<void> | undefined;
  #publishQueue: Promise<void> = Promise.resolve();
  #loaded = false;

  constructor(state: RainrailBridgeRoomState, options: RainrailBridgeRoomOptions) {
    const publishToken = expectPublishToken(options?.publishToken);

    this.#state = state;
    claimStorage(state.storage);
    this.#publishToken = publishToken;
    this.#replayLimit = options?.replayLimit ?? DEFAULT_REPLAY_LIMIT;
    this.#bus = createRainrailEventBus(
      options?.replayLimit === undefined ? {} : { replayLimit: options.replayLimit },
    );
    this.#keepAliveIntervalMs = options?.keepAliveIntervalMs;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/healthz') {
      try {
        await this.#loadRecentEvents();
      } catch {
        return storageRestoreFailedResponse();
      }

      return Response.json({
        ok: true,
        clients: this.#bus.clientCount,
        recent: this.#bus.recentCount,
      });
    }

    if (request.method === 'POST' && url.pathname === '/publish') {
      if (!isAuthorizedPublishRequest(request, this.#publishToken)) {
        return new Response('unauthorized\n', { status: 401 });
      }

      return this.#publish(request);
    }

    if (request.method === 'GET' && url.pathname === '/events') {
      if (!isAuthorizedBridgeRequest(request, this.#publishToken)) {
        return new Response('unauthorized\n', { status: 401 });
      }

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
        if (request.signal.aborted || isAbortError(eventResult.error)) {
          return abortedPublishResponse();
        }

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
        const recentEvents = await this.#loadCurrentRecentEvents();
        if (request.signal.aborted) {
          return abortedPublishResponse();
        }

        if (!recentEvents.some((recentEvent) => recentEvent.id === event.id)) {
          const nextRecentEvents = this.#nextRecentEvents(recentEvents, event);
          await this.#state.storage.put(RECENT_EVENTS_KEY, nextRecentEvents);
          this.#bus.loadReplay(nextRecentEvents.slice(0, -1));
          this.#bus.publish(event);
        } else {
          this.#bus.loadReplay(recentEvents);
        }
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
    const refreshResult = this.#publishQueue.then(async () => {
      try {
        await this.#refreshRecentEvents();
      } catch {
        return storageRestoreFailedResponse();
      }

      return undefined;
    });

    this.#publishQueue = refreshResult.then(
      () => undefined,
      () => undefined,
    );

    const refreshError = await refreshResult;
    if (refreshError !== undefined) return refreshError;

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

  async #refreshRecentEvents(): Promise<void> {
    await this.#loadRecentEvents();
    this.#bus.loadReplay(await this.#loadCurrentRecentEvents());
  }

  async #loadCurrentRecentEvents(): Promise<RainrailEventEnvelope[]> {
    const stored = await this.#state.storage.get(RECENT_EVENTS_KEY);
    const storedRecentEvents = Array.isArray(stored) ? stored.flatMap(validateStoredReplayEvent) : [];

    return mergeRecentEvents([...storedRecentEvents, ...this.#bus.recentEvents], this.#replayLimit);
  }

  #nextRecentEvents(recentEvents: RainrailEventEnvelope[], event: RainrailEventEnvelope): RainrailEventEnvelope[] {
    if (this.#replayLimit <= 0) return [];

    return mergeRecentEvents([...recentEvents, event], this.#replayLimit);
  }
}

function validatePublishEnvelope(value: unknown): RainrailEventEnvelope {
  if (!isRecord(value)) {
    throw new TypeError('body must be a JSON object');
  }

  const id = expectString(value, 'id');
  const schemaVersion = expectString(value, 'schemaVersion');
  const name = expectString(value, 'name');
  const occurredAt = expectString(value, 'occurredAt');
  const source = expectRecord(value, 'source');
  const delivery = expectRecord(value, 'delivery');
  const subject = expectRecord(value, 'subject');
  const rawPayload = expectRecord(value, 'rawPayload');

  if (schemaVersion !== 'rainrail.event.v1') {
    throw new TypeError('schemaVersion must be rainrail.event.v1');
  }

  const sourceType = expectString(source, 'type');
  const sourceName = expectString(source, 'name');
  const deliveryId = expectString(delivery, 'id');
  const deliveryReceivedAt = expectString(delivery, 'receivedAt');
  const subjectType = expectString(subject, 'type');
  const subjectId = expectString(subject, 'id');
  const rawPayloadKind = expectString(rawPayload, 'kind');
  const rawPayloadReference = expectString(rawPayload, 'reference');

  if (!('payload' in value)) {
    throw new TypeError('payload is required');
  }

  const event: RainrailEventEnvelope = {
    id,
    schemaVersion,
    source: {
      type: sourceType,
      name: sourceName,
      ...optionalString(source, 'repository'),
      ...optionalString(source, 'account'),
      ...optionalString(source, 'environment'),
    },
    name,
    delivery: {
      id: deliveryId,
      receivedAt: deliveryReceivedAt,
    },
    occurredAt,
    subject: {
      type: subjectType,
      id: subjectId,
      ...optionalUrl(subject, 'url'),
    },
    payload: normalizePayload(value.payload),
    rawPayload: {
      kind: rawPayloadKind,
      reference: expectSanitizedUrl(rawPayloadReference, 'reference'),
      ...optionalString(rawPayload, 'contentType'),
      ...optionalSha256(rawPayload),
    },
  };
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

function optionalString(record: Record<string, unknown>, key: string): Record<string, string> {
  if (!(key in record)) return {};

  if (typeof record[key] !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }

  return { [key]: record[key] };
}

function optionalUrl(record: Record<string, unknown>, key: string): Record<string, string> {
  if (!(key in record)) return {};

  if (typeof record[key] !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }

  const sanitized = sanitizeUrl(record[key]);
  return sanitized === undefined ? {} : { [key]: sanitized };
}

function sanitizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function expectSanitizedUrl(value: string, key: string): string {
  const sanitized = sanitizeUrl(value);
  if (sanitized === undefined) {
    throw new TypeError(`${key} must be a valid URL`);
  }

  return sanitized;
}

function optionalSha256(record: Record<string, unknown>): Record<string, string> {
  if (!('sha256' in record)) return {};

  if (typeof record.sha256 !== 'string') {
    throw new TypeError('sha256 must be a string');
  }

  if (!/^[a-f0-9]{64}$/i.test(record.sha256)) return {};

  return { sha256: record.sha256.toLowerCase() };
}

function normalizePayload(value: unknown): unknown {
  if (!isRecord(value)) {
    return {};
  }

  const payload: Record<string, string | number | boolean | null> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (ALLOWED_PAYLOAD_KEYS.has(key) && isJsonScalar(nestedValue)) {
      payload[key] = nestedValue;
    }
  }

  return payload;
}

function isJsonScalar(value: unknown): value is string | number | boolean | null {
  return value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function claimStorage(storage: RainrailBridgeRoomStorage): void {
  if (claimedStorages.has(storage)) {
    throw new TypeError('RainrailBridgeRoom storage must be owned by a single room');
  }

  claimedStorages.add(storage);
}

function expectPublishToken(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError('publishToken must be a non-empty string');
  }

  return value;
}

function isAuthorizedPublishRequest(request: Request, publishToken: string): boolean {
  return isAuthorizedBridgeRequest(request, publishToken);
}

function isAuthorizedBridgeRequest(request: Request, publishToken: string): boolean {
  const authorization = request.headers.get('Authorization');
  if (authorization?.startsWith('Bearer ') && constantTimeStringEqual(authorization.slice('Bearer '.length), publishToken)) {
    return true;
  }

  const headerToken = request.headers.get('X-Rainrail-Publish-Token');
  return headerToken !== null && constantTimeStringEqual(headerToken, publishToken);
}

function constantTimeStringEqual(left: string, right: string): boolean {
  let diff = left.length ^ right.length;
  const maxLength = Math.max(left.length, right.length);

  for (let index = 0; index < maxLength; index += 1) {
    diff |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }

  return diff === 0;
}

function abortedPublishResponse(): Response {
  return new Response('request aborted\n', { status: 499 });
}

function storageRestoreFailedResponse(): Response {
  return new Response('storage restore failed\n', { status: 500 });
}

function mergeRecentEvents(events: RainrailEventEnvelope[], replayLimit: number): RainrailEventEnvelope[] {
  if (replayLimit <= 0) return [];

  const merged = new Map<string, RainrailEventEnvelope>();
  for (const event of events) {
    merged.set(event.id, event);
  }

  return [...merged.values()].slice(-replayLimit);
}
