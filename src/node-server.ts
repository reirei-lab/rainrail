import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { RainrailBridgeRoom, type RainrailBridgeRoomState } from './bridge-room.js';
import { createRainrailEepBridgeIntakeAdapters } from './eep-bridge-bundle.js';
import {
  createRainrailHttpApp,
  rainrailHttpRequestBodyLimit,
  shouldReadRainrailHttpRequestBody,
  shouldStreamRainrailHttpRequestBody,
  type RainrailHttpApp,
  type RainrailHttpAppOptions,
} from './http-app.js';
import { jsonResponse, readRequestBody, writeFetchResponse } from './http-utils.js';
import type { RainrailIntakeAdapter } from './intake-adapter.js';
import {
  JsonFileOperationalStore,
  RainrailOperationalStore,
  type OperationalStore,
} from './operational-store.js';
import type { RainrailOperationalStoreConfig } from './config.js';

export interface RainrailNodeServerOptions extends Omit<RainrailHttpAppOptions, 'room'> {
  githubWebhookSecret: string;
  githubSourceName?: string;
  allowedHosts?: readonly string[];
  maxWebhookBodyBytes?: number;
  intakeAdapters?: readonly RainrailIntakeAdapter[];
  operationalStoreConfig?: RainrailOperationalStoreConfig;
  state?: RainrailBridgeRoomState;
  replayLimit?: number;
  keepAliveIntervalMs?: number;
  maxBodyBytes?: number;
}

export interface RainrailNodeServer {
  server: http.Server;
  app: RainrailHttpApp;
  room: RainrailBridgeRoom;
  operationalStore?: OperationalStore;
}

export function createRainrailNodeServer(options: RainrailNodeServerOptions): RainrailNodeServer {
  if (options.operationalStore !== undefined && options.operationalStoreConfig !== undefined) {
    throw new Error('operationalStore and operationalStoreConfig are mutually exclusive');
  }
  const ownedOperationalStore = options.operationalStore === undefined && options.operationalStoreConfig !== undefined
    ? createOperationalStoreFromConfig(options.operationalStoreConfig)
    : undefined;
  try {
    const hasCustomTailAdapter = options.intakeAdapters?.some((adapter) => adapter.tail !== undefined) ?? false;
    const operationalStore = options.operationalStore ?? ownedOperationalStore;
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
      ...(operationalStore === undefined ? {} : { operationalStore }),
      ...(options.taskQueue === undefined ? {} : { taskQueue: options.taskQueue }),
      ...(options.dashboardCardRegistry === undefined ? {} : { dashboardCardRegistry: options.dashboardCardRegistry }),
      ...(options.dashboardCardCatalog === undefined ? {} : { dashboardCardCatalog: options.dashboardCardCatalog }),
      ...(options.dashboardDefaultLayout === undefined ? {} : { dashboardDefaultLayout: options.dashboardDefaultLayout }),
      ...(options.dashboardCommandMaxBodyBytes === undefined && options.maxBodyBytes === undefined ? {} : {
        dashboardCommandMaxBodyBytes: options.dashboardCommandMaxBodyBytes ?? options.maxBodyBytes,
      }),
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
        if (!isAllowedHostHeader(request.headers.host, options.allowedHosts)) {
          await writeFetchResponse(
            response,
            jsonResponse({ error: 'invalid_host_header' }, { status: 400 }),
            { signal: abortController.signal },
          );
          return;
        }

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
    server.once('close', () => {
      ownedOperationalStore?.close();
    });
    server.once('error', () => {
      ownedOperationalStore?.close();
    });

    return {
      server,
      app,
      room,
      ...(operationalStore === undefined ? {} : { operationalStore }),
    };
  } catch (error) {
    ownedOperationalStore?.close();
    throw error;
  }
}

