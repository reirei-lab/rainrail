import type { RainrailEventEnvelope } from '../events.js';
import { createRainrailEventBus, type RainrailEventBus } from './event-bus.js';
import { formatRainrailSseEvent, rainrailSseHeaders } from './sse.js';

const RECENT_EVENTS_KEY = 'rainrail:recent-events';
const DEFAULT_REPLAY_LIMIT = 100;
const ALLOWED_PAYLOAD_KEYS = new Set(['action', 'status', 'conclusion']);
const CLOUDFLARE_ERROR_PAYLOAD_KEYS = new Set([
  'scriptName',
  'scriptVersion',
  'method',
  'url',
  'cfRay',
  'exceptions',
]);
const GITHUB_MENTION_PAYLOAD_KEYS = new Set([
  'provider',
  'action',
  'event',
  'repository',
  'actor',
  'resource',
  'pullRequest',
  'comment',
  'review',
]);
const MANUAL_INPUT_PAYLOAD_KEYS = new Set([
  'provider',
  'channel',
  'action',
  'conversation',
  'message',
  'actor',
  'attachments',
  'replyTarget',
]);
const ALLOWED_RAW_PAYLOAD_KINDS = new Set(['external-reference', 'inline-redacted']);
const ALLOWED_URL_PROTOCOLS = new Set(['https:', 'github:', 'cloudflare:', 'manual:', 'chat:']);
const SAFE_DELIVERY_REFERENCE_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const SAFE_IDENTIFIER_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_METADATA_TOKEN = /^[a-z0-9][a-z0-9._:-]{0,63}$/i;
const SAFE_REPOSITORY_NAME = /^[A-Za-z0-9_.-]{1,64}\/[A-Za-z0-9_.-]{1,64}$/;
const SAFE_REF_SUBJECT_ID = /^(?:(?:branch|tag):|refs\/(?:heads|tags)\/)[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const SAFE_GITHUB_URL_SEGMENT = /^[A-Za-z0-9_.-]{1,64}$/;
const SAFE_GITHUB_NUMERIC_ID = /^\d{1,20}$/;
const SAFE_UTC_ISO_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/;
const MAX_CLOUDFLARE_EXCEPTION_MESSAGE_LENGTH = 512;
const MAX_CLOUDFLARE_EXCEPTION_NAME_LENGTH = 200;
const MAX_CLOUDFLARE_EXCEPTION_STACK_LENGTH = 1_200;
const MAX_CLOUDFLARE_EXCEPTION_STACK_LINES = 8;
const MAX_MANUAL_INPUT_TEXT_LENGTH = 8_000;
const MAX_MANUAL_INPUT_ATTACHMENTS = 20;
const claimedStorages = new WeakSet<RainrailBridgeRoomStorage>();

type PublishEventResult =
  | { ok: true; event: RainrailEventEnvelope }
  | { ok: false; error: unknown };

export interface RainrailBridgeRoomStorage {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  compareAndSet?(key: string, expected: unknown, value: unknown): Promise<boolean>;
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
    const replayLimit = expectReplayLimit(options?.replayLimit ?? DEFAULT_REPLAY_LIMIT);

    this.#state = state;
    claimStorage(state.storage);
    this.#publishToken = publishToken;
    this.#replayLimit = replayLimit;
    this.#bus = createRainrailEventBus(
      options?.replayLimit === undefined ? {} : { replayLimit },
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

        return new Response(`invalid event envelope: ${publishErrorMessage(eventResult.error)}\n`, { status: 400 });
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

        let responseEvent = event;
        const existingEvent = recentEvents.find((recentEvent) => recentEvent.id === event.id);
        if (existingEvent === undefined) {
          const nextRecentEvents = this.#nextRecentEvents(recentEvents, event);
          await this.#state.storage.put(RECENT_EVENTS_KEY, nextRecentEvents);
          this.#bus.loadReplay(nextRecentEvents.slice(0, -1));
          this.#bus.publish(event);
        } else {
          this.#bus.loadReplay(recentEvents);
          responseEvent = existingEvent;
        }
        return Response.json({
          ok: true,
          id: responseEvent.id,
          name: responseEvent.name,
          event: responseEvent,
          clients: this.#bus.clientCount,
        });
      } catch {
        return new Response('publish failed\n', { status: 500 });
      }
    });

    this.#publishQueue = publishResult.then(
      () => undefined,
      () => undefined,
    );

    return publishResult;
  }

  async #subscribe(request: Request): Promise<Response> {
    const refreshResult = this.#publishQueue.then(async () => {
      if (request.signal.aborted) {
        return abortedPublishResponse();
      }

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

  const id = expectIdentifier(value, 'id');
  const schemaVersion = expectString(value, 'schemaVersion');
  const name = expectIdentifier(value, 'name');
  const occurredAt = expectTimestamp(value, 'occurredAt');
  const source = expectRecord(value, 'source');
  const delivery = expectRecord(value, 'delivery');
  const subject = expectRecord(value, 'subject');
  const rawPayload = expectRecord(value, 'rawPayload');

  if (schemaVersion !== 'rainrail.event.v1') {
    throw new TypeError('schemaVersion must be rainrail.event.v1');
  }

  const sourceType = expectIdentifier(source, 'type');
  const sourceName = expectIdentifier(source, 'name');
  const deliveryId = expectIdentifier(delivery, 'id');
  const deliveryReceivedAt = expectTimestamp(delivery, 'receivedAt');
  const subjectType = expectIdentifier(subject, 'type');
  const subjectId = expectSubjectIdentifier(subject);
  const rawPayloadKind = expectRawPayloadKind(rawPayload);
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
      ...optionalRepository(source, 'repository'),
      ...optionalIdentifier(source, 'account'),
      ...optionalIdentifier(source, 'environment'),
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
    payload: normalizePayload(value.payload, { sourceType, name }),
    rawPayload: {
      kind: rawPayloadKind,
      reference: expectSanitizedUrl(rawPayloadReference, 'reference'),
      ...optionalContentType(rawPayload),
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

function expectIdentifier(record: Record<string, unknown>, key: string): string {
  const value = expectString(record, key);
  if (!isSafeIdentifier(value)) {
    throw new TypeError(`${key} must be a safe identifier`);
  }

  return value;
}

function expectSubjectIdentifier(record: Record<string, unknown>): string {
  const value = expectString(record, 'id');
  if (!isSafeIdentifier(value) && !SAFE_REF_SUBJECT_ID.test(value)) {
    throw new TypeError('id must be a safe identifier');
  }

  return value;
}

function expectTimestamp(record: Record<string, unknown>, key: string): string {
  const value = expectString(record, key);
  if (!isValidUtcIsoTimestamp(value)) {
    throw new TypeError(`${key} must be a UTC ISO timestamp`);
  }

  return value;
}

function isValidUtcIsoTimestamp(value: string): boolean {
  const match = SAFE_UTC_ISO_TIMESTAMP.exec(value);
  if (match === null) return false;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;

  const [, seconds, milliseconds] = match;
  const canonical = `${seconds}.${(milliseconds ?? '').padEnd(3, '0')}Z`;
  return new Date(parsed).toISOString() === canonical;
}

function expectRecord(record: Record<string, unknown>, key: string): Record<string, unknown> {
  if (!isRecord(record[key])) {
    throw new TypeError(`${key} must be an object`);
  }

  return record[key];
}

function optionalIdentifier(record: Record<string, unknown>, key: string): Record<string, string> {
  if (!(key in record)) return {};

  if (typeof record[key] !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }

  return isSafeIdentifier(record[key]) ? { [key]: record[key] } : {};
}

function optionalRepository(record: Record<string, unknown>, key: string): Record<string, string> {
  if (!(key in record)) return {};

  if (typeof record[key] !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }

  return SAFE_REPOSITORY_NAME.test(record[key]) ? { [key]: record[key] } : {};
}

function optionalUrl(record: Record<string, unknown>, key: string): Record<string, string> {
  if (!(key in record)) return {};

  if (typeof record[key] !== 'string') {
    throw new TypeError(`${key} must be a string`);
  }

  const sanitized = sanitizeUrl(record[key]);
  return sanitized === undefined ? {} : { [key]: sanitized };
}

function optionalContentType(record: Record<string, unknown>): Record<string, string> {
  if (!('contentType' in record)) return {};

  if (typeof record.contentType !== 'string') {
    throw new TypeError('contentType must be a string');
  }

  const contentType = record.contentType.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType === undefined || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(contentType)) {
    return {};
  }

  return { contentType };
}

