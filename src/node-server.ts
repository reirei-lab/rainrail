import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import { RainrailBridgeRoom, type RainrailBridgeRoomState } from './bridge-room.js';
import { createRainrailHttpApp, type RainrailHttpApp, type RainrailHttpAppOptions } from './http-app.js';
import { jsonResponse, readRequestBody, writeFetchResponse } from './http-utils.js';

export interface RainrailNodeServerOptions extends Omit<RainrailHttpAppOptions, 'room'> {
  state?: RainrailBridgeRoomState;
  replayLimit?: number;
  keepAliveIntervalMs?: number;
  maxBodyBytes?: number;
}

export interface RainrailNodeServer {
  server: http.Server;
  app: RainrailHttpApp;
  room: RainrailBridgeRoom;
}

export function createRainrailNodeServer(options: RainrailNodeServerOptions): RainrailNodeServer {
  const room = new RainrailBridgeRoom(options.state ?? createInMemoryBridgeRoomState(), {
    publishToken: options.publishToken,
    ...(options.replayLimit === undefined ? {} : { replayLimit: options.replayLimit }),
    ...(options.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: options.keepAliveIntervalMs }),
  });
  const app = createRainrailHttpApp({
    room,
    githubWebhookSecret: options.githubWebhookSecret,
    publishToken: options.publishToken,
    ...(options.eventsBearerToken === undefined ? {} : { eventsBearerToken: options.eventsBearerToken }),
    runtime: options.runtime ?? 'node',
    ...(options.githubSourceName === undefined ? {} : { githubSourceName: options.githubSourceName }),
    ...(options.maxWebhookBodyBytes === undefined ? {} : { maxWebhookBodyBytes: options.maxWebhookBodyBytes }),
  });

  const server = http.createServer(async (request, response) => {
    const abortController = new AbortController();
    response.once('close', () => {
      abortController.abort();
    });

    try {
      await writeFetchResponse(
        response,
        await app.fetch(await toFetchRequest(request, options, abortController.signal)),
        { signal: abortController.signal },
      );
    } catch (error) {
      const status = isStatusCodeError(error) ? error.statusCode : 500;
      await writeFetchResponse(
        response,
        jsonResponse({ error: status === 413 ? 'request_body_too_large' : 'internal_server_error' }, { status }),
      );
    }
  });

  return { server, app, room };
}

export function createInMemoryBridgeRoomState(): RainrailBridgeRoomState {
  const values = new Map<string, unknown>();

  return {
    storage: {
      async get(key) {
        return values.get(key);
      },
      async put(key, value) {
        values.set(key, value);
      },
    },
  };
}

async function toFetchRequest(
  request: IncomingMessage,
  options: Pick<RainrailNodeServerOptions, 'maxBodyBytes' | 'maxWebhookBodyBytes'>,
  signal: AbortSignal,
): Promise<Request> {
  const host = request.headers.host ?? '127.0.0.1';
  const url = new URL(request.url ?? '/', `http://${host}`);
  const headers = new Headers();

  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
    } else {
      headers.set(key, value);
    }
  }

  const init: RequestInit = {
    method: request.method ?? 'GET',
    headers,
    signal,
  };

  if (request.method === 'POST' && url.pathname === '/webhooks/github') {
    init.body = await readRequestBody(request, options.maxWebhookBodyBytes ?? options.maxBodyBytes);
  }

  return new Request(url, init);
}

function isStatusCodeError(error: unknown): error is { statusCode: number } {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof error.statusCode === 'number';
}