export function createOperationalStoreFromConfig(
  config: RainrailOperationalStoreConfig,
): OperationalStore & { close(): void } {
  switch (config.kind) {
    case 'json':
      return new JsonFileOperationalStore({
        databasePath: expectConfiguredDatabasePath(config, 'json'),
        eventLimit: config.eventLimit,
      });
    case 'memory':
      if (config.databasePath !== undefined) {
        throw new Error('operationalStoreConfig.databasePath must be omitted for memory stores');
      }
      return new RainrailOperationalStore({
        databasePath: ':memory:',
        eventLimit: config.eventLimit,
      });
    case 'sqlite':
      return new RainrailOperationalStore({
        databasePath: expectConfiguredDatabasePath(config, 'sqlite'),
        eventLimit: config.eventLimit,
      });
    default:
      throw new Error('operationalStoreConfig.kind must be one of: sqlite, json, memory');
  }
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
  if (methodCanHaveBody(method)) {
    if (shouldReadRainrailHttpRequestBody(url.pathname, method, appOptions)) {
      init.body = await readRequestBody(
        request,
        rainrailHttpRequestBodyLimit(url.pathname, method, appOptions) ?? options.maxBodyBytes,
      );
    } else if (
      shouldStreamRainrailHttpRequestBody(url.pathname, method, appOptions)
      || isDashboardBodyRoute(url.pathname, method)
    ) {
      init.body = Readable.toWeb(request) as ReadableStream;
      Object.assign(init, { duplex: 'half' });
    }
  }

  return new Request(url, init);
}

function methodCanHaveBody(method: string): boolean {
  const normalized = method.toUpperCase();
  return normalized !== 'GET' && normalized !== 'HEAD';
}

function isDashboardCommandRoute(pathname: string, method: string): boolean {
  return method.toUpperCase() === 'POST'
    && (/^\/api\/v1\/agent-tasks\/(?:[^/]+\/actions\/(?:resume|reset|terminate)|actions\/terminate-all)$/.test(pathname)
      || pathname === '/api/v1/queue/actions/assign-next'
      || pathname === '/api/v1/settings/actions/update');
}

function isDashboardBodyRoute(pathname: string, method: string): boolean {
  return isDashboardCommandRoute(pathname, method)
    || (method.toUpperCase() === 'PUT' && pathname === '/api/v1/dashboard/layout')
    || (method.toUpperCase() === 'PATCH' && /^\/api\/v1\/dashboard\/layout\/items\/[^/]+\/config$/.test(pathname));
}

function isAllowedHostHeader(host: string | undefined, allowedHosts: readonly string[] | undefined): boolean {
  if (allowedHosts === undefined || allowedHosts.length === 0) return true;
  const hostName = hostHeaderName(host ?? '127.0.0.1');
  if (hostName === undefined) return false;
  return new Set([
    'localhost',
    '127.0.0.1',
    '::1',
    ...allowedHosts.map(normalizeHostName),
  ]).has(hostName);
}

function hostHeaderName(host: string): string | undefined {
  const bracketed = /^\[([0-9A-Fa-f:.]+)\](?::[0-9]{1,5})?$/u.exec(host);
  if (bracketed?.[1] !== undefined) {
    return bracketed[1].toLowerCase();
  }
  const named = /^([A-Za-z0-9._-]+)(?::[0-9]{1,5})?$/u.exec(host);
  return named?.[1]?.toLowerCase();
}

function normalizeHostName(host: string): string {
  return host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1).toLowerCase()
    : host.toLowerCase();
}

function isStatusCodeError(error: unknown): error is { statusCode: number } {
  return typeof error === 'object'
    && error !== null
    && 'statusCode' in error
    && typeof error.statusCode === 'number';
}

function expectConfiguredDatabasePath(config: RainrailOperationalStoreConfig, kind: 'sqlite' | 'json'): string {
  if (config.databasePath === undefined || config.databasePath.length === 0) {
    throw new Error(`operationalStoreConfig.databasePath is required for ${kind} stores`);
  }
  return config.databasePath;
}
