import http, { type IncomingMessage, type ServerResponse } from 'node:http';

import { RainrailBridgeRoom, type RainrailBridgeRoomState } from './bridge-room.js';
import { createRainrailEepBridgeIntakeAdapters } from './eep-bridge-bundle.js';
import {
  createRainrailHttpApp,
  rainrailHttpRequestBodyLimit,
  shouldReadRainrailHttpRequestBody,
  type RainrailHttpApp,
  type RainrailHttpAppOptions,
} from './http-app.js';
import { jsonResponse, readRequestBody, writeFetchResponse } from './http-utils.js';
import type { RainrailIntakeAdapter } from './intake-adapter.js';

export interface RainrailNodeServerOptions extends Omit<RainrailHttpAppOptions, 'room'> {
  githubWebhookSecret: string;
  githubSourceName?: string;
  maxWebhookBodyBytes?: number;
  intakeAdapters?: readonly RainrailIntakeAdapter[];
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
  const hasCustomTailAdapter = options.intakeAdapters?.some((adapter) => adapter.tail !== undefined) ?? false;
  const room = new RainrailBridgeRoom(options.state ?? createInMemoryBridgeRoomState(), {
    publishToken: options.publishToken,
    ...(options.replayLimit === undefined ? {} : { replayLimit: options.replayLimit }),
    ...(options.keepAliveIntervalMs === undefined ? {} : { keepAliveIntervalMs: options.keepAliveIntervalMs }),
  });
  const appOptions: RainrailHttpAppOptions = {
    room,
    publishToken: options.publishToken,
    ...(options.eventsBearerToken === undefined ? {} : { eventsBearerToken: options.eventsBearerToken }),
    runtime: options.runtime ?? 'node',
    ...(options.operationalStore === undefined ? {} : { operationalStore: options.operationalStore }),
    ...(options.dashboardCommandMaxBodyBytes === undefined ? {} : { dashboardCommandMaxBodyBytes: options.dashboardCommandMaxBodyBytes }),
    ...(options.dashboardAuth === undefined ? {} : { dashboardAuth: options.dashboardAuth }),
    ...(options.commandHandler === undefined ? {} : { commandHandler: options.commandHandler }),
    intakeAdapters: [
      ...createRainrailEepBridgeIntakeAdapters({
        env: { GITHUB_WEBHOOK_SECRET: options.githubWebhookSecret },
        ...(options.githubSourceName === undefined ? {} : { githubSourceName: options.githubSourceName }),
        includeCloudflareTail: !hasCustomTailAdapter,
        ...(options.maxWebhookBodyBytes === undefined && options.maxBodyBytes === undefined ? {} : {
          githubMaxBodyBytes: options.maxWebhookBodyBytes ?? options.maxBodyBytes,
        }),
      }),
      ...(options.intakeAdapters ?? []),
    ],
  };
  const app = createRainrailHttpApp(appOptions);

  const server = http.createServer(async (request, response) => {
    const abortController = new AbortController();
    response.once('close', () => {
      abortController.abort();
    });

    try {
      await writeFetchResponse(
        response,
        await app.fetch(await toFetchRequest(request, options, appOptions, abortController.signal)),
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
      async compareAndSet(key, expected, value) {
        if (!Object.is(values.get(key), expected)) {
          return false;
        }
        values.set(key, value);
        return true;
      },
    },
  };
}

async function toFetchRequest(
  request: IncomingMessage,
  options: Pick<RainrailNodeServerOptions, 'maxBodyBytes'>,
  appOptions: RainrailHttpAppOptions,
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

  const method = request.method ?? 'GET';
  if (methodCanHaveBody(method) && shouldReadRainrailHttpRequestBody(url.pathname, method, appOptions)) {
    init.body = await readRequestBody(
      request,
      rainrailHttpRequestBodyLimit(url.pathname, method, appOptions) ?? options.maxBodyBytes,
    );
  }

  return new Request(url, init);
}

function methodCanHaveBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

function isStatusCodeError(error: unknown): error is { statusCode: number } {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof error.statusCode === 'number';
}