function expectRawPayloadKind(record: Record<string, unknown>): string {
  const kind = expectString(record, 'kind');
  if (!ALLOWED_RAW_PAYLOAD_KINDS.has(kind)) {
    throw new TypeError('kind must be a known raw payload kind');
  }

  return kind;
}

function sanitizeUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!isAllowedUrl(url)) return undefined;

    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function isAllowedUrl(url: URL): boolean {
  if (!ALLOWED_URL_PROTOCOLS.has(url.protocol)) return false;

  if (url.protocol === 'https:') {
    return isAllowedGitHubUrl(url);
  }

  if (
    url.protocol === 'github:'
    || url.protocol === 'cloudflare:'
    || url.protocol === 'manual:'
    || url.protocol === 'chat:'
  ) {
    return isAllowedDeliveryReferenceUrl(url);
  }

  return true;
}

function isAllowedGitHubUrl(url: URL): boolean {
  if (url.hostname !== 'github.com') return false;

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return false;

  const [, , resource, id] = parts;
  if (!SAFE_GITHUB_URL_SEGMENT.test(parts[0] ?? '') || !SAFE_GITHUB_URL_SEGMENT.test(parts[1] ?? '')) {
    return false;
  }

  return (
    parts.length === 2 ||
    ((resource === 'issues' || resource === 'pull') && SAFE_GITHUB_NUMERIC_ID.test(id ?? '') && parts.length === 4) ||
    (resource === 'runs' && SAFE_GITHUB_NUMERIC_ID.test(id ?? '') && parts.length === 4) ||
    (resource === 'actions' && parts[3] === 'runs' && SAFE_GITHUB_NUMERIC_ID.test(parts[4] ?? '') && parts.length === 5)
  );
}

