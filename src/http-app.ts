import { publishCloudflareTailEvents, type CloudflareTailEvent, type PublishCloudflareTailEventResult } from './cloudflare-tail.js';
import { rainrailEventsAuthErrorResponse, verifyRainrailEventsBearerToken } from './events-auth.js';
import type { RainrailEventEnvelope } from './events.js';
import { handleGitHubWebhookRequest } from './github-webhook.js';
import {
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  corsPreflightResponse,
  jsonResponse,
  methodNotAllowedResponse,
  readFetchRequestBody,
  textResponse,
  withCors,
} from './http-utils.js';
import type { RainrailOperationalStore } from './operational-store.js';

export interface RainrailBridgeRoomFetchTarget {
  fetch(request: Request): Response | Promise<Response>;
}

export interface RainrailHttpAppOptions {
  room: RainrailBridgeRoomFetchTarget;
  githubWebhookSecret: string;
  publishToken: string;
  eventsBearerToken?: string;
  runtime?: string;
  githubSourceName?: string;
  maxWebhookBodyBytes?: number;
  operationalStore?: RainrailOperationalStore;
}

export interface RainrailHttpApp {
  fetch(request: Request): Promise<Response>;
  tail?(events: CloudflareTailEvent[]): Promise<PublishCloudflareTailEventResult[]>;
}

const INTERNAL_ROOM_ORIGIN = 'https://rainrail-room.local';

export function createRainrailHttpApp(options: RainrailHttpAppOptions): RainrailHttpApp {
  return {
    async fetch(request): Promise<Response> {
      try {
        return withCors(await routeRainrailHttpRequest(request, options));
      } catch {
        return jsonResponse({ error: 'internal_server_error' }, { status: 500 });
      }
    },

    async tail(events): Promise<PublishCloudflareTailEventResult[]> {
      return publishCloudflareTailEvents(events, {
        fallbackDeliveryId: await stableTailFallbackDeliveryId(events),
        publish: (event) => publishEvent(options, event),
      });
    },
  };
}

async function routeRainrailHttpRequest(request: Request, options: RainrailHttpAppOptions): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return corsPreflightResponse();
  }

  if (url.pathname === '/healthz') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const roomResponse = await options.room.fetch(new Request(`${INTERNAL_ROOM_ORIGIN}/healthz`));
    if (!roomResponse.ok) {
      return jsonResponse({ error: 'room_health_unavailable' }, { status: 502 });
    }

    return jsonResponse({
      ok: true,
      runtime: options.runtime ?? 'fetch',
      room: await roomResponse.json(),
    });
  }

  if (url.pathname === '/events') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyRainrailEventsBearerToken(request, options.eventsBearerToken);
    if (!auth.ok) return rainrailEventsAuthErrorResponse(auth);

    return options.room.fetch(new Request(`${INTERNAL_ROOM_ORIGIN}/events`, {
      headers: bridgeAuthorizationHeaders(request, options.publishToken),
      signal: request.signal,
    }));
  }

  if (url.pathname === '/webhooks/github') {
    if (request.method !== 'POST') return methodNotAllowedResponse(['POST', 'OPTIONS']);

    return handleGitHubWebhook(request, options);
  }

  if (url.pathname === '/api/state') {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    return dashboardStateResponse(url, options);
  }

  const eventDetailMatch = /^\/api\/events\/([^/]+)$/.exec(url.pathname);
  if (eventDetailMatch !== null) {
    if (request.method !== 'GET') return methodNotAllowedResponse(['GET', 'OPTIONS']);

    const auth = verifyDashboardReadRequest(request, options);
    if (auth !== undefined) return auth;

    const eventId = safeDecodeURIComponent(eventDetailMatch[1]!);
    if (eventId === undefined) {
      return jsonResponse({ error: 'invalid_event_id' }, { status: 400 });
    }

    return dashboardEventDetailResponse(eventId, options);
  }

  return textResponse('not found\n', { status: 404 });
}

