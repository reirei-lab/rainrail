import { publishCloudflareTailEvents, type CloudflareTailEvent, type PublishCloudflareTailEventResult } from './cloudflare-tail.js';
import { rainrailEventsAuthErrorResponse, verifyRainrailEventsBearerToken } from './events-auth.js';
import { handleGitHubWebhookRequest } from './github-webhook.js';
import {
  corsPreflightResponse,
  jsonResponse,
  methodNotAllowedResponse,
  textResponse,
  withCors,
} from './http-utils.js';

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

  return textResponse('not found\n', { status: 404 });
}

async function handleGitHubWebhook(request: Request, options: RainrailHttpAppOptions): Promise<Response> {
  const result = await handleGitHubWebhookRequest(request, {
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

function publishEvent(options: RainrailHttpAppOptions, event: unknown): Promise<Response> | Response {
  return options.room.fetch(new Request(`${INTERNAL_ROOM_ORIGIN}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.publishToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(event),
  }));
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