function isAllowedDeliveryReferenceUrl(url: URL): boolean {
  if (url.hostname !== 'deliveries') return false;

  const parts = url.pathname.split('/').filter(Boolean);
  return parts.length === 1 && url.pathname === `/${parts[0]}` && SAFE_DELIVERY_REFERENCE_ID.test(parts[0] ?? '');
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

function normalizePayload(value: unknown, context: { sourceType: string; name: string }): unknown {
  if (!isRecord(value)) {
    return {};
  }

  const payload: Record<string, unknown> = {};
  const manualPayload = isManualInputPayload(context);
  for (const [key, nestedValue] of Object.entries(value)) {
    if (manualPayload) {
      if (MANUAL_INPUT_PAYLOAD_KEYS.has(key)) {
        const normalized = normalizeManualInputPayloadField(key, nestedValue);
        if (normalized !== undefined) {
          payload[key] = normalized;
        }
      }
    } else if (ALLOWED_PAYLOAD_KEYS.has(key) && isSafePayloadMetadata(nestedValue)) {
      payload[key] = nestedValue;
    } else if (isCloudflareErrorPayload(value, context) && CLOUDFLARE_ERROR_PAYLOAD_KEYS.has(key)) {
      const normalized = normalizeCloudflareErrorPayloadField(key, nestedValue);
      if (normalized !== undefined) {
        payload[key] = normalized;
      }
    } else if (isGitHubMentionPayload(value) && GITHUB_MENTION_PAYLOAD_KEYS.has(key)) {
      const normalized = normalizeGitHubMentionPayloadField(key, nestedValue);
      if (normalized !== undefined) {
        payload[key] = normalized;
      }
    }
  }

  return payload;
}

function isCloudflareErrorPayload(
  value: Record<string, unknown>,
  context: { sourceType: string; name: string },
): boolean {
  if (context.sourceType !== 'cloudflare' || context.name !== 'cloudflare.error') {
    return false;
  }
  return value.action === 'exception'
    || value.conclusion === 'failure'
    || Array.isArray(value.exceptions);
}

function normalizeCloudflareErrorPayloadField(key: string, value: unknown): unknown {
  if (key === 'exceptions') return normalizeCloudflareExceptions(value);
  if (key === 'url') return typeof value === 'string' ? sanitizePayloadUrl(value) : undefined;
  if (typeof value === 'string' && isSafePayloadMetadata(value)) return value;
  return undefined;
}

function normalizeCloudflareExceptions(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const exceptions = value.flatMap((exception) => {
    if (!isRecord(exception)) return [];
    const normalized: Record<string, string> = {};
    for (const key of ['name', 'message', 'stack'] as const) {
      const nestedValue = exception[key];
      if (typeof nestedValue === 'string' && nestedValue.length > 0) {
        normalized[key] = normalizeCloudflareExceptionString(key, nestedValue);
      }
    }
    return Object.keys(normalized).length > 0 ? [normalized] : [];
  });
  return exceptions.length > 0 ? exceptions : undefined;
}

function normalizeCloudflareExceptionString(key: 'name' | 'message' | 'stack', value: string): string {
  const sanitized = sanitizePayloadText(value);
  if (key === 'name') {
    return truncatePayloadText(sanitized, MAX_CLOUDFLARE_EXCEPTION_NAME_LENGTH);
  }
  if (key === 'message') {
    return truncatePayloadText(sanitized, MAX_CLOUDFLARE_EXCEPTION_MESSAGE_LENGTH);
  }
  if (key === 'stack') {
    return truncatePayloadStackText(
      truncatePayloadStackLines(sanitized, MAX_CLOUDFLARE_EXCEPTION_STACK_LINES),
      MAX_CLOUDFLARE_EXCEPTION_STACK_LENGTH,
    );
  }
  return sanitized;
}

function sanitizePayloadUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    url.username = '';
    url.password = '';
    url.pathname = sanitizePayloadPathname(url.pathname);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

function isGitHubMentionPayload(value: Record<string, unknown>): boolean {
  return value.event === 'issue_comment'
    || value.event === 'pull_request_review_comment'
    || value.event === 'pull_request_review';
}

function normalizeGitHubMentionPayloadField(key: string, value: unknown): unknown {
  if (key === 'provider') {
    return value === 'github' ? value : undefined;
  }
  if (key === 'action' || key === 'event') {
    return typeof value === 'string' && isSafePayloadMetadata(value) ? value : undefined;
  }
  if (key === 'repository') return normalizeGitHubRepository(value);
  if (key === 'actor') return normalizeGitHubActor(value);
  if (key === 'resource' || key === 'pullRequest') return normalizeGitHubResource(value);
  if (key === 'comment' || key === 'review') return normalizeGitHubComment(value);
  return undefined;
}

function isManualInputPayload(context: { sourceType: string; name: string }): boolean {
  return (context.sourceType === 'manual' && context.name === 'rainrail.manual.message')
    || (context.sourceType === 'chat' && context.name === 'rainrail.chat.message');
}

function normalizeManualInputPayloadField(key: string, value: unknown): unknown {
  if (key === 'provider') return value === 'rainrail' ? value : undefined;
  if (key === 'channel') return value === 'manual' || value === 'chat' ? value : undefined;
  if (key === 'action') return value === 'message' ? value : undefined;
  if (key === 'conversation') return normalizeManualConversation(value);
  if (key === 'message') return normalizeManualMessage(value);
  if (key === 'actor') return normalizeManualActor(value);
  if (key === 'attachments') return normalizeManualAttachments(value);
  if (key === 'replyTarget') return normalizeManualReplyTarget(value);
  return undefined;
}

function normalizeManualConversation(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const normalized = {
    ...pickManualStringFields(value, ['id', 'url']),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeManualMessage(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const normalized = {
    ...pickManualStringFields(value, ['id', 'text']),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeManualActor(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const normalized = {
    ...pickManualStringFields(value, ['id', 'displayName', 'type']),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeManualAttachments(value: unknown): unknown {
  if (!Array.isArray(value)) return undefined;
  const attachments = value.slice(0, MAX_MANUAL_INPUT_ATTACHMENTS).flatMap((attachment) => {
    if (!isRecord(attachment)) return [];
    const normalized = {
      ...pickManualStringFields(attachment, ['id', 'name', 'contentType', 'url']),
    };
    return Object.keys(normalized).length > 0 ? [normalized] : [];
  });
  return attachments.length > 0 ? attachments : undefined;
}

function normalizeManualReplyTarget(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const normalized = {
    ...pickManualStringFields(value, ['id', 'url']),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function pickManualStringFields(record: Record<string, unknown>, keys: string[]): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      normalized[key] = key === 'url'
        ? truncateManualPayloadString(sanitizePayloadUrl(value) ?? '')
        : truncateManualPayloadString(sanitizePayloadText(value));
    }
  }
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value.length > 0));
}

function truncateManualPayloadString(value: string): string {
  return value.slice(0, MAX_MANUAL_INPUT_TEXT_LENGTH);
}

function normalizeGitHubRepository(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return pickStringFields(value, ['fullName', 'nameWithOwner']);
}

function normalizeGitHubActor(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  return pickStringFields(value, ['login']);
}

function normalizeGitHubResource(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const normalized: Record<string, unknown> = {
    ...pickStringFields(value, ['type', 'id', 'title', 'url']),
    ...pickNumberFields(value, ['number']),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeGitHubComment(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const normalized = {
    ...pickStringFields(value, ['id', 'url', 'author']),
    ...mentionedLoginsFromComment(value),
  };
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function pickStringFields(record: Record<string, unknown>, keys: string[]): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) {
      normalized[key] = key === 'url' ? sanitizeGitHubMentionUrl(value) ?? '' : sanitizePayloadText(value);
    }
  }
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value.length > 0));
}

function sanitizeGitHubMentionUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return undefined;
    url.username = '';
    url.password = '';
    url.search = '';
    if (!isSafeGitHubMentionFragment(url.hash)) {
      url.hash = '';
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function isSafeGitHubMentionFragment(hash: string): boolean {
  if (hash.length === 0) return true;
  return /^#(?:issuecomment-\d+|discussion_r\d+|pullrequestreview-\d+)$/iu.test(hash);
}

function pickNumberFields(record: Record<string, unknown>, keys: string[]): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      normalized[key] = value;
    }
  }
  return normalized;
}