function verifyDashboardReadRequest(request: Request, options: RainrailHttpAppOptions): Response | undefined {
  if (options.operationalStore === undefined) return undefined;

  const auth = verifyRainrailEventsBearerToken(request, options.eventsBearerToken);
  return auth.ok ? undefined : rainrailEventsAuthErrorResponse(auth);
}

function dashboardStateResponse(url: URL, options: RainrailHttpAppOptions): Response {
  if (options.operationalStore === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  return jsonResponse(options.operationalStore.snapshot({
    hideSkippedActivityEvents: url.searchParams.get('hideSkippedActivity') === '1',
  }));
}

function dashboardEventDetailResponse(eventId: string, options: RainrailHttpAppOptions): Response {
  if (options.operationalStore === undefined) {
    return jsonResponse({ error: 'operational_store_not_configured' }, { status: 503 });
  }

  const event = options.operationalStore.getEvent(eventId);
  if (event === undefined) {
    return jsonResponse({ error: 'event_not_found' }, { status: 404 });
  }

  return jsonResponse(event);
}

async function handleGitHubWebhook(request: Request, options: RainrailHttpAppOptions): Promise<Response> {
  let rawBody: ArrayBuffer;
  try {
    rawBody = await readFetchRequestBody(request, options.maxWebhookBodyBytes ?? DEFAULT_MAX_REQUEST_BODY_BYTES);
  } catch (error) {
    if (isStatusCodeError(error) && error.statusCode === 413) {
      return jsonResponse({ error: 'request_body_too_large' }, { status: 413 });
    }

    throw error;
  }

  const limitedRequest = new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body: rawBody,
    signal: request.signal,
  });
  const result = await handleGitHubWebhookRequest(limitedRequest, {
    secret: options.githubWebhookSecret,
    ...(options.githubSourceName === undefined ? {} : { sourceName: options.githubSourceName }),
  });

  if (!result.ok) {
    return jsonResponse({ error: result.reason }, { status: result.status });
  }

  const publishResponse = await publishEvent(options, result.event);
  if (!publishResponse.ok) {
    return jsonResponse({ error: 'failed_to_publish_event' }, { status: 502 });
  }

  return jsonResponse({
    ok: true,
    id: result.event.id,
    name: result.event.name,
    source: 'github',
  }, { status: 202 });
}

async function publishEvent(options: RainrailHttpAppOptions, event: unknown): Promise<Response> {
  const response = await options.room.fetch(new Request(`${INTERNAL_ROOM_ORIGIN}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.publishToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  }));

  if (response.ok) {
    try {
      const publishedEvent = await readPublishedEvent(response);
      if (publishedEvent !== undefined) {
        options.operationalStore?.recordEvent(publishedEvent);
      }
    } catch {
      // Event delivery already succeeded. Operational dashboard persistence must not turn
      // an accepted external delivery into a provider-visible failure and duplicate retry.
    }
  }

  return response;
}

async function readPublishedEvent(response: Response): Promise<RainrailEventEnvelope | undefined> {
  const body = await response.clone().json() as unknown;
  if (typeof body !== 'object' || body === null || !('event' in body)) {
    return undefined;
  }

  const { event } = body;
  return isRainrailEventEnvelope(event) ? event : undefined;
}

function safeDecodeURIComponent(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

function isRainrailEventEnvelope(value: unknown): value is RainrailEventEnvelope {
  return typeof value === 'object'
    && value !== null
    && 'schemaVersion' in value
    && value.schemaVersion === 'rainrail.event.v1';
}

function bridgeAuthorizationHeaders(request: Request, publishToken: string): Headers {
  const headers = new Headers({
    Authorization: `Bearer ${publishToken}`,
  });
  const lastEventId = request.headers.get('Last-Event-ID');
  if (lastEventId !== null) {
    headers.set('Last-Event-ID', lastEventId);
  }

  return headers;
}

async function stableTailFallbackDeliveryId(events: CloudflareTailEvent[]): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(stableStringify(events)),
  );

  return `tail-batch-${toHex(new Uint8Array(digest)).slice(0, 32)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(',')}}`;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isStatusCodeError(error: unknown): error is { statusCode: number } {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof error.statusCode === 'number';
}