function sanitizePayloadPathname(pathname: string): string {
  const segments = pathname.split('/');
  return segments.map((segment, index) => {
    if (segment.length === 0) return segment;
    const previous = segments[index - 1]?.toLowerCase() ?? '';
    if (/^(token|secret|password|code|reset|magic-link|invite|session|auth|verify|verification)$/iu.test(previous)) {
      return '[redacted]';
    }
    if (/^(token|secret|password|code|reset)$/iu.test(segment)) {
      return '[redacted]';
    }
    return /^[A-Za-z0-9_-]{16,}$/u.test(segment) && /[A-Za-z]/u.test(segment) && /\d/u.test(segment)
      ? '[redacted]'
      : segment;
  }).join('/') || '/';
}

function sanitizePayloadText(value: string): string {
  return redactPayloadSecretStructuredValues(value)
    .replace(/<!--\s*error-fingerprint:[^>\r\n]*(?:-->)?/giu, '<!-- escaped-error-fingerprint: [redacted] -->')
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`/@]*@[^\s"'<>`,;)]+/giu, (url) => sanitizePayloadCredentialUrl(url))
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>`,;)]+/giu, (url) => sanitizePayloadCredentialUrl(url))
    .replace(/https?:\/\/[^\s"'<>`]+/giu, (url) => sanitizePayloadUrl(url) ?? '[redacted-url]')
    .replace(/(^|[\s"'(<`,;])\/[^\s"'<>`,;)]+/giu, (match, prefix: string) => `${prefix}${sanitizePayloadPathname(match.slice(prefix.length))}`)
    .replace(/\b(cookie|set-cookie)\s*:\s*[^\r\n]+/giu, '$1: [redacted]')
    .replace(/\bauthorization\s*:\s*[^\r\n]+/giu, 'authorization: [redacted]')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(["'])(?:\\.|(?!\5)[^\\])*\5/giu, '$1$2$3$2$4$5[redacted]$5')
    .replace(/(["'])([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\1(\s*:\s*)(["'])(?:\\.|(?!\4)[^\\\r\n])*(?=\r?\n|$)/giu, '$1$2$1$3$4[redacted]$4')
    .replace(/(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(["'])(?:\\.|(?!\5)[^\\\r\n])*(?=\r?\n|$)/giu, '$1$2$3$2$4$5[redacted]$5')
    .replace(/(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*:\s*)(?!["']|\[redacted\])([^,\s\r\n}\]]+)/giu, '$1$2$3$2$4[redacted]')
    .replace(/(^|[.?&{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2\s*=\s*(["'])(?:\\.|(?!\4)[^\\])*\4/giu, '$1$2$3$2=[redacted]')
    .replace(/(^|[.?&{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2\s*=\s*(["'])(?:\\.|(?!\4)[^\\\r\n])*(?=\r?\n|$)/giu, '$1$2$3$2=[redacted]')
    .replace(/(^|[.?&{\s"'<>`,;\[(])([A-Za-z0-9_.-]*authorization[A-Za-z0-9_.-]*)\s*=\s*([^\r\n"'<>`,;]*?)(?=(?:\s+[A-Za-z0-9_.-]*(?:authorization|cookie|set-cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*\s*=)|[&\r\n"'<>`,;]|$)/giu, '$1$2=[redacted]')
    .replace(/(^|[.?&{\s"'<>`,;\[(])([A-Za-z0-9_.-]*(?:cookie|set-cookie)[A-Za-z0-9_.-]*)\s*=\s*([^;\s\r\n"'<>`,]*(?:;\s*[^=;\s\r\n"'<>`,]+=[^;\s\r\n"'<>`,]*)*)/giu, '$1$2=[redacted]')
    .replace(/(^|[.?&{\s"'<>`,;\[(])([A-Za-z0-9_.-]*(?:token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\s*=\s*([^&\s"'<>`,;]+)/giu, '$1$2=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/giu, 'Bearer [redacted]');
}

function sanitizePayloadCredentialUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.pathname = sanitizePayloadPathname(url.pathname);
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return '[redacted-url]';
  }
}

function redactPayloadSecretStructuredValues(value: string): string {
  const keyPattern = /(^|[{\s"'<>`,;\[(])(["']?)([A-Za-z0-9_.-]*(?:authorization|cookie|token|secret|password|key|code|reset|verification|session)[A-Za-z0-9_.-]*)\2(\s*[:=]\s*)([\[{])/giu;
  let redacted = '';
  let cursor = 0;
  for (const match of value.matchAll(keyPattern)) {
    const matchText = match[0];
    const matchIndex = match.index;
    if (matchIndex < cursor) continue;
    const valueStart = matchIndex + matchText.length - 1;
    const valueEnd = findPayloadBalancedStructuredValueEnd(value, valueStart);
    redacted += value.slice(cursor, matchIndex);
    redacted += `${match[1] ?? ''}${match[2] ?? ''}${match[3] ?? ''}${match[2] ?? ''}${match[4] ?? ''}[redacted]`;
    if (valueEnd === undefined) {
      const newlineIndex = value.indexOf('\n', valueStart);
      cursor = newlineIndex === -1 ? value.length : newlineIndex;
    } else {
      cursor = valueEnd + 1;
    }
  }
  return redacted + value.slice(cursor);
}

function findPayloadBalancedStructuredValueEnd(value: string, valueStart: number): number | undefined {
  const stack: string[] = [];
  let quote: string | undefined;
  let escaped = false;
  for (let index = valueStart; index < value.length; index += 1) {
    const char = value[index];
    if (quote !== undefined) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '[') {
      stack.push(']');
    } else if (char === '{') {
      stack.push('}');
    } else if (char === ']') {
      if (stack.at(-1) !== ']') return undefined;
      stack.pop();
      if (stack.length === 0) return index;
    } else if (char === '}') {
      if (stack.at(-1) !== '}') return undefined;
      stack.pop();
      if (stack.length === 0) return index;
    }
  }
  return undefined;
}

function mentionedLoginsFromComment(value: Record<string, unknown>): { mentionedLogins: string[] } | {} {
  const mentions = new Set<string>();

  const existing = value.mentionedLogins;
  if (Array.isArray(existing)) {
    for (const login of existing) {
      if (typeof login === 'string' && isSafeGitHubLogin(login)) mentions.add(login);
    }
  }

  const body = value.body;
  if (typeof body === 'string') {
    for (const match of body.matchAll(/(^|[^\w-])@([A-Za-z0-9-]{1,39})(?=$|[^\w-])/gu)) {
      const login = match[2];
      if (login !== undefined && isSafeGitHubLogin(login)) mentions.add(login);
    }
  }

  return mentions.size > 0 ? { mentionedLogins: [...mentions] } : {};
}

function isSafeGitHubLogin(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u.test(value);
}

function truncatePayloadText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength)}\n... truncated ...`;
}

function truncatePayloadLines(value: string, maxLines: number): string {
  const lines = value.split(/\r?\n/u);
  if (lines.length <= maxLines) return value;
  return `${lines.slice(0, maxLines).join('\n')}\n... truncated ...`;
}

function truncatePayloadStackLines(value: string, maxLines: number): string {
  const fallbackLines: string[] = [];
  const keptLines: string[] = [];
  let frameSeen = false;
  let truncated = false;
  let cursor = 0;

  while (cursor <= value.length) {
    const nextLineBreak = value.indexOf('\n', cursor);
    const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
    const line = value.slice(cursor, lineEnd).replace(/\r$/u, '');
    if (fallbackLines.length < maxLines) {
      fallbackLines.push(line);
    } else {
      truncated = true;
    }
    if (isPayloadStackFrameLine(line)) {
      frameSeen = true;
      if (keptLines.length < maxLines) {
        keptLines.push(line);
      } else {
        truncated = true;
      }
    } else if (!frameSeen) {
      if (keptLines.length < Math.min(2, maxLines)) {
        keptLines.push(truncatePayloadStackContextLine(line));
      } else {
        truncated = true;
      }
    } else if (keptLines.length < maxLines) {
      keptLines.push(line);
    } else {
      truncated = true;
    }
    if (nextLineBreak === -1) break;
    cursor = nextLineBreak + 1;
  }

  const lines = frameSeen ? keptLines : fallbackLines;
  if (!truncated) return value;
  return `${lines.join('\n')}\n... truncated ...`;
}

function truncatePayloadStackText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const lines = value.split('\n');
  const kept = lines
    .filter((line, index) => index < 2 || isPayloadStackFrameLine(line) || line === '... truncated ...')
    .map((line) => isPayloadStackFrameLine(line) || line === '... truncated ...' ? line : truncatePayloadStackContextLine(line));
  const output = kept.join('\n');
  if (output.length <= maxLength) return output.includes('... truncated ...') ? output : `${output}\n... truncated ...`;
  return `${output.slice(0, maxLength - '\n... truncated ...'.length)}\n... truncated ...`;
}

function isPayloadStackFrameLine(line: string): boolean {
  return /^\s*at\s+\S+/u.test(line);
}

function truncatePayloadStackContextLine(line: string): string {
  const maxLength = 200;
  if (line.length <= maxLength) return line;
  return `${line.slice(0, maxLength)} ... truncated ...`;
}

function isSafePayloadMetadata(value: unknown): value is string | null {
  if (value === null) return true;

  return typeof value === 'string' && SAFE_METADATA_TOKEN.test(value);
}

function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER_TOKEN.test(value) || SAFE_REPOSITORY_NAME.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function publishErrorMessage(error: unknown): string {
  if (error instanceof SyntaxError) {
    return 'malformed JSON';
  }

  if (error instanceof TypeError) {
    return error.message;
  }

  return 'invalid request body';
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

function expectReplayLimit(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 0) {
    throw new RangeError('replayLimit must be a finite non-negative integer');
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
    if (merged.has(event.id)) {
      merged.delete(event.id);
    }

    merged.set(event.id, event);
  }

  return [...merged.values()].slice(-replayLimit);
}
